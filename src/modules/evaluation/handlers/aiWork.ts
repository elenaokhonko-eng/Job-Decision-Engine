import type { AiWorkSettings } from "../../../platform/config/index.js";
import {
  selectHeldAiWorkCounts,
  selectJobVersionScoreAbove,
  type EvaluationQueryable,
  type HeldAiWorkCounts,
} from "../../../platform/persistence/evaluation/index.js";

/** FALSE while the owner's switch is closed, and for a job at or below the cut-off or without a ranking score. */
export async function jobVersionMayReceiveAiWork(
  db: EvaluationQueryable,
  workspaceId: string,
  jobVersionId: string,
  settings: AiWorkSettings,
): Promise<boolean> {
  if (settings.mode === "HELD") return false;
  return selectJobVersionScoreAbove(db, workspaceId, jobVersionId, settings.scoreCutoff);
}

export type AiWorkReport = AiWorkSettings & HeldAiWorkCounts;

/** The switch as it stands, with counts of the waiting work so a hold is never invisible. */
export async function describeAiWork(
  db: EvaluationQueryable,
  workspaceId: string,
  outcomes: readonly string[],
  settings: AiWorkSettings,
): Promise<AiWorkReport> {
  return { ...settings, ...(await selectHeldAiWorkCounts(db, workspaceId, outcomes)) };
}
