/**
 * User-run staging-only evaluation smoke. Dry-runs by default and limits
 * provider calls to the active profile-v6 queue cohort selected below.
 */
import dotenv from 'dotenv';
import pg from 'pg';

import { isPooledPostgresConnectionString, pgPoolConfig } from '../src/db/pgSsl.js';
import {
  createStagingDatabaseIdentityDiagnostic,
  isApprovedStagingDatabaseIdentity,
  STAGE1_3_STAGING_IDENTITY_EXPECTATIONS,
} from '../src/db/stagingDatabaseIdentity.js';
import {
  selectEligibleEvaluationQueueRows,
  supersedeStaleEvaluationQueueRows,
} from '../src/pipeline/evaluationQueueLineage.js';
import {
  newlyIntroducedStagingDebt,
  type StagingWorkspaceDebtCounts,
} from '../src/pipeline/stagingDebtDelta.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../src/workspace/context.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const EXPECTED_STAGING_BRANCH_ID = STAGE1_3_STAGING_IDENTITY_EXPECTATIONS.expectedBranchId;
const EXPECTED_PROFILE_VERSION = 6;
const MAX_SMOKE_JOBS = 500;
const MAX_RETRY_WAIT_SECONDS = 1800;

interface ActiveProfileRow {
  readonly id: string;
  readonly version_number: number;
  readonly effective_at: Date | string;
}

interface QueueStatusCounts {
  readonly completed: number | string;
  readonly retry_wait: number | string;
  readonly failed: number | string;
  readonly needs_manual_review: number | string;
  readonly pending: number | string;
  readonly evaluating: number | string;
  readonly superseded: number | string;
}

