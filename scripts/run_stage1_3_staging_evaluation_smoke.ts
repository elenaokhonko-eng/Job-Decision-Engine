/**
 * User-run staging-only evaluation smoke. Dry-runs by default and limits
 * provider calls to the active profile-v6 queue cohort selected below.
 */
import dotenv from 'dotenv';
import pg from 'pg';

import { isPooledPostgresConnectionString, pgPoolConfig } from '../src/db/pgSsl.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../src/workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const EXPECTED_STAGING_BRANCH_ID = 'br-orange-boat-azehba7u';
const EXPECTED_DATABASE_NAME = 'neondb';
const EXPECTED_PROFILE_VERSION = 6;
const MAX_SMOKE_JOBS = 500;
const MAX_RETRY_WAIT_SECONDS = 1800;

interface ActiveProfileRow {
  readonly id: string;
  readonly version_number: number;
  readonly effective_at: Date | string;
}

interface EligibleQueueRow {
  readonly queue_id: string;
  readonly job_version_id: string;
  readonly status: string;
  readonly available_at: Date | string | null;
}

interface QueueStatusCounts {
  readonly completed: number | string;
  readonly retry_wait: number | string;
  readonly failed: number | string;
  readonly needs_manual_review: number | string;
  readonly pending: number | string;
  readonly evaluating: number | string;
}

interface ReadModelCounts {
  readonly technical_errors: number | string;
  readonly summary_apply_now: number | string;
  readonly view_apply_now: number | string;
  readonly summary_track: number | string;
  readonly view_track: number | string;
  readonly summary_top_ten: number | string;
  readonly view_top_ten: number | string;
}

function parseLimit(): number {
  const raw = process.argv.find((argument) => argument.startsWith('--limit='))?.slice('--limit='.length);
  const limit = raw === undefined ? 1 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SMOKE_JOBS) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_SMOKE_JOBS}.`);
  }
  if (process.argv.includes('--apply') && !raw) {
    throw new Error('--apply requires an explicit --limit=N bound.');
  }
  return limit;
}

function parseRetryPasses(): number {
  const raw = process.argv.find((argument) => argument.startsWith('--retry-passes='))?.slice('--retry-passes='.length);
  const passes = raw ? Number(raw) : 1;
  if (!Number.isInteger(passes) || passes < 0 || passes > 2) {
    throw new Error('--retry-passes must be an integer from 0 to 2.');
  }
  return passes;
}

async function readQueueStatusCounts(
  pool: pg.Pool,
  context: WorkspaceContext,
  profileVersionId: string,
  queueIds: readonly string[]
): Promise<QueueStatusCounts> {
  const { rows } = await pool.query<QueueStatusCounts>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'COMPLETED')::INTEGER AS completed,
       COUNT(*) FILTER (WHERE status = 'RETRY_WAIT')::INTEGER AS retry_wait,
       COUNT(*) FILTER (WHERE status = 'FAILED')::INTEGER AS failed,
       COUNT(*) FILTER (WHERE status = 'NEEDS_MANUAL_REVIEW')::INTEGER AS needs_manual_review,
       COUNT(*) FILTER (WHERE status = 'PENDING')::INTEGER AS pending,
       COUNT(*) FILTER (WHERE status = 'EVALUATING')::INTEGER AS evaluating
     FROM evaluation_queue
     WHERE workspace_id = $1
       AND profile_version_id = $2
       AND id = ANY($3::uuid[])`,
    [context.workspaceId, profileVersionId, queueIds]
  );
  const result = rows[0];
  if (!result) throw new Error('Could not read the bounded evaluation smoke queue status.');
  return result;
}

async function readReadModelCounts(
  pool: pg.Pool,
  context: WorkspaceContext
): Promise<ReadModelCounts> {
  const { rows } = await pool.query<ReadModelCounts>(
    `SELECT summary.technical_errors,
            summary.apply_now_count AS summary_apply_now,
            (SELECT COUNT(DISTINCT canonical_job_id)::INTEGER
             FROM v_apply_now_jobs_stage3_scoped WHERE workspace_id = $1) AS view_apply_now,
            summary.track_count AS summary_track,
            (SELECT COUNT(DISTINCT canonical_job_id)::INTEGER
             FROM v_track_jobs_scoped WHERE workspace_id = $1) AS view_track,
            summary.top_ten_ready_count AS summary_top_ten,
            (SELECT COUNT(DISTINCT canonical_job_id)::INTEGER
             FROM v_top_ten_ready_jobs_stage3_scoped WHERE workspace_id = $1) AS view_top_ten
     FROM v_application_workspace_summary_scoped AS summary
     WHERE summary.workspace_id = $1 AND summary.user_key = $2
     LIMIT 1`,
    [context.workspaceId, context.userKey]
  );
  const result = rows[0];
  if (!result) throw new Error('Could not read the current profile-v6 Streamlit summary row.');
  return result;
}

