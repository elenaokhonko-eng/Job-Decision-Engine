import pg from "pg";
import dotenv from "dotenv";

import { isPooledPostgresConnectionString, pgConnectionConfig } from "../src/db/pgSsl.js";
import { isCurrentReadyApplicationReadiness, loadCurrentApplicationReadiness } from "../src/services/currentApplicationReadiness.js";
import { readDeadLetterTaskHealth } from "../src/tasks/deadLetterPolicy.js";
import { enforcePipelineWorkerExitPolicy } from "../src/tasks/pipelineWorkerExitPolicy.js";
import type { PipelineStageTaskType, PipelineStageWorkerOptions, PipelineStageWorkerSummary } from "../src/tasks/stageTaskWorker.js";
import { resolveWorkspaceContext } from "../src/workspace/context.js";
import type { WorkspaceContext } from "../src/workspace/context.js";
import type { SourceEvidenceRefreshResult } from "../src/ingestion/sourceEvidenceRefresh.js";
import { AshbyAdapter } from "../src/ingestion/adapters/ashbyAdapter.js";
import { GreenhouseAdapter } from "../src/ingestion/adapters/greenhouseAdapter.js";
import { LeverAdapter } from "../src/ingestion/adapters/leverAdapter.js";
import type { EvaluateQueueOptions } from "./evaluate_queue.js";
import type { EvaluationQueueStats } from "../src/pipeline/evaluationQueuePolicy.js";
import type { BaseSourceAdapter } from "../src/ingestion/adapters/baseAdapter.js";


dotenv.config();
dotenv.config({ path: ".env.local" });

const PIPELINE_WORKER_LOCK_ID = 1001;
const PILOT_TASK_TYPES: PipelineStageTaskType[] = [
  "NORMALIZE_OBSERVATION",
  "EXTRACT_DETERMINISTIC_REQUIREMENTS",
  "APPLY_HARD_GATES",
  "PUBLISH_EMBEDDING",
  "ROUTE_LANE",
  "MATCH_PROFILE_EVIDENCE",
  "DECIDE_RECOMMENDATION",
  "ENQUEUE_EXPLANATION",
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ScopedPilotArgs {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
}

export interface ScopedPilotReport {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly title: string;
  readonly company: string;
  readonly sourcePluginKey: string;
  readonly preferenceRevisionId: string | null;
  readonly sourceRefresh: SourceEvidenceRefreshResult;
  readonly worker: PipelineStageWorkerSummary | null;
  readonly evaluation: EvaluationQueueStats | null;
  readonly readiness: {
    readonly status: string | null;
    readonly reasonCodes: readonly string[];
    readonly matchRunId: string | null;
    readonly deterministicDecisionId: string | null;
    readonly recommendationEligibility: string | null;
    readonly recommendationOutcome: string | null;
    readonly availabilityStatus: string | null;
    readonly checks: readonly {
      readonly key: string;
      readonly status: string;
      readonly importance: string;
      readonly reasonCode: string | null;
    }[];
  } | null;
  readonly documentsEligible: boolean;
  readonly operationalError: string | null;
}

interface PilotTarget extends pg.QueryResultRow {
  readonly canonical_job_id: string;
  readonly job_version_id: string;
  readonly latest_job_version_id: string | null;
  readonly is_test_fixture: boolean;
  readonly normalized_title: string;
  readonly company_name: string;
  readonly processing_state: string | null;
  readonly latest_match_run_id: string | null;
  readonly latest_deterministic_decision_id: string | null;
  readonly source_expires_at: Date | string | null;
  readonly source_name: string;
  readonly source_plugin_key: string | null;
  readonly source_external_id: string | null;
  readonly source_url: string | null;
  readonly canonical_apply_url: string | null;
  readonly observation_id: string;
  readonly has_evaluation: boolean;
  readonly has_application: boolean;
  readonly has_documents: boolean;
}

interface ScopedTaskHealth {
  readonly pending: number;
  readonly retryWait: number;
  readonly blocked: number;
  readonly running: number;
  readonly activeRunning: number;
  readonly deadLetter: number;
  readonly oldestPendingAgeSeconds: number;
  readonly oldestRetryWaitAgeSeconds: number;
}

export function parseScopedPilotArgs(argv: readonly string[]): ScopedPilotArgs {
  let canonicalJobId: string | undefined;
  let jobVersionId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if ((arg === "--canonical-job-id" || arg === "--job-version-id") && !argv[index + 1]) {
      throw new Error(`Missing value for ${arg}.`);
    }
    if (arg === "--canonical-job-id") {
      if (canonicalJobId) throw new Error("--canonical-job-id may only be provided once.");
      canonicalJobId = argv[++index];
    } else if (arg === "--job-version-id") {
      if (jobVersionId) throw new Error("--job-version-id may only be provided once.");
      jobVersionId = argv[++index];
    } else {
      throw new Error(`Unsupported argument: ${arg}.`);
    }
  }
  if (!canonicalJobId) throw new Error("--canonical-job-id is required.");
  if (!jobVersionId) throw new Error("--job-version-id is required.");
  if (!UUID_PATTERN.test(canonicalJobId)) throw new Error("--canonical-job-id must be a UUID.");
  if (!UUID_PATTERN.test(jobVersionId)) throw new Error("--job-version-id must be a UUID.");
  return { canonicalJobId, jobVersionId };
}

