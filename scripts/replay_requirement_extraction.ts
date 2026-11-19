/**
 * Replay of requirement extraction (`deterministic_v4`) on a STAGING branch.
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
 *
 *   npm run replay:requirements            (read-only plan + before)
 *   npm run replay:requirements -- --migrate (applies pending migrations to the replay branch)
 *   npm run replay:requirements -- --apply (writes to the replay branch)
 *   npm run replay:requirements -- --apply --scope matched (also every job that already has a match)
 *   npm run replay:requirements -- --apply --rematch-only (re-match and re-decide; e.g. SCORING_POLICY=topk_capability_semantic_v1)
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '.env.local' });

const replayUrl = process.env.REPLAY_DATABASE_URL?.trim();
if (!replayUrl) {
  console.error('REPLAY_DATABASE_URL is not set. Put the staging branch connection string in .env.local as REPLAY_DATABASE_URL.');
  process.exit(1);
}
// No default pool anywhere may reach a different database.
process.env.DATABASE_URL = replayUrl;
process.env.DATABASE_URL_UNPOOLED = replayUrl;

const CHUNK = 40;
const MAX_EMBEDDING_FAILURE_SHARE = 0.05;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  // Re-match and re-decide only (requirements and embeddings already current), e.g. to apply a new scoring policy.
  const rematchOnly = process.argv.includes('--rematch-only');
  const { pgConnectionConfig } = await import('../src/db/pgSsl.js');
  const { requireApprovedReplayTarget } = await import('../src/reporting/replayGuard.js');
  const { resolveWorkspaceContext } = await import('../src/workspace/context.js');
  const { LINKEDIN_SAVED_SOURCE_NAME } = await import('../src/ingestion/linkedInSavedExport.js');
  const { buildMeasurementReport, classifyNonFitTitle } = await import('../src/reporting/rankingMeasurement.js');
  const { loadCandidateJobs, loadSavedObservations } = await import('../src/reporting/rankingMeasurementQueries.js');
  const { formatReport } = await import('./measure_ranking.js');

  const client = new pg.Client(pgConnectionConfig(replayUrl!));
  await client.connect();
  // The stage runners take a pool (they check out their own connection), not a connected client.
  const pool = new pg.Pool({ ...pgConnectionConfig(replayUrl!), max: 4 });
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
      await client.query('BEGIN READ ONLY');
      try {
        const saved = await loadSavedObservations(client as never, workspace.workspaceId, LINKEDIN_SAVED_SOURCE_NAME);
        const candidates = await loadCandidateJobs(client as never, workspace.workspaceId);
        console.log(`\n===== ${label} =====\n${formatReport(buildMeasurementReport(saved, candidates))}`);
      } finally {
        await client.query('ROLLBACK');
      }
    };

    const { rows } = await client.query<{ canonical_job_id: string; job_version_id: string; title: string | null; saved: boolean; matched: boolean }>(
      `SELECT cj.id AS canonical_job_id, cj.latest_job_version_id AS job_version_id, cj.normalized_title AS title,
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
    const scope = rows.filter((row) => row.saved || classifyNonFitTitle(row.title ?? '') !== null || (wide && row.matched));
    console.log(`Replay scope: ${scope.filter((r) => r.saved).length} saved jobs + ${scope.filter((r) => !r.saved).length} non-fit jobs`);

    await measure('BEFORE (current staging data)');
    if (!apply) {
      console.log('\nRead-only run. Re-run with --apply to re-extract, publish embeddings, re-match and re-decide.');
      return;
    }

    const { runRequirementsExtraction } = await import('../src/pipeline/requirementsExtractor.js');
    const { runEmbeddingBatchWithFallback } = await import('../src/embeddings/batchCoordinator.js');
    const { runDeterministicMatcher } = await import('../src/pipeline/deterministicMatcher.js');
    const { runRecommendationDecider } = await import('../src/pipeline/recommendationDecider.js');

    const totals = { extracted: 0, extractionErrors: 0, embeddingsOk: 0, embeddingsFailed: 0, matched: 0, matchErrors: 0, decisionErrors: 0 };
    for (let at = 0; at < scope.length; at += CHUNK) {
      const chunk = scope.slice(at, at + CHUNK);
      const jobVersionIds = chunk.map((row) => row.job_version_id);
      const canonicalJobIds = chunk.map((row) => row.canonical_job_id);

      if (!rematchOnly) {
      const extraction = await runRequirementsExtraction(pool as never, {
        context: workspace,
        jobVersionIds,
        reprocess: true,
        ignoreRetryWindow: true,
        quotedMode: 'deterministic_only',
        limit: CHUNK,
      });
      totals.extracted += extraction.processed;
      totals.extractionErrors += extraction.errors;

      const embeddings = await runEmbeddingBatchWithFallback(2000, pool as never, { context: workspace, jobVersionIds });
      totals.embeddingsOk += embeddings.primary.succeeded;
      totals.embeddingsFailed += embeddings.primary.failed;
      }

      const attempted = totals.embeddingsOk + totals.embeddingsFailed;
      if (attempted > 0 && totals.embeddingsFailed / attempted > MAX_EMBEDDING_FAILURE_SHARE) {
        throw new Error(`Stopping: ${totals.embeddingsFailed} of ${attempted} embedding inputs failed (limit ${MAX_EMBEDDING_FAILURE_SHARE * 100}%).`);
      }

      const matching = await runDeterministicMatcher(pool as never, { context: workspace, canonicalJobIds });
      totals.matched += matching.matchedJobs;
      totals.matchErrors += matching.errors;
      const decisions = await runRecommendationDecider(pool as never, { context: workspace, canonicalJobIds });
      totals.decisionErrors += decisions.errors;
      console.error(`Replayed ${Math.min(at + CHUNK, scope.length)}/${scope.length}`);
    }
    console.log(`\nReplay totals: ${JSON.stringify(totals)}`);
    await measure('AFTER (deterministic_v4)');
  } finally {
    await pool.end();
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Replay failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
