import pg from "pg";
import { z } from "zod";

import { stableStringify, sha256Hex } from "../config/structuredLoader.js";
import { GATE_VERSION } from "../contracts/version.js";
import { loadActiveEvidenceStrengthPolicy } from "../evidence/evidenceStrengthPolicy.js";
import { buildPipelineTaskContextFingerprint } from "../pipeline/artifactContext.js";
import { loadWorkspaceLanesConfig } from "../pipeline/laneConfigLoader.js";
import type { WorkspaceContext } from "../workspace/context.js";
import type { PipelineTaskRow } from "./pipelineTasks.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const payloadSchema = z.record(z.string(), z.unknown());

export type PipelineTaskCurrentnessStatus =
  | "CURRENT"
  | "SUPERSEDED_JOB_VERSION"
  | "SUPERSEDED_PROFILE_VERSION"
  | "SUPERSEDED_REQUIREMENT_SET"
  | "SUPERSEDED_MATCH"
  | "SUPERSEDED_DECISION"
  | "SUPERSEDED_CONTEXT"
  | "ALREADY_SATISFIED"
  | "UNRESOLVED";

export interface PipelineTaskCurrentnessResult {
  status: PipelineTaskCurrentnessStatus;
  reasonCode: string;
  details: Readonly<Record<string, string | null>>;
}

export interface PipelineTaskReconciliationSummary {
  scannedPending: number;
  current: number;
  unresolved: number;
  wouldReconcile: number;
  reconciled: number;
  stalePendingReconciledThisRun: number;
  byClassification: Partial<Record<PipelineTaskCurrentnessStatus, number>>;
  byReason: Record<string, number>;
  byTaskType: Record<string, number>;
}

export interface ReconcileStalePendingPipelineTasksOptions {
  apply?: boolean;
  limit?: number;
  taskTypes?: readonly string[];
}

export interface PipelineTaskLaneCurrentContext {
  lanesVersion: string | null;
  preferenceContextId: string | null;
  preferenceContextKnown: boolean;
}

