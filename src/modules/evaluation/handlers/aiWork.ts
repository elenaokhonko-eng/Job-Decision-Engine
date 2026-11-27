import { listLeadJobIds } from "../../catalog/index.js";
import type { AiWorkSettings } from "../../../platform/config/index.js";
import {
  selectHeldAiWorkCounts,
  selectJobVersionQualifies,
  selectQualifyingJobVersions,
  type EvaluationQueryable,
  type HeldAiWorkCounts,
} from "../../../platform/persistence/evaluation/index.js";

/**
 * FALSE while the owner's switch is closed, and for a job at or below the cut-off, without a ranking score, or
 * scored under another score policy than the approved one.
 */
export async function jobVersionMayReceiveAiWork(
  db: EvaluationQueryable,
  workspaceId: string,
  jobVersionId: string,
  settings: AiWorkSettings,
): Promise<boolean> {
  if (settings.mode === "HELD") return false;
  return selectJobVersionQualifies(db, workspaceId, jobVersionId, settings);
}

/** `jobVersionMayReceiveAiWork` for a list, in one query. */
export async function jobVersionsThatMayReceiveAiWork(
  db: EvaluationQueryable,
  workspaceId: string,
  jobVersionIds: readonly string[],
  settings: AiWorkSettings,
): Promise<ReadonlySet<string>> {
  if (settings.mode === "HELD") return new Set();
  return new Set(await selectQualifyingJobVersions(db, workspaceId, jobVersionIds, settings));
}

export type AiWorkReport = AiWorkSettings & HeldAiWorkCounts;

/**
 * The switch as it stands, with counts of the waiting work so a hold is never invisible. Leads are never evaluated,
 * so nothing of theirs is counted as waiting for the owner.
 */
export async function describeAiWork(
  db: EvaluationQueryable,
  workspaceId: string,
  outcomes: readonly string[],
  settings: AiWorkSettings,
): Promise<AiWorkReport> {
  return {
    ...settings,
    ...(await selectHeldAiWorkCounts(
      db,
      workspaceId,
      outcomes,
      settings.mode === "OPEN" ? settings : null,
      await listLeadJobIds(db, workspaceId),
    )),
  };
}
