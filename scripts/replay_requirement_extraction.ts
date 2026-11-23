/**
 * Replay of requirement extraction (the current `DETERMINISTIC_EXTRACTOR_VERSION`) on a STAGING branch.
 *
 * Re-extracts requirements for the saved jobs and the non-fit jobs, publishes the new
 * requirement embeddings, re-matches and re-decides, then prints the ranking measurement
 * before and after on the same data.
 *
 * Safety:
 *  - The target is REPLAY_DATABASE_URL only. DATABASE_URL is never used, and is overridden
 *    in-process so no default pool can reach another database.
 *  - The connected Neon branch must be the approved staging branch (or REPLAY_BRANCH_ID),
 *    and never a known production host or branch.
 *  - Without --apply nothing is written: it prints the plan and the "before" measurement.
 *  - Stops if more than 5% of embedding inputs fail.
 *  - A dropped connection is reconnected and the interrupted chunk is retried (pg 'error' events are handled, never unhandled).
 *  - Resumes where it stopped: a job whose active requirement set is already on the current extractor version is not re-extracted
 *    (pass --force-all to re-extract everything). Matching and deciding are idempotent and run for every job in scope.
 *  - Exits non-zero on ANY failed or incomplete stage (extraction, embeddings, matching, deciding, re-gate) and prints the totals line only on success.
 *  - Spend cap: REPLAY_SPEND_CAP_USD (default 5). The estimate is printed before anything runs and the script stops
 *    (also in the read-only run) when it exceeds the cap. Extraction is deterministic_only (no model call); only embeddings cost money.
 *
 *   npm run replay:requirements            (read-only plan + before)
 *   npm run replay:requirements -- --migrate (applies pending migrations to the replay branch)
 *   npm run replay:requirements -- --apply (writes to the replay branch)
 *   npm run replay:requirements -- --apply --scope matched (also every job that already has a match)
 *   npm run replay:requirements -- --scope live-pass   (every live, gate-passed job with a confirmed link; prints job count and cost estimate)
 *   npm run replay:requirements -- --apply --regate --scope live-pass   (re-runs the hard gates with the current rules first)
 *   npm run replay:requirements -- --apply --rematch-only (re-match and re-decide; e.g. SCORING_POLICY=topk_capability_semantic_v1)
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local' });

// Anything that escapes main() must fail the run, never leave a half-finished replay with a success code.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error) => {
    console.error(`Replay failed (${event}): ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

const replayUrl = process.env.REPLAY_DATABASE_URL?.trim();
if (!replayUrl) {
  console.error('REPLAY_DATABASE_URL is not set. Put the staging branch connection string in .env.local as REPLAY_DATABASE_URL.');
  process.exit(1);
}
// No default pool anywhere may reach a different database.
process.env.DATABASE_URL = replayUrl;
process.env.DATABASE_URL_UNPOOLED = replayUrl;

const CHUNK = 40;
const spendCapUsd = Number(process.env.REPLAY_SPEND_CAP_USD ?? '5');
// Upper-bound embedding price (gemini-embedding-001 list price is about US$0.15 per million input tokens).
const EMBEDDING_USD_PER_MILLION_TOKENS = 0.15;
// Re-extraction can find more requirements than are stored today; the estimate is doubled to stay on the safe side.
const ESTIMATE_SAFETY_FACTOR = 2;

async function estimateReplayCost(client: { query: pg.Client["query"] }, jobVersionIds: string[]): Promise<{ tokens: number; usd: number }> {
  const { rows } = await client.query<{ chars: string }>(
    `SELECT COALESCE(SUM(LENGTH(requirement_text)), 0)::text AS chars FROM job_requirements WHERE job_version_id = ANY($1::uuid[])`,
    [jobVersionIds],
  );
  const tokens = Math.ceil((Number(rows[0]?.chars ?? 0) / 4) * ESTIMATE_SAFETY_FACTOR);
  return { tokens, usd: (tokens / 1_000_000) * EMBEDDING_USD_PER_MILLION_TOKENS };
}
const MAX_EMBEDDING_FAILURE_SHARE = 0.05;
const MAX_CHUNK_RETRIES = 3;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // Re-match and re-decide only (requirements and embeddings already current), e.g. to apply a new scoring policy.
  const rematchOnly = process.argv.includes('--rematch-only');
  const regate = process.argv.includes('--regate');
  const { pgConnectionConfig } = await import('../src/db/pgSsl.js');
  const { requireApprovedReplayTarget } = await import('../src/reporting/replayGuard.js');
  const { resolveWorkspaceContext } = await import('../src/workspace/context.js');
  const { LINKEDIN_SAVED_SOURCE_NAME } = await import('../src/ingestion/linkedInSavedExport.js');
  const { buildMeasurementReport, classifyNonFitTitle } = await import('../src/reporting/rankingMeasurement.js');
  const { loadCandidateJobs, loadSavedObservations } = await import('../src/reporting/rankingMeasurementQueries.js');
  const { formatReport } = await import('./measure_ranking.js');

  const {
    ResilientClient, attachPoolErrorHandler, retryOnConnectionLoss, isTransientConnectionError,
    emptyReplayTotals, assessReplay, loadJobsOnExtractorVersion, countGatePassedLeftBeforeMatching,
  } = await import('../src/reporting/replayResilience.js');
  const { DETERMINISTIC_EXTRACTOR_VERSION } = await import('../src/requirements/deterministicExtractors.js');

  // A client that handles its 'error' events and reconnects after a dropped connection.
  const client = new ResilientClient(() => new pg.Client(pgConnectionConfig(replayUrl!)));
  await client.connect();
  // The stage runners take a pool (they check out their own connection), not a connected client.
  const pool = new pg.Pool({ ...pgConnectionConfig(replayUrl!), max: 4 });
  attachPoolErrorHandler(pool);
  try {
    const identity = await client.query<{ database_name: string | null; branch_id: string | null }>(
      `SELECT current_database() AS database_name, current_setting('neon.branch_id', TRUE) AS branch_id`,
    );
    const target = requireApprovedReplayTarget(
      replayUrl!,
      { databaseName: identity.rows[0]?.database_name ?? null, branchId: identity.rows[0]?.branch_id ?? null },
      process.env.REPLAY_BRANCH_ID,
    );
    console.error(`Replay target: ${target.host} (branch ${target.branchId ?? 'unknown'})${apply ? '  [APPLY]' : '  [read-only]'}`);

    const { getMigrationStatus, runMigrations } = await import('../src/db/migrate.js');
    if (process.argv.includes('--migrate')) {
      // Additive migrations only, on the verified replay branch: a snapshot taken before a migration lacks its views.
      const applied = await runMigrations(pool);
      console.log(`Applied ${applied.length} migration(s) to the replay branch: ${applied.join(', ') || 'none pending'}`);
    }
    const migrationStatus = await getMigrationStatus(pool);
    if (migrationStatus.pendingCount > 0) {
      console.error(`${migrationStatus.pendingCount} migration(s) are pending on the replay branch (${migrationStatus.pending.join(', ')}).`);
      if (apply) throw new Error('Refusing --apply with pending migrations. Run with --migrate first.');
    }

    const workspace = await resolveWorkspaceContext(client as never);

    const measure = async (label: string): Promise<void> => {
      // A drop inside the read-only transaction loses it; the whole unit is retried on a fresh connection.
      await retryOnConnectionLoss(async () => {
        await client.query('BEGIN READ ONLY');
        try {
          const saved = await loadSavedObservations(client as never, workspace.workspaceId, LINKEDIN_SAVED_SOURCE_NAME);
          const candidates = await loadCandidateJobs(client as never, workspace.workspaceId);
          console.log(`\n===== ${label} =====\n${formatReport(buildMeasurementReport(saved, candidates))}`);
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
        }
      });
    };

    // --regate (needs --apply): run the hard gates again on every live job with the current rules, before the scope is
    // computed, so "gate-passed" means passed under today's rules. A HARD_REJECT clears the stored recommendation (#202).
    if (regate) {
      if (!apply) throw new Error('--regate writes gate decisions; use it with --apply.');
      const { regateJobIds, printRegateOutcome } = await import('./regate_job_ids.js');
      const live = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM canonical_jobs
          WHERE workspace_id = $1 AND archived_at IS NULL AND is_test_fixture IS NOT TRUE
            AND COALESCE(processing_state, processing_status) <> 'MANUALLY_REMOVED'`,
        [workspace.workspaceId],
      );
      const before = await client.query<{ gate_decision: string | null; n: number }>(
        `SELECT gate_decision, COUNT(*)::int AS n FROM canonical_jobs WHERE workspace_id = $1 AND archived_at IS NULL GROUP BY 1 ORDER BY 1`,
        [workspace.workspaceId],
      );
      console.log(`Gate decisions before re-gate: ${JSON.stringify(before.rows)}`);
      const outcome = await regateJobIds(pool as never, workspace, live.rows.map((row) => row.id));
      printRegateOutcome(outcome);
      if (!outcome.ok) throw new Error('Re-gate incomplete: stopping before the replay.');
      const after = await client.query<{ gate_decision: string | null; n: number }>(
        `SELECT gate_decision, COUNT(*)::int AS n FROM canonical_jobs WHERE workspace_id = $1 AND archived_at IS NULL GROUP BY 1 ORDER BY 1`,
        [workspace.workspaceId],
      );
      console.log(`Gate decisions after re-gate:  ${JSON.stringify(after.rows)}`);
    }

    const { rows } = await client.query<{ canonical_job_id: string; job_version_id: string; title: string | null; saved: boolean; matched: boolean; live_pass: boolean }>(
      `SELECT cj.id AS canonical_job_id, cj.latest_job_version_id AS job_version_id, cj.normalized_title AS title,
              (cj.gate_decision = 'PASS' AND cj.is_test_fixture IS NOT TRUE
                 AND cj.processing_state <> 'MANUALLY_REMOVED'
                 AND cj.canonical_url ~* '^https?://'
                 AND cj.canonical_url !~* '^https?://himalayas\\.app/jobs/([0-9a-f]{16,}|api)') AS live_pass,
              (cj.latest_match_run_id IS NOT NULL) AS matched,
              EXISTS (SELECT 1 FROM raw_job_observations o JOIN job_versions ojv ON ojv.id = o.job_version_id
                      WHERE o.workspace_id = cj.workspace_id AND o.source_name = $2 AND ojv.canonical_job_id = cj.id) AS saved
       FROM canonical_jobs cj
       WHERE cj.workspace_id = $1 AND cj.archived_at IS NULL AND cj.latest_job_version_id IS NOT NULL`,
      [workspace.workspaceId, LINKEDIN_SAVED_SOURCE_NAME],
    );
    // Default scope: saved jobs and non-fit titles. --scope matched: also every job that already has a match
    // (a wider, unbiased pool for blind review).
    const wide = process.argv.includes('--scope') && process.argv[process.argv.indexOf('--scope') + 1] === 'matched';
    // --scope live-pass: every live job that passed the hard gate and has a confirmed posting link (no invented Himalayas
    // link, no test fixture, not manually removed). Saved jobs stay in so the measurement keeps its anchors.
    const livePass = process.argv.includes('--scope') && process.argv[process.argv.indexOf('--scope') + 1] === 'live-pass';
    const scope = livePass
      ? rows.filter((row) => row.live_pass || row.saved)
      : rows.filter((row) => row.saved || classifyNonFitTitle(row.title ?? '') !== null || (wide && row.matched));
    console.log(
      `Replay scope: ${scope.length} jobs (${scope.filter((r) => r.saved).length} saved, ${scope.filter((r) => r.live_pass && !r.saved).length} live gate-passed, ${scope.filter((r) => !r.saved && !r.live_pass).length} non-fit)`,
    );
    const estimate = await estimateReplayCost(client as never, scope.map((row) => row.job_version_id));
    console.log(`Cost estimate (embeddings only; extraction makes no model call): ~${estimate.tokens.toLocaleString('en-US')} tokens, about US$${estimate.usd.toFixed(2)} (cap US$${spendCapUsd.toFixed(2)})`);
    if (estimate.usd > spendCapUsd) {
      throw new Error(`Estimated cost US$${estimate.usd.toFixed(2)} exceeds the cap US$${spendCapUsd.toFixed(2)}. Stopping before any write.`);
    }

    await measure('BEFORE (current staging data)');
    if (!apply) {
      console.log('\nRead-only run. Re-run with --apply to re-extract, publish embeddings, re-match and re-decide.');
      return;
    }

    const { runRequirementsExtraction } = await import('../src/pipeline/requirementsExtractor.js');
    const { runEmbeddingBatchWithFallback } = await import('../src/embeddings/batchCoordinator.js');
    const { runDeterministicMatcher } = await import('../src/pipeline/deterministicMatcher.js');
    const { runRecommendationDecider } = await import('../src/pipeline/recommendationDecider.js');

    const totals = emptyReplayTotals();
    // Resume: jobs already on the current extractor version are not re-extracted (their embeddings stay valid).
    const forceAll = process.argv.includes('--force-all');
    const alreadyExtracted = rematchOnly || forceAll
      ? new Set<string>()
      : await loadJobsOnExtractorVersion(client, workspace.workspaceId, scope.map((row) => row.canonical_job_id), DETERMINISTIC_EXTRACTOR_VERSION);
    totals.resumedSkipped = alreadyExtracted.size;
    let extractionDiscovered = 0;
    if (alreadyExtracted.size > 0) {
      console.log(`Resuming: ${alreadyExtracted.size} of ${scope.length} jobs are already on ${DETERMINISTIC_EXTRACTOR_VERSION} and are not re-extracted (--force-all to redo them).`);
    }

    for (let at = 0; at < scope.length; at += CHUNK) {
      const chunk = scope.slice(at, at + CHUNK);
      const canonicalJobIds = chunk.map((row) => row.canonical_job_id);
      const toExtract = chunk.filter((row) => !alreadyExtracted.has(row.canonical_job_id));

      // One chunk is a unit of work. A dropped connection re-runs the whole chunk (every stage is idempotent) and the
      // chunk's numbers are added to the totals only once it has finished, so a retry never double counts.
      let attempt = 0;
      let chunkTotals = emptyReplayTotals();
      let chunkDiscovered = 0;
      for (;;) {
        attempt += 1;
        chunkTotals = emptyReplayTotals();
        chunkDiscovered = 0;
        try {
          if (!rematchOnly) {
            if (toExtract.length > 0) {
              const extraction = await runRequirementsExtraction(pool as never, {
                context: workspace,
                jobVersionIds: toExtract.map((row) => row.job_version_id),
                reprocess: true,
                ignoreRetryWindow: true,
                quotedMode: 'deterministic_only',
                limit: CHUNK,
              });
              chunkDiscovered += extraction.discovered;
              chunkTotals.extracted += extraction.processed;
              chunkTotals.extractionErrors += extraction.errors;
            }
            // Idempotent: only inputs without an embedding cost anything, so resumed jobs are free here.
            const embeddings = await runEmbeddingBatchWithFallback(2000, pool as never, {
              context: workspace,
              jobVersionIds: chunk.map((row) => row.job_version_id),
            });
            chunkTotals.embeddingsOk += embeddings.primary.succeeded;
            chunkTotals.embeddingsFailed += embeddings.primary.failed;
          }
          if (regate) {
            // A re-gate leaves jobs before lane routing; the matcher only takes routed jobs. Route again with the active lane revisions.
            const { runLaneRouting } = await import('../src/pipeline/laneRouter.js');
            const routing = await runLaneRouting(pool as never, { context: workspace, canonicalJobIds, limit: CHUNK, reprocessExisting: true });
            chunkTotals.routed += routing.routed;
          }
          const matching = await runDeterministicMatcher(pool as never, { context: workspace, canonicalJobIds });
          chunkTotals.matched += matching.matchedJobs;
          chunkTotals.matchHeldBack += matching.skippedJobs;
          chunkTotals.matchErrors += matching.errors;
          const decisions = await runRecommendationDecider(pool as never, { context: workspace, canonicalJobIds });
          chunkTotals.decisionErrors += decisions.errors;
          break;
        } catch (error) {
          if (!isTransientConnectionError(error) || attempt > MAX_CHUNK_RETRIES) throw error;
          totals.chunksRetried += 1;
          console.error(`Chunk at ${at} lost its connection (${error instanceof Error ? error.message : String(error)}); retrying (${attempt}/${MAX_CHUNK_RETRIES}).`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
      extractionDiscovered += chunkDiscovered;
      for (const key of Object.keys(chunkTotals) as Array<keyof typeof chunkTotals>) {
        if (key !== 'resumedSkipped' && key !== 'chunksRetried') totals[key] += chunkTotals[key];
      }

      const attempted = totals.embeddingsOk + totals.embeddingsFailed;
      if (attempted > 0 && totals.embeddingsFailed / attempted > MAX_EMBEDDING_FAILURE_SHARE) {
        throw new Error(`Stopping: ${totals.embeddingsFailed} of ${attempted} embedding inputs failed (limit ${MAX_EMBEDDING_FAILURE_SHARE * 100}%).`);
      }
      // Broken-funnel guard: a first chunk that matches nothing means the jobs never reached the matcher.
      if (at === 0 && totals.matched + totals.matchHeldBack === 0) throw new Error('The first chunk matched 0 jobs: they did not reach the matcher. Stopping.');
      console.error(`Replayed ${Math.min(at + CHUNK, scope.length)}/${scope.length}`);
    }

    // Any failed or incomplete stage fails the run (AGENTS.md invariant 7). The totals line is for a complete run only.
    const failures = assessReplay(totals, { extractionDiscovered, rematchOnly });
    if (failures.length > 0) {
      console.error(`Replay totals (INCOMPLETE): ${JSON.stringify(totals)}`);
      throw new Error(`Replay did not complete: ${failures.join('; ')}.`);
    }
    console.log(`\nReplay totals: ${JSON.stringify(totals)} (scope ${scope.length}, extracted ${totals.extracted}/${extractionDiscovered} selected, matched ${totals.matched + totals.matchHeldBack})`);
    await measure(`AFTER (${DETERMINISTIC_EXTRACTOR_VERSION})`);
  } finally {
    await pool.end().catch(() => undefined);
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Replay failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
