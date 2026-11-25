/**
 * `pipeline_tasks.repair_action` codes of a stage task that completes WITHOUT a stage result by design.
 *
 * A COMPLETED task with no repair_action and no result row is a lost result (`task_completed_without_result`, and for a
 * DECIDE task the reopen rule in `enqueuePipelineTask`). A task that has nothing to do for its job records why in
 * repair_action, so a designed no-op and a lost result can be told apart. Pure constants: no database, no clock.
 */

/** A DECIDE task that completed without stamping a decision for the version; the suffix names why. */
export const DECISION_NOT_STAMPABLE_PREFIX = "DECISION_NOT_STAMPABLE:";

export type DecisionNotStampableReason =
  /** The job is still before lane routing (RAW_STAGED, PREQUALIFIED); the decider is downstream of routing. */
  | "PRE_ROUTING_STATE"
  /** A terminal job whose version already has a decision, and the task is not a decider-version reassessment. */
  | "TERMINAL_HAS_DECISION"
  /** The version has no complete description or no source content, so the decider cannot select it. */
  | "AWAITING_CONTENT_NOT_DECIDABLE"
  /** The job needs a current completed match run to be decided and has none (for example UNMATCHED without a match run). */
  | "NO_CURRENT_MATCH_RUN";

export function decisionNotStampable(reason: DecisionNotStampableReason): string {
  return `${DECISION_NOT_STAMPABLE_PREFIX}${reason}`;
}

/** A MATCH task that has no match to perform for the job's state; the suffix is that state or reason. */
export const MATCH_NOT_APPLICABLE_PREFIX = "MATCH_NOT_APPLICABLE:";

export function matchNotApplicable(stateOrReason: string): string {
  return `${MATCH_NOT_APPLICABLE_PREFIX}${stateOrReason}`;
}

