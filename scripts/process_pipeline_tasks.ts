import { appendFile, writeFile } from "node:fs/promises";
import pg from "pg";
import dotenv from "dotenv";
import { isPooledPostgresConnectionString, pgConnectionConfig } from "../src/db/pgSsl.js";
import {
  PipelineWorkerCancelledError,
  parsePipelineStageTaskLimits,
  parsePipelineTaskTypes,
  runPipelineStageTaskWorker,
} from "../src/tasks/stageTaskWorker.js";
import type { PipelineTaskReconciliationSummary } from "../src/tasks/pipelineTaskCurrentness.js";
import { enforcePipelineWorkerExitPolicy } from "../src/tasks/pipelineWorkerExitPolicy.js";
import {
  DEAD_LETTER_CLASSIFICATION_SQL,
  DEAD_LETTER_LINEAGE_JOINS_SQL,
  readDeadLetterTaskHealth,
  reconcileStaleSupersededEmbeddingDeadLetters,
} from "../src/tasks/deadLetterPolicy.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../src/workspace/context.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const LOCK_ID = 1001;
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const lockDatabaseUrl = String(process.env.DATABASE_URL_UNPOOLED || databaseUrl).trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the pipeline worker.");
}
if (isPooledPostgresConnectionString(lockDatabaseUrl)) {
  throw new Error(
    "Pipeline worker requires a direct/unpooled DATABASE_URL_UNPOOLED for its singleton advisory lock; pooled DATABASE_URL is reserved for task traffic."
  );
}

const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
const lockPool = new pg.Pool(pgConnectionConfig(lockDatabaseUrl));
const shutdownController = new AbortController();
let shutdownSignal: NodeJS.Signals | null = null;
let forcedShutdownTimer: NodeJS.Timeout | null = null;

function parsePositiveIntEnv(name: string, fallback: number, max?: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

function parseUuidListEnv(name: string): string[] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const values = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invalid = values.filter((value) => !uuidPattern.test(value));
  if (invalid.length > 0) throw new Error(`${name} contains invalid UUID value(s).`);
  return values;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function pipelineStageStartOffset(taskTypeCount: number): number {
  if (taskTypeCount <= 0) return 0;
  const configuredOffset = process.env.PIPELINE_TASK_WORKER_STAGE_START_OFFSET?.trim();
  if (configuredOffset) {
    const parsedOffset = Number.parseInt(configuredOffset, 10);
    return Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset % taskTypeCount : 0;
  }

  const runId = Number.parseInt(process.env.GITHUB_RUN_ID ?? "0", 10);
  const runAttempt = Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? "1", 10);
  const runOffset = Number.isFinite(runId) && runId >= 0 ? runId : 0;
  const attemptOffset = Number.isFinite(runAttempt) && runAttempt > 1 ? runAttempt - 1 : 0;
  return (runOffset + attemptOffset) % taskTypeCount;
}

interface QueueHealthRow {
  task_type: string;
  status: string;
  task_count: number;
  oldest_age_seconds: number | null;
}

interface QueueHealth {
  pending: number;
  retryWait: number;
  blockedDependency: number;
  deadLetter: number;
  actionableCurrentDeadLetter: number;
  staleHistoricalDeadLetter: number;
  oldestPendingAgeSeconds: number;
  oldestRetryWaitAgeSeconds: number;
  byType: QueueHealthRow[];
}

interface PipelineDeadLetterHealthReport {
  actionableDeadLetters: number | null;
  staleHistoricalDeadLetters: number | null;
  newlyDeadLetteredThisRun: number | null;
  staleHistoricalDeadLettersReconciled: number;
  staleHistoricalDeadLettersRemaining: number | null;
  reportGeneratedAt: string;
  error: string | null;
}

interface PipelineTaskReconciliationReport {
  stalePendingReconciliation: PipelineTaskReconciliationSummary | null;
  stalePendingReconciledThisRun: number;
  deferredByBudget: number;
  byReason: Record<string, number> | null;
  byTaskType: Record<string, number> | null;
  tasksCompletedThisRun: number;
  successorTasksCreatedThisRun: number;
  activePendingBefore: number | null;
  activePendingAfter: number | null;
  netActivePendingDelta: number | null;
  oldestActivePendingAgeSecondsBefore: number | null;
  oldestActivePendingAgeSecondsAfter: number | null;
  reportGeneratedAt: string;
  error: string | null;
}

