import { z } from "zod";

import { TaskIntentV2Schema } from "./taskIntent.js";
import type { ClaimedPipelineTask } from "./pipelineTasks.js";

export interface ForcedTaskRerouteIntent {
  readonly producer: string;
  readonly requestId: string;
  readonly triggerRevisionId: string | null;
  readonly mode: "FORCE_RECOMPUTE";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function forcedTaskReroutePayload(
  task: ClaimedPipelineTask,
  canonicalJobId: string,
  jobVersionId: string,
): Record<string, unknown> {
  const parsedPayload = z.record(z.string(), z.unknown()).safeParse(task.payload);
  if (!parsedPayload.success) throw new Error(`Forced task ${task.taskKey} has an invalid payload.`);
  const payload = { ...parsedPayload.data };
  delete payload.task_intent;
  return { ...payload, canonical_job_id: canonicalJobId, job_version_id: jobVersionId };
}

export function forcedTaskRerouteIntent(task: ClaimedPipelineTask): ForcedTaskRerouteIntent {
  const parsedPayload = z.record(z.string(), z.unknown()).safeParse(task.payload);
  if (!parsedPayload.success) throw new Error(`Forced task ${task.taskKey} has an invalid payload.`);
  const record = parsedPayload.data;
  const parsedIntent = TaskIntentV2Schema.safeParse(record.task_intent);
  if (record.task_intent !== undefined && !parsedIntent.success) {
    throw new Error(`Forced task ${task.taskKey} contains an invalid TaskIntentV2.`);
  }
  if (parsedIntent.success) {
    if (parsedIntent.data.mode !== "FORCE_RECOMPUTE") {
      throw new Error(`Forced task ${task.taskKey} has a non-forced TaskIntentV2 mode.`);
    }
    return {
      producer: parsedIntent.data.producer,
      requestId: parsedIntent.data.requestId,
      triggerRevisionId: parsedIntent.data.triggerRevisionId,
      mode: "FORCE_RECOMPUTE",
    };
  }

  const keyParts = task.taskKey.split(":");
  if (task.taskType === "APPLY_HARD_GATES" && keyParts[2] === "preference") {
    const modeKey = keyParts[3]?.trim();
    const revision = keyParts[4]?.trim();
    if (!modeKey || !revision || record.preference_mode_key !== modeKey) {
      throw new Error(`Legacy preference task ${task.taskKey} has unproven mode or revision identity.`);
    }
    return {
      producer: "api.preference_mode_change",
      requestId: `preference:${modeKey}:${revision}`,
      triggerRevisionId: revision,
      mode: "FORCE_RECOMPUTE",
    };
  }

  const requestId = nonEmptyString(record.policy_recheck_request_id) ?? task.taskKey;
  const triggerRevisionId = nonEmptyString(record.verification_answer_revision_id) ??
    nonEmptyString(record.repair_generation) ?? null;
  return {
    producer: `legacy:${task.taskType}`,
    requestId,
    triggerRevisionId,
    mode: "FORCE_RECOMPUTE",
  };
}
