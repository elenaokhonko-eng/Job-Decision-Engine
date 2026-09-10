import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { runNormalization as defaultRunNormalization } from "../pipeline/normalize.js";
import { runRequirementsExtraction as defaultRunRequirementsExtraction } from "../pipeline/requirementsExtractor.js";
import { runHardGates as defaultRunHardGates } from "../pipeline/hardGate.js";
import { runEmbeddingBatchWithFallback as defaultRunEmbeddingBatchWithFallback } from "../embeddings/batchCoordinator.js";
import { runLaneRouting as defaultRunLaneRouting } from "../pipeline/laneRouter.js";
import { runDeterministicMatcher as defaultRunDeterministicMatcher } from "../pipeline/deterministicMatcher.js";
import { runRecommendationDecider as defaultRunRecommendationDecider } from "../pipeline/recommendationDecider.js";
import { runExplanationQueueEnqueuer as defaultRunExplanationQueueEnqueuer } from "../pipeline/explanationQueueEnqueuer.js";
import { buildPipelineTaskContextFingerprint } from "../pipeline/artifactContext.js";
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
  byType: Record<string, { inserted: number; existing: number }>;
}

export interface PipelineStageWorkerSummary {
  seeded: SeedPipelineTasksSummary | null;
  claimed: number;
  completed: number;
  blocked: number;
  failed: number;
  deadLettered: number;
  byType: Record<string, { claimed: number; completed: number; blocked: number; failed: number; deadLettered: number }>;
  errors: Array<{ taskType: string; taskKey: string; error: string }>;
}

export interface PipelineStageWorkerOptions {
  context?: WorkspaceContext;
  taskTypes?: PipelineStageTaskType[];
  seed?: boolean;
  maxSeedPerType?: number;
  maxTasks?: number;
  claimBatchSize?: number;
  leaseSeconds?: number;
  heartbeatSeconds?: number;
  wallClockMs?: number;
  claimedBy?: string;
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
  context: WorkspaceContext
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
  const taskVariant =
    ((taskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS" &&
      taskPayload.repair_existing_state === true) ||
      ((taskType === "PUBLISH_EMBEDDING" || taskType === "ROUTE_LANE") &&
        taskPayload.reprocess_existing_state === true) ||
      (taskType === "MATCH_PROFILE_EVIDENCE" &&
        taskPayload.reprocess_existing_state === true) ||
      (taskType === "DECIDE_RECOMMENDATION" &&
        taskPayload.repair_existing_state === true))
      ? "repair"
      : undefined;
  const result = await enqueuePipelineTask(
    {
      taskType,
      taskKey: buildPipelineTaskKey(
        taskType,
        id,
        stageVersion(taskType),
        profileVersionId,
        taskVariant
      ),
      payload: taskPayload,
      maxAttempts,
      contextFingerprint: buildPipelineTaskContextFingerprint({
        workspaceId: context.workspaceId,
        taskType,
        taskVersion: stageVersion(taskType),
        payload: taskPayload,
      }),
    },
    clientOrPool,
    { context }
  );
  return result.inserted;
}

function stageVersion(taskType: PipelineStageTaskType): string {
  switch (taskType) {
    case "NORMALIZE_OBSERVATION":
      return "normalizer_v1";
    case "EXTRACT_DETERMINISTIC_REQUIREMENTS":
      return "deterministic_v1";
    case "APPLY_HARD_GATES":
      return "hard_gate_v1";
    case "EXTRACT_QUOTED_REQUIREMENTS":
      return "quoted_requirements_v1";
    case "PUBLISH_EMBEDDING":
      return "embedding_publication_v1";
    case "ROUTE_LANE":
      return "lane_router_v1";
    case "MATCH_PROFILE_EVIDENCE":
      return "deterministic_matcher_v1";
    case "DECIDE_RECOMMENDATION":
      return "recommendation_decider_v1";
    case "ENQUEUE_EXPLANATION":
      return "explanation_queue_v1";
  }
}

