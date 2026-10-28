import pg from "pg";
import { z } from "zod";

import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { GATE_VERSION } from "../contracts/version.js";
import { loadActiveEvidenceStrengthPolicy } from "../evidence/evidenceStrengthPolicy.js";
import { buildPipelineTaskContextFingerprint } from "../pipeline/artifactContext.js";
import { loadWorkspaceLanesConfig } from "../pipeline/laneConfigLoader.js";
import {
  applicationReadinessViewAvailable,
  isCurrentReadinessAssessment,
  loadCurrentApplicationReadiness,
  type CurrentApplicationReadiness,
} from "../services/currentApplicationReadiness.js";
import type { WorkspaceContext } from "../workspace/context.js";
import type { PipelineTaskRow } from "./pipelineTasks.js";
import { TaskIntentV2Schema, type TaskIntentV2 } from "./taskIntent.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENTNESS_CLASSIFIER_VERSION = "pipeline_task_currentness_v2" as const;
const payloadSchema = z.record(z.string(), z.unknown());

export type PipelineTaskCurrentnessStatus =
  | "CURRENT"
  | "PROVEN_SUPERSEDED"
  | "PROVEN_SATISFIED"
  | "PROVEN_ARCHIVED"
  | "UNRESOLVED";

export interface PipelineTaskCurrentnessResult {
  status: PipelineTaskCurrentnessStatus;
  reasonCode: string;
  details: Readonly<Record<string, string | null>>;
}

export interface PipelineTaskReconciliationDecision {
  taskId: string;
  taskType: string;
  classification: PipelineTaskCurrentnessStatus;
  reasonCode: string;
  details: Readonly<Record<string, string | null>>;
  contextFingerprint: string | null;
  intent: TaskIntentV2 | null;
}

export interface PipelineTaskReconciliationSummary {
  scannedPending: number;
  current: number;
  unresolved: number;
  wouldReconcile: number;
  reconciled: number;
  stalePendingReconciledThisRun: number;
  deferredByBudget: number;
  decisions: PipelineTaskReconciliationDecision[];
  byClassification: Partial<Record<PipelineTaskCurrentnessStatus, number>>;
  byReason: Record<string, number>;
  byTaskType: Record<string, number>;
}

export interface ReconcileStalePendingPipelineTasksOptions {
  apply?: boolean;
  limit?: number;
  taskTypes?: readonly string[];
  jobVersionIds?: readonly string[];
  observationIds?: readonly string[];
  timeBudgetMs?: number;
}

export interface PipelineTaskLaneCurrentContext {
  lanesVersion: string | null;
  preferenceContextId: string | null;
  preferenceContextKnown: boolean;
}

interface PipelineTaskLineageFacts {
  canonical_job_id: string;
  archived_at: Date | string | null;
  latest_job_version_id: string | null;
  task_job_version_id: string;
  task_content_hash: string | null;
  task_requirement_set_id: string | null;
  current_content_hash: string | null;
  current_requirement_set_id: string | null;
  processing_state: string | null;
  recommendation_outcome: string | null;
  active_profile_version_id: string | null;
  requested_profile_status: string | null;
  latest_match_run_id: string | null;
  match_job_version_id: string | null;
  match_profile_version_id: string | null;
  match_profile_status: string | null;
  match_requirement_set_id: string | null;
  match_job_content_hash: string | null;
  match_context_fingerprint: string | null;
  match_evidence_strength_policy_hash: string | null;
  match_status: string | null;
  match_embedding_space_id: string | null;
  match_requirement_count: number | null;
  latest_deterministic_decision_id: string | null;
  decision_job_version_id: string | null;
  decision_match_run_id: string | null;
  decision_policy_snapshot_id: string | null;
  latest_policy_snapshot_id: string | null;
  latest_lane_decision_id: string | null;
  lane_job_version_id: string | null;
  lane_version: string | null;
  lane_preference_context_id: string | null;
  gate_job_version_id: string | null;
  gate_version: string | null;
  requirements_current: boolean;
  quoted_requirements_current: boolean;
  current_evaluation_work_exists: boolean;
  current_job_embedding_exists: boolean;
}

const lineageTaskTypes = new Set([
  "EXTRACT_DETERMINISTIC_REQUIREMENTS",
  "APPLY_HARD_GATES",
  "EXTRACT_QUOTED_REQUIREMENTS",
  "PUBLISH_EMBEDDING",
  "ROUTE_LANE",
  "MATCH_PROFILE_EVIDENCE",
  "DECIDE_RECOMMENDATION",
  "ENQUEUE_EXPLANATION",
]);

