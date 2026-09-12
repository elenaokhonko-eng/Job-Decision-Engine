import { sha256Hex, stableStringify } from "../config/structuredLoader.js";

export const PIPELINE_CONTEXT_SCHEMA_VERSION = "pipeline_context_v1" as const;

export interface PipelineTaskContextInput {
  workspaceId: string;
  taskType: string;
  taskVersion: string;
  payload: Record<string, unknown>;
}

const CONTEXT_PAYLOAD_KEYS = [
  "canonical_job_id",
  "job_version_id",
  "content_hash",
  "active_requirement_set_id",
  "requirement_extraction_run_id",
  "match_run_id",
  "profile_version_id",
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
  "repair_existing_state",
  "reassessment_reason",
] as const;

function contextPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    CONTEXT_PAYLOAD_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(payload, key))
      .map((key) => [key, payload[key]])
  );
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