export function createScopedPilotWorkerOptions(jobVersionId: string): PipelineStageWorkerOptions {
  if (!UUID_PATTERN.test(jobVersionId)) throw new Error("A scoped pilot requires a valid job version UUID.");
  return {
    taskTypes: [...PILOT_TASK_TYPES],
    jobVersionIds: [jobVersionId],
    seed: true,
    includeRoutingDeferred: true,
    includeTestFixtures: false,
    maxTasks: 50,
    stageQuantum: 1,
    reconcileStalePending: true,
    maxStalePendingReconciliation: 50,
    stalePendingReconciliationTimeBudgetMs: 10000,
    claimBatchSize: 1,
    leaseSeconds: 300,
    heartbeatSeconds: 60,
    wallClockMs: 15 * 60 * 1000,
    minTimeToStartTaskMs: 1000,
    maxSeedPerType: 100,
    seedTimeBudgetMs: 15000,
    claimedBy: `scoped-pilot:${jobVersionId}`,
  };
}

export function createScopedEvaluationOptions(
  jobVersionId: string,
  profileVersionId: string,
): EvaluateQueueOptions {
  if (!UUID_PATTERN.test(jobVersionId) || !UUID_PATTERN.test(profileVersionId)) {
    throw new Error("Scoped evaluation requires valid job-version and profile-version UUIDs.");
  }
  return { jobVersionIds: [jobVersionId], profileVersionId, limit: 1 };
}

export function createEmployerAtsAdapter(sourcePluginKey: string, sourceUrl: string): BaseSourceAdapter | null {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const pathParts = url.pathname.split("/").filter(Boolean);
  const pluginKey = sourcePluginKey.trim().toLowerCase();

  if (pluginKey === "ashby" && url.hostname === "jobs.ashbyhq.com" && pathParts.length >= 2) {
    return new AshbyAdapter(pathParts[0]);
  }
  if (pluginKey === "greenhouse" &&
      ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(url.hostname) &&
      pathParts.length >= 2) {
    return new GreenhouseAdapter(pathParts[0]);
  }
  if (pluginKey === "lever" && url.hostname === "jobs.lever.co" && pathParts.length >= 2) {
    return new LeverAdapter(pathParts[0]);
  }
  return null;
}

export function createScopedEvaluationOptionsWithContext(
  jobVersionId: string,
  profileVersionId: string,
  context: WorkspaceContext,
): EvaluateQueueOptions {
  return { ...createScopedEvaluationOptions(jobVersionId, profileVersionId), context };
}