function countValue(value: number | string): number {
  return Number(value);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limit = parseLimit();
  const retryPasses = parseRetryPasses();
  const databaseUrl = process.env.STAGE3_STAGING_DATABASE_URL;
  if (!databaseUrl) throw new Error('STAGE3_STAGING_DATABASE_URL is required.');
  if (isPooledPostgresConnectionString(databaseUrl)) {
    throw new Error('Staging evaluation smoke requires a direct, unpooled connection.');
  }

  const pool = new pg.Pool(pgPoolConfig(databaseUrl));
  const client = await pool.connect();
  try {
    const identity = await client.query<{ database_name: string; branch_id: string | null }>(
      `SELECT current_database() AS database_name,
              current_setting('neon.branch_id', TRUE) AS branch_id`
    );
    const databaseIdentity = identity.rows[0];
    if (
      databaseIdentity?.database_name !== EXPECTED_DATABASE_NAME ||
      databaseIdentity.branch_id !== EXPECTED_STAGING_BRANCH_ID
    ) {
      throw new Error('Refusing evaluation smoke: connected database is not the approved staging branch.');
    }

    const context = await resolveWorkspaceContext(client);
    const profileResult = await client.query<ActiveProfileRow>(
      `SELECT id, version_number, effective_at
       FROM profile_versions
       WHERE workspace_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [context.workspaceId]
    );
    const activeProfile = profileResult.rows[0];
    if (!activeProfile || activeProfile.version_number !== EXPECTED_PROFILE_VERSION) {
      throw new Error('Evaluation smoke requires active profile v6 on staging.');
    }

    const preferenceResult = await client.query<{ preference_domain: string }>(
      `SELECT preference_domain
       FROM workspace_user_preference_active_versions
       WHERE workspace_id = $1 AND user_id = $2
         AND preference_domain IN ('lane_intent', 'stage3')`,
      [context.workspaceId, context.userId]
    );
    const activeDomains = new Set(preferenceResult.rows.map((row) => row.preference_domain));
    if (!activeDomains.has('lane_intent') || !activeDomains.has('stage3')) {
      throw new Error('Evaluation smoke requires active Stage 2 and Stage 3 preferences on staging.');
    }

    const queueResult = await client.query<EligibleQueueRow>(
      `SELECT eq.id AS queue_id, eq.job_version_id, eq.status, eq.available_at
       FROM evaluation_queue AS eq
       JOIN canonical_jobs AS job
         ON job.workspace_id = eq.workspace_id
        AND job.id = eq.canonical_job_id
       JOIN job_versions AS version
         ON version.workspace_id = eq.workspace_id
        AND version.id = eq.job_version_id
       JOIN deterministic_decisions AS decision
         ON decision.workspace_id = eq.workspace_id
        AND decision.id = eq.deterministic_decision_id
        AND decision.canonical_job_id = eq.canonical_job_id
        AND decision.job_version_id = eq.job_version_id
        AND decision.match_run_id = eq.match_run_id
        AND decision.context_fingerprint = eq.context_fingerprint
       JOIN match_runs AS match_run
         ON match_run.workspace_id = eq.workspace_id
        AND match_run.id = eq.match_run_id
        AND match_run.canonical_job_id = eq.canonical_job_id
        AND match_run.job_version_id = eq.job_version_id
        AND match_run.profile_version_id = eq.profile_version_id
        AND match_run.requirement_set_id = version.active_requirement_set_id
        AND match_run.job_content_hash = version.content_hash
        AND match_run.context_fingerprint = eq.context_fingerprint
        AND match_run.status = 'COMPLETED'
       WHERE eq.workspace_id = $1
         AND eq.profile_version_id = $2
         AND eq.enqueued_at >= $3
         AND eq.job_content_hash = version.content_hash
         AND eq.context_fingerprint IS NOT NULL
         AND eq.status IN ('PENDING', 'RETRY_WAIT')
         AND (eq.status = 'PENDING' OR eq.available_at IS NULL OR eq.available_at <= NOW())
         AND job.latest_job_version_id = eq.job_version_id
         AND job.gate_decision = 'PASS'
         AND job.primary_lane IS NOT NULL
         AND BTRIM(job.primary_lane) <> ''
         AND job.primary_lane <> 'UNCLASSIFIED'
       ORDER BY eq.priority_score DESC, eq.enqueued_at ASC
       LIMIT $4`,
      [context.workspaceId, activeProfile.id, activeProfile.effective_at, limit]
    );
    const candidates = queueResult.rows;
    const queueIds = candidates.map((candidate) => candidate.queue_id);
    const jobVersionIds = [...new Set(candidates.map((candidate) => candidate.job_version_id))];
    if (jobVersionIds.length !== queueIds.length) {
      throw new Error('The bounded smoke cohort has multiple active queue rows for a job version.');
    }
    console.log(JSON.stringify({
      mode: apply ? 'STAGING_EVALUATION_SMOKE_APPLY' : 'DRY_RUN',
      branchId: EXPECTED_STAGING_BRANCH_ID,
      activeProfileVersion: activeProfile.version_number,
      eligibleQueueItems: candidates.length,
      uniqueJobVersions: jobVersionIds.length,
      limit,
      retryPasses,
      workflowExitOnRetryWait: false,
    }, null, 2));

    if (!apply || candidates.length === 0) return;

    process.env.DATABASE_URL = databaseUrl;
    process.env.DATABASE_URL_UNPOOLED = databaseUrl;
    process.env.EVALUATION_EXIT_ON_RETRY_WAIT = 'false';

    const [{ evaluateQueue, closeEvaluationQueuePool }, { runEvaluationQueueWithExitPolicy }] = await Promise.all([
      import('./evaluate_queue.js'),
      import('../src/pipeline/evaluationQueueExitPolicy.js'),
    ]);

    let failedDuringSmoke = 0;
    let manualReviewDuringSmoke = 0;
    try {
      for (let pass = 0; pass <= retryPasses; pass += 1) {
        const outcome = await runEvaluationQueueWithExitPolicy(
          () => evaluateQueue({
            context,
            profileVersionId: activeProfile.id,
            jobVersionIds,
            limit: jobVersionIds.length,
          }),
          false
        );
        if (!outcome.ok) throw new Error(`Fatal evaluation worker error: ${String(outcome.error)}`);
        failedDuringSmoke += outcome.stats.failed;
        manualReviewDuringSmoke += outcome.stats.manualReview;

        const status = await readQueueStatusCounts(pool, context, activeProfile.id, queueIds);
        if (countValue(status.retry_wait) === 0 || pass === retryPasses) break;

        const nextAvailable = await pool.query<{ available_at: Date | string | null }>(
          `SELECT MIN(available_at) AS available_at
           FROM evaluation_queue
           WHERE workspace_id = $1 AND profile_version_id = $2 AND id = ANY($3::uuid[])
             AND status = 'RETRY_WAIT'`,
          [context.workspaceId, activeProfile.id, queueIds]
        );
        const retryAt = nextAvailable.rows[0]?.available_at;
        if (!retryAt) throw new Error('Retry-wait items have no available_at timestamp.');
        const waitMs = new Date(retryAt).getTime() - Date.now() + 500;
        if (waitMs > MAX_RETRY_WAIT_SECONDS * 1000) {
          throw new Error('Retry backoff exceeds the bounded staging-smoke wait window.');
        }
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    } finally {
      await closeEvaluationQueuePool();
    }

    const status = await readQueueStatusCounts(pool, context, activeProfile.id, queueIds);
    const { materializeApplicationRankings } = await import('../src/services/applicationRankingMaterializer.js');
    const rankings = await materializeApplicationRankings(pool, context.workspaceId, {
      context,
      jobVersionIds,
    });
    const readModels = await readReadModelCounts(pool, context);
    console.log(JSON.stringify({
      evaluation: {
        completed: countValue(status.completed),
        retryWait: countValue(status.retry_wait),
        failed: countValue(status.failed),
        needsManualReview: countValue(status.needs_manual_review),
        pending: countValue(status.pending),
        evaluating: countValue(status.evaluating),
        failedAttemptsDuringSmoke: failedDuringSmoke,
        manualReviewTransitionsDuringSmoke: manualReviewDuringSmoke,
      },
      rankingMaterialization: rankings,
      readModels: {
        technicalErrors: countValue(readModels.technical_errors),
        summaryApplyNow: countValue(readModels.summary_apply_now),
        viewApplyNow: countValue(readModels.view_apply_now),
        summaryTrack: countValue(readModels.summary_track),
        viewTrack: countValue(readModels.view_track),
        summaryTopTen: countValue(readModels.summary_top_ten),
        viewTopTen: countValue(readModels.view_top_ten),
      },
    }, null, 2));

    if (
      countValue(status.completed) !== queueIds.length ||
      countValue(readModels.technical_errors) > 0 ||
      countValue(readModels.summary_apply_now) !== countValue(readModels.view_apply_now) ||
      countValue(readModels.summary_track) !== countValue(readModels.view_track) ||
      countValue(readModels.summary_top_ten) !== countValue(readModels.view_top_ten) ||
      countValue(status.retry_wait) > 0 ||
      countValue(status.failed) > 0 ||
      countValue(status.needs_manual_review) > 0 ||
      countValue(status.pending) > 0 ||
      countValue(status.evaluating) > 0
    ) {
      throw new Error('Bounded staging evaluation smoke did not drain to a clean terminal state.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('Staging evaluation smoke failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