async function selectAndEnqueue(
  client: QueryClient,
  ctx: WorkspaceContext,
  summary: SeedPipelineTasksSummary,
  taskType: PipelineStageTaskType,
  sql: string,
  params: unknown[],
  build: (row: any) => { id: string; payload: Record<string, unknown> },
  enabledTypes?: Set<PipelineStageTaskType>
): Promise<void> {
  if (enabledTypes && !enabledTypes.has(taskType)) return;
  const { rows } = await client.query(sql, params);
  for (const row of rows) {
    const task = build(row);
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
  } = {}
): Promise<SeedPipelineTasksSummary> {
  const pool = clientOrPool || defaultPool;
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;
  const summary: SeedPipelineTasksSummary = { inserted: 0, existing: 0, byType: {} };
  const maxPerType = options.maxSeedPerType ?? 500;
  const enabledTypes: Set<PipelineStageTaskType> | undefined = options.taskTypes
    ? new Set<PipelineStageTaskType>(options.taskTypes)
    : undefined;

  try {
    const ctx = options.context ?? (await resolveWorkspaceContext(client as any));

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
        id: row.observation_id,
        payload: { observation_id: row.observation_id },
      }),
      enabledTypes
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
        id: row.job_version_id,
        payload: {
          canonical_job_id: row.canonical_job_id,
          job_version_id: row.job_version_id,
          ...(row.repair_existing_state === true ? { repair_existing_state: true } : {}),
        },
      }),
      enabledTypes
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
        id: row.job_version_id,
        payload: {
          canonical_job_id: row.canonical_job_id,
          job_version_id: row.job_version_id,
          ...(row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
        },
      }),
      enabledTypes
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
        id: row.job_version_id,
        payload: { canonical_job_id: row.canonical_job_id, job_version_id: row.job_version_id },
      }),
      enabledTypes
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
          AND COALESCE(c.processing_state, c.processing_status) IN ('PREQUALIFIED', 'ROUTING_DEFERRED')
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
           JOIN semantic_embeddings se
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
        id: row.job_version_id,
        payload: {
          canonical_job_id: row.canonical_job_id,
          job_version_id: row.job_version_id,
          ...(row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
        },
      }),
      enabledTypes
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "ROUTE_LANE",
      `SELECT c.id AS canonical_job_id, jv.id AS job_version_id,
              TRUE AS reprocess_existing_state
       FROM canonical_jobs c
       JOIN job_versions jv ON jv.workspace_id = c.workspace_id AND jv.id = c.latest_job_version_id
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) = 'PREQUALIFIED'
         AND EXISTS (
           SELECT 1
           FROM embedding_inputs ei
           JOIN semantic_embeddings se
             ON se.workspace_id = ei.workspace_id
            AND se.embedding_input_id = ei.id
           WHERE ei.workspace_id = c.workspace_id
             AND ei.source_type = 'JOB_VERSION'
             AND ei.source_id = jv.id
         )
       ORDER BY jv.observed_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: row.job_version_id,
        payload: {
          canonical_job_id: row.canonical_job_id,
          job_version_id: row.job_version_id,
          ...(row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
        },
      }),
      enabledTypes
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
           )
         )
       ORDER BY c.updated_at ASC
       LIMIT $2`,
      [ctx.workspaceId, maxPerType],
      (row) => ({
        id: row.job_version_id,
        payload: {
          canonical_job_id: row.canonical_job_id,
          job_version_id: row.job_version_id,
          profile_version_id: row.profile_version_id,
          ...(row.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
        },
      }),
      enabledTypes
    );

    await selectAndEnqueue(
      client as any,
      ctx,
      summary,
      "DECIDE_RECOMMENDATION",
      `SELECT c.id AS canonical_job_id,
              COALESCE(c.latest_job_version_id, jv.id) AS job_version_id,
              active_profile.id AS profile_version_id,
              TRUE AS repair_existing_state
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
         SELECT id
         FROM job_versions
         WHERE workspace_id = c.workspace_id AND canonical_job_id = c.id
         ORDER BY observed_at DESC
         LIMIT 1
       ) jv ON TRUE
       WHERE c.workspace_id = $1
         AND COALESCE(c.processing_state, c.processing_status) IN (
           'HARD_REJECTED', 'NEEDS_VERIFICATION', 'ROUTING_DEFERRED',
           'MATCHED', 'QUEUED_FOR_AI', 'NEEDS_MANUAL_REVIEW'
         )
         AND COALESCE(c.latest_job_version_id, jv.id) IS NOT NULL
         AND c.recommendation_outcome IS NULL
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
        id: row.job_version_id,
        payload: {
          canonical_job_id: row.canonical_job_id,
          job_version_id: row.job_version_id,
          ...(row.profile_version_id ? { profile_version_id: row.profile_version_id } : {}),
          ...(row.repair_existing_state === true ? { repair_existing_state: true } : {}),
        },
      }),
      enabledTypes
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
        id: row.job_version_id,
        payload: { canonical_job_id: row.canonical_job_id, job_version_id: row.job_version_id },
      }),
      enabledTypes
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

async function lookupJobState(
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  jobVersionId: string
): Promise<{
  canonicalJobId: string | null;
  processingState: string | null;
  primaryLane: string | null;
  laneEvidence: string | null;
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
    gate_decision: string | null;
    recommendation_eligibility: string | null;
    recommendation_outcome: string | null;
    latest_job_version_id: string | null;
  }>(
    `SELECT c.id AS canonical_job_id,
            COALESCE(c.processing_state, c.processing_status) AS processing_state,
            c.primary_lane,
            c.lane_evidence,
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
       JOIN semantic_embeddings se
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
}): boolean {
  if (state.processingState !== "ROUTING_DEFERRED") return false;
  const evidence = String(state.laneEvidence || "");
  return [
    "ROUTING_ERROR",
    "EMBEDDING_UNAVAILABLE",
    "ZERO_VECTOR_EMBEDDING",
    "EMBEDDING_DIM_MISMATCH",
  ].some((marker) => evidence.includes(marker));
}

