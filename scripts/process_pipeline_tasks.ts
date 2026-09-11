import pg from "pg";
import dotenv from "dotenv";
import { isPooledPostgresConnectionString, pgConnectionConfig } from "../src/db/pgSsl.js";
import {
  PipelineWorkerCancelledError,
  parsePipelineTaskTypes,
  runPipelineStageTaskWorker,
} from "../src/tasks/stageTaskWorker.js";

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

  const taskTypes = parsePipelineTaskTypes(process.env.PIPELINE_TASK_WORKER_TASK_TYPES);
  // Quoted requirements are optional enrichment. Keep a quote-only drain from
  // monopolizing the mandatory pipeline worker lock while preserving a single
  // quote worker for idempotent enrichment.
  const lockId = taskTypes.length === 1 && taskTypes[0] === "EXTRACT_QUOTED_REQUIREMENTS" ? 1002 : LOCK_ID;
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
      taskTypes,
      seed: parseBooleanEnv("PIPELINE_TASK_WORKER_SEED", true),
      includeRoutingDeferred: parseBooleanEnv("PIPELINE_TASK_WORKER_INCLUDE_ROUTING_DEFERRED", false),
      routingDeferredReplayVersion: process.env.PIPELINE_TASK_WORKER_ROUTING_DEFERRED_REPLAY_VERSION || "routing_deferred_replay_v1",
      maxTasks: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_TASKS", 100, 1000),
      claimBatchSize: parsePositiveIntEnv("PIPELINE_TASK_WORKER_CLAIM_BATCH_SIZE", 1, 25),
      leaseSeconds: parsePositiveIntEnv("PIPELINE_TASK_WORKER_LEASE_SECONDS", 300, 3600),
      heartbeatSeconds: parsePositiveIntEnv("PIPELINE_TASK_WORKER_HEARTBEAT_SECONDS", 60, 600),
      wallClockMs: parsePositiveIntEnv("PIPELINE_TASK_WORKER_WALL_CLOCK_MS", 55 * 60 * 1000, 23 * 60 * 60 * 1000),
      maxSeedPerType: parsePositiveIntEnv("PIPELINE_TASK_WORKER_MAX_SEED_PER_TYPE", 500, 5000),
      claimedBy: process.env.PIPELINE_TASK_WORKER_CLAIMED_BY || `gha-stage-worker:${process.pid}`,
      abortSignal: shutdownController.signal,
    });

    console.log("Pipeline task worker summary:", JSON.stringify(summary, null, 2));

    if (shutdownController.signal.aborted) {
      throw new PipelineWorkerCancelledError(
        `Pipeline task worker cancelled by ${shutdownSignal || "shutdown signal"}.`
      );
    }

    const failOnRetryWait = parseBooleanEnv("PIPELINE_TASK_WORKER_EXIT_ON_RETRY_WAIT", true);
    if (summary.deadLettered > 0) {
      throw new Error(`Pipeline task worker dead-lettered ${summary.deadLettered} task(s).`);
    }
    if (failOnRetryWait && summary.failed > 0) {
      throw new Error(
        `Pipeline task worker moved ${summary.failed} task(s) to RETRY_WAIT. See task errors above.`
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