async function readScopedTaskHealth(
  client: pg.Pool | pg.PoolClient,
  workspaceId: string,
  jobVersionId: string,
): Promise<ScopedTaskHealth> {
  const { rows } = await client.query<{
    pending: number;
    retry_wait: number;
    blocked: number;
    running: number;
    active_running: number;
    dead_letter: number;
    oldest_pending_age_seconds: number;
    oldest_retry_wait_age_seconds: number;
  }>(
    `SELECT COUNT(*) FILTER (WHERE task.status = 'PENDING')::INTEGER AS pending,
            COUNT(*) FILTER (WHERE task.status = 'RETRY_WAIT')::INTEGER AS retry_wait,
            COUNT(*) FILTER (WHERE task.status = 'BLOCKED_DEPENDENCY')::INTEGER AS blocked,
            COUNT(*) FILTER (WHERE task.status = 'RUNNING')::INTEGER AS running,
            COUNT(*) FILTER (
              WHERE task.status = 'RUNNING'
                AND COALESCE(task.lease_expires_at > NOW(), TRUE)
            )::INTEGER AS active_running,
            COUNT(*) FILTER (WHERE task.status = 'DEAD_LETTER')::INTEGER AS dead_letter,
            COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(task.created_at) FILTER (WHERE task.status = 'PENDING'))), 0)::INTEGER AS oldest_pending_age_seconds,
            COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(task.created_at) FILTER (WHERE task.status = 'RETRY_WAIT'))), 0)::INTEGER AS oldest_retry_wait_age_seconds
     FROM pipeline_tasks task
     WHERE task.workspace_id = $1
       AND (
         task.payload->>'job_version_id' = $2
         OR EXISTS (
           SELECT 1
           FROM raw_job_observations observation
           WHERE observation.workspace_id = task.workspace_id
             AND observation.id::TEXT = task.payload->>'observation_id'
             AND observation.job_version_id::TEXT = $2
         )
       )
       AND task.status IN ('PENDING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY', 'RUNNING', 'DEAD_LETTER')`,
    [workspaceId, jobVersionId],
  );
  const row = rows[0];
  return {
    pending: Number(row?.pending ?? 0),
    retryWait: Number(row?.retry_wait ?? 0),
    blocked: Number(row?.blocked ?? 0),
    running: Number(row?.running ?? 0),
    activeRunning: Number(row?.active_running ?? 0),
    deadLetter: Number(row?.dead_letter ?? 0),
    oldestPendingAgeSeconds: Number(row?.oldest_pending_age_seconds ?? 0),
    oldestRetryWaitAgeSeconds: Number(row?.oldest_retry_wait_age_seconds ?? 0),
  };
}

