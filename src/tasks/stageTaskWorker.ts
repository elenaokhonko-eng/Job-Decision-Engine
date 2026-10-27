import crypto from "crypto";
import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { runNormalization as defaultRunNormalization } from "../pipeline/normalize.js";
import { runRequirementsExtraction as defaultRunRequirementsExtraction } from "../pipeline/requirementsExtractor.js";
import { runHardGates as defaultRunHardGates } from "../pipeline/hardGate.js";
import { runEmbeddingBatchWithFallback as defaultRunEmbeddingBatchWithFallback } from "../embeddings/batchCoordinator.js";
import { runLaneRouting as defaultRunLaneRouting } from "../pipeline/laneRouter.js";
import { loadWorkspaceLanesConfig } from "../pipeline/laneConfigLoader.js";
import { runDeterministicMatcher as defaultRunDeterministicMatcher } from "../pipeline/deterministicMatcher.js";
import { runRecommendationDecider as defaultRunRecommendationDecider } from "../pipeline/recommendationDecider.js";
import { runExplanationQueueEnqueuer as defaultRunExplanationQueueEnqueuer } from "../pipeline/explanationQueueEnqueuer.js";
import { applicationReadinessViewAvailable } from "../services/currentApplicationReadiness.js";
import { isCurrentCanonicalJobVersion } from "./canonicalJobVersion.js";
import { createTaskIntentV2, TaskIntentV2Schema } from "./taskIntent.js";
import { forcedTaskRerouteIntent, forcedTaskReroutePayload } from "./forcedTaskReroute.js";
import { planPipelineStageRound } from "./pipelineStageScheduler.js";
import { scopeSeedQuery } from "./seedQueryScope.js";
import {
  pipelineTaskStageVersion,
  reconcileStalePendingPipelineTasks,
  type PipelineTaskReconciliationSummary,
} from "./pipelineTaskCurrentness.js";
import {
  blockPipelineTask,
  claimPipelineTasks,
  completePipelineTaskAndRun,
  enqueuePipelineTask,
  failPipelineTask,
  heartbeatPipelineTask,
  releasePipelineTaskForRetry,
  type ClaimedPipelineTask,
} from "./pipelineTasks.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export const PIPELINE_STAGE_TASK_TYPES = [
  "NORMALIZE_OBSERVATION",
  "EXTRACT_DETERMINISTIC_REQUIREMENTS",
  "APPLY_HARD_GATES",
  "EXTRACT_QUOTED_REQUIREMENTS",
  "PUBLISH_EMBEDDING",
  "ROUTE_LANE",
  "MATCH_PROFILE_EVIDENCE",
  "DECIDE_RECOMMENDATION",
  "ENQUEUE_EXPLANATION",
] as const;

const SEMANTIC_MATCH_REPAIR_GENERATION = "semantic_match_repair_v2";

export type PipelineStageTaskType = (typeof PIPELINE_STAGE_TASK_TYPES)[number];

export function parsePipelineTaskTypes(raw: string | undefined): PipelineStageTaskType[] {
  if (!raw || raw.trim() === "") return [...PIPELINE_STAGE_TASK_TYPES];

  const requested = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  const unsupported = requested.filter(
    (value): value is string => !PIPELINE_STAGE_TASK_TYPES.includes(value as PipelineStageTaskType)
  );
  if (unsupported.length > 0) {
    throw new Error(`Unsupported PIPELINE_TASK_WORKER_TASK_TYPES value(s): ${unsupported.join(", ")}`);
  }
  if (requested.length === 0) {
    throw new Error("PIPELINE_TASK_WORKER_TASK_TYPES must contain at least one task type when set.");
  }
  return requested as PipelineStageTaskType[];
}

export function parsePipelineStageTaskLimits(
  raw: string | undefined,
): Partial<Record<PipelineStageTaskType, number>> {
  if (!raw || raw.trim() === "") return {};

  const limits: Partial<Record<PipelineStageTaskType, number>> = {};
  for (const entry of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const [rawTaskType, rawLimit, ...unexpected] = entry.split("=").map((value) => value.trim());
    if (unexpected.length > 0 || !rawTaskType || !rawLimit) {
      throw new Error(`Invalid pipeline stage limit "${entry}". Use TASK_TYPE=POSITIVE_INTEGER.`);
    }
    if (!PIPELINE_STAGE_TASK_TYPES.includes(rawTaskType as PipelineStageTaskType)) {
      throw new Error(`Unsupported pipeline stage limit task type: ${rawTaskType}`);
    }
    const limit = Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`Pipeline stage limit for ${rawTaskType} must be a positive integer.`);
    }
    limits[rawTaskType as PipelineStageTaskType] = limit;
  }
  return limits;
}

export interface PipelineStageWorkerDependencies {
  runNormalization: typeof defaultRunNormalization;
  runRequirementsExtraction: typeof defaultRunRequirementsExtraction;
  runHardGates: typeof defaultRunHardGates;
  runEmbeddingBatchWithFallback: typeof defaultRunEmbeddingBatchWithFallback;
  runLaneRouting: typeof defaultRunLaneRouting;
  runDeterministicMatcher: typeof defaultRunDeterministicMatcher;
  runRecommendationDecider: typeof defaultRunRecommendationDecider;
  runExplanationQueueEnqueuer: typeof defaultRunExplanationQueueEnqueuer;
}

export interface SeedPipelineTasksSummary {
  inserted: number;
  existing: number;
  deferredByBudget: number;
  timeBudgetExceeded: boolean;
  byType: Record<string, { inserted: number; existing: number }>;
}

export type PipelineWorkerExitReason =
  | "QUEUE_DRAINED"
  | "MAX_TASKS_REACHED"
  | "WALL_CLOCK_BUDGET_REACHED"
  | "STAGE_LIMIT_REACHED";

export interface PipelineStageWorkerSummary {
  seeded: SeedPipelineTasksSummary | null;
  stalePendingReconciliation: PipelineTaskReconciliationSummary;
  claimed: number;
  completed: number;
  successorTasksCreated: number;
  blocked: number;
  failed: number;
  deadLettered: number;
  exitReason: PipelineWorkerExitReason;
  durationMs: number;
  byType: Record<string, { claimed: number; completed: number; blocked: number; failed: number; deadLettered: number }>;
  errors: Array<{ taskType: string; taskKey: string; error: string }>;
}

export interface PipelineStageWorkerOptions {
  context?: WorkspaceContext;
  taskTypes?: PipelineStageTaskType[];
  jobVersionIds?: readonly string[];
  observationIds?: readonly string[];
  seed?: boolean;
  /** Explicitly opt into bounded replay of ROUTING_DEFERRED jobs. */
  includeRoutingDeferred?: boolean;
  /** Release and rehearsal paths can opt in; scheduled production work excludes fixtures. */
  includeTestFixtures?: boolean;
  routingDeferredReplayVersion?: string;
  maxSeedPerType?: number;
  maxTasks?: number;
  /** Per-stage caps applied across round-robin passes. */
  maxTasksByType?: Partial<Record<PipelineStageTaskType, number>>;
  seedTimeBudgetMs?: number;
  /** Tasks claimed per stage on each round-robin pass. */
  stageQuantum?: number;
  /** First stage index for this run; bounded by the stage count. */
  stageStartOffset?: number;
  /** Defaults to true; set false only when reconciliation is exercised separately. */
  reconcileStalePending?: boolean;
  maxStalePendingReconciliation?: number;
  stalePendingReconciliationTimeBudgetMs?: number;
  claimBatchSize?: number;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  wallClockMs?: number;
  minTimeToStartTaskMs?: number;
  claimedBy?: string;
  /** Reuse one durable AI budget identity across all explanation tasks in this worker run. */
  budgetRunId?: string;
  abortSignal?: AbortSignal;
}

type QueryClient = {
  query: pg.PoolClient["query"];
};

const defaultDependencies: PipelineStageWorkerDependencies = {
  runNormalization: defaultRunNormalization,
  runRequirementsExtraction: defaultRunRequirementsExtraction,
  runHardGates: defaultRunHardGates,
  runEmbeddingBatchWithFallback: defaultRunEmbeddingBatchWithFallback,
  runLaneRouting: defaultRunLaneRouting,
  runDeterministicMatcher: defaultRunDeterministicMatcher,
  runRecommendationDecider: defaultRunRecommendationDecider,
  runExplanationQueueEnqueuer: defaultRunExplanationQueueEnqueuer,
};

const MODEL_BACKED_STAGE_TASK_TYPES = new Set<PipelineStageTaskType>([
  "EXTRACT_QUOTED_REQUIREMENTS",
  "PUBLISH_EMBEDDING",
  "ROUTE_LANE",
]);

function isPool(value: pg.Pool | pg.PoolClient): value is pg.Pool {
  return typeof (value as pg.Pool).connect === "function" && !("release" in value);
}

function incrementSeed(
  summary: SeedPipelineTasksSummary,
  taskType: PipelineStageTaskType,
  inserted: boolean
): void {
  summary.byType[taskType] ??= { inserted: 0, existing: 0 };
  if (inserted) {
    summary.inserted += 1;
    summary.byType[taskType].inserted += 1;
  } else {
    summary.existing += 1;
    summary.byType[taskType].existing += 1;
  }
}

function incrementWorker(
  summary: PipelineStageWorkerSummary,
  taskType: string,
  field: "claimed" | "completed" | "blocked" | "failed" | "deadLettered"
): void {
  summary.byType[taskType] ??= { claimed: 0, completed: 0, blocked: 0, failed: 0, deadLettered: 0 };
  summary.byType[taskType][field] += 1;
}

export class PipelineWorkerCancelledError extends Error {
  constructor(message = "Pipeline task worker cancellation requested.") {
    super(message);
    this.name = "PipelineWorkerCancelledError";
  }
}

export class PipelineTaskDependencyBlockedError extends Error {
  constructor(
    public readonly blockedOn: string,
    public readonly repairAction: string,
    message: string
  ) {
    super(message);
    this.name = "PipelineTaskDependencyBlockedError";
  }
}

function abortReasonMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.trim() !== "") return reason;
  return "Pipeline task worker cancellation requested.";
}

function throwIfWorkerCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PipelineWorkerCancelledError(abortReasonMessage(signal));
  }
}

function requireStringPayload(task: ClaimedPipelineTask, field: string): string {
  const payload = task.payload as Record<string, unknown> | null;
  const value = payload?.[field];
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  throw new Error(`Pipeline task ${task.taskKey} is missing string payload field ${field}.`);
}