interface QueueHealthScope {
  taskTypes: readonly string[];
  jobVersionIds?: readonly string[];
  observationIds?: readonly string[];
}

function scopedTaskTargetClause(jobVersionParam: number, observationParam: number): string {
  return `AND (
    ($${jobVersionParam}::text[] IS NULL AND $${observationParam}::text[] IS NULL)
    OR task.payload->>'job_version_id' = ANY(COALESCE($${jobVersionParam}::text[], ARRAY[]::text[]))
    OR task.payload->>'observation_id' = ANY(COALESCE($${observationParam}::text[], ARRAY[]::text[]))
    OR EXISTS (
      SELECT 1
      FROM raw_job_observations AS scoped_observation
      WHERE scoped_observation.workspace_id = task.workspace_id
        AND scoped_observation.id::text = task.payload->>'observation_id'
        AND scoped_observation.job_version_id::text = ANY(COALESCE($${jobVersionParam}::text[], ARRAY[]::text[]))
    )
    OR EXISTS (
      SELECT 1
      FROM raw_job_observations AS scoped_child
      WHERE scoped_child.workspace_id = task.workspace_id
        AND scoped_child.id::text = task.payload->>'observation_id'
        AND scoped_child.derived_from_observation_id::text = ANY(COALESCE($${observationParam}::text[], ARRAY[]::text[]))
    )
    OR EXISTS (
      SELECT 1
      FROM raw_job_observations AS scoped_parent
      WHERE scoped_parent.workspace_id = task.workspace_id
        AND scoped_parent.id::text = ANY(COALESCE($${observationParam}::text[], ARRAY[]::text[]))
        AND scoped_parent.job_version_id::text = task.payload->>'job_version_id'
    )
  )`;
}

