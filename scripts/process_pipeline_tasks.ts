import pg from "pg";
import dotenv from "dotenv";
import { isPooledPostgresConnectionString, pgConnectionConfig } from "../src/db/pgSsl.js";
import {
  PipelineWorkerCancelledError,
  parsePipelineStageTaskLimits,
  parsePipelineTaskTypes,
  runPipelineStageTaskWorker,
} from "../src/tasks/stageTaskWorker.js";
import { enforcePipelineWorkerExitPolicy } from "../src/tasks/pipelineWorkerExitPolicy.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";

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

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
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
  oldestPendingAgeSeconds: number;
  oldestRetryWaitAgeSeconds: number;
  byType: QueueHealthRow[];
}

async function readQueueHealth(pool: pg.Pool): Promise<QueueHealth> {
  // The pool exposes the query surface required by the workspace resolver.
  const ctx = await resolveWorkspaceContext(pool as unknown as pg.PoolClient);
  const result = await pool.query<QueueHealthRow>(
    `SELECT task_type, status, task_count, oldest_age_seconds
     FROM v_pipeline_task_queue_health
     WHERE workspace_id = $1
     ORDER BY task_type, status`,
    [ctx.workspaceId],
  );
  const byStatus = (status: string) => result.rows
    .filter((row) => row.status === status)
    .reduce((total, row) => total + Number(row.task_count), 0);
  const oldestAge = (status: string) => result.rows
    .filter((row) => row.status === status)
    .reduce((oldest, row) => Math.max(oldest, Number(row.oldest_age_seconds ?? 0)), 0);

  return {
    pending: byStatus("PENDING"),
    retryWait: byStatus("RETRY_WAIT"),
    blockedDependency: byStatus("BLOCKED_DEPENDENCY"),
    deadLetter: byStatus("DEAD_LETTER"),
    oldestPendingAgeSeconds: oldestAge("PENDING"),
    oldestRetryWaitAgeSeconds: oldestAge("RETRY_WAIT"),
    byType: result.rows,
  };
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

  try {
    const { rows } = await lockClient.query(`SELECT pg_try_advisory_lock($1) AS locked`, [lockId]);
    lockAcquired = Boolean(rows[0]?.locked);

    if (!lockAcquired) {
      console.warn("Another pipeline worker is already running. Exiting cleanly.");
      return;
    }

    const summary = await runPipelineStageTaskWorker(pool, {
      taskTypes: activeTaskTypes,
      seed: parseBooleanEnv("PIPELINE_TASK_WORKER_SEED", true),
      includeRoutingDeferred: parseBooleanEnv("PIPELINE_TASK_WORKER_INCLUDE_ROUTING_DEFERRED", true),
      includeTestFixtures: parseBooleanEnv("PIPELINE_TASK_WORKER_INCLUDE_TEST_FIXTURES", false),
      routingDeferredReplayVersion: process.env.PIPELINE_TASK_WORKER_ROUTING_DEFERRED_REPLAY_VERSION || "routing_deferred_replay_v1",
      maxTasks: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_TASKS", 100, 10000),
      maxTasksByType: parsePipelineStageTaskLimits(process.env.PIPELINE_TASK_WORKER_STAGE_MAX_TASKS),
      claimBatchSize: parsePositiveIntEnv("PIPELINE_TASK_WORKER_CLAIM_BATCH_SIZE", 1, 25),
      leaseSeconds: parsePositiveIntEnv("PIPELINE_TASK_WORKER_LEASE_SECONDS", 300, 3600),
      heartbeatSeconds: parsePositiveIntEnv("PIPELINE_TASK_WORKER_HEARTBEAT_SECONDS", 60, 600),
      wallClockMs: parsePositiveIntEnv("PIPELINE_TASK_WORKER_WALL_CLOCK_MS", 10 * 60 * 1000, 23 * 60 * 60 * 1000),
      minTimeToStartTaskMs: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MIN_TIME_TO_START_TASK_MS", 120000, 600000),
      maxSeedPerType: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE", 500, 5000),
      claimedBy: process.env.PIPELINE_TASK_WORKER_CLAIMED_BY || `gha-stage-worker:${process.pid}`,
      abortSignal: shutdownController.signal,
    });

    console.log("Pipeline task worker summary:", JSON.stringify(summary, null, 2));

    const queueHealth = await readQueueHealth(pool);
    console.log("Pipeline task queue health:", JSON.stringify(queueHealth, null, 2));
    console.log("Pipeline bounded-run result:", JSON.stringify({
      exit_reason: summary.exitReason,
      claimed: summary.claimed,
      completed: summary.completed,
      failed: summary.failed,
      dead_lettered: summary.deadLettered,
      remaining_pending: queueHealth.pending,
      duration_ms: summary.durationMs,
    }, null, 2));
    if (queueHealth.retryWait > 0) {
      console.warn(`Pipeline has ${queueHealth.retryWait} RETRY_WAIT task(s); automatic recovery remains scheduled.`);
    }
    if (queueHealth.blockedDependency > 0) {
      console.warn(`Pipeline has ${queueHealth.blockedDependency} BLOCKED_DEPENDENCY task(s) awaiting repair artifacts.`);
    }

    const activeQueueRows = queueHealth.byType.filter((row) => activeTaskTypes.includes(row.task_type as typeof activeTaskTypes[number]));
    const activePending = activeQueueRows
      .filter((row) => row.status === "PENDING")
      .reduce((total, row) => total + Number(row.task_count), 0);
    const oldestActivePendingAgeSeconds = activeQueueRows
      .filter((row) => row.status === "PENDING")
      .reduce((oldest, row) => Math.max(oldest, Number(row.oldest_age_seconds ?? 0)), 0);
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
      failedThisRun: summary.failed,
      exitReason: summary.exitReason,
      deadLetteredThisRun: summary.deadLettered,
      deadLetterCount: queueHealth.deadLetter,
      retryWaitCount: queueHealth.retryWait,
      oldestRetryWaitAgeSeconds: queueHealth.oldestRetryWaitAgeSeconds,
      activePendingCount: activePending,
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
