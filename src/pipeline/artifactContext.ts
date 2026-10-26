import { sha256Hex, stableStringify } from "../config/structuredLoader.js";

export const PIPELINE_CONTEXT_SCHEMA_VERSION = "pipeline_context_v1" as const;

export interface PipelineTaskContextInput {
  workspaceId: string;
  taskType: string;
  taskVersion: string;
  payload: Record<string, unknown>;
}

const TASK_INTENT_CONTEXT_KEYS = [
  "schemaVersion",
  "taskType",
  "stageVersion",
  "producer",
  "requestId",
  "mode",
  "triggerRevisionId",
  "target",
] as const;

const CONTEXT_PAYLOAD_KEYS = [
  "canonical_job_id",
  "job_version_id",
  "content_hash",
  "active_requirement_set_id",
  "requirement_extraction_run_id",
  "match_run_id",
  "profile_version_id",
  "preference_context_id",
  "preference_mode_key",
  "preference_mode_updated_at",
  "workability_policy_hash",
  "lane_policy_version",
  "embedding_space_id",
  "embedding_model",
  "matcher_version",
  "policy_snapshot_id",
  "policy_hash",
  "evidence_strength_policy_hash",
  "evaluation_schema_version",
  "prompt_hash",
  "model_route",
  "force_policy_recalculation",
  "reprocess",
  "reprocess_existing_state",
  "repair_existing_state",
  "repair_dependency",
  "repair_generation",
  "repair_match_run_id",
  "reassessment_reason",
  "verification_answer_revision_id",
  "queue_budget_run_id",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskIntentContext(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    TASK_INTENT_CONTEXT_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
      .map((key) => [key, value[key]]),
  );
}

function contextPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const context = Object.fromEntries(
    CONTEXT_PAYLOAD_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(payload, key))
      .map((key) => [key, payload[key]]),
  );
  const intent = taskIntentContext(payload.task_intent);
  return intent ? { ...context, task_intent: intent } : context;
}

export function buildPipelineTaskContextFingerprint(input: PipelineTaskContextInput): string {
  return sha256Hex(
    `${PIPELINE_CONTEXT_SCHEMA_VERSION}|${stableStringify({
      workspace_id: input.workspaceId,
      task_type: input.taskType,
      task_version: input.taskVersion,
      payload: contextPayload(input.payload),
    })}`
  );
}