async function readQueueHealth(
  pool: pg.Pool,
  workspaceId: string,
  scope?: QueueHealthScope,
): Promise<QueueHealth> {
  const client = await pool.connect();
  try {
    if (scope) {
      const jobVersionIds = scope.jobVersionIds ?? null;
      const observationIds = scope.observationIds ?? null;
      const params = [workspaceId, [...scope.taskTypes], jobVersionIds, observationIds];
      const targetClause = scopedTaskTargetClause(3, 4);
      const queueResult = await client.query<QueueHealthRow>(
        `SELECT task.task_type,
                task.status,
                COUNT(*)::INTEGER AS task_count,
                EXTRACT(EPOCH FROM NOW() - MIN(task.created_at))::INTEGER AS oldest_age_seconds
         FROM pipeline_tasks AS task
         WHERE task.workspace_id = $1
           AND task.task_type = ANY($2::text[])
           AND task.status IN ('PENDING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
           ${targetClause}
         GROUP BY task.task_type, task.status
         ORDER BY task.task_type, task.status`,
        params,
      );
      const deadLetterResult = await client.query<{
        task_type: string;
        actionable_dead_letter_count: number;
        stale_historical_dead_letter_count: number;
      }>(
        `SELECT task.task_type,
                COUNT(*) FILTER (
                  WHERE (${DEAD_LETTER_CLASSIFICATION_SQL}) = 'ACTIONABLE_CURRENT'
                )::INTEGER AS actionable_dead_letter_count,
                COUNT(*) FILTER (
                  WHERE (${DEAD_LETTER_CLASSIFICATION_SQL}) = 'STALE_HISTORICAL'
                )::INTEGER AS stale_historical_dead_letter_count
         FROM pipeline_tasks AS task
         ${DEAD_LETTER_LINEAGE_JOINS_SQL}
         WHERE task.workspace_id = $1
           AND task.task_type = ANY($2::text[])
           AND task.status = 'DEAD_LETTER'
           ${targetClause}
           AND NOT EXISTS (
             SELECT 1
             FROM canonical_jobs AS fixture_job
             LEFT JOIN job_versions AS fixture_version
               ON fixture_version.workspace_id = fixture_job.workspace_id
              AND fixture_version.canonical_job_id = fixture_job.id
             WHERE fixture_job.workspace_id = task.workspace_id
               AND fixture_job.is_test_fixture = TRUE
               AND (
                 task.payload->>'canonical_job_id' = fixture_job.id::TEXT
                 OR task.payload->>'job_version_id' = fixture_version.id::TEXT
               )
           )
         GROUP BY task.task_type
         ORDER BY task.task_type`,
        params,
      );
      const actionableCurrentDeadLetter = deadLetterResult.rows.reduce(
        (total, row) => total + Number(row.actionable_dead_letter_count),
        0,
      );
      const staleHistoricalDeadLetter = deadLetterResult.rows.reduce(
        (total, row) => total + Number(row.stale_historical_dead_letter_count),
        0,
      );
      const byStatus = (status: string) => queueResult.rows
        .filter((row) => row.status === status)
        .reduce((total, row) => total + Number(row.task_count), 0);
      const oldestAge = (status: string) => queueResult.rows
        .filter((row) => row.status === status)
        .reduce((oldest, row) => Math.max(oldest, Number(row.oldest_age_seconds ?? 0)), 0);

      return {
        pending: byStatus("PENDING"),
        retryWait: byStatus("RETRY_WAIT"),
        blockedDependency: byStatus("BLOCKED_DEPENDENCY"),
        deadLetter: actionableCurrentDeadLetter + staleHistoricalDeadLetter,
        actionableCurrentDeadLetter,
        staleHistoricalDeadLetter,
        oldestPendingAgeSeconds: oldestAge("PENDING"),
        oldestRetryWaitAgeSeconds: oldestAge("RETRY_WAIT"),
        byType: queueResult.rows,
      };
    }

    const queueResult = await client.query<QueueHealthRow>(
      `SELECT task_type, status, task_count, oldest_age_seconds
       FROM v_pipeline_task_queue_health
       WHERE workspace_id = $1
       ORDER BY task_type, status`,
      [workspaceId],
    );
    const deadLetterHealth = await readDeadLetterTaskHealth(client, workspaceId);
    const actionableCurrentDeadLetter = deadLetterHealth.reduce(
      (total, row) => total + Number(row.actionable_dead_letter_count),
      0,
    );
    const staleHistoricalDeadLetter = deadLetterHealth.reduce(
      (total, row) => total + Number(row.stale_historical_dead_letter_count),
      0,
    );
    const byStatus = (status: string) => queueResult.rows
      .filter((row) => row.status === status)
      .reduce((total, row) => total + Number(row.task_count), 0);
    const oldestAge = (status: string) => queueResult.rows
      .filter((row) => row.status === status)
      .reduce((oldest, row) => Math.max(oldest, Number(row.oldest_age_seconds ?? 0)), 0);

    return {
      pending: byStatus("PENDING"),
      retryWait: byStatus("RETRY_WAIT"),
      blockedDependency: byStatus("BLOCKED_DEPENDENCY"),
      deadLetter: actionableCurrentDeadLetter + staleHistoricalDeadLetter,
      actionableCurrentDeadLetter,
      staleHistoricalDeadLetter,
      oldestPendingAgeSeconds: oldestAge("PENDING"),
      oldestRetryWaitAgeSeconds: oldestAge("RETRY_WAIT"),
      byType: queueResult.rows,
    };
  } finally {
    client.release();
  }
}

function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownController.signal.aborted) return;

  shutdownSignal = signal;
  const graceMs = parsePositiveIntEnv("PIPELINE_TASK_WORKER_SHUTDOWN_GRACE_MS", 60000, 60000);
  const message = `Pipeline task worker received ${signal}; stopping before claiming more work.`;
  console.warn(message);
  shutdownController.abort(new PipelineWorkerCancelledError(message));

  forcedShutdownTimer = setTimeout(() => {
    console.error(`Pipeline task worker did not stop within ${graceMs}ms after ${signal}; forcing exit.`);
    process.exit(130);
  }, graceMs);
  forcedShutdownTimer.unref?.();
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