interface PipelineTaskLineageFacts {
  canonical_job_id: string;
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
    `SELECT preference_domain, revision_id
     FROM workspace_user_preference_active_versions
     WHERE workspace_id = $1 AND user_id = $2
     ORDER BY preference_domain ASC`,
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
     LIMIT 1`,
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
  if (observation.processing_status === "PROCESSED" && observation.job_version_id) {
    return result("ALREADY_SATISFIED", "NORMALIZATION_ALREADY_PROCESSED", {
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

export async function classifyPipelineTaskCurrentness(
  task: PipelineTaskRow,
  client: pg.PoolClient,
  context: WorkspaceContext,
  laneContext?: PipelineTaskLaneCurrentContext,
  evidenceStrengthPolicyHash?: string,
): Promise<PipelineTaskCurrentnessResult> {
  const payload = recordPayload(task.payload);
  if (!payload) return result("UNRESOLVED", "TASK_PAYLOAD_INVALID");

  if (task.task_type === "NORMALIZE_OBSERVATION") {
    const observationId = stringField(payload, "observation_id");
    const taskKeyParts = task.task_key.split(":");
    const expectedStageVersion = pipelineTaskStageVersion(task.task_type);
    if (!observationId || !UUID_PATTERN.test(observationId)) {
      return result("UNRESOLVED", "NORMALIZATION_OBSERVATION_ID_MISSING");
    }
    if (!expectedStageVersion || taskKeyParts[2] !== expectedStageVersion) {
      return result("SUPERSEDED_CONTEXT", "TASK_STAGE_VERSION_IS_NOT_CURRENT", {
        taskStageVersion: taskKeyParts[2] ?? null,
        currentStageVersion: expectedStageVersion,
      });
    }
    if (taskKeyParts[1] !== observationId) {
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
  const facts = await readLineageFacts(client, context, payload, taskVersionId);
  if (!facts) return result("UNRESOLVED", "CANONICAL_LINEAGE_NOT_FOUND", { jobVersionId: taskVersionId });

  if (facts.latest_job_version_id !== taskVersionId) {
    return result("SUPERSEDED_JOB_VERSION", "TASK_JOB_VERSION_IS_NOT_LATEST", {
      canonicalJobId: facts.canonical_job_id,
      taskJobVersionId: taskVersionId,
      latestJobVersionId: facts.latest_job_version_id,
    });
  }

  const expectedStageVersion = pipelineTaskStageVersion(task.task_type);
  const taskKeyParts = task.task_key.split(":");
  if (!expectedStageVersion || taskKeyParts[2] !== expectedStageVersion) {
    return result("SUPERSEDED_CONTEXT", "TASK_STAGE_VERSION_IS_NOT_CURRENT", {
      taskStageVersion: taskKeyParts[2] ?? null,
      currentStageVersion: expectedStageVersion,
    });
  }
  if (taskKeyParts[1] !== taskVersionId) {
    return result("UNRESOLVED", "TASK_KEY_LINEAGE_MISMATCH", {
      taskKeyVersionId: taskKeyParts[1] ?? null,
      payloadJobVersionId: taskVersionId,
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
  if (payloadContentHash && payloadContentHash !== facts.current_content_hash) {
    return result("SUPERSEDED_JOB_VERSION", "TASK_CONTENT_HASH_IS_NOT_CURRENT", {
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
    return result("SUPERSEDED_REQUIREMENT_SET", "TASK_REQUIREMENT_SET_IS_NOT_CURRENT", {
      taskRequirementSetId: payloadRequirementSetId,
      currentRequirementSetId: facts.current_requirement_set_id,
    });
  }

  const taskProfileId = stringField(payload, "profile_version_id");
  if (taskProfileId && facts.active_profile_version_id && taskProfileId !== facts.active_profile_version_id) {
    if (facts.requested_profile_status === null) {
      return result("UNRESOLVED", "TASK_PROFILE_VERSION_NOT_FOUND", {
        taskProfileVersionId: taskProfileId,
        activeProfileVersionId: facts.active_profile_version_id,
      });
    }
    return result("SUPERSEDED_PROFILE_VERSION", "TASK_PROFILE_VERSION_IS_NOT_ACTIVE", {
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
    return result("SUPERSEDED_MATCH", "TASK_MATCH_RUN_IS_NOT_LATEST", {
      taskMatchRunId: payloadMatchRunId,
      latestMatchRunId: facts.latest_match_run_id,
    });
  }
  if (payloadDecisionId && payloadDecisionId !== facts.latest_deterministic_decision_id) {
    return result("SUPERSEDED_DECISION", "TASK_DECISION_IS_NOT_LATEST", {
      taskDecisionId: payloadDecisionId,
      latestDecisionId: facts.latest_deterministic_decision_id,
    });
  }
  if ((task.task_type === "DECIDE_RECOMMENDATION" || task.task_type === "ENQUEUE_EXPLANATION") &&
      payloadMatchRunId && facts.match_profile_version_id &&
      facts.match_profile_version_id !== facts.active_profile_version_id) {
    if (facts.match_profile_status === null || !facts.active_profile_version_id) {
      return result("UNRESOLVED", "MATCH_PROFILE_ACTIVATION_UNPROVEN", {
        matchProfileVersionId: facts.match_profile_version_id,
        activeProfileVersionId: facts.active_profile_version_id,
      });
    }
    return result("SUPERSEDED_PROFILE_VERSION", "TASK_MATCH_PROFILE_IS_NOT_ACTIVE", {
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
  const decisionIsCurrent = Boolean(
    facts.latest_deterministic_decision_id &&
    facts.decision_job_version_id === facts.latest_job_version_id &&
    facts.decision_match_run_id === (facts.latest_match_run_id ?? null) &&
    facts.decision_policy_snapshot_id === facts.latest_policy_snapshot_id &&
    (facts.decision_match_run_id === null || matchIsCurrent),
  );

  if (task.task_type === "PUBLISH_EMBEDDING") {
    const repairMatchRunId = stringField(payload, "repair_match_run_id");
    if (repairMatchRunId && repairMatchRunId !== facts.latest_match_run_id) {
      return result("SUPERSEDED_MATCH", "EMBEDDING_REPAIR_MATCH_RUN_IS_NOT_LATEST", {
        taskMatchRunId: repairMatchRunId,
        latestMatchRunId: facts.latest_match_run_id,
      });
    }
    if (repairMatchRunId && matchIsCurrent && facts.current_job_embedding_exists) {
      return result("ALREADY_SATISFIED", "CURRENT_MATCH_EMBEDDINGS_ALREADY_PUBLISHED", {
        jobVersionId: taskVersionId,
        matchRunId: repairMatchRunId,
      });
    }
  }

  if (task.task_type === "EXTRACT_DETERMINISTIC_REQUIREMENTS" && facts.requirements_current) {
    return result("ALREADY_SATISFIED", "CURRENT_DETERMINISTIC_REQUIREMENTS_EXIST", {
      jobVersionId: taskVersionId,
      requirementSetId: facts.current_requirement_set_id,
    });
  }
  if (task.task_type === "EXTRACT_QUOTED_REQUIREMENTS" && facts.quoted_requirements_current) {
    return result("ALREADY_SATISFIED", "CURRENT_QUOTED_REQUIREMENTS_EXIST", {
      jobVersionId: taskVersionId,
      requirementSetId: facts.current_requirement_set_id,
    });
  }
  if (task.task_type === "APPLY_HARD_GATES" &&
      facts.gate_job_version_id === facts.latest_job_version_id && facts.gate_version === GATE_VERSION &&
      facts.processing_state !== "RAW_STAGED") {
    return result("ALREADY_SATISFIED", "CURRENT_HARD_GATE_DECISION_EXISTS", {
      jobVersionId: taskVersionId,
      gateVersion: facts.gate_version,
    });
  }
  if (task.task_type === "ROUTE_LANE" &&
      ["LANE_ROUTED", "MATCHED", "QUEUED_FOR_AI", "EVALUATING", "AI_EVALUATED", "EVALUATED"].includes(facts.processing_state ?? "") &&
      facts.lane_job_version_id === facts.latest_job_version_id &&
      facts.lane_version === laneContext?.lanesVersion &&
      laneContext?.preferenceContextKnown === true &&
      facts.lane_preference_context_id === laneContext.preferenceContextId) {
    return result("ALREADY_SATISFIED", "CURRENT_LANE_ROUTING_ARTIFACT_EXISTS", {
      jobVersionId: taskVersionId,
      laneDecisionId: facts.latest_lane_decision_id,
      lanesVersion: facts.lane_version,
    });
  }
  if (task.task_type === "MATCH_PROFILE_EVIDENCE" &&
      !booleanField(payload, "reprocess_existing_state") && matchIsCurrent &&
      (!taskProfileId || taskProfileId === facts.match_profile_version_id)) {
    return result("ALREADY_SATISFIED", "CURRENT_MATCH_RUN_EXISTS", {
      jobVersionId: taskVersionId,
      matchRunId: facts.latest_match_run_id,
    });
  }
  if (task.task_type === "DECIDE_RECOMMENDATION" &&
      facts.recommendation_outcome !== null && decisionIsCurrent) {
    return result("ALREADY_SATISFIED", "CURRENT_DETERMINISTIC_DECISION_EXISTS", {
      jobVersionId: taskVersionId,
      decisionId: facts.latest_deterministic_decision_id,
      policySnapshotId: facts.latest_policy_snapshot_id,
    });
  }
  if (task.task_type === "ENQUEUE_EXPLANATION" && matchIsCurrent && decisionIsCurrent &&
      facts.current_evaluation_work_exists) {
    return result("ALREADY_SATISFIED", "CURRENT_EVALUATION_WORK_EXISTS", {
      jobVersionId: taskVersionId,
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

  return result("CURRENT", "TASK_CONTEXT_IS_CURRENT", {
    canonicalJobId: facts.canonical_job_id,
    jobVersionId: taskVersionId,
  });
}

function reconciliationAction(currentness: PipelineTaskCurrentnessResult): string {
  if (currentness.status === "ALREADY_SATISFIED") return "RECONCILED_ALREADY_SATISFIED_STAGE";
  if (currentness.status === "SUPERSEDED_MATCH") return "RECONCILED_SUPERSEDED_MATCH_RUN";
  return `RECONCILED_${currentness.status}`;
}

function auditMarker(currentness: PipelineTaskCurrentnessResult): string {
  return JSON.stringify({
    event: "PIPELINE_TASK_RECONCILED",
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
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 10000));
  const taskTypes = options.taskTypes?.filter((value) => value.trim() !== "") ?? [];
  const params: unknown[] = [context.workspaceId];
  let taskTypeClause = "";
  if (taskTypes.length > 0) {
    params.push(taskTypes);
    taskTypeClause = `AND task_type = ANY($${params.length}::text[])`;
  }
  params.push(limit);
  const { rows: tasks } = await client.query<PipelineTaskRow>(
    `SELECT id, workspace_id, task_type, task_key, payload, status, available_at,
            lease_id, lease_expires_at, heartbeat_at, claimed_by, attempt_count,
            max_attempts, last_error, dead_letter_reason, created_at, updated_at,
            completed_at, context_fingerprint, blocked_on, blocked_reason, repair_action
     FROM pipeline_tasks
     WHERE workspace_id = $1
       AND status = 'PENDING'
       ${taskTypeClause}
     ORDER BY available_at ASC, created_at ASC, id ASC
     LIMIT $${params.length}`,
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
    byClassification: {},
    byReason: {},
    byTaskType: {},
  };
  for (const task of tasks) {
    const currentness = await classifyPipelineTaskCurrentness(
      task,
      client,
      context,
      laneContext,
      evidenceStrengthPolicyHash,
    );
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
    if (options.apply !== true) continue;

    const marker = auditMarker(currentness);
    const { rowCount } = await client.query(
      `UPDATE pipeline_tasks
       SET status = 'COMPLETED',
           lease_id = NULL,
           lease_expires_at = NULL,
           heartbeat_at = NULL,
           claimed_by = NULL,
           completed_at = NOW(),
           updated_at = NOW(),
           last_error = concat_ws(E'\\n', NULLIF(last_error, ''), $3),
           repair_action = concat_ws(E'\\n', NULLIF(repair_action, ''), $4)
       WHERE workspace_id = $1
         AND id = $2
         AND status = 'PENDING'`,
      [context.workspaceId, task.id, marker, `${reconciliationAction(currentness)} ${marker}`],
    );
    if (rowCount === 1) {
      summary.reconciled += 1;
      summary.stalePendingReconciledThisRun += 1;
      summary.byReason[currentness.status] = (summary.byReason[currentness.status] ?? 0) + 1;
      summary.byTaskType[task.task_type] = (summary.byTaskType[task.task_type] ?? 0) + 1;
    }
  }

  return summary;
}