function optionalStringPayload(task: ClaimedPipelineTask, field: string): string | undefined {
  const payload = task.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function buildPipelineTaskKey(
  taskType: PipelineStageTaskType,
  id: string,
  version: string,
  profileVersionId?: string,
  taskVariant?: string
): string {
  const variantSuffix = taskVariant ? `:${taskVariant}` : "";
  const profileSuffix = taskType === "MATCH_PROFILE_EVIDENCE" && profileVersionId
    ? `:profile:${profileVersionId}`
    : "";
  return `${taskType}:${id}:${version}${variantSuffix}${profileSuffix}`;
}

async function resolveActiveProfileVersionId(
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext
): Promise<string> {
  const { rows } = await (clientOrPool as QueryClient).query<{ id: string }>(
    `SELECT pv.id
     FROM profile_versions pv
     WHERE pv.workspace_id = $1
       AND pv.status = 'ACTIVE'
     ORDER BY pv.created_at DESC
     LIMIT 1`,
    [ctx.workspaceId]
  );
  const profileVersionId = rows[0]?.id;
  if (!profileVersionId) {
    throw new Error(`No ACTIVE profile version found for workspace_id=${ctx.workspaceId}.`);
  }
  return profileVersionId;
}

async function enqueueStageTask(
  taskType: PipelineStageTaskType,
  id: string,
  payload: Record<string, unknown>,
  clientOrPool: pg.Pool | pg.PoolClient,
  context: WorkspaceContext,
  intentOptions?: {
    producer?: string;
    requestId?: string;
    triggerRevisionId?: string | null;
    mode?: "ENSURE_CURRENT" | "FORCE_RECOMPUTE";
  },
): Promise<boolean> {
  const maxAttempts = MODEL_BACKED_STAGE_TASK_TYPES.has(taskType) ? 3 : 8;
  let taskPayload = payload;
  let profileVersionId: string | undefined;
  if (taskType === "MATCH_PROFILE_EVIDENCE") {
    profileVersionId = typeof payload.profile_version_id === "string" && payload.profile_version_id.trim() !== ""
      ? payload.profile_version_id
      : await resolveActiveProfileVersionId(clientOrPool, context);
    taskPayload = { ...payload, profile_version_id: profileVersionId };
  } else if (taskType === "DECIDE_RECOMMENDATION") {
    const activeProfileRes = await clientOrPool.query<{ id: string }>(
      `SELECT pv.id
       FROM profile_versions pv
       WHERE pv.workspace_id = $1
         AND pv.status = 'ACTIVE'
       ORDER BY pv.created_at DESC
       LIMIT 1`,
      [context.workspaceId]
    );
    profileVersionId = activeProfileRes.rows[0]?.id;
    if (profileVersionId) {
      taskPayload = { ...payload, profile_version_id: profileVersionId };
    }
  }

  // Task identity must include the artifact context that the task is meant to
  // consume. Otherwise a completed task created before a rematch/decision can
  // suppress the successor task created after the current artifact exists.
  const jobVersionId = typeof taskPayload.job_version_id === "string"
    ? taskPayload.job_version_id
    : null;
  if (jobVersionId && [
    "MATCH_PROFILE_EVIDENCE",
    "DECIDE_RECOMMENDATION",
    "ENQUEUE_EXPLANATION",
  ].includes(taskType)) {
    const currentContext = await clientOrPool.query<{
      active_requirement_set_id: string | null;
      content_hash: string | null;
      latest_match_run_id: string | null;
      latest_deterministic_decision_id: string | null;
    }>(
      `SELECT jv.active_requirement_set_id,
              jv.content_hash,
              c.latest_match_run_id,
              c.latest_deterministic_decision_id
       FROM job_versions jv
       JOIN canonical_jobs c
         ON c.workspace_id = jv.workspace_id
        AND c.id = jv.canonical_job_id
       WHERE jv.workspace_id = $1
         AND jv.id = $2
       LIMIT 1`,
      [context.workspaceId, jobVersionId]
    );
    const row = currentContext.rows[0];
    if (row) {
      taskPayload = {
        ...taskPayload,
        content_hash: row.content_hash,
        active_requirement_set_id: row.active_requirement_set_id,
        ...(taskType === "DECIDE_RECOMMENDATION" || taskType === "ENQUEUE_EXPLANATION"
          ? {
              match_run_id: row.latest_match_run_id,
              deterministic_decision_id: row.latest_deterministic_decision_id,
            }
          : {}),
      };
    }
  }
  const routingReplayVersion =
    taskType === "ROUTE_LANE" &&
    typeof taskPayload.routing_deferred_replay_version === "string" &&
    taskPayload.routing_deferred_replay_version.trim() !== ""
      ? taskPayload.routing_deferred_replay_version.trim()
      : null;
  const isRepairTask =
    taskPayload.reprocess === true ||
    taskPayload.force_policy_recalculation === true ||
    (typeof taskPayload.verification_answer_revision_id === "string" && taskPayload.verification_answer_revision_id.trim() !== "") ||
    (taskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS" &&
      taskPayload.repair_existing_state === true) ||
    ((taskType === "PUBLISH_EMBEDDING" || taskType === "ROUTE_LANE") &&
      taskPayload.reprocess_existing_state === true) ||
    (taskType === "MATCH_PROFILE_EVIDENCE" &&
      taskPayload.reprocess_existing_state === true) ||
    (taskType === "DECIDE_RECOMMENDATION" &&
      taskPayload.repair_existing_state === true);
  const taskVariant = routingReplayVersion
    ? `repair-${routingReplayVersion}`
    : isRepairTask ? "repair" : undefined;
  const taskVersion = stageVersion(taskType);
  const taskKey = buildPipelineTaskKey(taskType, id, taskVersion, profileVersionId, taskVariant);
  const intent = createTaskIntentV2({
    workspaceId: context.workspaceId,
    taskType,
    stageVersion: taskVersion,
    producer: intentOptions?.producer ?? `stageTaskWorker:${taskType}`,
    requestId: intentOptions?.requestId ?? taskKey,
    triggerRevisionId: intentOptions?.triggerRevisionId,
    mode: intentOptions?.mode,
    payload: taskPayload,
  });
  const result = await enqueuePipelineTask(
    {
      taskType,
      taskKey,
      payload: taskPayload,
      maxAttempts,
      intent,
    },
    clientOrPool,
    { context }
  );
  return result.inserted;
}

function stageVersion(taskType: PipelineStageTaskType): string {
  const version = pipelineTaskStageVersion(taskType);
  if (!version) throw new Error(`Unsupported pipeline task type: ${taskType}`);
  return version;
}

function requiredSeedValue(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Seed query did not return required ${field} for a pipeline task.`);
  }
  return value;
}

async function selectAndEnqueue(
  client: QueryClient,
  ctx: WorkspaceContext,
  summary: SeedPipelineTasksSummary,
  taskType: PipelineStageTaskType,
  sql: string,
  params: unknown[],
  build: (row: Record<string, unknown>) => { id: string; payload: Record<string, unknown> },
  enabledTypes?: Set<PipelineStageTaskType>,
  includeTestFixtures = false,
  deadlineAt?: number,
  seedScope: { jobVersionIds?: readonly string[]; observationIds?: readonly string[] } = {},
  maxSeedPerType = 200,
): Promise<void> {
  if (enabledTypes && !enabledTypes.has(taskType)) return;
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    summary.timeBudgetExceeded = true;
    return;
  }
  const scopedQuery = scopeSeedQuery(sql, params, seedScope, maxSeedPerType);
  const { rows } = await client.query<Record<string, unknown>>(scopedQuery.sql, scopedQuery.params);
  const candidates = rows.map(build);
  const canonicalJobIds = [...new Set(candidates
    .map((candidate) => candidate.payload.canonical_job_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0))];
  const fixtureIds = new Set<string>();

  if (!includeTestFixtures && canonicalJobIds.length > 0) {
    const fixtures = await client.query<{ id: string }>(
      `SELECT id
       FROM canonical_jobs
       WHERE workspace_id = $1
         AND is_test_fixture = TRUE
         AND id = ANY($2::uuid[])`,
      [ctx.workspaceId, canonicalJobIds],
    );
    for (const fixture of fixtures.rows) fixtureIds.add(fixture.id);
  }

  for (let index = 0; index < candidates.length; index += 1) {
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
      summary.timeBudgetExceeded = true;
      summary.deferredByBudget += candidates.length - index;
      break;
    }
    const task = candidates[index];
    if (!task) continue;
    const canonicalJobId = task.payload.canonical_job_id;
    if (!includeTestFixtures && typeof canonicalJobId === "string" && fixtureIds.has(canonicalJobId)) continue;
    const inserted = await enqueueStageTask(taskType, task.id, task.payload, client as any, ctx);
    incrementSeed(summary, taskType, inserted);
  }
}

export async function seedRecoverablePipelineTasks(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options: {
    context?: WorkspaceContext;
    maxSeedPerType?: number;
    taskTypes?: PipelineStageTaskType[];
    jobVersionIds?: readonly string[];
    observationIds?: readonly string[];
    includeRoutingDeferred?: boolean;
    includeTestFixtures?: boolean;
    routingDeferredReplayVersion?: string;
    budgetRunId?: string;
    timeBudgetMs?: number;
  } = {}
): Promise<SeedPipelineTasksSummary> {
  const pool = clientOrPool || defaultPool;
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;
  const summary: SeedPipelineTasksSummary = {
    inserted: 0,
    existing: 0,
    deferredByBudget: 0,
    timeBudgetExceeded: false,
    byType: {},
  };
  const maxPerType = options.maxSeedPerType ?? 200;
  const timeBudgetMs = Math.max(1, Math.min(options.timeBudgetMs ?? 15_000, 60_000));
  const deadlineAt = Date.now() + timeBudgetMs;
  // Technical routing failures are machine-recoverable by default. Terminal
  // POLICY_NO_MATCH outcomes are excluded below unless a lane revision changed.
  const includeRoutingDeferred = options.includeRoutingDeferred !== false;
  const includeTestFixtures = options.includeTestFixtures === true;
  let routingDeferredReplayVersion = options.routingDeferredReplayVersion?.trim() || "";
  const enabledTypes: Set<PipelineStageTaskType> | undefined = options.taskTypes
    ? new Set<PipelineStageTaskType>(options.taskTypes)
    : undefined;
  const seedScope = {
    jobVersionIds: options.jobVersionIds,
    observationIds: options.observationIds,
  };

  try {
    const ctx = options.context ?? (await resolveWorkspaceContext(client as any));
    if (!routingDeferredReplayVersion) {
      const lanes = await loadWorkspaceLanesConfig(client as any, { context: ctx, seedIfEmpty: true });
      routingDeferredReplayVersion = lanes.config.version || "routing_deferred_replay_v1";
    }
    const readinessViewAvailable = !enabledTypes || enabledTypes.has("DECIDE_RECOMMENDATION")
      ? await applicationReadinessViewAvailable(client as pg.PoolClient)
      : false;
    const readinessRefreshPredicate = readinessViewAvailable
      ? `EXISTS (
          SELECT 1
          FROM v_application_readiness_current readiness_refresh
          WHERE readiness_refresh.workspace_id = c.workspace_id
            AND readiness_refresh.canonical_job_id = c.id
            AND readiness_refresh.job_version_id::text = COALESCE(c.latest_job_version_id, jv.id)::text
            AND (
              readiness_refresh.application_readiness IS NULL
              OR readiness_refresh.readiness_reason_codes && ARRAY[
                'READINESS_EVIDENCE_STALE',
                'READINESS_FINGERPRINT_STALE',
                'READINESS_CONTEXT_STALE'
              ]::text[]
              OR (
                'READINESS_EVIDENCE_EXPIRED' = ANY(readiness_refresh.readiness_reason_codes)
                AND readiness_refresh.readiness_expires_at IS NOT NULL
                AND NULLIF(readiness_refresh.application_readiness->>'evaluated_at', '')::timestamptz
                  < readiness_refresh.readiness_expires_at
              )
            )
        )`
      : "FALSE";

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "NORMALIZE_OBSERVATION",
      `SELECT obs.id AS observation_id
       FROM raw_job_observations obs
       WHERE obs.workspace_id = $1
         AND obs.job_version_id IS NULL
         AND COALESCE(obs.processing_status, 'PENDING') = 'PENDING'
       ORDER BY obs.retrieved_at ASC, obs.id ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "observation_id"),
        payload: { observation_id: requiredSeedValue(row, "observation_id") },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      `SELECT c.id AS canonical_job_id,
              jv.id AS job_version_id,
              COALESCE(c.processing_state, c.processing_status) <> 'RAW_STAGED' AS repair_existing_state
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.id = COALESCE(c.latest_job_version_id, (
          SELECT jv2.id
          FROM job_versions jv2
          WHERE jv2.workspace_id = c.workspace_id
            AND jv2.canonical_job_id = c.id
          ORDER BY jv2.observed_at DESC
          LIMIT 1
        ))
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) IN (
           'RAW_STAGED', 'PREQUALIFIED', 'LANE_ROUTED', 'ROUTING_DEFERRED', 'MATCHED',
           'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: {
          canonical_job_id: requiredSeedValue(row, "canonical_job_id"),
          job_version_id: requiredSeedValue(row, "job_version_id"),
          ...(row.repair_existing_state === true ? { repair_existing_state: true } : {}),
        },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "APPLY_HARD_GATES",
      `SELECT c.id AS canonical_job_id, jv.id AS job_version_id
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.id = COALESCE(c.latest_job_version_id, (
          SELECT jv2.id
          FROM job_versions jv2
          WHERE jv2.workspace_id = c.workspace_id
            AND jv2.canonical_job_id = c.id
          ORDER BY jv2.observed_at DESC
          LIMIT 1
        ))
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) = 'RAW_STAGED'
         AND EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: {
          canonical_job_id: requiredSeedValue(row, "canonical_job_id"),
          job_version_id: requiredSeedValue(row, "job_version_id"),
          ...(row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
        },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "EXTRACT_QUOTED_REQUIREMENTS",
      `SELECT c.id AS canonical_job_id, jv.id AS job_version_id
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       WHERE c.workspace_id = $1
          AND COALESCE(c.processing_state, c.processing_status) IN ('PREQUALIFIED', 'ROUTING_DEFERRED')
         AND NOT EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'LLM_QUOTED'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: { canonical_job_id: requiredSeedValue(row, "canonical_job_id"), job_version_id: requiredSeedValue(row, "job_version_id") },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "PUBLISH_EMBEDDING",
      `SELECT c.id AS canonical_job_id,
              jv.id AS job_version_id,
              c.latest_match_run_id AS repair_match_run_id
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.id = c.latest_job_version_id
       JOIN match_runs mr
         ON mr.workspace_id = c.workspace_id
        AND mr.id = c.latest_match_run_id
        AND mr.canonical_job_id = c.id
        AND mr.job_version_id = jv.id
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED'
         AND c.profile_match_status = 'UNKNOWN'
         AND (
           mr.status <> 'COMPLETED'
           OR mr.embedding_space_id IS NULL
         )
         AND EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
       ORDER BY c.updated_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: {
          canonical_job_id: requiredSeedValue(row, "canonical_job_id"),
          job_version_id: requiredSeedValue(row, "job_version_id"),
          repair_dependency: "SEMANTIC_MATCH_EMBEDDING_INCOMPLETE",
          repair_generation: SEMANTIC_MATCH_REPAIR_GENERATION,
          repair_match_run_id: requiredSeedValue(row, "repair_match_run_id"),
          reprocess_existing_state: true,
        },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "PUBLISH_EMBEDDING",
      `SELECT c.id AS canonical_job_id, jv.id AS job_version_id,
              TRUE AS reprocess_existing_state
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       WHERE c.workspace_id = $1
          AND (
            COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
            OR (
              COALESCE(c.processing_state, c.processing_status) = 'ROUTING_DEFERRED'
              AND COALESCE(c.routing_disposition, 'TECHNICAL_DEFERRED') = 'TECHNICAL_DEFERRED'
            )
          )
         AND EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           JOIN v_published_semantic_embeddings se
             ON se.workspace_id = ei.workspace_id
            AND se.embedding_input_id = ei.id
           JOIN embedding_spaces es
             ON es.workspace_id = se.workspace_id
            AND es.id = se.embedding_space_id
           WHERE ei.workspace_id = c.workspace_id
             AND ei.source_type = 'JOB_VERSION'
             AND ei.source_id = jv.id
             AND es.is_fallback_space = FALSE
             AND LOWER(es.provider) = LOWER($3)
             AND es.model = $4
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`,
      [
        ctx.workspaceId,
        maxPerType,
        process.env.EMBEDDING_PRIMARY_PROVIDER || 'gemini',
        process.env.EMBEDDING_PRIMARY_MODEL || 'gemini-embedding-001',
      ],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: {
          canonical_job_id: requiredSeedValue(row, "canonical_job_id"),
          job_version_id: requiredSeedValue(row, "job_version_id"),
          ...(row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
        },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "ROUTE_LANE",
      `SELECT c.id AS canonical_job_id, jv.id AS job_version_id,
              COALESCE(c.processing_state, c.processing_status) AS processing_state,
              TRUE AS reprocess_existing_state
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       WHERE c.workspace_id = $1
         AND (
           COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
           OR (
            $2::boolean
             AND (
               (
                 COALESCE(c.processing_state, c.processing_status) = 'ROUTING_DEFERRED'
                 AND COALESCE(c.routing_disposition, 'TECHNICAL_DEFERRED') = 'TECHNICAL_DEFERRED'
               )
               OR (
                 COALESCE(c.processing_state, c.processing_status) = 'UNMATCHED'
                 AND c.routing_disposition = 'POLICY_NO_MATCH'
               )
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pipeline_tasks replay_task
                WHERE replay_task.workspace_id = c.workspace_id
                  AND replay_task.task_type = 'ROUTE_LANE'
                  AND replay_task.task_key =
                    'ROUTE_LANE:' || jv.id || ':lane_router_v1:repair-' || $3::text
             )
           )
         )
         AND EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           JOIN v_published_semantic_embeddings se
             ON se.workspace_id = ei.workspace_id
            AND se.embedding_input_id = ei.id
           WHERE ei.workspace_id = c.workspace_id
             AND ei.source_type = 'JOB_VERSION'
             AND ei.source_id = jv.id
         )
       ORDER BY jv.observed_at ASC
       LIMIT $4`,
      [ctx.workspaceId, includeRoutingDeferred, routingDeferredReplayVersion, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: {
          canonical_job_id: requiredSeedValue(row, "canonical_job_id"),
          job_version_id: requiredSeedValue(row, "job_version_id"),
          ...(row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
          ...(
            includeRoutingDeferred &&
            typeof row.processing_state === "string" &&
            ["ROUTING_DEFERRED", "UNMATCHED"].includes(row.processing_state)
              ? { routing_deferred_replay_version: routingDeferredReplayVersion }
              : {}
          ),
        },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "MATCH_PROFILE_EVIDENCE",
      `SELECT c.id AS canonical_job_id,
              COALESCE(c.latest_job_version_id, jv.id) AS job_version_id,
              active_profile.id AS profile_version_id,
              TRUE AS reprocess_existing_state
       FROM canonical_jobs c
       CROSS JOIN LATERAL (
         SELECT pv.id
         FROM profile_versions pv
         WHERE pv.workspace_id = c.workspace_id
           AND pv.status = 'ACTIVE'
         ORDER BY pv.created_at DESC
         LIMIT 1
       ) active_profile
       LEFT JOIN LATERAL (
         SELECT id
         FROM job_versions
         WHERE workspace_id = c.workspace_id AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       JOIN job_versions target_jv
         ON target_jv.workspace_id = c.workspace_id
        AND target_jv.id = COALESCE(c.latest_job_version_id, jv.id)
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) IN (
           'LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI', 'EVALUATING', 'AI_EVALUATED', 'EVALUATED'
         )
         AND c.primary_lane IS NOT NULL
         AND c.primary_lane <> 'UNCLASSIFIED'
         AND COALESCE(c.latest_job_version_id, jv.id) IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM job_version_pipeline_state ps
           JOIN requirement_extraction_runs rer
             ON rer.workspace_id = ps.workspace_id
            AND rer.job_version_id = ps.job_version_id
            AND rer.run_type = 'DETERMINISTIC'
            AND rer.status = 'COMPLETED'
            AND target_jv.active_requirement_set_id IS NOT NULL
            AND rer.requirement_set_id = target_jv.active_requirement_set_id
           WHERE ps.workspace_id = c.workspace_id
             AND ps.job_version_id = target_jv.id
             AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
             AND ps.stage_status = 'COMPLETED'
         )
         AND (
           COALESCE(c.processing_state, c.processing_status) = 'LANE_ROUTED'
           OR NOT EXISTS (
             SELECT 1
             FROM match_runs mr
             WHERE mr.workspace_id = c.workspace_id
               AND mr.id = c.latest_match_run_id
               AND mr.canonical_job_id = c.id
               AND mr.job_version_id = target_jv.id
               AND mr.profile_version_id = active_profile.id
               AND mr.requirement_set_id = target_jv.active_requirement_set_id
               AND mr.job_content_hash = target_jv.content_hash
               AND mr.status = 'COMPLETED'
               AND mr.context_fingerprint IS NOT NULL
               AND (
                 mr.requirement_count = 0
                 OR mr.embedding_space_id IS NOT NULL
               )
           )
         )
       ORDER BY c.updated_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: {
          canonical_job_id: requiredSeedValue(row, "canonical_job_id"),
          job_version_id: requiredSeedValue(row, "job_version_id"),
          profile_version_id: row.profile_version_id,
          ...(row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
        },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "DECIDE_RECOMMENDATION",
      `SELECT c.id AS canonical_job_id,
              COALESCE(c.latest_job_version_id, jv.id) AS job_version_id,
              jv.content_hash,
              jv.active_requirement_set_id,
              c.latest_match_run_id AS match_run_id,
              c.latest_deterministic_decision_id AS deterministic_decision_id,
              active_profile.id AS profile_version_id,
              TRUE AS repair_existing_state,
              (${readinessRefreshPredicate} AND c.recommendation_outcome IS NOT NULL) AS readiness_reassessment_required
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT pv.id
         FROM profile_versions pv
         WHERE pv.workspace_id = c.workspace_id
           AND pv.status = 'ACTIVE'
         ORDER BY pv.created_at DESC
         LIMIT 1
       ) active_profile ON TRUE
       LEFT JOIN LATERAL (
         SELECT id, content_hash, active_requirement_set_id
         FROM job_versions
         WHERE workspace_id = c.workspace_id AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       WHERE c.workspace_id = $1
         AND (
           COALESCE(c.processing_state, c.processing_status) IN (
             'HARD_REJECTED', 'NEEDS_VERIFICATION', 'ROUTING_DEFERRED',
             'MATCHED', 'QUEUED_FOR_AI', 'NEEDS_MANUAL_REVIEW'
           )
           OR ${readinessRefreshPredicate}
         )
         AND COALESCE(c.latest_job_version_id, jv.id) IS NOT NULL
         AND (
           c.recommendation_outcome IS NULL
           OR ${readinessRefreshPredicate}
         )
         AND (
           COALESCE(c.processing_state, c.processing_status) IN (
             'HARD_REJECTED', 'NEEDS_VERIFICATION', 'ROUTING_DEFERRED'
           )
           OR EXISTS (
             SELECT 1
             FROM job_versions target_jv
             JOIN profile_versions current_profile
               ON current_profile.workspace_id = target_jv.workspace_id
              AND current_profile.status = 'ACTIVE'
             JOIN match_runs current_match
               ON current_match.workspace_id = c.workspace_id
              AND current_match.canonical_job_id = c.id
              AND current_match.id = c.latest_match_run_id
              AND current_match.job_version_id = target_jv.id
              AND current_match.profile_version_id = current_profile.id
              AND current_match.requirement_set_id = target_jv.active_requirement_set_id
              AND current_match.job_content_hash = target_jv.content_hash
              AND current_match.context_fingerprint IS NOT NULL
              AND current_match.status = 'COMPLETED'
             WHERE target_jv.workspace_id = c.workspace_id
               AND target_jv.id = COALESCE(c.latest_job_version_id, jv.id)
           )
         )
       ORDER BY c.updated_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: {
          canonical_job_id: requiredSeedValue(row, "canonical_job_id"),
          job_version_id: requiredSeedValue(row, "job_version_id"),
          content_hash: row.content_hash ?? null,
          active_requirement_set_id: row.active_requirement_set_id ?? null,
          match_run_id: row.match_run_id ?? null,
          deterministic_decision_id: row.deterministic_decision_id ?? null,
          ...(row.profile_version_id ? { profile_version_id: row.profile_version_id } : {}),
          ...(row.repair_existing_state === true ? { repair_existing_state: true } : {}),
          ...(row.readiness_reassessment_required === true
            ? { reprocess_existing_state: true, reassessment_reason: "APPLICATION_READINESS_REFRESH" }
            : {}),
        },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "ENQUEUE_EXPLANATION",
      `SELECT c.id AS canonical_job_id, COALESCE(c.latest_job_version_id, jv.id) AS job_version_id
       FROM canonical_jobs c
       LEFT JOIN LATERAL (
         SELECT id
         FROM job_versions
         WHERE workspace_id = c.workspace_id AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED', 'QUEUED_FOR_AI')
         AND COALESCE(c.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
         AND COALESCE(c.recommendation_outcome, 'TRACK') IN ('PRIORITY', 'REVIEW')
         AND COALESCE(c.latest_job_version_id, jv.id) IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM job_versions target_jv
           JOIN profile_versions current_profile
             ON current_profile.workspace_id = target_jv.workspace_id
            AND current_profile.status = 'ACTIVE'
           JOIN match_runs current_match
             ON current_match.workspace_id = c.workspace_id
            AND current_match.canonical_job_id = c.id
            AND current_match.id = c.latest_match_run_id
            AND current_match.job_version_id = target_jv.id
            AND current_match.profile_version_id = current_profile.id
            AND current_match.requirement_set_id = target_jv.active_requirement_set_id
            AND current_match.job_content_hash = target_jv.content_hash
            AND current_match.context_fingerprint IS NOT NULL
            AND current_match.status = 'COMPLETED'
           JOIN deterministic_decisions current_decision
             ON current_decision.workspace_id = c.workspace_id
            AND current_decision.id = c.latest_deterministic_decision_id
            AND current_decision.canonical_job_id = c.id
            AND current_decision.job_version_id = target_jv.id
            AND current_decision.match_run_id = current_match.id
            AND current_decision.context_fingerprint IS NOT NULL
           WHERE target_jv.workspace_id = c.workspace_id
             AND target_jv.id = COALESCE(c.latest_job_version_id, jv.id)
         )
         AND NOT EXISTS (
           SELECT 1
           FROM ai_evaluations ae
           WHERE ae.workspace_id = c.workspace_id
             AND ae.canonical_job_id = c.id
             AND ae.job_version_id = COALESCE(c.latest_job_version_id, jv.id)
             AND ae.profile_version_id IS NOT DISTINCT FROM (
               SELECT pv.id
               FROM profile_versions pv
               WHERE pv.workspace_id = c.workspace_id
                 AND pv.status = 'ACTIVE'
               ORDER BY pv.created_at DESC
               LIMIT 1
             )
             AND ae.match_run_id = c.latest_match_run_id
             AND ae.deterministic_decision_id = c.latest_deterministic_decision_id
             AND ae.job_content_hash IS NOT DISTINCT FROM (
               SELECT target_jv.content_hash
               FROM job_versions target_jv
               WHERE target_jv.workspace_id = c.workspace_id
                 AND target_jv.id = COALESCE(c.latest_job_version_id, jv.id)
             )
             AND ae.context_fingerprint IS NOT NULL
         )
       ORDER BY c.updated_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: requiredSeedValue(row, "job_version_id"),
        payload: {
          canonical_job_id: requiredSeedValue(row, "canonical_job_id"),
          job_version_id: requiredSeedValue(row, "job_version_id"),
          ...(options.budgetRunId ? { queue_budget_run_id: options.budgetRunId } : {}),
        },
      }),
      enabledTypes,
      includeTestFixtures,
      deadlineAt,
    seedScope,
    maxPerType,
    );

    return summary;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}

async function lookupObservationVersion(
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  observationId: string
): Promise<{ canonicalJobId: string | null; jobVersionId: string | null }> {
  const { rows } = await (clientOrPool as QueryClient).query<{
    canonical_job_id: string | null;
    job_version_id: string | null;
  }>(
    `SELECT jv.canonical_job_id, obs.job_version_id
     FROM raw_job_observations obs
     LEFT JOIN job_versions jv
       ON jv.workspace_id = obs.workspace_id
      AND jv.id = obs.job_version_id
     WHERE obs.workspace_id = $1
       AND obs.id = $2
     LIMIT 1`,
    [ctx.workspaceId, observationId]
  );
  return {
    canonicalJobId: rows[0]?.canonical_job_id ?? null,
    jobVersionId: rows[0]?.job_version_id ?? null,
  };
}

async function taskTargetsTestFixture(
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
): Promise<boolean> {
  const canonicalJobId = optionalStringPayload(task, "canonical_job_id");
  const jobVersionId = optionalStringPayload(task, "job_version_id");
  const observationId = optionalStringPayload(task, "observation_id");
  if (!canonicalJobId && !jobVersionId && !observationId) return false;

  const { rows } = await (clientOrPool as QueryClient).query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM canonical_jobs c
       LEFT JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.canonical_job_id = c.id
       LEFT JOIN raw_job_observations observation
         ON observation.workspace_id = c.workspace_id
        AND observation.job_version_id = jv.id
       WHERE c.workspace_id = $1
         AND c.is_test_fixture = TRUE
         AND (
           c.id::text = $2
           OR jv.id::text = $3
           OR observation.id::text = $4
         )
     ) AS exists`,
    [ctx.workspaceId, canonicalJobId ?? "", jobVersionId ?? "", observationId ?? ""],
  );
  return Boolean(rows[0]?.exists);
}

async function lookupJobState(
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  jobVersionId: string
): Promise<{
  canonicalJobId: string | null;
  processingState: string | null;
  primaryLane: string | null;
  laneEvidence: string | null;
  routingDisposition: string | null;
  profileMatchStatus: string | null;
  recommendationEligibility: string | null;
  recommendationOutcome: string | null;
  gateDecision: string | null;
  latestJobVersionId: string | null;
}> {
  const { rows } = await (clientOrPool as QueryClient).query<{
    canonical_job_id: string | null;
    processing_state: string | null;
    primary_lane: string | null;
    lane_evidence: string | null;
    routing_disposition: string | null;
    profile_match_status: string | null;
    gate_decision: string | null;
    recommendation_eligibility: string | null;
    recommendation_outcome: string | null;
    latest_job_version_id: string | null;
  }>(
    `SELECT c.id AS canonical_job_id,
            COALESCE(c.processing_state, c.processing_status) AS processing_state,
            c.primary_lane,
            c.lane_evidence,
            c.routing_disposition,
            c.profile_match_status,
            c.gate_decision,
            c.recommendation_eligibility,
            c.recommendation_outcome,
            c.latest_job_version_id
     FROM job_versions jv
     JOIN canonical_jobs c
       ON c.workspace_id = jv.workspace_id
      AND c.id = jv.canonical_job_id
     WHERE jv.workspace_id = $1
       AND jv.id = $2
     LIMIT 1`,
    [ctx.workspaceId, jobVersionId]
  );
  const row = rows[0];
  return {
    canonicalJobId: row?.canonical_job_id ?? null,
    processingState: row?.processing_state ?? null,
    primaryLane: row?.primary_lane ?? null,
    laneEvidence: row?.lane_evidence ?? null,
    routingDisposition: row?.routing_disposition ?? null,
    profileMatchStatus: row?.profile_match_status ?? null,
    gateDecision: row?.gate_decision ?? null,
    recommendationEligibility: row?.recommendation_eligibility ?? null,
    recommendationOutcome: row?.recommendation_outcome ?? null,
    latestJobVersionId: row?.latest_job_version_id ?? null,
  };
}

async function jobVersionHasCurrentMatch(
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  jobVersionId: string
): Promise<boolean> {
  const { rows } = await (clientOrPool as QueryClient).query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM canonical_jobs c
       JOIN job_versions jv
         ON jv.workspace_id = c.workspace_id
        AND jv.canonical_job_id = c.id
        AND jv.id = $2
       JOIN profile_versions pv
         ON pv.workspace_id = c.workspace_id
        AND pv.status = 'ACTIVE'
       JOIN match_runs mr
         ON mr.workspace_id = c.workspace_id
        AND mr.canonical_job_id = c.id
        AND mr.id = c.latest_match_run_id
        AND mr.job_version_id = jv.id
        AND mr.profile_version_id = pv.id
        AND mr.requirement_set_id = jv.active_requirement_set_id
        AND mr.job_content_hash = jv.content_hash
        AND mr.context_fingerprint IS NOT NULL
        AND mr.status = 'COMPLETED'
       WHERE c.workspace_id = $1
     ) AS exists`,
    [ctx.workspaceId, jobVersionId]
  );
  return Boolean(rows[0]?.exists);
}

async function jobVersionHasEmbedding(
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  jobVersionId: string,
  embeddingSpaceIds: string[]
): Promise<boolean> {
  const { rows } = await (clientOrPool as QueryClient).query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM embedding_inputs ei
       JOIN v_published_semantic_embeddings se
         ON se.workspace_id = ei.workspace_id
        AND se.embedding_input_id = ei.id
       WHERE ei.workspace_id = $1
         AND ei.source_type = 'JOB_VERSION'
         AND ei.source_id = $2
         AND se.embedding_space_id = ANY($3::uuid[])
     ) AS exists`,
    [ctx.workspaceId, jobVersionId, embeddingSpaceIds]
  );
  return Boolean(rows[0]?.exists);
}