async function markTaskTargetNeedsManualReview(
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
     SET processing_state = 'NEEDS_MANUAL_REVIEW',
         processing_status = 'NEEDS_MANUAL_REVIEW',
         rejection_reason = COALESCE(rejection_reason, $3),
         updated_at = NOW()
     WHERE workspace_id = $1
       AND id = $2
       AND COALESCE(processing_state, processing_status) <> 'MANUALLY_REMOVED'`,
    [ctx.workspaceId, canonicalJobId, `Task ${task.taskKey} exhausted retries: ${errorMessage}`]
  );
}

async function maybeEnqueueAfterTask(
  taskType: PipelineStageTaskType,
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext
): Promise<void> {
  const payload = (task.payload || {}) as Record<string, unknown>;
  const jobVersionId = typeof payload.job_version_id === "string" ? payload.job_version_id : null;

  if (taskType === "NORMALIZE_OBSERVATION") {
    const observationId = requireStringPayload(task, "observation_id");
    const mapping = await lookupObservationVersion(clientOrPool, ctx, observationId);
    if (mapping.jobVersionId) {
      await enqueueStageTask(
        "EXTRACT_DETERMINISTIC_REQUIREMENTS",
        mapping.jobVersionId,
        { canonical_job_id: mapping.canonicalJobId, job_version_id: mapping.jobVersionId },
        clientOrPool,
        ctx
      );
    }
    return;
  }

  if (!jobVersionId) return;

  if (taskType === "EXTRACT_DETERMINISTIC_REQUIREMENTS") {
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
      await enqueueStageTask(
        "MATCH_PROFILE_EVIDENCE",
        jobVersionId,
        {
          canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
          job_version_id: jobVersionId,
        },
        clientOrPool,
        ctx
      );
      return;
    }
    if (repairExistingState && state.processingState === "PREQUALIFIED") {
      await enqueueStageTask(
        "EXTRACT_QUOTED_REQUIREMENTS",
        jobVersionId,
        {
          canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
          job_version_id: jobVersionId,
        },
        clientOrPool,
        ctx
      );
      await enqueueStageTask("PUBLISH_EMBEDDING", jobVersionId, {
        canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
        job_version_id: jobVersionId,
      }, clientOrPool, ctx);
      return;
    }
    await enqueueStageTask("APPLY_HARD_GATES", jobVersionId, payload, clientOrPool, ctx);
    return;
  }

  const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
  const stagePayload = {
    canonical_job_id: state.canonicalJobId ?? payload.canonical_job_id,
    job_version_id: jobVersionId,
    ...(payload.reprocess_existing_state === true ? { reprocess_existing_state: true } : {}),
  };

  if (taskType === "APPLY_HARD_GATES") {
    if (state.processingState === "PREQUALIFIED") {
      // Quoted requirements are advisory enrichment. Publish deterministic
      // requirement embeddings immediately so quote-provider latency/failure
      // cannot hold a gate-passed job before lane routing.
      await enqueueStageTask("EXTRACT_QUOTED_REQUIREMENTS", jobVersionId, stagePayload, clientOrPool, ctx);
      await enqueueStageTask("PUBLISH_EMBEDDING", jobVersionId, stagePayload, clientOrPool, ctx);
    } else if (state.processingState === "HARD_REJECTED" || state.processingState === "NEEDS_VERIFICATION") {
      await enqueueStageTask("DECIDE_RECOMMENDATION", jobVersionId, stagePayload, clientOrPool, ctx);
    }
    return;
  }

  if (taskType === "EXTRACT_QUOTED_REQUIREMENTS") {
    await enqueueStageTask("PUBLISH_EMBEDDING", jobVersionId, stagePayload, clientOrPool, ctx);
    return;
  }

  if (taskType === "PUBLISH_EMBEDDING") {
    await enqueueStageTask("ROUTE_LANE", jobVersionId, stagePayload, clientOrPool, ctx);
    return;
  }

  if (taskType === "ROUTE_LANE") {
    if (state.processingState === "LANE_ROUTED") {
      await enqueueStageTask("MATCH_PROFILE_EVIDENCE", jobVersionId, stagePayload, clientOrPool, ctx);
    } else if (state.processingState === "ROUTING_DEFERRED") {
      await enqueueStageTask("DECIDE_RECOMMENDATION", jobVersionId, stagePayload, clientOrPool, ctx);
    }
    return;
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
      return;
    }
    await enqueueStageTask("DECIDE_RECOMMENDATION", jobVersionId, stagePayload, clientOrPool, ctx);
    return;
  }

  if (
    taskType === "DECIDE_RECOMMENDATION" &&
    state.recommendationEligibility === "ELIGIBLE" &&
    (state.recommendationOutcome === "PRIORITY" || state.recommendationOutcome === "REVIEW")
  ) {
    await enqueueStageTask("ENQUEUE_EXPLANATION", jobVersionId, stagePayload, clientOrPool, ctx);
  }
}

async function executeStageTask(
  taskType: PipelineStageTaskType,
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  dependencies: PipelineStageWorkerDependencies
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
    const currentState = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (currentState.latestJobVersionId && currentState.latestJobVersionId !== jobVersionId) {
      // Requirement tasks are version-specific. A canonical job may have
      // advanced since this task was seeded; completing the stale task keeps
      // old versions from creating retry/manual-review noise or overwriting
      // the current version's funnel state.
      return;
    }
    if (["HARD_REJECTED", "MANUALLY_REMOVED"].includes(currentState.processingState || "")) {
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
    const reprocess = payload.force_policy_recalculation === true || payload.reprocess === true;
    const currentState = await lookupJobState(clientOrPool, ctx, jobVersionId);

    // A preference refresh can leave a task for a superseded job version in
    // the queue. Hard-gate execution is version-specific; the gate runner
    // intentionally selects the canonical latest version, so a stale task
    // must complete as a no-op even when it carries force_policy_recalculation.
    if (
      currentState.latestJobVersionId &&
      currentState.latestJobVersionId !== jobVersionId
    ) {
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
    });
    if (summary.errors > 0) {
      throw new Error(`Hard gate failed for job_version_id=${jobVersionId}.`);
    }
    const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (!["PREQUALIFIED", "HARD_REJECTED", "NEEDS_VERIFICATION"].includes(state.processingState || "")) {
      throw new Error(`Hard gate left job_version_id=${jobVersionId} in unexpected state ${state.processingState}.`);
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
        includeProfileFacts: false,
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
    const summary = await dependencies.runLaneRouting(clientOrPool, {
      context: ctx,
      jobVersionIds: [jobVersionId],
      limit: 1,
    });
    const state = await lookupJobState(clientOrPool, ctx, jobVersionId);
    if (state.processingState === "LANE_ROUTED") return;
    if (isTechnicalRoutingDeferral(state)) {
      throw new Error(`Lane routing deferred due to technical evidence for job_version_id=${jobVersionId}.`);
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
    const hasCompletedDeterministicRun = await jobVersionHasCompletedRequirementsExtraction(
      clientOrPool,
      ctx,
      jobVersionId,
      "DETERMINISTIC"
    );
    if (!hasCompletedDeterministicRun) {
      await enqueueStageTask(
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
      throw new PipelineTaskDependencyBlockedError(
        `EXTRACT_DETERMINISTIC_REQUIREMENTS:${jobVersionId}`,
        "Run deterministic requirement extraction, then resume MATCH_PROFILE_EVIDENCE.",
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
    if (state.processingState !== "MATCHED") {
      throw new Error(`Deterministic matching left job_version_id=${jobVersionId} in state ${state.processingState}.`);
    }
    return;
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
    const matchDependentStates = new Set([
      "LANE_ROUTED",
      "MATCHED",
      "QUEUED_FOR_AI",
      "EVALUATING",
      "AI_EVALUATED",
      "EVALUATED",
    ]);
    const isRoutingDeferred = decisionState.processingState === "ROUTING_DEFERRED";
    const requiresCurrentMatch =
      !isRoutingDeferred &&
      (decisionState.gateDecision === "PASS" || matchDependentStates.has(decisionState.processingState || ""));
    if (requiresCurrentMatch && !(await jobVersionHasCurrentMatch(clientOrPool, ctx, jobVersionId))) {
      const payload = (task.payload || {}) as Record<string, unknown>;
      await enqueueStageTask(
        "MATCH_PROFILE_EVIDENCE",
        jobVersionId,
        {
          canonical_job_id: payload.canonical_job_id,
          job_version_id: jobVersionId,
        },
        clientOrPool,
        ctx
      );
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
    });
  }
}

async function processClaimedTask(
  task: ClaimedPipelineTask,
  clientOrPool: pg.Pool | pg.PoolClient,
  ctx: WorkspaceContext,
  options: Required<Pick<PipelineStageWorkerOptions, "heartbeatSeconds">>,
  dependencies: PipelineStageWorkerDependencies
): Promise<void> {
  const taskType = task.taskType as PipelineStageTaskType;
  if (!PIPELINE_STAGE_TASK_TYPES.includes(taskType)) {
    throw new Error(`Unsupported pipeline task type: ${task.taskType}`);
  }

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
    await executeStageTask(taskType, task, clientOrPool, ctx, dependencies);
    await completePipelineTaskAndRun(task, clientOrPool, {
      context: ctx,
      afterComplete: async (transactionClient) => {
        await maybeEnqueueAfterTask(taskType, task, transactionClient, ctx);
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
  const leaseSeconds = options.leaseSeconds ?? 300;
  const heartbeatSeconds = options.heartbeatSeconds ?? Math.max(15, Math.floor(leaseSeconds / 3));
  const wallClockMs = options.wallClockMs ?? 55 * 60 * 1000;
  const claimedBy = options.claimedBy ?? `stage-worker:${process.pid}`;
  const startedAt = Date.now();
  const summary: PipelineStageWorkerSummary = {
    seeded: null,
    claimed: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    deadLettered: 0,
    byType: {},
    errors: [],
  };

  try {
    throwIfWorkerCancelled(options.abortSignal);

    if (options.seed !== false) {
      summary.seeded = await seedRecoverablePipelineTasks(client as any, {
        context: ctx,
        taskTypes,
        maxSeedPerType: options.maxSeedPerType,
      });
    }

    while (summary.claimed < maxTasks && Date.now() - startedAt < wallClockMs) {
      throwIfWorkerCancelled(options.abortSignal);
      let madeProgress = false;
      for (const taskType of taskTypes) {
        throwIfWorkerCancelled(options.abortSignal);
        if (summary.claimed >= maxTasks || Date.now() - startedAt >= wallClockMs) break;
        const claimLimit = Math.min(claimBatchSize, maxTasks - summary.claimed);
        const claimedTasks = await claimPipelineTasks(
          {
            taskType,
            limit: claimLimit,
            leaseSeconds,
            claimedBy,
          },
          client as any,
          { context: ctx }
        );

        if (claimedTasks.length === 0) continue;
        madeProgress = true;

        for (const task of claimedTasks) {
          summary.claimed += 1;
          incrementWorker(summary, task.taskType, "claimed");
          try {
            // Keep the cancellation check inside the lease-release catch:
            // aborting immediately after claim must never strand a RUNNING
            // task until its lease expires.
            throwIfWorkerCancelled(options.abortSignal);
            await processClaimedTask(
              task,
              client as any,
              ctx,
              { heartbeatSeconds },
              dependencies
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
              await markTaskTargetNeedsManualReview(task, client as any, ctx, message);
              summary.deadLettered += 1;
              incrementWorker(summary, task.taskType, "deadLettered");
            }
            summary.failed += 1;
            incrementWorker(summary, task.taskType, "failed");
            summary.errors.push({ taskType: task.taskType, taskKey: task.taskKey, error: message });
          }
        }
      }

      if (!madeProgress) break;
    }

    return summary;
  } finally {
    if (ownsClient && typeof (client as any).release === "function") {
      (client as pg.PoolClient).release();
    }
  }
}