async function loadPilotTarget(
  client: pg.PoolClient,
  context: WorkspaceContext,
  args: ScopedPilotArgs,
): Promise<PilotTarget> {
  const { rows } = await client.query<PilotTarget>(
    `SELECT canonical.id::TEXT AS canonical_job_id,
            version.id::TEXT AS job_version_id,
            canonical.latest_job_version_id::TEXT AS latest_job_version_id,
            canonical.is_test_fixture,
            canonical.normalized_title,
            canonical.company_name,
            COALESCE(canonical.processing_state, canonical.processing_status) AS processing_state,
            canonical.latest_match_run_id::TEXT AS latest_match_run_id,
            canonical.latest_deterministic_decision_id::TEXT AS latest_deterministic_decision_id,
            version.source_expires_at,
            observation.source_name,
            observation.source_plugin_key,
            observation.source_external_id,
            observation.source_url,
            observation.canonical_apply_url,
            observation.id::TEXT AS observation_id,
            EXISTS (
              SELECT 1 FROM ai_evaluations evaluation
              WHERE evaluation.workspace_id = canonical.workspace_id
                AND evaluation.canonical_job_id = canonical.id
                AND evaluation.job_version_id = version.id
            ) AS has_evaluation,
            EXISTS (
              SELECT 1 FROM application_records application
              WHERE application.workspace_id = canonical.workspace_id
                AND application.canonical_job_id = canonical.id
            ) AS has_application,
            EXISTS (
              SELECT 1 FROM document_runs document
              WHERE document.workspace_id = canonical.workspace_id
                AND document.canonical_job_id = canonical.id
            ) AS has_documents
     FROM canonical_jobs canonical
     JOIN job_versions version
       ON version.workspace_id = canonical.workspace_id
      AND version.canonical_job_id = canonical.id
      AND version.id = canonical.latest_job_version_id
     JOIN LATERAL (
       SELECT observation.*
       FROM raw_job_observations observation
       WHERE observation.workspace_id = canonical.workspace_id
         AND observation.job_version_id = version.id
       ORDER BY observation.retrieved_at DESC, observation.id DESC
       LIMIT 1
     ) observation ON TRUE
     WHERE canonical.workspace_id = $1
       AND canonical.id = $2::UUID
       AND version.id = $3::UUID
     LIMIT 1`,
    [context.workspaceId, args.canonicalJobId, args.jobVersionId],
  );
  const target = rows[0];
  if (!target) throw new Error("The selected job version or linked source observation was not found.");
  if (target.is_test_fixture) throw new Error("The selected job is a test fixture.");
  if (target.latest_job_version_id !== args.jobVersionId) throw new Error("The selected version is no longer current.");
  if (["HARD_REJECTED", "MANUALLY_REMOVED", "PROCESSING_ERROR"].includes(target.processing_state ?? "")) {
    throw new Error(`The selected job is in non-pilot state ${target.processing_state}.`);
  }
  if (target.latest_match_run_id || target.latest_deterministic_decision_id || target.has_evaluation) {
    throw new Error("The selected job has already been matched or evaluated; choose an unprocessed job version.");
  }
  if (target.has_application || target.has_documents) {
    throw new Error("The selected job already has application or document history.");
  }
  if (target.source_expires_at && new Date(target.source_expires_at).getTime() <= Date.now()) {
    throw new Error("The selected job version has expired and cannot be used for a positive pilot.");
  }
  return target;
}

async function readCurrentDecisionAndReadiness(
  client: pg.PoolClient,
  context: WorkspaceContext,
  canonicalJobId: string,
  jobVersionId: string,
): Promise<{
  readiness: Awaited<ReturnType<typeof loadCurrentApplicationReadiness>>;
  recommendationEligibility: string | null;
  recommendationOutcome: string | null;
  matchRunId: string | null;
  deterministicDecisionId: string | null;
  availabilityStatus: string | null;
}> {
  const { rows } = await client.query<{
    recommendation_eligibility: string | null;
    recommendation_outcome: string | null;
    latest_match_run_id: string | null;
    latest_deterministic_decision_id: string | null;
  }>(
    `SELECT recommendation_eligibility,
            recommendation_outcome,
            latest_match_run_id::TEXT AS latest_match_run_id,
            latest_deterministic_decision_id::TEXT AS latest_deterministic_decision_id
     FROM canonical_jobs
     WHERE workspace_id = $1 AND id = $2::UUID AND latest_job_version_id = $3::UUID
     LIMIT 1`,
    [context.workspaceId, canonicalJobId, jobVersionId],
  );
  const row = rows[0];
  const readiness = await loadCurrentApplicationReadiness(client, context.workspaceId, canonicalJobId, jobVersionId);
  const availability = await client.query<{ availability_status: string | null }>(
    `SELECT availability_status
     FROM v_application_readiness_current
     WHERE workspace_id = $1 AND canonical_job_id = $2::UUID AND job_version_id = $3::UUID
     LIMIT 1`,
    [context.workspaceId, canonicalJobId, jobVersionId],
  );
  return {
    readiness,
    recommendationEligibility: row?.recommendation_eligibility ?? null,
    recommendationOutcome: row?.recommendation_outcome ?? null,
    matchRunId: row?.latest_match_run_id ?? null,
    deterministicDecisionId: row?.latest_deterministic_decision_id ?? null,
    availabilityStatus: availability.rows[0]?.availability_status ?? null,
  };
}