interface ReadModelCounts {
  readonly technical_errors: number | string;
  readonly cohort_technical_errors: number | string;
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
       COUNT(*) FILTER (WHERE status = 'EVALUATING')::INTEGER AS evaluating,
       COUNT(*) FILTER (WHERE status = 'SUPERSEDED')::INTEGER AS superseded
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
  context: WorkspaceContext,
  jobVersionIds: readonly string[]
): Promise<ReadModelCounts> {
  const { rows } = await pool.query<ReadModelCounts>(
    `SELECT summary.technical_errors,
            COALESCE((
              SELECT SUM(GREATEST(
                COALESCE(shortlist.technical_error_count, 0),
                CASE WHEN shortlist.processing_state = 'PROCESSING_ERROR' THEN 1 ELSE 0 END
              ))::INTEGER
              FROM v_canonical_shortlist_actions_scoped shortlist
              WHERE shortlist.workspace_id = $1
                AND shortlist.job_version_id = ANY($3::uuid[])
            ), 0)::INTEGER AS cohort_technical_errors,
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
    [context.workspaceId, context.userKey, [...jobVersionIds]]
  );
  const result = rows[0];
  if (!result) throw new Error('Could not read the current profile-v6 Streamlit summary row.');
  return result;
}

interface WorkspaceDebtRow {
  readonly technical_errors: number | string;
  readonly stranded_nonterminal_jobs: number | string;
  readonly pipeline_retry_wait: number | string;
  readonly pipeline_dead_letter: number | string;
}

async function readWorkspaceDebtCounts(
  pool: pg.Pool,
  context: WorkspaceContext
): Promise<StagingWorkspaceDebtCounts> {
  const { rows } = await pool.query<WorkspaceDebtRow>(
    `WITH stranded AS (
       SELECT job.id
       FROM canonical_jobs job
       WHERE job.workspace_id = $1
         AND NOT COALESCE(job.is_test_fixture, FALSE)
         AND COALESCE(job.processing_state, job.processing_status) IN (
           'RAW_STAGED', 'PREQUALIFIED', 'ROUTING_DEFERRED', 'LANE_ROUTED',
           'QUEUED_FOR_AI', 'EVALUATING', 'RETRY_WAIT'
         )
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_tasks task
           WHERE task.workspace_id = job.workspace_id
             AND task.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
             AND (
               task.payload->>'canonical_job_id' = job.id::text
               OR task.payload->>'job_version_id' = job.latest_job_version_id::text
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM evaluation_queue queue
           WHERE queue.workspace_id = job.workspace_id
             AND queue.canonical_job_id = job.id
             AND queue.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
         )
     )
     SELECT
       (SELECT technical_errors
        FROM v_application_workspace_summary_scoped
        WHERE workspace_id = $1 AND user_key = $2
        LIMIT 1) AS technical_errors,
       (SELECT COUNT(*)::INTEGER FROM stranded) AS stranded_nonterminal_jobs,
       (SELECT COUNT(*)::INTEGER FROM pipeline_tasks
        WHERE workspace_id = $1 AND status = 'RETRY_WAIT') AS pipeline_retry_wait,
       (SELECT COUNT(*)::INTEGER FROM pipeline_tasks
        WHERE workspace_id = $1 AND status = 'DEAD_LETTER') AS pipeline_dead_letter`,
    [context.workspaceId, context.userKey]
  );
  const row = rows[0];
  if (!row) throw new Error('Could not read staging workspace debt counts.');
  return {
    technicalErrors: countValue(row.technical_errors),
    strandedNonterminalJobs: countValue(row.stranded_nonterminal_jobs),
    pipelineRetryWait: countValue(row.pipeline_retry_wait),
    pipelineDeadLetter: countValue(row.pipeline_dead_letter),
  };
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
    const identity = await client.query<{ database_name: string | null; branch_id: string | null }>(
      `SELECT current_database() AS database_name,
              current_setting('neon.branch_id', TRUE) AS branch_id`
    );
    const databaseIdentity = identity.rows[0];
    const identityDiagnostic = createStagingDatabaseIdentityDiagnostic(
      databaseUrl,
      databaseIdentity
        ? { databaseName: databaseIdentity.database_name, branchId: databaseIdentity.branch_id }
        : null,
      STAGE1_3_STAGING_IDENTITY_EXPECTATIONS,
    );
    console.log(identityDiagnostic);
    if (!isApprovedStagingDatabaseIdentity({
      databaseName: databaseIdentity?.database_name,
      branchId: databaseIdentity?.branch_id,
      hostname: identityDiagnostic.connectionHost,
    }, STAGE1_3_STAGING_IDENTITY_EXPECTATIONS)) {
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

    const workspaceDebtBefore = await readWorkspaceDebtCounts(pool, context);
    let supersededQueueRows = 0;
    let candidates: Awaited<ReturnType<typeof selectEligibleEvaluationQueueRows>>;
    await client.query('BEGIN');
    try {
      if (apply) {
        supersededQueueRows = await supersedeStaleEvaluationQueueRows(client, {
          workspaceId: context.workspaceId,
          profileVersionId: activeProfile.id,
        });
      }
      candidates = await selectEligibleEvaluationQueueRows(client, {
        workspaceId: context.workspaceId,
        profileVersionId: activeProfile.id,
        enqueuedAtOrAfter: activeProfile.effective_at,
        limit,
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    const workspaceDebtAfterReconciliation = await readWorkspaceDebtCounts(pool, context);
    const reconciliationDebtDelta = newlyIntroducedStagingDebt(workspaceDebtBefore, workspaceDebtAfterReconciliation);
    const queueIds = candidates.map((candidate) => candidate.id);
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
      staleQueueRowsSuperseded: supersededQueueRows,
      workspaceDebtBeforeReconciliation: workspaceDebtBefore,
      workspaceDebtAfterReconciliation,
      reconciliationDebtDeltaIsInformational: reconciliationDebtDelta,
      limit,
      retryPasses,
      workflowExitOnRetryWait: false,
    }, null, 2));

    if (!apply) return;
    if (candidates.length === 0) {
      const workspaceDebtAfter = await readWorkspaceDebtCounts(pool, context);
      const newDebt = newlyIntroducedStagingDebt(workspaceDebtAfterReconciliation, workspaceDebtAfter);
      console.log(JSON.stringify({
        evaluation: { completed: 0, eligibleQueueItems: 0 },
        workspaceDebt: {
          beforeReconciliation: workspaceDebtBefore,
          afterReconciliation: workspaceDebtAfterReconciliation,
          reconciliationChanges: reconciliationDebtDelta,
          afterSmoke: workspaceDebtAfter,
          newlyIntroducedDuringSmoke: newDebt,
          releaseDebtClassification: Object.values(newDebt).some((value) => value > 0)
            ? 'NEW REGRESSION CAUSED BY RELEASE'
            : 'PRE-EXISTING PROD DEBT (unchanged during smoke)',
          unchangedInheritedDebtIsInformational: true,
        },
      }, null, 2));
      throw new Error(`No current profile-v6 queue item was eligible; ${supersededQueueRows} stale row(s) were superseded and no provider call was made.`);
    }

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
    const [readModels, workspaceDebtAfter] = await Promise.all([
      readReadModelCounts(pool, context, jobVersionIds),
      readWorkspaceDebtCounts(pool, context),
    ]);
    const newlyIntroducedDebt = newlyIntroducedStagingDebt(workspaceDebtAfterReconciliation, workspaceDebtAfter);
    const hasNewWorkspaceDebt = Object.values(newlyIntroducedDebt).some((value) => value > 0);
    console.log(JSON.stringify({
      evaluation: {
        completed: countValue(status.completed),
        supersededDuringSmoke: countValue(status.superseded),
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
        workspaceTechnicalErrors: countValue(readModels.technical_errors),
        smokeCohortTechnicalErrors: countValue(readModels.cohort_technical_errors),
        summaryApplyNow: countValue(readModels.summary_apply_now),
        viewApplyNow: countValue(readModels.view_apply_now),
        summaryTrack: countValue(readModels.summary_track),
        viewTrack: countValue(readModels.view_track),
        summaryTopTen: countValue(readModels.summary_top_ten),
        viewTopTen: countValue(readModels.view_top_ten),
      },
      workspaceDebt: {
        beforeReconciliation: workspaceDebtBefore,
        afterReconciliation: workspaceDebtAfterReconciliation,
        reconciliationChanges: reconciliationDebtDelta,
        afterSmoke: workspaceDebtAfter,
        newlyIntroducedDuringSmoke: newlyIntroducedDebt,
        releaseDebtClassification: hasNewWorkspaceDebt
          ? 'NEW REGRESSION CAUSED BY RELEASE'
          : 'PRE-EXISTING PROD DEBT (unchanged during smoke)',
        unchangedInheritedDebtIsInformational: true,
      },
    }, null, 2));

    if (
      countValue(status.completed) === 0 ||
      countValue(status.completed) + countValue(status.superseded) !== queueIds.length ||
      countValue(readModels.cohort_technical_errors) > 0 ||
      countValue(readModels.summary_apply_now) !== countValue(readModels.view_apply_now) ||
      countValue(readModels.summary_track) !== countValue(readModels.view_track) ||
      countValue(readModels.summary_top_ten) !== countValue(readModels.view_top_ten) ||
      countValue(status.retry_wait) > 0 ||
      countValue(status.failed) > 0 ||
      countValue(status.needs_manual_review) > 0 ||
      countValue(status.pending) > 0 ||
      countValue(status.evaluating) > 0 ||
      hasNewWorkspaceDebt
    ) {
      throw new Error('Bounded staging evaluation smoke did not drain without new release-lineage failures.');
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
