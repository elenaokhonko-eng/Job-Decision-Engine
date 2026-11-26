/**
 * Which queue work waits for the owner's go. Held work is left exactly as it is: not claimed, not blocked, not
 * closed. It is therefore also left out of the worker's backlog SLOs, which measure work the worker could do.
 */
import type { AiWorkSettings } from "../../../platform/config/index.js";

/** The one pipeline task type that leads to a model evaluation. */
export const AI_WORK_TASK_TYPE = "ENQUEUE_EXPLANATION";

export function claimableTaskTypes<T extends string>(taskTypes: readonly T[], settings: AiWorkSettings): T[] {
  return settings.mode === "HELD" ? taskTypes.filter((type) => type !== AI_WORK_TASK_TYPE) : [...taskTypes];
}

/** Drops held PENDING and RETRY_WAIT rows from queue-health rows; dead letters and blocked tasks stay counted. */
export function withoutHeldQueueRows<T extends { task_type: string; status: string }>(
  rows: readonly T[],
  settings: AiWorkSettings,
): T[] {
  return rows.filter((row) => !(
    settings.mode === "HELD" &&
    row.task_type === AI_WORK_TASK_TYPE &&
    (row.status === "PENDING" || row.status === "RETRY_WAIT")
  ));
}