async function readScopedEvaluationProfileVersion(client: pg.PoolClient, context: WorkspaceContext): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id::TEXT AS id
     FROM profile_versions
     WHERE workspace_id = $1 AND status = 'ACTIVE'
     ORDER BY created_at DESC
     LIMIT 1`,
    [context.workspaceId],
  );
  if (!rows[0]?.id) throw new Error("The scoped pilot requires an active profile version.");
  return rows[0].id;
}

function hostIdentity(connectionString: string): { host: string; database: string } {
  const parsed = new URL(connectionString);
  return {
    host: parsed.hostname.replace(/-pooler(?=\.)/, ""),
    database: parsed.pathname,
  };
}

export async function runScopedPilot(args: ScopedPilotArgs): Promise<ScopedPilotReport> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const directUrl = (process.env.DATABASE_URL_UNPOOLED || databaseUrl || "").trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the scoped pilot.");
  if (!directUrl || isPooledPostgresConnectionString(directUrl)) {
    throw new Error("DATABASE_URL_UNPOOLED must be a direct connection for the scoped worker lock.");
  }
  if (hostIdentity(databaseUrl).host !== hostIdentity(directUrl).host ||
      hostIdentity(databaseUrl).database !== hostIdentity(directUrl).database) {
    throw new Error("DATABASE_URL and DATABASE_URL_UNPOOLED must target the same database branch.");
  }
  if ((process.env.WORKFLOW_KILL_SWITCH || "").trim().toLowerCase() !== "true") {
    throw new Error("WORKFLOW_KILL_SWITCH=true is required while the scoped pilot runs.");
  }

  const { runPipelineStageTaskWorker } = await import("../src/tasks/stageTaskWorker.js");
  const { refreshCanonicalJobSourceEvidence } = await import("../src/ingestion/sourceEvidenceRefresh.js");
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  const lockPool = new pg.Pool(pgConnectionConfig(directUrl));
  let lockClient: pg.PoolClient | null = null;
  let lockAcquired = false;
  let evaluationModule: typeof import("./evaluate_queue.js") | null = null;
  let operationalError: string | null = null;
  try {
    lockClient = await lockPool.connect();
    const lock = await lockClient.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [PIPELINE_WORKER_LOCK_ID]);
    lockAcquired = Boolean(lock.rows[0]?.locked);
    if (!lockAcquired) throw new Error("Another pipeline worker holds the singleton lock; no pilot work was claimed.");

    const client = await pool.connect();
    try {
      const context = await resolveWorkspaceContext(client);
      const target = await loadPilotTarget(client, context, args);
      const before = await readScopedTaskHealth(client, context.workspaceId, args.jobVersionId);
      if (before.activeRunning > 0) {
        throw new Error("The selected job version has an active task lease; refusing to overlap its worker.");
      }
      const adapterUrl = target.source_url ?? target.canonical_apply_url;
      const adapter = target.source_plugin_key && adapterUrl
        ? createEmployerAtsAdapter(target.source_plugin_key, adapterUrl)
        : null;
      const deadLetters = await readDeadLetterTaskHealth(client, context.workspaceId);
      const actionableDeadLetters = deadLetters.reduce(
        (count, row) => count + Number(row.actionable_dead_letter_count),
        0,
      );
      if (actionableDeadLetters > 0) {
        throw new Error(`The workspace has ${actionableDeadLetters} actionable current dead-letter task(s); scoped pilot is blocked.`);
      }
      if (!adapter) {
        throw new Error(`No supported official ATS adapter is configured for source ${target.source_plugin_key ?? target.source_name}.`);
      }

      const preference = await client.query<{ revision_id: string }>(
        `SELECT revision.id AS revision_id
         FROM workspace_user_preference_active_versions active
         JOIN workspace_user_preference_revisions revision
           ON revision.workspace_id = active.workspace_id
          AND revision.user_id = active.user_id
          AND revision.preference_domain = active.preference_domain
          AND revision.id = active.revision_id
         WHERE active.workspace_id = $1 AND active.user_id = $2 AND active.preference_domain = 'stage3'
         LIMIT 1`,
        [context.workspaceId, context.userId],
      );
      const preferenceRevisionId = preference.rows[0]?.revision_id ?? null;
      const sourceRefresh = await refreshCanonicalJobSourceEvidence(pool, {
        canonicalJobId: args.canonicalJobId,
        jobVersionId: args.jobVersionId,
        observationId: target.observation_id,
      }, { adapter, context, maxPages: 20 });

      if (sourceRefresh.status !== "REFRESHED") {
        return {
          canonicalJobId: args.canonicalJobId,
          jobVersionId: args.jobVersionId,
          title: target.normalized_title,
          company: target.company_name,
          sourcePluginKey: target.source_plugin_key ?? "UNKNOWN",
          preferenceRevisionId,
          sourceRefresh,
          worker: null,
          evaluation: null,
          readiness: null,
          documentsEligible: false,
          operationalError: `Source evidence refresh ended with ${sourceRefresh.status}${sourceRefresh.reasonCode ? ` (${sourceRefresh.reasonCode})` : ""}.`,
        };
      }

      const worker = await runPipelineStageTaskWorker(pool, {
        ...createScopedPilotWorkerOptions(args.jobVersionId),
        context,
      });
      if (worker.failed > 0 || worker.deadLettered > 0 || worker.errors.length > 0) {
        const current = await readCurrentDecisionAndReadiness(client, context, args.canonicalJobId, args.jobVersionId);
        return thisReport({ target, args, preferenceRevisionId, sourceRefresh, worker, evaluation: null, current, error: "Scoped pipeline worker reported a task failure." });
      }

      const evaluationProfileVersionId = await readScopedEvaluationProfileVersion(client, context);
      evaluationModule = await import("./evaluate_queue.js");
      let evaluation: EvaluationQueueStats | null = null;
      try {
        evaluation = await evaluationModule.evaluateQueue(
          createScopedEvaluationOptionsWithContext(args.jobVersionId, evaluationProfileVersionId, context),
        );
      } catch (error) {
        operationalError = `Scoped evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      const after = await readScopedTaskHealth(client, context.workspaceId, args.jobVersionId);
      const finalDeadLetters = await readDeadLetterTaskHealth(client, context.workspaceId);
      const finalActionableDeadLetters = finalDeadLetters.reduce(
        (count, row) => count + Number(row.actionable_dead_letter_count),
        0,
      );
      try {
        enforcePipelineWorkerExitPolicy({
          claimedThisRun: worker.claimed,
          completedThisRun: worker.completed,
          failedThisRun: worker.failed + (evaluation?.failed ?? 0),
          exitReason: worker.exitReason,
          deadLetteredThisRun: worker.deadLettered,
          actionableCurrentDeadLetterCount: finalActionableDeadLetters,
          staleHistoricalDeadLetterCount: finalDeadLetters.reduce(
            (count, row) => count + Number(row.stale_historical_dead_letter_count),
            0,
          ),
          retryWaitCount: after.retryWait,
          oldestRetryWaitAgeSeconds: after.oldestRetryWaitAgeSeconds,
          activePendingCountBefore: before.pending,
          activePendingCount: after.pending,
          oldestActivePendingAgeSecondsBefore: before.oldestPendingAgeSeconds,
          oldestActivePendingAgeSeconds: after.oldestPendingAgeSeconds,
          failOnRetryWait: true,
          maxRetryWaitCount: 500,
          maxRetryWaitAgeSeconds: 21600,
          maxPendingAgeSeconds: 7200,
          noProgressPendingThreshold: 1,
        });
      } catch (error) {
        operationalError = error instanceof Error ? error.message : String(error);
      }

      const current = await readCurrentDecisionAndReadiness(client, context, args.canonicalJobId, args.jobVersionId);
      const readinessPayload = current.readiness?.application_readiness;
      const readinessRecord = readinessPayload !== null && typeof readinessPayload === "object"
        ? Object.fromEntries(Object.entries(readinessPayload))
        : null;
      const checks = Array.isArray(readinessRecord?.checks) ? readinessRecord.checks : [];
      const readinessChecks = checks.flatMap((check) => {
        if (!check || typeof check !== "object" || Array.isArray(check)) return [];
        const record = Object.fromEntries(Object.entries(check));
        if (typeof record.key !== "string" || typeof record.status !== "string" || typeof record.importance !== "string") return [];
        return [{
          key: record.key,
          status: record.status,
          importance: record.importance,
          reasonCode: typeof record.reason_code === "string" ? record.reason_code : null,
        }];
      });
      const outcome = current.recommendationOutcome;
      const documentsEligible = isCurrentReadyApplicationReadiness(current.readiness) &&
        current.recommendationEligibility === "ELIGIBLE" &&
        (outcome === "PRIORITY" || outcome === "REVIEW") &&
        evaluation !== null &&
        evaluation.processed > 0 && evaluation.failed === 0 && evaluation.manualReview === 0;
      return {
        canonicalJobId: args.canonicalJobId,
        jobVersionId: args.jobVersionId,
        title: target.normalized_title,
        company: target.company_name,
        sourcePluginKey: target.source_plugin_key ?? "UNKNOWN",
        preferenceRevisionId,
        sourceRefresh,
        worker,
        evaluation,
        readiness: {
          status: current.readiness?.readiness_status ?? null,
          reasonCodes: current.readiness?.readiness_reason_codes ?? [],
          matchRunId: current.matchRunId,
          deterministicDecisionId: current.deterministicDecisionId,
          recommendationEligibility: current.recommendationEligibility,
          recommendationOutcome: current.recommendationOutcome,
          availabilityStatus: current.availabilityStatus,
          checks: readinessChecks,
        },
        documentsEligible,
        operationalError: operationalError ?? (evaluation?.failed ? "Scoped evaluation queued one or more tasks for retry." : null),
      };
    } finally {
      client.release();
    }
  } finally {
    if (evaluationModule) await evaluationModule.closeEvaluationQueuePool();
    if (lockClient) {
      if (lockAcquired) {
        try {
          const unlock = await lockClient.query<{ unlocked: boolean }>(
            "SELECT pg_advisory_unlock($1) AS unlocked",
            [PIPELINE_WORKER_LOCK_ID],
          );
          if (unlock.rows[0]?.unlocked !== true) {
            console.error("Scoped pilot did not release the singleton pipeline lock.");
            process.exitCode = 1;
          }
        } catch {
          console.error("Failed to release the scoped pilot singleton pipeline lock.");
          process.exitCode = 1;
        }
      }
      lockClient.release();
    }
    await pool.end();
    await lockPool.end();
  }
}