export function pipelineTaskStageVersion(taskType: string): string | null {
  switch (taskType) {
    case "NORMALIZE_OBSERVATION": return "normalizer_v1";
    case "EXTRACT_DETERMINISTIC_REQUIREMENTS": return "deterministic_v3";
    case "APPLY_HARD_GATES": return "hard_gate_v1";
    case "EXTRACT_QUOTED_REQUIREMENTS": return "quoted_requirements_v1";
    case "PUBLISH_EMBEDDING": return "embedding_publication_v1";
    case "ROUTE_LANE": return "lane_router_v1";
    case "MATCH_PROFILE_EVIDENCE": return "deterministic_matcher_v1";
    case "DECIDE_RECOMMENDATION": return "recommendation_decider_v1";
    case "ENQUEUE_EXPLANATION": return "explanation_queue_v2";
    default: return null;
  }
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  const input: unknown = typeof value === "string" ? parseJson(value) : value;
  const parsed = payloadSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

function parseJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function hasExplicitRerunRequest(payload: Record<string, unknown>): boolean {
  const intent = TaskIntentV2Schema.safeParse(payload.task_intent);
  return booleanField(payload, "reprocess") ||
    booleanField(payload, "force_policy_recalculation") ||
    booleanField(payload, "reprocess_existing_state") ||
    stringField(payload, "verification_answer_revision_id") !== null ||
    (intent.success && intent.data.mode === "FORCE_RECOMPUTE");
}

function isLegacyPreferenceRecalculationTask(
  task: PipelineTaskRow,
  payload: Record<string, unknown>,
): boolean {
  if (task.task_type !== "APPLY_HARD_GATES" ||
      payload.force_policy_recalculation !== true ||
      typeof payload.preference_mode_key !== "string" ||
      typeof payload.preference_mode_updated_at !== "string") return false;
  const parts = task.task_key.split(":");
  if (parts[0] !== "APPLY_HARD_GATES" ||
      parts[1] !== stringField(payload, "job_version_id") ||
      parts[2] !== "preference" ||
      parts[3] !== payload.preference_mode_key ||
      !parts[4]) return false;
  const expectedRevision = Date.parse(payload.preference_mode_updated_at);
  return Number.isFinite(expectedRevision)
    ? parts[4] === String(expectedRevision)
    : /^[0-9a-f-]{36}$/i.test(parts[4]);
}

function supportsLegacyTaskKey(
  taskType: string,
  taskKey: string,
  payload: Record<string, unknown>,
): boolean {
  const stageVersion = pipelineTaskStageVersion(taskType);
  const parts = taskKey.split(":");
  if (!stageVersion || parts[0] !== taskType) return false;

  if (taskType === "NORMALIZE_OBSERVATION") {
    return parts[1] === stringField(payload, "observation_id") && parts[2] === stageVersion;
  }

  const payloadVersionId = stringField(payload, "job_version_id");
  if (!payloadVersionId || parts[1] !== payloadVersionId) return false;
  if (parts[2] === stageVersion) return true;
  return taskType === "APPLY_HARD_GATES" &&
    parts[2] === "preference" &&
    Boolean(parts[3]?.trim()) &&
    Boolean(parts[4]?.trim());
}

function result(
  status: PipelineTaskCurrentnessStatus,
  reasonCode: string,
  details: Record<string, string | null> = {},
): PipelineTaskCurrentnessResult {
  return { status, reasonCode, details };
}

async function readCurrentLaneContext(
  client: pg.PoolClient,
  context: WorkspaceContext,
): Promise<PipelineTaskLaneCurrentContext> {
  const laneConfig = await loadWorkspaceLanesConfig(client, {
    context,
    seedIfEmpty: false,
  });
  const { rows: activeRevisions } = await client.query<{ preference_domain: string; revision_id: string }>(
    `SELECT active.preference_domain, active.revision_id
     FROM workspace_user_preference_active_versions AS active
     WHERE active.workspace_id = $1 AND active.user_id = $2
     ORDER BY active.preference_domain ASC
     FOR SHARE OF active`,
    [context.workspaceId, context.userId],
  );
  if (activeRevisions.length === 0) {
    return {
      lanesVersion: laneConfig.config.version ?? null,
      preferenceContextId: null,
      preferenceContextKnown: true,
    };
  }

  const revisions = Object.fromEntries(activeRevisions.map((row) => [row.preference_domain, row.revision_id]));
  const contextHash = sha256Hex(stableStringify({
    schema_version: "workspace_preference_context_v1",
    workspace_id: context.workspaceId,
    user_id: context.userId,
    revisions,
  }));
  const { rows: contexts } = await client.query<{ id: string }>(
    `SELECT id
     FROM workspace_user_preference_contexts
     WHERE workspace_id = $1 AND user_id = $2 AND context_hash = $3
     LIMIT 1`,
    [context.workspaceId, context.userId, contextHash],
  );

  return {
    lanesVersion: laneConfig.config.version ?? null,
    preferenceContextId: contexts[0]?.id ?? null,
    preferenceContextKnown: contexts.length > 0,
  };
}

async function readLineageFacts(
  client: pg.PoolClient,
  context: WorkspaceContext,
  payload: Record<string, unknown>,
  taskVersionId: string,
): Promise<PipelineTaskLineageFacts | null> {
  const canonicalJobId = stringField(payload, "canonical_job_id");
  if (canonicalJobId && !UUID_PATTERN.test(canonicalJobId)) return null;
  const requestedProfileId = stringField(payload, "profile_version_id");
  if (requestedProfileId && !UUID_PATTERN.test(requestedProfileId)) return null;

  const { rows } = await client.query<PipelineTaskLineageFacts>(
    `SELECT canonical.id::text AS canonical_job_id,
            canonical.archived_at,
            canonical.latest_job_version_id::text AS latest_job_version_id,
            task_version.id::text AS task_job_version_id,
            task_version.content_hash AS task_content_hash,
            task_version.active_requirement_set_id::text AS task_requirement_set_id,
            current_version.content_hash AS current_content_hash,
            current_version.active_requirement_set_id::text AS current_requirement_set_id,
            COALESCE(canonical.processing_state, canonical.processing_status) AS processing_state,
            canonical.recommendation_outcome,
            active_profile.id::text AS active_profile_version_id,
            requested_profile.status AS requested_profile_status,
            canonical.latest_match_run_id::text AS latest_match_run_id,
            current_match.job_version_id::text AS match_job_version_id,
            current_match.profile_version_id::text AS match_profile_version_id,
            match_profile.status AS match_profile_status,
            current_match.requirement_set_id::text AS match_requirement_set_id,
            current_match.job_content_hash AS match_job_content_hash,
            current_match.context_fingerprint AS match_context_fingerprint,
            current_match.evidence_strength_policy_hash AS match_evidence_strength_policy_hash,
            current_match.status AS match_status,
            current_match.embedding_space_id::text AS match_embedding_space_id,
            current_match.requirement_count AS match_requirement_count,
            canonical.latest_deterministic_decision_id::text AS latest_deterministic_decision_id,
            current_decision.job_version_id::text AS decision_job_version_id,
            current_decision.match_run_id::text AS decision_match_run_id,
            current_decision.policy_snapshot_id::text AS decision_policy_snapshot_id,
            current_policy.id::text AS latest_policy_snapshot_id,
            canonical.latest_lane_decision_id::text AS latest_lane_decision_id,
            current_lane.job_version_id::text AS lane_job_version_id,
            current_lane.lane_snapshot->>'lanes_version' AS lane_version,
            current_lane.lane_snapshot->>'preference_context_id' AS lane_preference_context_id,
            current_gate.job_version_id::text AS gate_job_version_id,
            current_gate.gate_version AS gate_version,
            EXISTS (
              SELECT 1
              FROM job_version_pipeline_state pipeline_state
              JOIN requirement_extraction_runs extraction
                ON extraction.workspace_id = pipeline_state.workspace_id
               AND extraction.job_version_id = pipeline_state.job_version_id
               AND extraction.run_type = 'DETERMINISTIC'
               AND extraction.status = 'COMPLETED'
               AND extraction.requirement_set_id = current_version.active_requirement_set_id
              WHERE pipeline_state.workspace_id = canonical.workspace_id
                AND pipeline_state.job_version_id = current_version.id
                AND pipeline_state.current_stage = 'REQUIREMENTS_EXTRACTED'
                AND pipeline_state.stage_status = 'COMPLETED'
                AND current_version.active_requirement_set_id IS NOT NULL
            ) AS requirements_current,
            EXISTS (
              SELECT 1
              FROM requirement_extraction_runs extraction
              WHERE extraction.workspace_id = canonical.workspace_id
                AND extraction.job_version_id = current_version.id
                AND extraction.run_type = 'LLM_QUOTED'
                AND extraction.status = 'COMPLETED'
                AND extraction.requirement_set_id = current_version.active_requirement_set_id
                AND current_version.active_requirement_set_id IS NOT NULL
            ) AS quoted_requirements_current,
            EXISTS (
              SELECT 1
              FROM evaluation_queue queue_item
              WHERE queue_item.workspace_id = canonical.workspace_id
                AND queue_item.canonical_job_id = canonical.id
                AND queue_item.job_version_id = current_version.id
                AND queue_item.profile_version_id = active_profile.id
                AND queue_item.match_run_id = current_match.id
                AND queue_item.deterministic_decision_id = current_decision.id
                AND queue_item.job_content_hash = current_version.content_hash
                AND queue_item.context_fingerprint IS NOT NULL
                AND queue_item.status NOT IN ('SUPERSEDED', 'CANCELLED')
            ) OR EXISTS (
              SELECT 1
              FROM ai_evaluations evaluation
              WHERE evaluation.workspace_id = canonical.workspace_id
                AND evaluation.canonical_job_id = canonical.id
                AND evaluation.job_version_id = current_version.id
                AND evaluation.profile_version_id = active_profile.id
                AND evaluation.match_run_id = current_match.id
                AND evaluation.deterministic_decision_id = current_decision.id
                AND evaluation.job_content_hash = current_version.content_hash
                AND evaluation.context_fingerprint IS NOT NULL
            ) AS current_evaluation_work_exists,
            EXISTS (
              SELECT 1
              FROM embedding_inputs input
              JOIN v_published_semantic_embeddings published
                ON published.workspace_id = input.workspace_id
               AND published.embedding_input_id = input.id
              JOIN embedding_spaces space
                ON space.workspace_id = published.workspace_id
               AND space.id = published.embedding_space_id
              WHERE input.workspace_id = canonical.workspace_id
                AND input.source_type = 'JOB_VERSION'
                AND input.source_id = current_version.id
                AND space.is_fallback_space = FALSE
            ) AS current_job_embedding_exists
     FROM job_versions task_version
     JOIN canonical_jobs canonical
       ON canonical.workspace_id = task_version.workspace_id
      AND canonical.id = task_version.canonical_job_id
     LEFT JOIN job_versions current_version
       ON current_version.workspace_id = canonical.workspace_id
      AND current_version.id = canonical.latest_job_version_id
     LEFT JOIN LATERAL (
       SELECT profile.id
       FROM profile_versions profile
       WHERE profile.workspace_id = canonical.workspace_id
         AND profile.status = 'ACTIVE'
       ORDER BY profile.created_at DESC, profile.id DESC
       LIMIT 1
     ) active_profile ON TRUE
     LEFT JOIN profile_versions requested_profile
       ON requested_profile.workspace_id = canonical.workspace_id
      AND requested_profile.id = $4::uuid
     LEFT JOIN match_runs current_match
       ON current_match.workspace_id = canonical.workspace_id
      AND current_match.id = canonical.latest_match_run_id
     LEFT JOIN profile_versions match_profile
       ON match_profile.workspace_id = canonical.workspace_id
      AND match_profile.id = current_match.profile_version_id
     LEFT JOIN deterministic_decisions current_decision
       ON current_decision.workspace_id = canonical.workspace_id
      AND current_decision.id = canonical.latest_deterministic_decision_id
     LEFT JOIN LATERAL (
       SELECT snapshot.id
       FROM workspace_policy_snapshots snapshot
       WHERE snapshot.workspace_id = canonical.workspace_id
       ORDER BY snapshot.created_at DESC, snapshot.id DESC
       LIMIT 1
     ) current_policy ON TRUE
     LEFT JOIN lane_decisions current_lane
       ON current_lane.workspace_id = canonical.workspace_id
      AND current_lane.id = canonical.latest_lane_decision_id
     LEFT JOIN LATERAL (
       SELECT gate.job_version_id, gate.gate_version
       FROM gate_decisions gate
       WHERE gate.workspace_id = canonical.workspace_id
         AND gate.canonical_job_id = canonical.id
         AND gate.job_version_id = canonical.latest_job_version_id
       ORDER BY gate.created_at DESC, gate.id DESC
       LIMIT 1
     ) current_gate ON TRUE
     WHERE task_version.workspace_id = $1
       AND task_version.id = $2::uuid
       AND ($3::uuid IS NULL OR canonical.id = $3::uuid)
     LIMIT 1
     FOR SHARE OF canonical`,
    [context.workspaceId, taskVersionId, canonicalJobId, requestedProfileId],
  );
  return rows[0] ?? null;
}

async function classifyNormalizationTask(
  client: pg.PoolClient,
  context: WorkspaceContext,
  payload: Record<string, unknown>,
): Promise<PipelineTaskCurrentnessResult> {
  const observationId = stringField(payload, "observation_id");
  if (!observationId || !UUID_PATTERN.test(observationId)) {
    return result("UNRESOLVED", "NORMALIZATION_OBSERVATION_ID_MISSING");
  }
  const { rows } = await client.query<{ processing_status: string | null; job_version_id: string | null }>(
    `SELECT processing_status, job_version_id::text AS job_version_id
     FROM raw_job_observations
     WHERE workspace_id = $1 AND id = $2::uuid
     LIMIT 1`,
    [context.workspaceId, observationId],
  );
  const observation = rows[0];
  if (!observation) return result("UNRESOLVED", "NORMALIZATION_OBSERVATION_NOT_FOUND");
  if (!hasExplicitRerunRequest(payload) &&
      observation.processing_status === "PROCESSED" && observation.job_version_id) {
    return result("PROVEN_SATISFIED", "NORMALIZATION_ALREADY_PROCESSED", {
      observationId,
      jobVersionId: observation.job_version_id,
    });
  }
  if (observation.processing_status === "PENDING") return result("CURRENT", "NORMALIZATION_OBSERVATION_PENDING");
  return result("UNRESOLVED", "NORMALIZATION_OBSERVATION_STATE_UNPROVEN", {
    processingStatus: observation.processing_status,
  });
}

function expectedMatchContextFingerprint(
  workspaceId: string,
  facts: PipelineTaskLineageFacts,
  evidenceStrengthPolicyHash: string | undefined,
): string | null {
  if (!facts.latest_job_version_id || !facts.current_content_hash || !facts.active_profile_version_id || !evidenceStrengthPolicyHash) {
    return null;
  }
  return buildPipelineTaskContextFingerprint({
    workspaceId,
    taskType: "MATCH_PROFILE_EVIDENCE",
    taskVersion: "deterministic_matcher_v1",
    payload: {
      canonical_job_id: facts.canonical_job_id,
      job_version_id: facts.latest_job_version_id,
      content_hash: facts.current_content_hash,
      active_requirement_set_id: facts.current_requirement_set_id,
      profile_version_id: facts.active_profile_version_id,
      matcher_version: "deterministic_matcher_v1",
      evidence_strength_policy_hash: evidenceStrengthPolicyHash,
    },
  });
}

interface SuccessorPipelineTaskRow extends pg.QueryResultRow {
  id: string;
  task_key: string;
  payload: unknown;
  context_fingerprint: string | null;
}

function successorPayloadMatchesCurrentContext(
  taskType: string,
  payload: Record<string, unknown>,
  facts: PipelineTaskLineageFacts,
): boolean {
  const contextSensitive = ["MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"].includes(taskType);
  if (contextSensitive && (
    stringField(payload, "content_hash") !== facts.current_content_hash ||
    nullableString(payload.active_requirement_set_id) !== facts.current_requirement_set_id
  )) return false;
  if (["MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"].includes(taskType) &&
      stringField(payload, "profile_version_id") !== facts.active_profile_version_id) return false;
  if (["DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"].includes(taskType) && (
    nullableString(payload.match_run_id) !== facts.latest_match_run_id ||
    nullableString(payload.deterministic_decision_id) !== facts.latest_deterministic_decision_id
  )) return false;
  const repairMatchRunId = stringField(payload, "repair_match_run_id");
  return !repairMatchRunId || repairMatchRunId === facts.latest_match_run_id;
}

async function findCurrentSuccessorTask(
  task: PipelineTaskRow,
  client: pg.PoolClient,
  context: WorkspaceContext,
  facts: PipelineTaskLineageFacts,
): Promise<string | null> {
  const latestJobVersionId = facts.latest_job_version_id;
  const stageVersion = pipelineTaskStageVersion(task.task_type);
  if (!latestJobVersionId || !stageVersion) return null;

  const { rows } = await client.query<SuccessorPipelineTaskRow>(
    `SELECT successor.id, successor.task_key, successor.payload, successor.context_fingerprint
     FROM pipeline_tasks AS successor
     WHERE successor.workspace_id = $1
       AND successor.task_type = $2
       AND successor.id <> $3
       AND successor.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT', 'BLOCKED_DEPENDENCY')
       AND successor.payload->>'canonical_job_id' = $4
       AND successor.payload->>'job_version_id' = $5
     ORDER BY successor.created_at ASC, successor.id ASC
     LIMIT 5
     FOR SHARE OF successor SKIP LOCKED`,
    [context.workspaceId, task.task_type, task.id, facts.canonical_job_id, latestJobVersionId],
  );

  for (const successor of rows) {
    const payload = recordPayload(successor.payload);
    if (!payload || !successorPayloadMatchesCurrentContext(task.task_type, payload, facts)) continue;

    if (Object.prototype.hasOwnProperty.call(payload, "task_intent")) {
      const parsedIntent = TaskIntentV2Schema.safeParse(payload.task_intent);
      if (!parsedIntent.success) continue;
      const intent = parsedIntent.data;
      const expectedFingerprint = buildPipelineTaskContextFingerprint({
        workspaceId: context.workspaceId,
        taskType: task.task_type,
        taskVersion: intent.stageVersion,
        payload,
      });
      if (intent.taskType !== task.task_type ||
          intent.stageVersion !== stageVersion ||
          intent.target.workspaceId !== context.workspaceId ||
          intent.target.canonicalJobId !== facts.canonical_job_id ||
          intent.target.jobVersionId !== latestJobVersionId ||
          intent.contextFingerprint !== successor.context_fingerprint ||
          intent.contextFingerprint !== expectedFingerprint) continue;
      return successor.id;
    }

    if (!supportsLegacyTaskKey(task.task_type, successor.task_key, payload)) continue;
    if (!successor.context_fingerprint || successor.context_fingerprint === "legacy_pipeline_context_v1") continue;
    const expectedFingerprint = buildPipelineTaskContextFingerprint({
      workspaceId: context.workspaceId,
      taskType: task.task_type,
      taskVersion: stageVersion,
      payload,
    });
    if (successor.context_fingerprint === expectedFingerprint) return successor.id;
  }
  return null;
}

async function proveSupersededWithSuccessor(
  task: PipelineTaskRow,
  payload: Record<string, unknown>,
  client: pg.PoolClient,
  context: WorkspaceContext,
  facts: PipelineTaskLineageFacts,
  reasonCode: string,
  details: Record<string, string | null>,
): Promise<PipelineTaskCurrentnessResult> {
  if (hasExplicitRerunRequest(payload)) {
    return result("UNRESOLVED", "FORCED_RERUN_REQUEST_NOT_DISCHARGED", details);
  }
  const successorTaskId = await findCurrentSuccessorTask(task, client, context, facts);
  if (!successorTaskId) {
    return result("UNRESOLVED", "SUCCESSOR_OBLIGATION_UNPROVEN", details);
  }
  return result("PROVEN_SUPERSEDED", reasonCode, {
    ...details,
    canonicalJobId: facts.canonical_job_id,
    successorTaskId,
    successorJobVersionId: facts.latest_job_version_id,
    latestJobVersionId: facts.latest_job_version_id,
  });
}

export async function classifyPipelineTaskCurrentness(
  task: PipelineTaskRow,
  client: pg.PoolClient,
  context: WorkspaceContext,
  laneContext?: PipelineTaskLaneCurrentContext,
  evidenceStrengthPolicyHash?: string,
): Promise<PipelineTaskCurrentnessResult> {
  const payload = recordPayload(task.payload);
  if (!payload) return result("UNRESOLVED", "TASK_PAYLOAD_INVALID");

  let taskIntent: TaskIntentV2 | null = null;
  if (Object.prototype.hasOwnProperty.call(payload, "task_intent")) {
    const parsedIntent = TaskIntentV2Schema.safeParse(payload.task_intent);
    if (!parsedIntent.success) return result("UNRESOLVED", "TASK_INTENT_INVALID");
    taskIntent = parsedIntent.data;
    const targetMatchesPayload =
      taskIntent.target.workspaceId === context.workspaceId &&
      taskIntent.taskType === task.task_type &&
      taskIntent.contextFingerprint === task.context_fingerprint &&
      taskIntent.target.canonicalJobId === stringField(payload, "canonical_job_id") &&
      taskIntent.target.jobVersionId === stringField(payload, "job_version_id") &&
      taskIntent.target.observationId === stringField(payload, "observation_id");
    if (!targetMatchesPayload) return result("UNRESOLVED", "TASK_INTENT_TARGET_OR_FINGERPRINT_MISMATCH");
  }

  if (task.task_type === "NORMALIZE_OBSERVATION") {
    const observationId = stringField(payload, "observation_id");
    const taskKeyParts = task.task_key.split(":");
    const expectedStageVersion = pipelineTaskStageVersion(task.task_type);
    if (!observationId || !UUID_PATTERN.test(observationId)) {
      return result("UNRESOLVED", "NORMALIZATION_OBSERVATION_ID_MISSING");
    }
    if (!expectedStageVersion) {
      return result("UNRESOLVED", "TASK_STAGE_VERSION_UNSUPPORTED", {
        currentStageVersion: expectedStageVersion,
      });
    }
    if (taskIntent && taskIntent.stageVersion !== expectedStageVersion) {
      return result("UNRESOLVED", "TASK_INTENT_STAGE_VERSION_UNSUPPORTED", {
        taskStageVersion: taskIntent.stageVersion,
        currentStageVersion: expectedStageVersion,
      });
    }
    if (!taskIntent && !supportsLegacyTaskKey(task.task_type, task.task_key, payload)) {
      return result("UNRESOLVED", "LEGACY_TASK_KEY_FORMAT_UNSUPPORTED", {
        taskType: task.task_type,
      });
    }
    if (!taskIntent && taskKeyParts[1] !== observationId) {
      return result("UNRESOLVED", "TASK_KEY_LINEAGE_MISMATCH", {
        taskKeyObservationId: taskKeyParts[1] ?? null,
        payloadObservationId: observationId,
      });
    }
    const expectedFingerprint = buildPipelineTaskContextFingerprint({
      workspaceId: context.workspaceId,
      taskType: task.task_type,
      taskVersion: expectedStageVersion,
      payload,
    });
    if (!task.context_fingerprint || task.context_fingerprint !== expectedFingerprint) {
      return result("UNRESOLVED", "TASK_CONTEXT_FINGERPRINT_UNPROVEN", {
        taskId: task.id,
        taskType: task.task_type,
      });
    }
    return classifyNormalizationTask(client, context, payload);
  }
  if (!lineageTaskTypes.has(task.task_type)) {
    return result("UNRESOLVED", "TASK_TYPE_UNSUPPORTED", { taskType: task.task_type });
  }

  const taskVersionId = stringField(payload, "job_version_id");
  if (!taskVersionId || !UUID_PATTERN.test(taskVersionId)) {
    return result("UNRESOLVED", "JOB_VERSION_ID_MISSING", { taskType: task.task_type });
  }
  if (["MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"].includes(task.task_type) ||
      stringField(payload, "profile_version_id")) {
    await client.query(
      `SELECT id
       FROM profile_versions
       WHERE workspace_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
       FOR SHARE`,
      [context.workspaceId],
    );
  }
  const facts = await readLineageFacts(client, context, payload, taskVersionId);
  if (!facts) return result("UNRESOLVED", "CANONICAL_LINEAGE_NOT_FOUND", { jobVersionId: taskVersionId });
  if (facts.archived_at !== null) {
    const archivedAt = facts.archived_at instanceof Date ? facts.archived_at.toISOString() : facts.archived_at;
    return result("PROVEN_ARCHIVED", "JOB_ARCHIVED", {
      canonicalJobId: facts.canonical_job_id,
      jobVersionId: taskVersionId,
      latestJobVersionId: facts.latest_job_version_id,
      archivedAt,
    });
  }

  if (!facts.latest_job_version_id) {
    return result("UNRESOLVED", "LATEST_JOB_VERSION_POINTER_MISSING", {
      canonicalJobId: facts.canonical_job_id,
      taskJobVersionId: taskVersionId,
    });
  }
  const jobVersionSuperseded = facts.latest_job_version_id !== taskVersionId;
  let readinessContractAvailable = false;
  let currentReadiness: CurrentApplicationReadiness | null = null;
  if (task.task_type === "DECIDE_RECOMMENDATION" || task.task_type === "ENQUEUE_EXPLANATION") {
    readinessContractAvailable = await applicationReadinessViewAvailable(client);
    if (readinessContractAvailable && facts.latest_job_version_id) {
      currentReadiness = await loadCurrentApplicationReadiness(
        client,
        context.workspaceId,
        facts.canonical_job_id,
        facts.latest_job_version_id,
        true,
      );
    }
  }

  const expectedStageVersion = pipelineTaskStageVersion(task.task_type);
  if (!expectedStageVersion) {
    return result("UNRESOLVED", "TASK_STAGE_VERSION_UNSUPPORTED", { taskType: task.task_type });
  }
  if (taskIntent && taskIntent.stageVersion !== expectedStageVersion) {
    return result("UNRESOLVED", "TASK_INTENT_STAGE_VERSION_UNSUPPORTED", {
      taskStageVersion: taskIntent.stageVersion,
      currentStageVersion: expectedStageVersion,
    });
  }
  if (!taskIntent && !supportsLegacyTaskKey(task.task_type, task.task_key, payload)) {
    return result("UNRESOLVED", "LEGACY_TASK_KEY_FORMAT_UNSUPPORTED", {
      taskType: task.task_type,
    });
  }

  const fingerprintStageVersion = taskIntent?.stageVersion ?? expectedStageVersion;
  const expectedFingerprint = buildPipelineTaskContextFingerprint({
    workspaceId: context.workspaceId,
    taskType: task.task_type,
    taskVersion: fingerprintStageVersion,
    payload,
  });
  if (!task.context_fingerprint || task.context_fingerprint !== expectedFingerprint) {
    if (task.context_fingerprint === "legacy_pipeline_context_v1" &&
        !taskIntent && isLegacyPreferenceRecalculationTask(task, payload)) {
      return result("CURRENT", "LEGACY_PREFERENCE_RECALCULATION_REQUEST", {
        canonicalJobId: facts.canonical_job_id,
        taskJobVersionId: taskVersionId,
        preferenceModeKey: stringField(payload, "preference_mode_key"),
        preferenceModeUpdatedAt: stringField(payload, "preference_mode_updated_at"),
      });
    }
    return result("UNRESOLVED", "TASK_CONTEXT_FINGERPRINT_UNPROVEN", {
      taskId: task.id,
      taskType: task.task_type,
    });
  }

  let supersessionReasonCode: string | null = null;
  let supersessionDetails: Record<string, string | null> = {};
  const recordSupersession = (reasonCode: string, details: Record<string, string | null>): void => {
    if (supersessionReasonCode !== null) return;
    supersessionReasonCode = reasonCode;
    supersessionDetails = details;
  };
  if (jobVersionSuperseded) {
    recordSupersession("TASK_JOB_VERSION_IS_NOT_LATEST", {
      canonicalJobId: facts.canonical_job_id,
      taskJobVersionId: taskVersionId,
      latestJobVersionId: facts.latest_job_version_id,
    });
  }

  const contextSensitiveTask = ["MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"].includes(task.task_type);
  if (contextSensitiveTask &&
      (!Object.prototype.hasOwnProperty.call(payload, "content_hash") ||
       !Object.prototype.hasOwnProperty.call(payload, "active_requirement_set_id"))) {
    return result("UNRESOLVED", "JOB_CONTENT_OR_REQUIREMENT_CONTEXT_MISSING", {
      taskType: task.task_type,
      jobVersionId: taskVersionId,
    });
  }
  if ((task.task_type === "DECIDE_RECOMMENDATION" || task.task_type === "ENQUEUE_EXPLANATION") &&
      (!Object.prototype.hasOwnProperty.call(payload, "match_run_id") ||
       !Object.prototype.hasOwnProperty.call(payload, "deterministic_decision_id"))) {
    return result("UNRESOLVED", "MATCH_OR_DECISION_CONTEXT_MISSING", {
      taskType: task.task_type,
      jobVersionId: taskVersionId,
    });
  }

  const payloadContentHash = stringField(payload, "content_hash");
  if (contextSensitiveTask && (!payloadContentHash || !facts.current_content_hash)) {
    return result("UNRESOLVED", "JOB_CONTENT_HASH_UNPROVEN", {
      taskType: task.task_type,
      jobVersionId: taskVersionId,
    });
  }
  if (payloadContentHash && !facts.current_content_hash) {
    return result("UNRESOLVED", "CURRENT_JOB_CONTENT_HASH_UNPROVEN", {
      taskJobVersionId: taskVersionId,
      taskContentHash: payloadContentHash,
    });
  }
  if (payloadContentHash && payloadContentHash !== facts.current_content_hash) {
    if (hasExplicitRerunRequest(payload)) {
      return result("UNRESOLVED", "FORCED_RERUN_CONTENT_HASH_UNPROVEN", {
        taskJobVersionId: taskVersionId,
        taskContentHash: payloadContentHash,
        currentContentHash: facts.current_content_hash,
      });
    }
    recordSupersession("TASK_CONTENT_HASH_IS_NOT_CURRENT", {
      taskJobVersionId: taskVersionId,
      taskContentHash: payloadContentHash,
      currentContentHash: facts.current_content_hash,
    });
  }

  const payloadRequirementSetId = Object.prototype.hasOwnProperty.call(payload, "active_requirement_set_id")
    ? nullableString(payload.active_requirement_set_id)
    : null;
  if (Object.prototype.hasOwnProperty.call(payload, "active_requirement_set_id") &&
      payloadRequirementSetId !== facts.current_requirement_set_id) {
    if (!facts.current_requirement_set_id || hasExplicitRerunRequest(payload)) {
      return result(
        "UNRESOLVED",
        hasExplicitRerunRequest(payload)
          ? "FORCED_RERUN_REQUIREMENT_SET_UNPROVEN"
          : "CURRENT_REQUIREMENT_SET_POINTER_MISSING",
        {
          taskRequirementSetId: payloadRequirementSetId,
          currentRequirementSetId: facts.current_requirement_set_id,
        },
      );
    }
    recordSupersession("TASK_REQUIREMENT_SET_IS_NOT_CURRENT", {
      taskRequirementSetId: payloadRequirementSetId,
      currentRequirementSetId: facts.current_requirement_set_id,
    });
  }

  const taskProfileId = stringField(payload, "profile_version_id");
  if (taskProfileId && !facts.active_profile_version_id) {
    return result("UNRESOLVED", "ACTIVE_PROFILE_VERSION_POINTER_MISSING", {
      taskProfileVersionId: taskProfileId,
    });
  }
  if (taskProfileId && facts.active_profile_version_id && taskProfileId !== facts.active_profile_version_id) {
    if (facts.requested_profile_status === null) {
      return result("UNRESOLVED", "TASK_PROFILE_VERSION_NOT_FOUND", {
        taskProfileVersionId: taskProfileId,
        activeProfileVersionId: facts.active_profile_version_id,
      });
    }
    if (hasExplicitRerunRequest(payload)) {
      return result("UNRESOLVED", "FORCED_RERUN_PROFILE_VERSION_NOT_ACTIVE", {
        taskProfileVersionId: taskProfileId,
        activeProfileVersionId: facts.active_profile_version_id,
      });
    }
    recordSupersession("TASK_PROFILE_VERSION_IS_NOT_ACTIVE", {
      taskProfileVersionId: taskProfileId,
      activeProfileVersionId: facts.active_profile_version_id,
    });
  }
  if (task.task_type === "MATCH_PROFILE_EVIDENCE" && (!taskProfileId || !facts.active_profile_version_id)) {
    return result("UNRESOLVED", "MATCH_PROFILE_CONTEXT_MISSING");
  }

  const payloadMatchRunId = stringField(payload, "match_run_id");
  const payloadDecisionId = stringField(payload, "deterministic_decision_id");
  if (payloadMatchRunId && payloadMatchRunId !== facts.latest_match_run_id) {
    if (!facts.latest_match_run_id || hasExplicitRerunRequest(payload)) {
      return result("UNRESOLVED", "FORCED_OR_UNKNOWN_MATCH_LINEAGE", {
        taskMatchRunId: payloadMatchRunId,
        latestMatchRunId: facts.latest_match_run_id,
      });
    }
    recordSupersession("TASK_MATCH_RUN_IS_NOT_LATEST", {
      taskMatchRunId: payloadMatchRunId,
      latestMatchRunId: facts.latest_match_run_id,
    });
  }
  if (payloadDecisionId && payloadDecisionId !== facts.latest_deterministic_decision_id) {
    if (!facts.latest_deterministic_decision_id || hasExplicitRerunRequest(payload)) {
      return result("UNRESOLVED", "FORCED_OR_UNKNOWN_DECISION_LINEAGE", {
        taskDecisionId: payloadDecisionId,
        latestDecisionId: facts.latest_deterministic_decision_id,
      });
    }
    recordSupersession("TASK_DECISION_IS_NOT_LATEST", {
      taskDecisionId: payloadDecisionId,
      latestDecisionId: facts.latest_deterministic_decision_id,
    });
  }
  if ((task.task_type === "DECIDE_RECOMMENDATION" || task.task_type === "ENQUEUE_EXPLANATION") &&
      payloadMatchRunId && facts.match_profile_version_id &&
      facts.match_profile_version_id !== facts.active_profile_version_id) {
    if (facts.match_profile_status === null || !facts.active_profile_version_id || hasExplicitRerunRequest(payload)) {
      return result("UNRESOLVED", "MATCH_PROFILE_ACTIVATION_UNPROVEN", {
        matchProfileVersionId: facts.match_profile_version_id,
        activeProfileVersionId: facts.active_profile_version_id,
      });
    }
    recordSupersession("TASK_MATCH_PROFILE_IS_NOT_ACTIVE", {
      matchProfileVersionId: facts.match_profile_version_id,
      activeProfileVersionId: facts.active_profile_version_id,
    });
  }

  const expectedCurrentMatchFingerprint = expectedMatchContextFingerprint(
    context.workspaceId,
    facts,
    evidenceStrengthPolicyHash,
  );
  const matchIsCurrent = Boolean(
    facts.latest_match_run_id &&
    facts.match_job_version_id === facts.latest_job_version_id &&
    facts.match_profile_version_id === facts.active_profile_version_id &&
    facts.match_requirement_set_id === facts.current_requirement_set_id &&
    facts.match_job_content_hash === facts.current_content_hash &&
    facts.match_status === "COMPLETED" &&
    expectedCurrentMatchFingerprint &&
    facts.match_context_fingerprint === expectedCurrentMatchFingerprint &&
    facts.match_evidence_strength_policy_hash === evidenceStrengthPolicyHash &&
    (Number(facts.match_requirement_count ?? 0) === 0 || facts.match_embedding_space_id),
  );
  const decisionReadinessCurrent = !readinessContractAvailable ||
    isCurrentReadinessAssessment(currentReadiness);
  const decisionIsCurrent = Boolean(
    facts.latest_deterministic_decision_id &&
    facts.decision_job_version_id === facts.latest_job_version_id &&
    facts.decision_match_run_id === (facts.latest_match_run_id ?? null) &&
    facts.decision_policy_snapshot_id === facts.latest_policy_snapshot_id &&
    (facts.decision_match_run_id === null || matchIsCurrent) &&
    decisionReadinessCurrent,
  );

  if (task.task_type === "PUBLISH_EMBEDDING" && jobVersionSuperseded &&
      !hasExplicitRerunRequest(payload) && facts.current_job_embedding_exists) {
    return result("PROVEN_SATISFIED", "CURRENT_JOB_VERSION_EMBEDDING_EXISTS", {
      canonicalJobId: facts.canonical_job_id,
      taskJobVersionId: taskVersionId,
      latestJobVersionId: facts.latest_job_version_id,
      latestContentHash: facts.current_content_hash,
    });
  }

  if (task.task_type === "PUBLISH_EMBEDDING") {
    const repairMatchRunId = stringField(payload, "repair_match_run_id");
    if (repairMatchRunId && repairMatchRunId !== facts.latest_match_run_id) {
      if (!facts.latest_match_run_id || hasExplicitRerunRequest(payload)) {
        return result("UNRESOLVED", "EMBEDDING_REPAIR_MATCH_LINEAGE_UNPROVEN", {
          taskMatchRunId: repairMatchRunId,
          latestMatchRunId: facts.latest_match_run_id,
        });
      }
      recordSupersession("EMBEDDING_REPAIR_MATCH_RUN_IS_NOT_LATEST", {
        taskMatchRunId: repairMatchRunId,
        latestMatchRunId: facts.latest_match_run_id,
      });
    }
    if (repairMatchRunId && repairMatchRunId === facts.latest_match_run_id &&
        !hasExplicitRerunRequest(payload) && matchIsCurrent && facts.current_job_embedding_exists) {
      return result("PROVEN_SATISFIED", "CURRENT_MATCH_EMBEDDINGS_ALREADY_PUBLISHED", {
        canonicalJobId: facts.canonical_job_id,
        latestJobVersionId: facts.latest_job_version_id,
        taskJobVersionId: taskVersionId,
        matchRunId: repairMatchRunId,
      });
    }
  }

  if (task.task_type === "EXTRACT_DETERMINISTIC_REQUIREMENTS" &&
      !hasExplicitRerunRequest(payload) && facts.requirements_current) {
    return result("PROVEN_SATISFIED", "CURRENT_DETERMINISTIC_REQUIREMENTS_EXIST", {
      canonicalJobId: facts.canonical_job_id,
      latestJobVersionId: facts.latest_job_version_id,
      taskJobVersionId: taskVersionId,
      requirementSetId: facts.current_requirement_set_id,
    });
  }
  if (task.task_type === "EXTRACT_QUOTED_REQUIREMENTS" &&
      !hasExplicitRerunRequest(payload) && facts.quoted_requirements_current) {
    return result("PROVEN_SATISFIED", "CURRENT_QUOTED_REQUIREMENTS_EXIST", {
      canonicalJobId: facts.canonical_job_id,
      latestJobVersionId: facts.latest_job_version_id,
      taskJobVersionId: taskVersionId,
      requirementSetId: facts.current_requirement_set_id,
    });
  }
  if (task.task_type === "APPLY_HARD_GATES" && !hasExplicitRerunRequest(payload) &&
      facts.gate_job_version_id === facts.latest_job_version_id && facts.gate_version === GATE_VERSION &&
      facts.processing_state !== "RAW_STAGED") {
    return result("PROVEN_SATISFIED", "CURRENT_HARD_GATE_DECISION_EXISTS", {
      canonicalJobId: facts.canonical_job_id,
      latestJobVersionId: facts.latest_job_version_id,
      taskJobVersionId: taskVersionId,
      gateVersion: facts.gate_version,
    });
  }
  if (task.task_type === "ROUTE_LANE" && !hasExplicitRerunRequest(payload) &&
      ["LANE_ROUTED", "MATCHED", "QUEUED_FOR_AI", "EVALUATING", "AI_EVALUATED", "EVALUATED"].includes(facts.processing_state ?? "") &&
      facts.lane_job_version_id === facts.latest_job_version_id &&
      facts.lane_version === laneContext?.lanesVersion &&
      laneContext?.preferenceContextKnown === true &&
      facts.lane_preference_context_id === laneContext.preferenceContextId) {
    return result("PROVEN_SATISFIED", "CURRENT_LANE_ROUTING_ARTIFACT_EXISTS", {
      canonicalJobId: facts.canonical_job_id,
      latestJobVersionId: facts.latest_job_version_id,
      taskJobVersionId: taskVersionId,
      laneDecisionId: facts.latest_lane_decision_id,
      lanesVersion: facts.lane_version,
    });
  }
  if (task.task_type === "MATCH_PROFILE_EVIDENCE" &&
      !hasExplicitRerunRequest(payload) && matchIsCurrent &&
      (!taskProfileId || taskProfileId === facts.match_profile_version_id)) {
    return result("PROVEN_SATISFIED", "CURRENT_MATCH_RUN_EXISTS", {
      canonicalJobId: facts.canonical_job_id,
      latestJobVersionId: facts.latest_job_version_id,
      taskJobVersionId: taskVersionId,
      matchRunId: facts.latest_match_run_id,
    });
  }
  if (task.task_type === "DECIDE_RECOMMENDATION" &&
      !hasExplicitRerunRequest(payload) && facts.recommendation_outcome !== null && decisionIsCurrent) {
    return result("PROVEN_SATISFIED", "CURRENT_DETERMINISTIC_DECISION_EXISTS", {
      canonicalJobId: facts.canonical_job_id,
      latestJobVersionId: facts.latest_job_version_id,
      taskJobVersionId: taskVersionId,
      decisionId: facts.latest_deterministic_decision_id,
      policySnapshotId: facts.latest_policy_snapshot_id,
    });
  }
  if (task.task_type === "ENQUEUE_EXPLANATION" && !hasExplicitRerunRequest(payload) &&
      matchIsCurrent && decisionIsCurrent && facts.current_evaluation_work_exists) {
    return result("PROVEN_SATISFIED", "CURRENT_EVALUATION_WORK_EXISTS", {
      canonicalJobId: facts.canonical_job_id,
      latestJobVersionId: facts.latest_job_version_id,
      taskJobVersionId: taskVersionId,
      matchRunId: facts.latest_match_run_id,
      decisionId: facts.latest_deterministic_decision_id,
    });
  }

  if ((task.task_type === "DECIDE_RECOMMENDATION" || task.task_type === "ENQUEUE_EXPLANATION") &&
      payloadMatchRunId && !matchIsCurrent) {
    return result("UNRESOLVED", "CURRENT_MATCH_LINEAGE_NOT_PROVEN", {
      taskMatchRunId: payloadMatchRunId,
      latestMatchRunId: facts.latest_match_run_id,
    });
  }
  if (task.task_type === "ENQUEUE_EXPLANATION" && payloadDecisionId && !decisionIsCurrent) {
    return result("UNRESOLVED", "CURRENT_DECISION_LINEAGE_NOT_PROVEN", {
      taskDecisionId: payloadDecisionId,
      latestDecisionId: facts.latest_deterministic_decision_id,
    });
  }

  if (supersessionReasonCode !== null) {
    return proveSupersededWithSuccessor(
      task,
      payload,
      client,
      context,
      facts,
      supersessionReasonCode,
      supersessionDetails,
    );
  }

  return result("CURRENT", "TASK_CONTEXT_IS_CURRENT", {
    canonicalJobId: facts.canonical_job_id,
    jobVersionId: taskVersionId,
  });
}

function reconciliationAction(currentness: PipelineTaskCurrentnessResult): string {
  if (currentness.status === "PROVEN_SATISFIED") return "RECONCILED_PROVEN_SATISFIED";
  if (currentness.status === "PROVEN_SUPERSEDED") return "RECONCILED_PROVEN_SUPERSEDED";
  if (currentness.status === "PROVEN_ARCHIVED") return "SKIPPED_ARCHIVED_JOB";
  return `RECONCILED_${currentness.status}`;
}

function auditMarker(currentness: PipelineTaskCurrentnessResult): string {
  return JSON.stringify({
    event: "PIPELINE_TASK_RECONCILED",
    classifier_version: CURRENTNESS_CLASSIFIER_VERSION,
    action: reconciliationAction(currentness),
    classification: currentness.status,
    reason_code: currentness.reasonCode,
    details: currentness.details,
    observed_at: new Date().toISOString(),
  });
}

export async function reconcileStalePendingPipelineTasks(
  client: pg.PoolClient,
  context: WorkspaceContext,
  options: ReconcileStalePendingPipelineTasksOptions = {},
): Promise<PipelineTaskReconciliationSummary> {
  const apply = options.apply === true;
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const timeBudgetMs = Math.max(1, Math.min(options.timeBudgetMs ?? 10_000, 60_000));
  const startedAt = Date.now();
  const taskTypes = options.taskTypes?.filter((value) => value.trim() !== "") ?? [];
  const jobVersionIds = options.jobVersionIds?.filter((value) => value.trim() !== "") ?? [];
  const observationIds = options.observationIds?.filter((value) => value.trim() !== "") ?? [];
  const params: unknown[] = [context.workspaceId];
  let taskTypeClause = "";
  let targetClause = "";
  if (taskTypes.length > 0) {
    params.push(taskTypes);
    taskTypeClause = `AND task.task_type = ANY($${params.length}::text[])`;
  }
  if (options.jobVersionIds !== undefined && options.observationIds !== undefined) {
    params.push(jobVersionIds, observationIds);
    const jobVersionParam = params.length - 1;
    const observationParam = params.length;
    targetClause = `AND (
      task.payload->>'job_version_id' = ANY($${jobVersionParam}::text[])
      OR task.payload->>'observation_id' = ANY($${observationParam}::text[])
      OR EXISTS (
        SELECT 1
        FROM raw_job_observations AS scoped_observation
        WHERE scoped_observation.workspace_id = task.workspace_id
          AND scoped_observation.id::text = task.payload->>'observation_id'
          AND scoped_observation.job_version_id::text = ANY($${jobVersionParam}::text[])
      )
    )`;
  } else if (options.jobVersionIds !== undefined) {
    params.push(jobVersionIds);
    const jobVersionParam = params.length;
    targetClause = `AND (
      task.payload->>'job_version_id' = ANY($${jobVersionParam}::text[])
      OR EXISTS (
        SELECT 1
        FROM raw_job_observations AS scoped_observation
        WHERE scoped_observation.workspace_id = task.workspace_id
          AND scoped_observation.id::text = task.payload->>'observation_id'
          AND scoped_observation.job_version_id::text = ANY($${jobVersionParam}::text[])
      )
    )`;
  } else if (options.observationIds !== undefined) {
    params.push(observationIds);
    targetClause = `AND task.payload->>'observation_id' = ANY($${params.length}::text[])`;
  }
  params.push(limit);

  if (apply) await client.query("BEGIN");
  try {
    const { rows: tasks } = await client.query<PipelineTaskRow>(
      `SELECT task.id, task.workspace_id, task.task_type, task.task_key, task.payload, task.status,
              task.available_at, task.lease_id, task.lease_expires_at, task.heartbeat_at,
              task.claimed_by, task.attempt_count, task.max_attempts, task.last_error,
              task.dead_letter_reason, task.created_at, task.updated_at, task.completed_at,
              task.context_fingerprint, task.blocked_on, task.blocked_reason, task.repair_action
       FROM pipeline_tasks AS task
       WHERE task.workspace_id = $1
         AND task.status = 'PENDING'
         ${taskTypeClause}
         ${targetClause}
       ORDER BY task.available_at ASC, task.created_at ASC, task.id ASC
       LIMIT $${params.length}
       ${apply ? "FOR UPDATE OF task SKIP LOCKED" : ""}`,
      params,
    );

    let laneContext: PipelineTaskLaneCurrentContext | undefined;
    if (tasks.some((task) => task.task_type === "ROUTE_LANE")) {
      laneContext = await readCurrentLaneContext(client, context);
    }
    let evidenceStrengthPolicyHash: string | undefined;
    if (tasks.some((task) => ["MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION"].includes(task.task_type))) {
      const activeEvidencePolicy = await loadActiveEvidenceStrengthPolicy(client, { context });
      evidenceStrengthPolicyHash = activeEvidencePolicy.policyHash;
    }

    const summary: PipelineTaskReconciliationSummary = {
      scannedPending: tasks.length,
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
    };
    for (let index = 0; index < tasks.length; index += 1) {
      if (Date.now() - startedAt >= timeBudgetMs) {
        summary.deferredByBudget = tasks.length - index;
        break;
      }
      const task = tasks[index];
      if (!task) continue;

      const currentness = await classifyPipelineTaskCurrentness(
        task,
        client,
        context,
        laneContext,
        evidenceStrengthPolicyHash,
      );
      const taskPayload = recordPayload(task.payload);
      const parsedIntent = taskPayload
        ? TaskIntentV2Schema.safeParse(taskPayload.task_intent)
        : null;
      const intent = parsedIntent?.success ? parsedIntent.data : null;
      const auditedCurrentness: PipelineTaskCurrentnessResult = {
        ...currentness,
        details: {
          ...currentness.details,
          taskId: task.id,
          taskType: task.task_type,
          taskKey: task.task_key,
          workspaceId: context.workspaceId,
          requestedContextFingerprint: task.context_fingerprint ?? null,
          intentProducer: intent?.producer ?? null,
          intentRequestId: intent?.requestId ?? null,
          intentMode: intent?.mode ?? null,
          intentStageVersion: intent?.stageVersion ?? null,
          intentTriggerRevisionId: intent?.triggerRevisionId ?? null,
        },
      };
      const decisionIndex = summary.decisions.push({
        taskId: task.id,
        taskType: task.task_type,
        classification: auditedCurrentness.status,
        reasonCode: auditedCurrentness.reasonCode,
        details: auditedCurrentness.details,
        contextFingerprint: task.context_fingerprint ?? null,
        intent,
      }) - 1;
      summary.byClassification[currentness.status] = (summary.byClassification[currentness.status] ?? 0) + 1;
      if (currentness.status === "CURRENT") {
        summary.current += 1;
        continue;
      }
      if (currentness.status === "UNRESOLVED") {
        summary.unresolved += 1;
        continue;
      }

      summary.wouldReconcile += 1;
      if (!apply) continue;

      const marker = auditMarker(auditedCurrentness);
      const payload = recordPayload(task.payload);
      const canonicalJobId = currentness.details.canonicalJobId ??
        (payload ? stringField(payload, "canonical_job_id") : null);
      const expectedLatestJobVersionId = canonicalJobId
        ? currentness.details.latestJobVersionId ??
          currentness.details.successorJobVersionId ??
          currentness.details.jobVersionId ??
          null
        : null;
      const { rowCount } = await client.query(
        `UPDATE pipeline_tasks AS task
         SET status = 'COMPLETED',
             lease_id = NULL,
             lease_expires_at = NULL,
             heartbeat_at = NULL,
             claimed_by = NULL,
             completed_at = NOW(),
             updated_at = NOW(),
             last_error = CASE WHEN $10::text = 'PROVEN_ARCHIVED' THEN NULL
               ELSE concat_ws(E'\\n', NULLIF(task.last_error, ''), $6::text) END,
             repair_action = concat_ws(E'\\n', NULLIF(task.repair_action, ''), $7::text)
         WHERE task.workspace_id = $1
           AND task.id = $2
           AND task.status = 'PENDING'
           AND task.task_key = $3
           AND task.context_fingerprint IS NOT DISTINCT FROM $4
           AND task.payload IS NOT DISTINCT FROM $5::jsonb
           AND (
             $8::uuid IS NULL
             OR EXISTS (
               SELECT 1
               FROM canonical_jobs current_job
               WHERE current_job.workspace_id = task.workspace_id
                 AND current_job.id = $9::uuid
                 AND current_job.latest_job_version_id = $8::uuid
             )
           )`,
        [
          context.workspaceId,
          task.id,
          task.task_key,
          task.context_fingerprint ?? null,
          task.payload,
          marker,
          `${reconciliationAction(auditedCurrentness)} ${marker}`,
          expectedLatestJobVersionId,
          canonicalJobId,
          currentness.status,
        ],
      );
      if (rowCount !== 1) {
        summary.wouldReconcile -= 1;
        summary.byClassification[currentness.status] = Math.max(0, (summary.byClassification[currentness.status] ?? 0) - 1);
        summary.unresolved += 1;
        summary.byClassification.UNRESOLVED = (summary.byClassification.UNRESOLVED ?? 0) + 1;
        summary.byReason.RECONCILIATION_COMPARE_AND_SET_FAILED =
          (summary.byReason.RECONCILIATION_COMPARE_AND_SET_FAILED ?? 0) + 1;
        summary.decisions[decisionIndex] = {
          taskId: task.id,
          taskType: task.task_type,
          classification: "UNRESOLVED",
          reasonCode: "RECONCILIATION_COMPARE_AND_SET_FAILED",
          details: { taskId: task.id, taskKey: task.task_key },
          contextFingerprint: task.context_fingerprint ?? null,
          intent,
        };
        continue;
      }
      summary.reconciled += 1;
      summary.stalePendingReconciledThisRun += 1;
      summary.byReason[currentness.reasonCode] = (summary.byReason[currentness.reasonCode] ?? 0) + 1;
      summary.byTaskType[task.task_type] = (summary.byTaskType[task.task_type] ?? 0) + 1;
    }

    if (apply) await client.query("COMMIT");
    return summary;
  } catch (error) {
    if (apply) await client.query("ROLLBACK");
    throw error;
  }
}