async function jobVersionHasCompletedRequirementsExtraction(
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  jobVersionId: string,
  runType: "DETERMINISTIC" | "LLM_QUOTED"
): Promise<boolean> {
  const { rows } = await (clientOrPool as QueryClient).query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM job_version_pipeline_state ps
       JOIN job_versions jv
         ON jv.workspace_id = ps.workspace_id
        AND jv.id = ps.job_version_id
       JOIN requirement_extraction_runs rer
         ON rer.workspace_id = jv.workspace_id
        AND rer.job_version_id = jv.id
        AND rer.run_type = $3
        AND rer.status = 'COMPLETED'
        AND jv.active_requirement_set_id IS NOT NULL
        AND rer.requirement_set_id = jv.active_requirement_set_id
       WHERE jv.workspace_id = $1
         AND jv.id = $2
         AND ps.current_stage = 'REQUIREMENTS_EXTRACTED'
         AND ps.stage_status = 'COMPLETED'
       ) AS exists`,
    [ctx.workspaceId, jobVersionId, runType]
  );
  return Boolean(rows[0]?.exists);
}

function isTechnicalRoutingDeferral(state: {
  processingState: string | null;
  laneEvidence: string | null;
  routingDisposition?: string | null;
}): boolean {
  if (state.processingState !== "ROUTING_DEFERRED") return false;
  if (state.routingDisposition === "POLICY_NO_MATCH") return false;
  if (state.routingDisposition === "TECHNICAL_DEFERRED") return true;
  const evidence = String(state.laneEvidence || "");
  return [
    "ROUTING_ERROR",
    "EMBEDDING_UNAVAILABLE",
    "ZERO_VECTOR_EMBEDDING",
    "EMBEDDING_DIM_MISMATCH",
  ].some((marker) => evidence.includes(marker));
}

interface AutomaticDependency {
  code:
    | "JOB_EMBEDDING_MISSING"
    | "REQUIREMENT_EMBEDDING_MISSING"
    | "PROFILE_FACT_EMBEDDING_MISSING"
    | "LANE_PROTOTYPE_EMBEDDING_MISSING"
    | "EMBEDDING_SPACE_INCOMPATIBLE"
    | "PROVIDER_TEMPORARILY_UNAVAILABLE"
    | "REQUIREMENT_EXTRACTION_INCOMPLETE";
  repairTaskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS" | "PUBLISH_EMBEDDING";
}

function classifyRoutingDependency(laneEvidence: string | null): AutomaticDependency {
  const evidence = String(laneEvidence || "").toUpperCase();
  if (evidence.includes("EMBEDDING_DIM_MISMATCH")) {
    return { code: "EMBEDDING_SPACE_INCOMPATIBLE", repairTaskType: "PUBLISH_EMBEDDING" };
  }
  if (evidence.includes("PROTOTYPE") || evidence.includes("LANE_PROTOTYPE")) {
    return { code: "LANE_PROTOTYPE_EMBEDDING_MISSING", repairTaskType: "PUBLISH_EMBEDDING" };
  }
  if (evidence.includes("ROUTING_ERROR") || evidence.includes("PROVIDER") || evidence.includes("UNAVAILABLE")) {
    return { code: "PROVIDER_TEMPORARILY_UNAVAILABLE", repairTaskType: "PUBLISH_EMBEDDING" };
  }
  return { code: "JOB_EMBEDDING_MISSING", repairTaskType: "PUBLISH_EMBEDDING" };
}

async function classifySemanticMatchDependency(
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  jobVersionId: string,
): Promise<AutomaticDependency> {
  const { rows } = await (clientOrPool as QueryClient).query<{
    has_active_space: boolean;
    requirements_complete: boolean;
    profile_facts_complete: boolean;
    complete_cohort: boolean;
  }>(
    `WITH active_spaces AS (
       SELECT id
       FROM embedding_spaces
       WHERE workspace_id = $1 AND active = TRUE
     ),
     requirements AS (
       SELECT requirement.id::text AS node_id
       FROM job_versions version
       JOIN job_requirements requirement
         ON requirement.workspace_id = version.workspace_id
        AND requirement.requirement_set_id = version.active_requirement_set_id
        AND requirement.status = 'VALIDATED'
       WHERE version.workspace_id = $1
         AND version.id = $2
     ),
     profile_facts AS (
       SELECT COALESCE(fact.fact_revision_id, fact.id)::text AS node_id
       FROM profile_versions profile
       JOIN profile_facts fact
         ON fact.workspace_id = profile.workspace_id
        AND fact.profile_version_id = profile.id
       WHERE profile.workspace_id = $1
         AND profile.status = 'ACTIVE'
         AND fact.fact_type <> 'CONTACT'
         AND fact.confidentiality IN ('PUBLIC', 'PRIVATE_REUSABLE')
     )
     SELECT
       EXISTS (SELECT 1 FROM active_spaces) AS has_active_space,
       EXISTS (
         SELECT 1
         FROM active_spaces space
         WHERE NOT EXISTS (
           SELECT 1
           FROM requirements requirement
           WHERE NOT EXISTS (
             SELECT 1
             FROM v_matchable_nodes node
             WHERE node.workspace_id = $1
               AND node.embedding_space_id = space.id
               AND node.node_type = 'JOB_REQUIREMENT'
               AND node.node_id::text = requirement.node_id
           )
         )
       ) AS requirements_complete,
       EXISTS (
         SELECT 1
         FROM active_spaces space
         WHERE NOT EXISTS (
           SELECT 1
           FROM profile_facts fact
           WHERE NOT EXISTS (
             SELECT 1
             FROM v_matchable_nodes node
             WHERE node.workspace_id = $1
               AND node.embedding_space_id = space.id
               AND node.node_type = 'PROFILE_FACT'
               AND node.node_id::text = fact.node_id
           )
         )
       ) AS profile_facts_complete,
       EXISTS (
         SELECT 1
         FROM active_spaces space
         WHERE NOT EXISTS (
           SELECT 1
           FROM requirements requirement
           WHERE NOT EXISTS (
             SELECT 1
             FROM v_matchable_nodes node
             WHERE node.workspace_id = $1
               AND node.embedding_space_id = space.id
               AND node.node_type = 'JOB_REQUIREMENT'
               AND node.node_id::text = requirement.node_id
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM profile_facts fact
           WHERE NOT EXISTS (
             SELECT 1
             FROM v_matchable_nodes node
             WHERE node.workspace_id = $1
               AND node.embedding_space_id = space.id
               AND node.node_type = 'PROFILE_FACT'
               AND node.node_id::text = fact.node_id
           )
         )
       ) AS complete_cohort`,
    [ctx.workspaceId, jobVersionId],
  );
  const result = rows[0];
  if (!result?.has_active_space || result.complete_cohort) {
    return { code: "EMBEDDING_SPACE_INCOMPATIBLE", repairTaskType: "PUBLISH_EMBEDDING" };
  }
  if (!result.requirements_complete) {
    return { code: "REQUIREMENT_EMBEDDING_MISSING", repairTaskType: "PUBLISH_EMBEDDING" };
  }
  if (!result.profile_facts_complete) {
    return { code: "PROFILE_FACT_EMBEDDING_MISSING", repairTaskType: "PUBLISH_EMBEDDING" };
  }
  return { code: "EMBEDDING_SPACE_INCOMPATIBLE", repairTaskType: "PUBLISH_EMBEDDING" };
}

async function enqueueDependencyRepair(
  dependency: AutomaticDependency,
  task: ClaimedPipelineTask,
  jobVersionId: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
): Promise<boolean> {
  const payload = task.payload as Record<string, unknown> | null;
  const repairPayload = {
    canonical_job_id: payload?.canonical_job_id,
    job_version_id: jobVersionId,
    repair_dependency: dependency.code,
    repair_generation: SEMANTIC_MATCH_REPAIR_GENERATION,
    repair_attempt: task.attemptNumber,
    ...(dependency.repairTaskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS"
      ? { repair_existing_state: true }
      : { reprocess_existing_state: true }),
  };
  return enqueueStageTask(dependency.repairTaskType, jobVersionId, repairPayload, clientOrPool, ctx);
}

async function reactivateBlockedDependencyTasks(
  repairTaskType: AutomaticDependency["repairTaskType"],
  jobVersionId: string,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
): Promise<void> {
  await (clientOrPool as QueryClient).query(
    `UPDATE pipeline_tasks
     SET status = 'PENDING',
         available_at = NOW(),
         lease_id = NULL,
         lease_expires_at = NULL,
         heartbeat_at = NULL,
         claimed_by = NULL,
         last_error = NULL,
         blocked_on = NULL,
         blocked_reason = NULL,
         repair_action = NULL,
         completed_at = NULL,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND status = 'BLOCKED_DEPENDENCY'
       AND repair_action = $2
       AND payload->>'job_version_id' = $3`,
    [ctx.workspaceId, repairTaskType, jobVersionId],
  );
}

async function markTaskTargetProcessingError(
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  errorMessage: string
): Promise<void> {
  const payload = (task.payload || {}) as Record<string, unknown>;
  let canonicalJobId = typeof payload.canonical_job_id === "string" ? payload.canonical_job_id : null;
  const jobVersionId = typeof payload.job_version_id === "string" ? payload.job_version_id : null;
  if (!canonicalJobId && jobVersionId) {
    const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
    canonicalJobId = state.canonicalJobId;
  }
  if (!canonicalJobId) return;

  await (clientOrPool as QueryClient).query(
    `UPDATE canonical_jobs
     SET processing_state = 'PROCESSING_ERROR',
         processing_status = 'PROCESSING_ERROR',
         rejection_reason = COALESCE(rejection_reason, $3),
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = $2
       AND COALESCE(processing_state, processing_status) <> 'MANUALLY_REMOVED'`,
    [ctx.workspaceId, canonicalJobId, `ENGINE_ERROR: task ${task.taskKey} exhausted automatic retries: ${errorMessage}`]
  );
}

async function maybeEnqueueAfterTask(
  taskType: PipelineStageTaskType,
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext
): Promise<number> {
  let insertedSuccessors = 0;
  const enqueueSuccessor = async (
    successorType: PipelineStageTaskType,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (await enqueueStageTask(successorType, id, payload, clientOrPool, ctx)) insertedSuccessors += 1;
  };
  const payload = (task.payload || {}) as Record<string, unknown>;
  const jobVersionId = typeof payload.job_version_id === "string" ? payload.job_version_id : null;

  if (taskType === "NORMALIZE_OBSERVATION") {
    const observationId = requireStringPayload(task, "observation_id");
    const mapping = await lookupObservationVersion(clientOrPool, ctx, observationId);
    if (mapping.jobVersionId) {
      await enqueueSuccessor(
        "EXTRACT_DETERMINISTIC_REQUIREMENTS",
        mapping.jobVersionId,
        { canonical_job_id: mapping.canonicalJobId, job_version_id: mapping.jobVersionId },
      );
    }
    return insertedSuccessors;
  }

  if (!jobVersionId) return insertedSuccessors;

  if (taskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS") {
    await reactivateBlockedDependencyTasks(
      "EXTRACT_DETERMINISTIC_REQUIREMENTS",
      jobVersionId,
      clientOrPool,
      ctx,
    );
    const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
    const repairExistingState = payload.repair_existing_state === true;
    const rematchableStates = new Set([
      "LANE_ROUTED",
      "MATCHED",
      "QUEUED_FOR_AI",
      "EVALUATING",
      "AI_EVALUATED",
      "EVALUATED",
    ]);
    if (
      repairExistingState &&
      rematchableStates.has(state.processingState || "") &&
      state.primaryLane &&
      state.primaryLane !== "UNCLASSIFIED"
    ) {
      await enqueueSuccessor(
        "MATCH_PROFILE_EVIDENCE",
        jobVersionId,
        {
          canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
          job_version_id: jobVersionId,
        },
      );
      return insertedSuccessors;
    }
    if (repairExistingState && state.processingState === "PREQUALIFIED") {
      await enqueueSuccessor("PUBLISH_EMBEDDING", jobVersionId, {
        canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
        job_version_id: jobVersionId,
      });
      return insertedSuccessors;
    }
    await enqueueSuccessor("APPLY_HARD_GATES", jobVersionId, payload);
    return insertedSuccessors;
  }

  const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
  const stagePayload = {
    canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
    job_version_id: jobVersionId,
    ...(payload.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
    ...(typeof payload.repair_dependency === "string" ? { repair_dependency: payload.repair_dependency } : {}),
    ...(typeof payload.repair_generation === "string" ? { repair_generation: payload.repair_generation } : {}),
    ...(typeof payload.repair_match_run_id === "string" ? { repair_match_run_id: payload.repair_match_run_id } : {}),
  };

  if (taskType === "APPLY_HARD_GATES") {
    if (state.processingState === "PREQUALIFIED") {
      // Quoted requirements are advisory enrichment and must be explicitly
      // drained after the mandatory pipeline. Publish deterministic
      // requirement embeddings immediately so quote-provider latency/failure
      // cannot hold a gate-passed job before lane routing.
      await enqueueSuccessor("PUBLISH_EMBEDDING", jobVersionId, stagePayload);
    } else if (state.processingState === "HARD_REJECTED" || state.processingState === "NEEDS_VERIFICATION") {
      await enqueueSuccessor("DECIDE_RECOMMENDATION", jobVersionId, stagePayload);
    }
    return insertedSuccessors;
  }

  if (taskType === "EXTRACT_QUOTED_REQUIREMENTS") {
    await enqueueSuccessor("PUBLISH_EMBEDDING", jobVersionId, stagePayload);
    return insertedSuccessors;
  }

  if (taskType === "PUBLISH_EMBEDDING") {
    await reactivateBlockedDependencyTasks("PUBLISH_EMBEDDING", jobVersionId, clientOrPool, ctx);
    await enqueueSuccessor("ROUTE_LANE", jobVersionId, stagePayload);
    return insertedSuccessors;
  }

  if (taskType === "ROUTE_LANE") {
    if (state.processingState === "LANE_ROUTED") {
      await enqueueSuccessor("MATCH_PROFILE_EVIDENCE", jobVersionId, stagePayload);
    } else if (state.processingState === "ROUTING_DEFERRED") {
      await enqueueSuccessor("DECIDE_RECOMMENDATION", jobVersionId, stagePayload);
    }
    return insertedSuccessors;
  }

  if (taskType === "MATCH_PROFILE_EVIDENCE") {
    if (
      ![
        "LANE_ROUTED",
        "MATCHED",
        "QUEUED_FOR_AI",
        "EVALUATING",
        "AI_EVALUATED",
        "EVALUATED",
      ].includes(state.processingState || "")
    ) {
      // A match is meaningful only after semantic lane routing has produced a
      // lane. Deferred and gate-verification states are valid terminal/holding
      // outcomes for this stage; stale matcher tasks must not retry or create
      // manual review noise for them.
      return insertedSuccessors;
    }
    await enqueueSuccessor("DECIDE_RECOMMENDATION", jobVersionId, stagePayload);
    return insertedSuccessors;
  }

  if (
    taskType === "DECIDE_RECOMMENDATION" &&
    state.recommendationEligibility === "ELIGIBLE" &&
    (state.recommendationOutcome === "PRIORITY" || state.recommendationOutcome === "REVIEW")
  ) {
    await enqueueSuccessor("ENQUEUE_EXPLANATION", jobVersionId, stagePayload);
  }
  return insertedSuccessors;
}

async function executeStageTask(
  taskType: PipelineStageTaskType,
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  dependencies: PipelineStageWorkerDependencies,
  budgetRunId: string,
  onSuccessorTaskCreated: () => void,
  onTaskRerouted: () => void,
): Promise<void> {
  if (taskType === "NORMALIZE_OBSERVATION") {
    const observationId = requireStringPayload(task, "observation_id");
    const summary = await dependencies.runNormalization(clientOrPool, {
      context: ctx,
      observationIds: [observationId],
      limit: 1,
    });
    if (summary.totalErrors > 0) {
      throw new Error(`Normalization failed for observation ${observationId}.`);
    }
    const mapping = await lookupObservationVersion(clientOrPool, ctx, observationId);
    if (!mapping.jobVersionId) {
      throw new Error(`Observation ${observationId} still has no job_version_id after normalization.`);
    }
    return;
  }

  const jobVersionId = requireStringPayload(task, "job_version_id");

  if (taskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS") {
    const payload = (task.payload || {}) as Record<string, unknown>;
    const reprocess = payload.reprocess === true;
    const currentState = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (currentState.latestJobVersionId && currentState.latestJobVersionId !== jobVersionId) {
      if (!reprocess) return;
      const canonicalJobId = currentState.canonicalJobId ?? optionalStringPayload(task, "canonical_job_id");
      if (!canonicalJobId) throw new Error(`Forced extraction task ${task.taskKey} has no canonical job identity.`);
      const payload = forcedTaskReroutePayload(task, canonicalJobId, currentState.latestJobVersionId);
      const reroute = forcedTaskRerouteIntent(task);
      if (await enqueueStageTask(
        "EXTRACT_DETERMINISTIC_REQUIREMENTS",
        currentState.latestJobVersionId,
        payload,
        clientOrPool,
        ctx,
        reroute,
      )) onSuccessorTaskCreated();
      onTaskRerouted();
      return;
    }
    if (["HARD_REJECTED", "MANUALLY_REMOVED", "UNMATCHED"].includes(currentState.processingState || "")) {
      // Deterministic requirements are not a prerequisite for a terminal
      // hard rejection. Old extraction tasks can remain queued after a gate
      // recalculation; complete them as harmless no-ops rather than creating
      // retry/manual-review noise for a job that cannot advance.
      return;
    }
    const summary = await dependencies.runRequirementsExtraction(clientOrPool, {
      context: ctx,
      jobVersionIds: [jobVersionId],
      limit: 1,
      quotedMode: "deterministic_only",
      failFastOnQuotedProviderFailure: false,
      ignoreRetryWindow: true,
      reprocess,
    });
    if (summary.errors > 0) {
      throw new Error(`Deterministic requirement extraction failed for job_version_id=${jobVersionId}.`);
    }
    const hasCompletedDeterministicRun = await jobVersionHasCompletedRequirementsExtraction(
      clientOrPool,
      ctx,
      jobVersionId,
      "DETERMINISTIC"
    );
    if (!hasCompletedDeterministicRun) {
      throw new Error(`No completed deterministic requirement extraction found for job_version_id=${jobVersionId}.`);
    }
    return;
  }

  if (taskType === "APPLY_HARD_GATES") {
    const payload = (task.payload || {}) as Record<string, unknown>;
    const verificationAnswerRevisionId = optionalStringPayload(task, "verification_answer_revision_id");
    const reprocess = payload.force_policy_recalculation === true ||
      payload.reprocess === true ||
      verificationAnswerRevisionId !== undefined;
    const currentState = await lookupJobState(clientOrPool, ctx, jobVersionId);

    if (currentState.latestJobVersionId && currentState.latestJobVersionId !== jobVersionId) {
      if (!reprocess) return;
      const canonicalJobId = currentState.canonicalJobId ?? optionalStringPayload(task, "canonical_job_id");
      if (!canonicalJobId) throw new Error(`Forced hard-gate task ${task.taskKey} has no canonical job identity.`);
      const payload = forcedTaskReroutePayload(task, canonicalJobId, currentState.latestJobVersionId);
      const reroute = forcedTaskRerouteIntent(task);
      if (await enqueueStageTask(
        "APPLY_HARD_GATES",
        currentState.latestJobVersionId,
        payload,
        clientOrPool,
        ctx,
        reroute,
      )) onSuccessorTaskCreated();
      onTaskRerouted();
      return;
    }

    // A durable gate task can outlive the job state that created it. This is
    // expected when a prior worker advanced the job before a duplicate/stale
    // task was claimed. Do not turn that stale task into a retry storm. A
    // forced policy recalculation is the explicit exception and must rerun.
    if (!reprocess && currentState.processingState && currentState.processingState !== "RAW_STAGED") {
      return;
    }

    const summary = await dependencies.runHardGates(clientOrPool, {
      context: ctx,
      jobVersionIds: [jobVersionId],
      limit: 1,
      reprocess,
      verificationJobVersionId: jobVersionId,
      ...(verificationAnswerRevisionId
        ? { verificationAnswerRevisionId }
        : {}),
    });
    if (summary.errors > 0) {
      throw new Error(`Hard gate failed for job_version_id=${jobVersionId}.`);
    }
    const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (!["PREQUALIFIED", "HARD_REJECTED", "NEEDS_VERIFICATION"].includes(state.processingState || "")) {
      throw new Error(`Hard gate left job_version_id=${jobVersionId} in unexpected state ${state.processingState}.`);
    }

    const policyRecheckRequestId = optionalStringPayload(task, "policy_recheck_request_id");
    if (policyRecheckRequestId) {
      const canonicalJobId = state.canonicalJobId ?? optionalStringPayload(task, "canonical_job_id");
      if (!canonicalJobId) {
        throw new Error(`Policy recheck task is missing canonical_job_id for request ${policyRecheckRequestId}.`);
      }
      const resolved = await clientOrPool.query(
        `UPDATE policy_recheck_requests
         SET status = 'RESOLVED',
             resolution_outcome = $5,
             resolved_at = NOW()
         WHERE workspace_id = $1
           AND id = $2::uuid
           AND canonical_job_id = $3::uuid
           AND job_version_id = $4::uuid
           AND status = 'PENDING'
         RETURNING id`,
        [
          ctx.workspaceId,
          policyRecheckRequestId,
          canonicalJobId,
          jobVersionId,
          `DETERMINISTIC_GATE_RECHECK_COMPLETED:${state.processingState}`,
        ]
      );
      if ((resolved.rowCount ?? 0) === 0) {
        const existing = await clientOrPool.query<{ status: string }>(
          `SELECT status FROM policy_recheck_requests WHERE workspace_id = $1 AND id = $2::uuid LIMIT 1`,
          [ctx.workspaceId, policyRecheckRequestId]
        );
        if (!existing.rows[0]) {
          throw new Error(`Policy recheck request ${policyRecheckRequestId} disappeared before resolution.`);
        }
      }
    }
    return;
  }

  if (taskType === "EXTRACT_QUOTED_REQUIREMENTS") {
    await dependencies.runRequirementsExtraction(clientOrPool, {
      context: ctx,
      jobVersionIds: [jobVersionId],
      limit: 1,
      quotedMode: "with_quoted",
      ignoreRetryWindow: true,
    });
    // Quoted extraction is optional enrichment. The deterministic run is the
    // gate for continuing the pipeline; quoted provider/validation failures
    // remain in the extraction audit and do not create manual-review state.
    // A missing/failed LLM_QUOTED run is expected to be recoverable enrichment
    // debt, not a blocker for embeddings, lane routing, or deterministic match.
    return;
  }

  if (taskType === "PUBLISH_EMBEDDING") {
    const maxItems = Number.parseInt(String(process.env.PIPELINE_TASK_EMBEDDING_BATCH_SIZE || "500"), 10);
    const summary = await dependencies.runEmbeddingBatchWithFallback(
      Number.isFinite(maxItems) && maxItems > 0 ? maxItems : 500,
      clientOrPool,
      {
        context: ctx,
        jobVersionIds: [jobVersionId],
        includeProfileFacts: true,
        includeLanePrototypes: true,
      }
    );
    const fallbackFailed = summary.fallback?.failed ?? 0;
    if (summary.primary.failed > 0 && fallbackFailed > 0) {
      throw new Error(
        `Embedding publication failed for ${summary.primary.failed + fallbackFailed} input(s).`
      );
    }
    const usableSpaceIds = [
      summary.seededSpaces.primarySpaceId,
      ...(summary.primary.failed > 0 && summary.fallback
        ? [summary.seededSpaces.fallbackSpaceId]
        : []),
    ];
    const embedded = await jobVersionHasEmbedding(clientOrPool, ctx, jobVersionId, usableSpaceIds);
    if (!embedded) {
      throw new Error(`No published JOB_VERSION embedding found for job_version_id=${jobVersionId}.`);
    }
    return;
  }

  if (taskType === "ROUTE_LANE") {
    const routeState = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (
      routeState.latestJobVersionId &&
      routeState.latestJobVersionId !== jobVersionId
    ) {
      return;
    }
    const summary = await dependencies.runLaneRouting(clientOrPool, {
      context: ctx,
      jobVersionIds: [jobVersionId],
      limit: 1,
    });
    const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
    // A duplicate or late route task can arrive after a concurrent worker has
    // already completed matching. Treat all downstream states as an
    // idempotent no-op; retrying this task must not create a false failure or
    // dead-letter an already-successful job.
    const processingState = state.processingState;
    if (
      [
        "LANE_ROUTED",
        "UNMATCHED",
        "MATCHED",
        "QUEUED_FOR_AI",
        "EVALUATING",
        "AI_EVALUATED",
        "EVALUATED",
      ].includes(processingState ?? "")
    ) return;
    if (isTechnicalRoutingDeferral(state)) {
      const dependency = classifyRoutingDependency(state.laneEvidence);
      await enqueueDependencyRepair(dependency, task, jobVersionId, clientOrPool, ctx);
      throw new PipelineTaskDependencyBlockedError(
        `${dependency.code}:${jobVersionId}`,
        dependency.repairTaskType,
        `Lane routing is blocked by ${dependency.code} for job_version_id=${jobVersionId}.`,
      );
    }
    if (state.processingState === "ROUTING_DEFERRED" && summary.deferred >= 0) return;
    throw new Error(`Lane routing did not advance job_version_id=${jobVersionId}; state=${state.processingState}.`);
  }

  if (taskType === "MATCH_PROFILE_EVIDENCE") {
    const matchState = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (
      matchState.latestJobVersionId &&
      matchState.latestJobVersionId !== jobVersionId
    ) {
      return;
    }
    if (
      ![
        "LANE_ROUTED",
        "MATCHED",
        "UNMATCHED",
        "QUEUED_FOR_AI",
        "EVALUATING",
        "AI_EVALUATED",
        "EVALUATED",
      ].includes(matchState.processingState || "")
    ) {
      // ROUTING_DEFERRED and NEEDS_VERIFICATION intentionally have no profile
      // match to perform. Complete stale tasks without converting a holding or
      // verification state into a retry/manual-review failure.
      return;
    }
    if (["MATCHED", "UNMATCHED"].includes(matchState.processingState || "")) {
      return;
    }
    const hasCompletedDeterministicRun = await jobVersionHasCompletedRequirementsExtraction(
      clientOrPool,
      ctx,
      jobVersionId,
      "DETERMINISTIC"
    );
    if (!hasCompletedDeterministicRun) {
      const repairInserted = await enqueueStageTask(
        "EXTRACT_DETERMINISTIC_REQUIREMENTS",
        jobVersionId,
        {
          canonical_job_id: (task.payload as Record<string, unknown> | null)?.canonical_job_id,
          job_version_id: jobVersionId,
          repair_existing_state: true,
        },
        clientOrPool,
        ctx
      );
      if (repairInserted) onSuccessorTaskCreated();
      throw new PipelineTaskDependencyBlockedError(
        `EXTRACT_DETERMINISTIC_REQUIREMENTS:${jobVersionId}`,
        "EXTRACT_DETERMINISTIC_REQUIREMENTS",
        `Matching is blocked until deterministic requirements are current for job_version_id=${jobVersionId}.`
      );
    }
    const summary = await dependencies.runDeterministicMatcher(clientOrPool, {
      context: ctx,
      jobVersionIds: [jobVersionId],
      limit: 1,
    });
    if (summary.errors > 0) {
      throw new Error(`Deterministic matching reported ${summary.errors} error(s).`);
    }
    const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (["MATCHED", "UNMATCHED"].includes(state.processingState || "")) {
      return;
    }
    if (state.processingState === "LANE_ROUTED" && state.profileMatchStatus === "UNKNOWN") {
      const dependency = await classifySemanticMatchDependency(clientOrPool, ctx, jobVersionId);
      if (await enqueueDependencyRepair(dependency, task, jobVersionId, clientOrPool, ctx)) {
        onSuccessorTaskCreated();
      }
      throw new PipelineTaskDependencyBlockedError(
        `${dependency.code}:${jobVersionId}`,
        dependency.repairTaskType,
        `Matching is blocked by ${dependency.code} for job_version_id=${jobVersionId}.`,
      );
    }
    throw new Error(`Deterministic matching left job_version_id=${jobVersionId} in state ${state.processingState}.`);
  }

  if (taskType === "DECIDE_RECOMMENDATION") {
    const decisionState = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (decisionState.latestJobVersionId && decisionState.latestJobVersionId !== jobVersionId) {
      // The canonical job advanced after this task was enqueued. Complete the
      // stale task without retrying obsolete work; the current version has its
      // own context-specific task identity.
      return;
    }
    if (["RAW_STAGED", "PREQUALIFIED"].includes(decisionState.processingState || "")) {
      // Recommendation decisions are downstream of lane routing. A stale
      // decision task can survive a retry or historical replay while the job
      // is still in the pre-lane funnel; it is not a dependency failure and
      // must not create a permanent blocked/manual-review record.
      return;
    }
    if (decisionState.recommendationOutcome && ["HARD_REJECTED", "UNMATCHED"].includes(decisionState.processingState || "")) {
      // Terminal jobs with recorded recommendation outcomes are complete.
      return;
    }
    const matchDependentStates = new Set([
      "LANE_ROUTED",
      "MATCHED",
      "QUEUED_FOR_AI",
      "EVALUATING",
      "AI_EVALUATED",
      "EVALUATED",
    ]);
    const isRoutingDeferred = decisionState.processingState === "ROUTING_DEFERRED";
    const isUnmatched = decisionState.processingState === "UNMATCHED";
    const requiresCurrentMatch =
      !isRoutingDeferred &&
      !isUnmatched &&
      (decisionState.gateDecision === "PASS" || matchDependentStates.has(decisionState.processingState || ""));
    if (requiresCurrentMatch && !(await jobVersionHasCurrentMatch(clientOrPool, ctx, jobVersionId))) {
      const payload = (task.payload || {}) as Record<string, unknown>;
      const matchTaskInserted = await enqueueStageTask(
        "MATCH_PROFILE_EVIDENCE",
        jobVersionId,
        {
          canonical_job_id: payload.canonical_job_id,
          job_version_id: jobVersionId,
        },
        clientOrPool,
        ctx
      );
      if (matchTaskInserted) onSuccessorTaskCreated();
      throw new PipelineTaskDependencyBlockedError(
        `MATCH_PROFILE_EVIDENCE:${jobVersionId}`,
        "Run a current profile match, then resume DECIDE_RECOMMENDATION.",
        `Recommendation decision is blocked until a current match exists for job_version_id=${jobVersionId}.`
      );
    }

    const summary = await dependencies.runRecommendationDecider(clientOrPool, {
      context: ctx,
      jobVersionIds: [jobVersionId],
      limit: 1,
    });
    if (summary.errors > 0) {
      throw new Error(`Recommendation decider reported ${summary.errors} error(s).`);
    }
    const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (!state.recommendationOutcome) {
      throw new Error(`Recommendation decider left job_version_id=${jobVersionId} without recommendation_outcome.`);
    }
    return;
  }

  if (taskType === "ENQUEUE_EXPLANATION") {
    await dependencies.runExplanationQueueEnqueuer(clientOrPool, {
      context: ctx,
      jobVersionIds: [jobVersionId],
      limit: 1,
      budgetRunId,
    });
  }
}

interface PipelineTaskRunMetrics {
  successorTasksCreated: number;
  rerouted: boolean;
}

async function processClaimedTask(
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  options: Required<Pick<PipelineStageWorkerOptions, "heartbeatSeconds">> & {
    budgetRunId: string;
    includeTestFixtures: boolean;
  },
  dependencies: PipelineStageWorkerDependencies,
  metrics: PipelineTaskRunMetrics,
): Promise<void> {
  const taskType = task.taskType as PipelineStageTaskType;
  if (!PIPELINE_STAGE_TASK_TYPES.includes(taskType)) {
    throw new Error(`Unsupported pipeline task type: ${task.taskType}`);
  }
  const isTestFixture = !options.includeTestFixtures && await taskTargetsTestFixture(task, clientOrPool, ctx);

  let heartbeatTimer: NodeJS.Timeout | null = null;
  if (options.heartbeatSeconds > 0) {
    heartbeatTimer = setInterval(() => {
      heartbeatPipelineTask(task.taskId, task.leaseId, clientOrPool, {
        context: ctx,
        extendLeaseSeconds: Math.max(options.heartbeatSeconds * 3, 60),
      }).catch((error) => {
        console.warn(`Pipeline task heartbeat failed for ${task.taskKey}:`, error);
      });
    }, options.heartbeatSeconds * 1000);
    heartbeatTimer.unref?.();
  }

  try {
    if (isTestFixture) {
      // Preserve the durable task history but do not execute or seed successor
      // work for release-only canaries in an operational worker.
      await completePipelineTaskAndRun(task, clientOrPool, { context: ctx });
      return;
    }
    if (taskType === "PUBLISH_EMBEDDING") {
      const canonicalJobId = requireStringPayload(task, "canonical_job_id");
      const jobVersionId = requireStringPayload(task, "job_version_id");
      if (!(await isCurrentCanonicalJobVersion(clientOrPool, ctx.workspaceId, canonicalJobId, jobVersionId))) {
        const payload = (task.payload || {}) as Record<string, unknown>;
        const intent = TaskIntentV2Schema.safeParse(payload.task_intent);
        const forced = payload.reprocess === true ||
          payload.force_policy_recalculation === true ||
          payload.reprocess_existing_state === true ||
          optionalStringPayload(task, "verification_answer_revision_id") !== undefined ||
          (intent.success && intent.data.mode === "FORCE_RECOMPUTE");
        if (forced) {
          const currentState = await lookupJobState(clientOrPool, ctx, jobVersionId);
          const latestJobVersionId = currentState.latestJobVersionId;
          const currentCanonicalJobId = currentState.canonicalJobId ?? canonicalJobId;
          if (!latestJobVersionId) {
            throw new Error(`Forced embedding task ${task.taskKey} has no authoritative latest job version.`);
          }
          const reroutedPayload = forcedTaskReroutePayload(task, currentCanonicalJobId, latestJobVersionId);
          const reroute = forcedTaskRerouteIntent(task);
          if (await enqueueStageTask(
            "PUBLISH_EMBEDDING",
            latestJobVersionId,
            reroutedPayload,
            clientOrPool,
            ctx,
            reroute,
          )) metrics.successorTasksCreated += 1;
          metrics.rerouted = true;
          await completePipelineTaskAndRun(task, clientOrPool, { context: ctx });
          return;
        }
        console.info(`Superseding stale embedding task ${task.taskKey} without provider work.`);
        await completePipelineTaskAndRun(task, clientOrPool, { context: ctx });
        return;
      }
    }
    await executeStageTask(
      taskType,
      task,
      clientOrPool,
      ctx,
      dependencies,
      options.budgetRunId,
      () => { metrics.successorTasksCreated += 1; },
      () => { metrics.rerouted = true; },
    );
    await completePipelineTaskAndRun(task, clientOrPool, {
      context: ctx,
      afterComplete: async (transactionClient) => {
        if (!metrics.rerouted) {
          metrics.successorTasksCreated += await maybeEnqueueAfterTask(taskType, task, transactionClient, ctx);
        }
      },
    });
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}

export async function runPipelineStageTaskWorker(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options: PipelineStageWorkerOptions = {},
  dependencies: PipelineStageWorkerDependencies = defaultDependencies
): Promise<PipelineStageWorkerSummary> {
  const pool = clientOrPool || defaultPool;
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;
  const ctx = options.context ?? (await resolveWorkspaceContext(client as any));
  const taskTypes = options.taskTypes ?? [...PIPELINE_STAGE_TASK_TYPES];
  const maxTasks = options.maxTasks ?? 100;
  const claimBatchSize = options.claimBatchSize ?? 1;
  const stageQuantum = Math.max(1, Math.floor(options.stageQuantum ?? 1));
  const leaseSeconds = options.leaseSeconds ?? 300;
  const heartbeatSeconds = options.heartbeatSeconds ?? Math.max(15, Math.floor(leaseSeconds / 3));
  const wallClockMs = options.wallClockMs ?? 55 * 60 * 1000;
  const minTimeToStartTaskMs = Math.max(
    0,
    Math.min(options.minTimeToStartTaskMs ?? 120_000, Math.max(0, wallClockMs - 1)),
  );
  const claimedBy = options.claimedBy ?? `stage-worker:${process.pid}`;
  const budgetRunId = options.budgetRunId?.trim() || crypto.randomUUID();
  const claimedByType: Partial<Record<PipelineStageTaskType, number>> = {};
  const stageStartOffset = Math.max(0, Math.floor(options.stageStartOffset ?? 0));
  let stageRound = 0;
  const startedAt = Date.now();
  const deadlineAt = startedAt + wallClockMs;
  const preparationReserveMs = Math.min(wallClockMs, Math.max(minTimeToStartTaskMs, 1_000));
  const preparationBudgetMs = Math.max(1, wallClockMs - preparationReserveMs);
  const seedTimeBudgetMs = Math.max(1, Math.min(
    Math.floor(options.seedTimeBudgetMs ?? 15_000),
    Math.floor(preparationBudgetMs / 2),
    60_000,
  ));
  const staleReconciliationTimeBudgetMs = Math.max(1, Math.min(
    Math.floor(options.stalePendingReconciliationTimeBudgetMs ?? 10_000),
    preparationBudgetMs - seedTimeBudgetMs,
    60_000,
  ));
  const canStartAnotherTask = () => Date.now() + minTimeToStartTaskMs < deadlineAt;
  const summary: PipelineStageWorkerSummary = {
    seeded: null,
    stalePendingReconciliation: {
      scannedPending: 0,
      current: 0,
      unresolved: 0,
      wouldReconcile: 0,
      reconciled: 0,
      stalePendingReconciledThisRun: 0,
      deferredByBudget: 0,
      decisions: [],
      byClassification: {},
      byReason: {},
      byTaskType: {},
    },
    claimed: 0,
    completed: 0,
    successorTasksCreated: 0,
    blocked: 0,
    failed: 0,
    deadLettered: 0,
    exitReason: "QUEUE_DRAINED",
    durationMs: 0,
    byType: {},
    errors: [],
  };

  try {
    throwIfWorkerCancelled(options.abortSignal);

    if (options.seed !== false) {
      summary.seeded = await seedRecoverablePipelineTasks(client as any, {
        context: ctx,
        taskTypes,
        jobVersionIds: options.jobVersionIds,
        observationIds: options.observationIds,
        includeRoutingDeferred: options.includeRoutingDeferred,
        includeTestFixtures: options.includeTestFixtures,
        routingDeferredReplayVersion: options.routingDeferredReplayVersion,
        budgetRunId,
        maxSeedPerType: options.maxSeedPerType,
        timeBudgetMs: seedTimeBudgetMs,
      });
    }

    if (options.reconcileStalePending !== false) {
      const reconciliationBudgetRemainingMs = Math.max(
        1,
        Math.min(staleReconciliationTimeBudgetMs, preparationBudgetMs - (Date.now() - startedAt)),
      );
      summary.stalePendingReconciliation = await reconcileStalePendingPipelineTasks(
        client as pg.PoolClient,
        ctx,
        {
          apply: true,
          limit: options.maxStalePendingReconciliation ?? 100,
          timeBudgetMs: reconciliationBudgetRemainingMs,
          taskTypes,
          jobVersionIds: options.jobVersionIds,
          observationIds: options.observationIds,
        },
      );
    }

    while (summary.claimed < maxTasks && canStartAnotherTask()) {
      throwIfWorkerCancelled(options.abortSignal);
      let madeProgress = false;

      const roundPlan = planPipelineStageRound(
        taskTypes,
        stageQuantum,
        claimedByType,
        options.maxTasksByType ?? {},
        maxTasks,
        maxTasks - summary.claimed,
        stageRound === 0 || taskTypes.length === 0
          ? stageStartOffset
          : (stageStartOffset + stageRound) % taskTypes.length,
      );
      stageRound += 1;
      for (const { taskType, claimLimit: stagePassLimit } of roundPlan) {
        const stageLimit = Math.max(1, Math.floor(options.maxTasksByType?.[taskType] ?? maxTasks));
        let claimedThisPass = 0;
        while (
          summary.claimed < maxTasks &&
          claimedThisPass < stagePassLimit &&
          (claimedByType[taskType] ?? 0) < stageLimit &&
          canStartAnotherTask()
        ) {
          throwIfWorkerCancelled(options.abortSignal);
          const claimLimit = Math.min(
            claimBatchSize,
            stagePassLimit - claimedThisPass,
            maxTasks - summary.claimed,
            stageLimit - (claimedByType[taskType] ?? 0),
          );
          const claimedTasks = await claimPipelineTasks(
            {
              taskType,
              limit: claimLimit,
              leaseSeconds,
              claimedBy,
              jobVersionIds: options.jobVersionIds,
              observationIds: options.observationIds,
            },
            client as any,
            { context: ctx }
          );

          if (claimedTasks.length === 0) break;
          madeProgress = true;
          claimedThisPass += claimedTasks.length;

          for (const task of claimedTasks) {
            summary.claimed += 1;
            claimedByType[taskType] = (claimedByType[taskType] ?? 0) + 1;
            incrementWorker(summary, task.taskType, "claimed");
            const taskMetrics: PipelineTaskRunMetrics = { successorTasksCreated: 0, rerouted: false };
            try {
              // Keep the cancellation check inside the lease-release catch:
              // aborting immediately after claim must never strand a RUNNING
              // task until its lease expires.
              throwIfWorkerCancelled(options.abortSignal);
              await processClaimedTask(
                task,
                client as any,
                ctx,
                {
                  heartbeatSeconds,
                  budgetRunId,
                  includeTestFixtures: options.includeTestFixtures === true,
                },
                dependencies,
                taskMetrics,
              );
              summary.completed += 1;
              incrementWorker(summary, task.taskType, "completed");
              throwIfWorkerCancelled(options.abortSignal);
            } catch (error) {
              if (error instanceof PipelineWorkerCancelledError) {
                await releasePipelineTaskForRetry(
                  task,
                  error.message,
                  client as any,
                  { context: ctx }
                ).catch((releaseError) => {
                  summary.errors.push({
                    taskType: task.taskType,
                    taskKey: task.taskKey,
                    error: `Cancellation lease release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
                  });
                });
                throw error;
              }
              if (error instanceof PipelineTaskDependencyBlockedError) {
                await blockPipelineTask(
                  task,
                  {
                    blockedOn: error.blockedOn,
                    reason: error.message,
                    repairAction: error.repairAction,
                  },
                  client as any,
                  { context: ctx }
                );
                summary.blocked += 1;
                incrementWorker(summary, task.taskType, "blocked");
                continue;
              }
              const message = error instanceof Error ? error.message : String(error);
              const exhausted = task.attemptNumber >= task.maxAttempts;
              await failPipelineTask(task, message, client as any, { context: ctx });
              if (exhausted) {
                await markTaskTargetProcessingError(task, client as any, ctx, message);
                summary.deadLettered += 1;
                incrementWorker(summary, task.taskType, "deadLettered");
              }
              summary.failed += 1;
              incrementWorker(summary, task.taskType, "failed");
              summary.errors.push({ taskType: task.taskType, taskKey: task.taskKey, error: message });
            } finally {
              summary.successorTasksCreated += taskMetrics.successorTasksCreated;
            }
          }
        }
      }

      if (!madeProgress || taskTypes.every((taskType) =>
        (claimedByType[taskType] ?? 0) >= Math.max(1, Math.floor(options.maxTasksByType?.[taskType] ?? maxTasks))
      )) {
        break;
      }
    }

    const durationMs = Date.now() - startedAt;
    const stageLimitsReached = taskTypes.every((taskType) =>
      (claimedByType[taskType] ?? 0) >= Math.max(1, Math.floor(options.maxTasksByType?.[taskType] ?? maxTasks))
    );
    summary.durationMs = durationMs;
    summary.exitReason = summary.claimed >= maxTasks
      ? "MAX_TASKS_REACHED"
      : durationMs >= wallClockMs || !canStartAnotherTask()
        ? "WALL_CLOCK_BUDGET_REACHED"
        : stageLimitsReached
          ? "STAGE_LIMIT_REACHED"
          : "QUEUE_DRAINED";

    return summary;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}