function thisReport(input: {
  readonly target: PilotTarget;
  readonly args: ScopedPilotArgs;
  readonly preferenceRevisionId: string | null;
  readonly sourceRefresh: SourceEvidenceRefreshResult;
  readonly worker: PipelineStageWorkerSummary;
  readonly evaluation: EvaluationQueueStats | null;
  readonly current: Awaited<ReturnType<typeof readCurrentDecisionAndReadiness>>;
  readonly error: string;
}): ScopedPilotReport {
  return {
    canonicalJobId: input.args.canonicalJobId,
    jobVersionId: input.args.jobVersionId,
    title: input.target.normalized_title,
    company: input.target.company_name,
    sourcePluginKey: input.target.source_plugin_key ?? "UNKNOWN",
    preferenceRevisionId: input.preferenceRevisionId,
    sourceRefresh: input.sourceRefresh,
    worker: input.worker,
    evaluation: input.evaluation,
    readiness: {
      status: input.current.readiness?.readiness_status ?? null,
      reasonCodes: input.current.readiness?.readiness_reason_codes ?? [],
      matchRunId: input.current.matchRunId,
      deterministicDecisionId: input.current.deterministicDecisionId,
      recommendationEligibility: input.current.recommendationEligibility,
      recommendationOutcome: input.current.recommendationOutcome,
      availabilityStatus: input.current.availabilityStatus,
      checks: [],
    },
    documentsEligible: false,
    operationalError: input.error,
  };
}

if (process.argv[1] && process.argv[1].includes("run_scoped_pilot")) {
  void (async () => {
    try {
      const args = parseScopedPilotArgs(process.argv.slice(2));
      const report = await runScopedPilot(args);
      console.log(JSON.stringify(report, null, 2));
      if (report.operationalError) process.exitCode = 1;
    } catch (error: unknown) {
      console.error("Scoped pilot failed:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  })();
}
