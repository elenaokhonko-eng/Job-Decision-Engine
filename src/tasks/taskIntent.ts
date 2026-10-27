import { z } from "zod";

import { buildPipelineTaskContextFingerprint } from "../pipeline/artifactContext.js";

const TaskIntentCoreSchema = z.object({
  schemaVersion: z.literal("task_intent_v2"),
  taskType: z.string().min(1),
  stageVersion: z.string().min(1),
  producer: z.string().min(1),
  requestId: z.string().min(1),
  mode: z.enum(["ENSURE_CURRENT", "FORCE_RECOMPUTE"]),
  triggerRevisionId: z.string().nullable(),
  target: z.object({
    workspaceId: z.string().min(1),
    canonicalJobId: z.string().nullable(),
    jobVersionId: z.string().nullable(),
    observationId: z.string().nullable(),
  }).strict(),
}).strict();

export const TaskIntentV2Schema = TaskIntentCoreSchema.extend({
  contextFingerprint: z.string().min(1),
}).strict();

export type TaskIntentV2 = z.infer<typeof TaskIntentV2Schema>;
export type TaskIntentMode = TaskIntentV2["mode"];

export interface CreateTaskIntentV2Input {
  readonly workspaceId: string;
  readonly taskType: string;
  readonly stageVersion: string;
  readonly producer: string;
  readonly requestId: string;
  readonly mode?: TaskIntentMode;
  readonly triggerRevisionId?: string | null;
  readonly payload: Record<string, unknown>;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function createTaskIntentV2(input: CreateTaskIntentV2Input): TaskIntentV2 {
  const forceRecompute = input.payload.reprocess === true ||
    input.payload.force_policy_recalculation === true ||
    input.payload.reprocess_existing_state === true ||
    (typeof input.payload.verification_answer_revision_id === "string" &&
      input.payload.verification_answer_revision_id.trim() !== "");
  const core = TaskIntentCoreSchema.parse({
    schemaVersion: "task_intent_v2",
    taskType: input.taskType,
    stageVersion: input.stageVersion,
    producer: input.producer,
    requestId: input.requestId,
    mode: input.mode ?? (forceRecompute ? "FORCE_RECOMPUTE" : "ENSURE_CURRENT"),
    triggerRevisionId: input.triggerRevisionId ??
      payloadString(input.payload, "trigger_revision_id") ??
      payloadString(input.payload, "verification_answer_revision_id") ??
      payloadString(input.payload, "preference_mode_updated_at") ??
      payloadString(input.payload, "repair_generation"),
    target: {
      workspaceId: input.workspaceId,
      canonicalJobId: payloadString(input.payload, "canonical_job_id"),
      jobVersionId: payloadString(input.payload, "job_version_id"),
      observationId: payloadString(input.payload, "observation_id"),
    },
  });
  const contextFingerprint = buildPipelineTaskContextFingerprint({
    workspaceId: input.workspaceId,
    taskType: input.taskType,
    taskVersion: input.stageVersion,
    payload: { ...input.payload, task_intent: core },
  });
  return TaskIntentV2Schema.parse({ ...core, contextFingerprint });
}