export async function processPipelineTasks(): Promise<void> {
  console.log("====================================================");
  console.log("          PROCESS PIPELINE TASK WORKER              ");
  console.log("====================================================");

  const requestedTaskTypes = parsePipelineTaskTypes(process.env.PIPELINE_TASK_WORKER_TASK_TYPES);
  const quotedExplicitlyRequested = requestedTaskTypes.includes("EXTRACT_QUOTED_REQUIREMENTS") &&
    Boolean(process.env.PIPELINE_TASK_WORKER_TASK_TYPES?.trim());
  const includeQuotedRequirements = quotedExplicitlyRequested ||
    parseBooleanEnv("PIPELINE_TASK_WORKER_INCLUDE_QUOTED_REQUIREMENTS", false);
  const taskTypes = includeQuotedRequirements
    ? requestedTaskTypes
    : requestedTaskTypes.filter((taskType) => taskType !== "EXTRACT_QUOTED_REQUIREMENTS");
  // Quoted requirements are optional enrichment. The default worker excludes
  // them; an explicit task-type selection or opt-in environment flag drains
  // them after the mandatory pipeline without holding up routing/matching.
  const lockId = taskTypes.length === 1 && taskTypes[0] === "EXTRACT_QUOTED_REQUIREMENTS" ? 1002 : LOCK_ID;
  const jobVersionIds = parseUuidListEnv("PIPELINE_TASK_WORKER_JOB_VERSION_IDS");
  const observationIds = parseUuidListEnv("PIPELINE_TASK_WORKER_OBSERVATION_IDS");
  const hasExplicitTargetScope = jobVersionIds !== undefined || observationIds !== undefined;
  const queueHealthScope: QueueHealthScope | undefined = hasExplicitTargetScope
    ? { taskTypes, jobVersionIds, observationIds }
    : undefined;

  const checkAiPreflight = parseBooleanEnv("PIPELINE_TASK_WORKER_PREFLIGHT_MODELS", true);
  const requiresExtractionRoute = taskTypes.includes("EXTRACT_QUOTED_REQUIREMENTS");

  let activeTaskTypes = [...taskTypes];

  if (checkAiPreflight && requiresExtractionRoute) {
    const { preflightModelRoutes } = await import("../src/services/agent.js");
    const preflight = await preflightModelRoutes();
    console.log("Model route preflight status:", {
      evaluation: preflight.evaluation,
      extraction: preflight.extraction,
      embedding: preflight.embedding,
      document: preflight.document,
    });
    if (!preflight.extraction) {
      if (activeTaskTypes.length === 1 && activeTaskTypes[0] === "EXTRACT_QUOTED_REQUIREMENTS") {
        throw new Error(
          "Pipeline task worker configured exclusively for EXTRACT_QUOTED_REQUIREMENTS, but extraction model routes are unavailable."
        );
      }
      console.warn(
        "Extraction model routes unavailable; excluding EXTRACT_QUOTED_REQUIREMENTS from active run so deterministic tasks proceed."
      );
      activeTaskTypes = activeTaskTypes.filter((t) => t !== "EXTRACT_QUOTED_REQUIREMENTS");
    }
  }

  const lockClient = await lockPool.connect();
  let lockAcquired = false;
  let workerError: Error | null = null;
  let workspaceId: string | null = null;
  let staleHistoricalDeadLettersReconciled = 0;
  const deadLetterReport: PipelineDeadLetterHealthReport = {
    actionableDeadLetters: null,
    staleHistoricalDeadLetters: null,
    newlyDeadLetteredThisRun: null,
    staleHistoricalDeadLettersReconciled: 0,
    staleHistoricalDeadLettersRemaining: null,
    reportGeneratedAt: "",
    error: null,
  };
  const deadLetterReportPath = process.env.PIPELINE_TASK_WORKER_DEAD_LETTER_REPORT_FILE?.trim()
    || "pipeline-dead-letter-health.json";
  const reconciliationReportPath = process.env.PIPELINE_TASK_WORKER_RECONCILIATION_REPORT_FILE?.trim()
    || "pipeline-task-reconciliation.json";
  const reconciliationReport: PipelineTaskReconciliationReport = {
    stalePendingReconciliation: null,
    stalePendingReconciledThisRun: 0,
    deferredByBudget: 0,
    byReason: null,
    byTaskType: null,
    tasksCompletedThisRun: 0,
    successorTasksCreatedThisRun: 0,
    activePendingBefore: null,
    activePendingAfter: null,
    netActivePendingDelta: null,
    oldestActivePendingAgeSecondsBefore: null,
    oldestActivePendingAgeSecondsAfter: null,
    reportGeneratedAt: "",
    error: null,
  };

  try {
    const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock($1) AS locked`, [lockId]);
    lockAcquired = Boolean(rows[0]?.locked);

    if (!lockAcquired) {
      const lockMessage = "Another pipeline worker already holds the advisory lock; no work was claimed.";
      deadLetterReport.error = lockMessage;
      reconciliationReport.error = lockMessage;
      console.warn("Another pipeline worker is already running. Exiting cleanly.");
      return;
    }

    const contextClient = await pool.connect();
    let context: WorkspaceContext;
    try {
      context = await resolveWorkspaceContext(contextClient);
      workspaceId = context.workspaceId;
    } finally {
      contextClient.release();
    }

    if (lockId === LOCK_ID && !hasExplicitTargetScope) {
      const reconciliationClient = await pool.connect();
      try {
        staleHistoricalDeadLettersReconciled = await reconcileStaleSupersededEmbeddingDeadLetters(
          reconciliationClient,
          context.workspaceId,
        );
      } finally {
        reconciliationClient.release();
      }
      console.log("Stale historical embedding dead letters reconciled:", staleHistoricalDeadLettersReconciled);
    }

    const queueHealthBefore = await readQueueHealth(pool, context.workspaceId, queueHealthScope);
    const activeQueueRowsBefore = queueHealthBefore.byType.filter(
      (row) => activeTaskTypes.includes(row.task_type as typeof activeTaskTypes[number]),
    );
    const activePendingBefore = activeQueueRowsBefore
      .filter((row) => row.status === "PENDING")
      .reduce((total, row) => total + Number(row.task_count), 0);
    const oldestActivePendingAgeBefore = activeQueueRowsBefore
      .filter((row) => row.status === "PENDING")
      .reduce((oldest, row) => Math.max(oldest, Number(row.oldest_age_seconds ?? 0)), 0);
    reconciliationReport.activePendingBefore = activePendingBefore;
    reconciliationReport.oldestActivePendingAgeSecondsBefore = oldestActivePendingAgeBefore;
    const stageStartOffset = pipelineStageStartOffset(activeTaskTypes.length);
    console.log("Pipeline stage start offset:", stageStartOffset);
    const summary = await runPipelineStageTaskWorker(pool, {
      taskTypes: activeTaskTypes,
      jobVersionIds,
      observationIds,
      stageStartOffset,
      seed: parseBooleanEnv("PIPELINE_TASK_WORKER_SEED", true),
      includeRoutingDeferred: parseBooleanEnv("PIPELINE_TASK_WORKER_INCLUDE_ROUTING_DEFERRED", true),
      includeTestFixtures: parseBooleanEnv("PIPELINE_TASK_WORKER_INCLUDE_TEST_FIXTURES", false),
      routingDeferredReplayVersion: process.env.PIPELINE_TASK_WORKER_ROUTING_DEFERRED_REPLAY_VERSION || "routing_deferred_replay_v1",
      maxTasks: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_TASKS", 100, 10000),
      maxTasksByType: parsePipelineStageTaskLimits(process.env.PIPELINE_TASK_WORKER_STAGE_MAX_TASKS),
      stageQuantum: parsePositiveIntEnv("PIPELINE_TASK_WORKER_STAGE_QUANTUM", 1, 100),
      maxStalePendingReconciliation: parsePositiveIntEnv("PIPELINE_TASK_WORKER_STALE_PENDING_RECONCILIATION_LIMIT", 100, 1000),
      stalePendingReconciliationTimeBudgetMs: parsePositiveIntEnv("PIPELINE_TASK_WORKER_STALE_PENDING_RECONCILIATION_BUDGET_MS", 10000, 60000),
      claimBatchSize: parsePositiveIntEnv("PIPELINE_TASK_WORKER_CLAIM_BATCH_SIZE", 1, 25),
      leaseSeconds: parsePositiveIntEnv("PIPELINE_TASK_WORKER_LEASE_SECONDS", 300, 3600),
      heartbeatSeconds: parsePositiveIntEnv("PIPELINE_TASK_WORKER_HEARTBEAT_SECONDS", 60, 600),
      wallClockMs: parsePositiveIntEnv("PIPELINE_TASK_WORKER_WALL_CLOCK_MS", 10 * 60 * 1000, 23 * 60 * 60 * 1000),
      minTimeToStartTaskMs: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MIN_TIME_TO_START_TASK_MS", 120000, 600000),
      maxSeedPerType: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE", 200, 1000),
      seedTimeBudgetMs: parsePositiveIntEnv("PIPELINE_TASK_WORKER_SEED_BUDGET_MS", 15_000, 60_000),
      claimedBy: process.env.PIPELINE_TASK_WORKER_CLAIMED_BY || `gha-stage-worker:${process.pid}`,
      abortSignal: shutdownController.signal,
    });

    reconciliationReport.stalePendingReconciliation = summary.stalePendingReconciliation;
    reconciliationReport.stalePendingReconciledThisRun = summary.stalePendingReconciliation.stalePendingReconciledThisRun;
    reconciliationReport.deferredByBudget = summary.stalePendingReconciliation.deferredByBudget;
    reconciliationReport.byReason = summary.stalePendingReconciliation.byReason;
    reconciliationReport.byTaskType = summary.stalePendingReconciliation.byTaskType;
    reconciliationReport.tasksCompletedThisRun = summary.completed;
    reconciliationReport.successorTasksCreatedThisRun = summary.successorTasksCreated;
    console.log("Pipeline task worker summary:", JSON.stringify(summary, null, 2));
    const workflowOutputPath = process.env.GITHUB_OUTPUT?.trim();
    if (workflowOutputPath) {
      await appendFile(workflowOutputPath, [
        `dead_lettered_this_run=${summary.deadLettered}`,
        `tasks_completed_this_run=${summary.completed}`,
        `successor_tasks_created_this_run=${summary.successorTasksCreated}`,
        `stale_pending_reconciled=${summary.stalePendingReconciliation.reconciled}`,
        `stale_pending_reconciled_this_run=${summary.stalePendingReconciliation.stalePendingReconciledThisRun}`,
        `stale_pending_unresolved=${summary.stalePendingReconciliation.unresolved}`,
        `stale_pending_deferred_by_budget=${summary.stalePendingReconciliation.deferredByBudget}`,
      ].join("\n") + "\n", "utf8");
    }

    const queueHealth = await readQueueHealth(pool, context.workspaceId, queueHealthScope);
    deadLetterReport.actionableDeadLetters = queueHealth.actionableCurrentDeadLetter;
    deadLetterReport.staleHistoricalDeadLetters = queueHealth.staleHistoricalDeadLetter;
    deadLetterReport.newlyDeadLetteredThisRun = summary.deadLettered;
    deadLetterReport.staleHistoricalDeadLettersReconciled = staleHistoricalDeadLettersReconciled;
    deadLetterReport.staleHistoricalDeadLettersRemaining = queueHealth.staleHistoricalDeadLetter;
    const activeQueueRows = queueHealth.byType.filter((row) => activeTaskTypes.includes(row.task_type as typeof activeTaskTypes[number]));
    const activePending = activeQueueRows
      .filter((row) => row.status === "PENDING")
      .reduce((total, row) => total + Number(row.task_count), 0);
    const oldestActivePendingAgeSeconds = activeQueueRows
      .filter((row) => row.status === "PENDING")
      .reduce((oldest, row) => Math.max(oldest, Number(row.oldest_age_seconds ?? 0)), 0);
    reconciliationReport.activePendingAfter = activePending;
    reconciliationReport.netActivePendingDelta = activePending - activePendingBefore;
    reconciliationReport.oldestActivePendingAgeSecondsAfter = oldestActivePendingAgeSeconds;
    if (workflowOutputPath) {
      await appendFile(workflowOutputPath, [
        `active_pending_before=${activePendingBefore}`,
        `active_pending_after=${activePending}`,
        `net_active_pending_delta=${activePending - activePendingBefore}`,
        `oldest_active_pending_age_seconds_before=${oldestActivePendingAgeBefore}`,
        `oldest_active_pending_age_seconds_after=${oldestActivePendingAgeSeconds}`,
      ].join("\n") + "\n", "utf8");
    }
    console.log("Pipeline task queue health:", JSON.stringify(queueHealth, null, 2));
    console.log("Pipeline task dead-letter health report:", JSON.stringify(deadLetterReport, null, 2));
    console.log("Pipeline bounded-run result:", JSON.stringify({
      exit_reason: summary.exitReason,
      claimed: summary.claimed,
      completed: summary.completed,
      failed: summary.failed,
      dead_lettered_this_run: summary.deadLettered,
      actionable_current_dead_letters: queueHealth.actionableCurrentDeadLetter,
      stale_historical_dead_letters: queueHealth.staleHistoricalDeadLetter,
      total_dead_letters: queueHealth.deadLetter,
      active_pending_before: activePendingBefore,
      active_pending_after: activePending,
      net_active_pending_delta: activePending - activePendingBefore,
      oldest_active_pending_age_seconds_before: oldestActivePendingAgeBefore,
      oldest_active_pending_age_seconds_after: oldestActivePendingAgeSeconds,
      tasks_completed_this_run: summary.completed,
      successor_tasks_created_this_run: summary.successorTasksCreated,
      stale_pending_reconciled: summary.stalePendingReconciliation.reconciled,
      stale_pending_reconciled_this_run: summary.stalePendingReconciliation.stalePendingReconciledThisRun,
      stale_pending_unresolved: summary.stalePendingReconciliation.unresolved,
      stale_pending_deferred_by_budget: summary.stalePendingReconciliation.deferredByBudget,
      task_reconciliation_decisions: summary.stalePendingReconciliation.decisions,
      stale_pending_by_reason: summary.stalePendingReconciliation.byReason,
      stale_pending_by_task_type: summary.stalePendingReconciliation.byTaskType,
      seed_deferred_by_budget: summary.seeded?.deferredByBudget ?? 0,
      seed_time_budget_exceeded: summary.seeded?.timeBudgetExceeded ?? false,
      remaining_pending: queueHealth.pending,
      duration_ms: summary.durationMs,
    }, null, 2));
    if (queueHealth.retryWait > 0) {
      console.warn(`Pipeline has ${queueHealth.retryWait} RETRY_WAIT task(s); automatic recovery remains scheduled.`);
    }
    if (queueHealth.blockedDependency > 0) {
      console.warn(`Pipeline has ${queueHealth.blockedDependency} BLOCKED_DEPENDENCY task(s) awaiting repair artifacts.`);
    }
    if (queueHealth.staleHistoricalDeadLetter > 0) {
      console.warn(
        `Pipeline retains ${queueHealth.staleHistoricalDeadLetter} auditable superseded-version dead-letter task(s); these do not block the worker.`,
      );
    }
    if (queueHealth.actionableCurrentDeadLetter > 0) {
      console.error(
        `Pipeline has ${queueHealth.actionableCurrentDeadLetter} actionable current dead-letter task(s).`,
      );
    }

    console.log("Pipeline active pending progress:", JSON.stringify({
      active_pending_before: activePendingBefore,
      active_pending_after: activePending,
      oldest_active_pending_age_seconds_before: oldestActivePendingAgeBefore,
      oldest_active_pending_age_seconds_after: oldestActivePendingAgeSeconds,
    }));
    const maxRetryWaitCount = parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_RETRY_WAIT_COUNT", 500, 100000);
    const maxRetryWaitAgeSeconds = parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_RETRY_WAIT_AGE_SECONDS", 21600, 604800);
    const maxPendingAgeSeconds = parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_PENDING_AGE_SECONDS", 7200, 604800);
    const noProgressPendingThreshold = parsePositiveIntEnv(
      "PIPELINE_TASK_WORKER_NO_FORWARD_PROGRESS_PENDING_THRESHOLD",
      1,
      100000,
    );
    const failOnRetryWait = parseBooleanEnv("PIPELINE_TASK_WORKER_EXIT_ON_RETRY_WAIT", true);
    enforcePipelineWorkerExitPolicy({
      claimedThisRun: summary.claimed,
      completedThisRun: summary.completed,
      failedThisRun: summary.failed,
      exitReason: summary.exitReason,
      deadLetteredThisRun: summary.deadLettered,
      actionableCurrentDeadLetterCount: queueHealth.actionableCurrentDeadLetter,
      staleHistoricalDeadLetterCount: queueHealth.staleHistoricalDeadLetter,
      retryWaitCount: queueHealth.retryWait,
      oldestRetryWaitAgeSeconds: queueHealth.oldestRetryWaitAgeSeconds,
      activePendingCountBefore: activePendingBefore,
      activePendingCount: activePending,
      oldestActivePendingAgeSecondsBefore: oldestActivePendingAgeBefore,
      oldestActivePendingAgeSeconds,
      failOnRetryWait,
      maxRetryWaitCount,
      maxRetryWaitAgeSeconds,
      maxPendingAgeSeconds,
      noProgressPendingThreshold,
    });

    if (shutdownController.signal.aborted) {
      throw new PipelineWorkerCancelledError(
        `Pipeline task worker cancelled by ${shutdownSignal || "shutdown signal"}.`
      );
    }

  } catch (err: any) {
    workerError = err instanceof Error ? err : new Error(String(err));
    console.error("Pipeline task worker failed:", workerError.message);
  } finally {
    if (deadLetterReport.actionableDeadLetters === null && workspaceId !== null) {
      try {
        const queueHealth = await readQueueHealth(pool, workspaceId, queueHealthScope);
        deadLetterReport.actionableDeadLetters = queueHealth.actionableCurrentDeadLetter;
        deadLetterReport.staleHistoricalDeadLettersRemaining = queueHealth.staleHistoricalDeadLetter;
        deadLetterReport.staleHistoricalDeadLetters = queueHealth.staleHistoricalDeadLetter;
      } catch (error: unknown) {
        deadLetterReport.error = error instanceof Error ? error.message : String(error);
      }
    }
    deadLetterReport.staleHistoricalDeadLettersReconciled = staleHistoricalDeadLettersReconciled;
    deadLetterReport.staleHistoricalDeadLetters ??= staleHistoricalDeadLettersReconciled;
    deadLetterReport.reportGeneratedAt = new Date().toISOString();
    deadLetterReport.error ??= workerError?.message ?? null;
    try {
      await writeFile(deadLetterReportPath, `${JSON.stringify(deadLetterReport, null, 2)}\n`, "utf8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to write pipeline dead-letter health report:", message);
      workerError ??= new Error(`Could not write pipeline dead-letter health report: ${message}`);
    }
    reconciliationReport.reportGeneratedAt = new Date().toISOString();
    reconciliationReport.error ??= workerError?.message ?? null;
    const reconciliationArtifact = {
      stale_pending_reconciliation: reconciliationReport.stalePendingReconciliation,
      stale_pending_reconciled_this_run: reconciliationReport.stalePendingReconciledThisRun,
      stale_pending_deferred_by_budget: reconciliationReport.deferredByBudget,
      by_reason: reconciliationReport.byReason,
      by_task_type: reconciliationReport.byTaskType,
      tasks_completed_this_run: reconciliationReport.tasksCompletedThisRun,
      successor_tasks_created_this_run: reconciliationReport.successorTasksCreatedThisRun,
      active_pending_before: reconciliationReport.activePendingBefore,
      active_pending_after: reconciliationReport.activePendingAfter,
      net_active_pending_delta: reconciliationReport.netActivePendingDelta,
      oldest_active_pending_age_seconds_before: reconciliationReport.oldestActivePendingAgeSecondsBefore,
      oldest_active_pending_age_seconds_after: reconciliationReport.oldestActivePendingAgeSecondsAfter,
      report_generated_at: reconciliationReport.reportGeneratedAt,
      error: reconciliationReport.error,
    };
    try {
      await writeFile(reconciliationReportPath, `${JSON.stringify(reconciliationArtifact, null, 2)}\n`, "utf8");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Failed to write pipeline task reconciliation report:", message);
      workerError ??= new Error(`Could not write pipeline task reconciliation report: ${message}`);
    }
    if (forcedShutdownTimer) {
      clearTimeout(forcedShutdownTimer);
      forcedShutdownTimer = null;
    }
    if (lockAcquired) {
      await lockClient.query(`SELECT pg_advisory_unlock($1)`, [lockId]).catch(() => {});
    }
    lockClient.release();
    await pool.end();
    await lockPool.end();
  }

  if (workerError) {
    process.exitCode = workerError instanceof PipelineWorkerCancelledError ? 130 : 1;
    throw workerError;
  }
}

if (process.argv[1] && process.argv[1].includes("process_pipeline_tasks")) {
  processPipelineTasks().catch(() => {
    process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : 1);
  });
}
