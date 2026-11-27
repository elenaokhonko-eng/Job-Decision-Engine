import {
  deleteEndedRematchWaits,
  insertNewRematchWaits,
  type DecisionQueryable,
} from "../../../platform/persistence/decision/index.js";

/**
 * Keeps the start of every wait for a re-match: records jobs that began to wait and clears jobs that no longer do.
 * The decider calls it for the jobs it decided, and the worker for the whole workspace when a pass starts and ends.
 * Without ids it covers the whole workspace.
 */
export async function syncRematchWaits(
  db: DecisionQueryable,
  workspaceId: string,
  canonicalJobIds?: readonly string[],
): Promise<void> {
  if (canonicalJobIds && canonicalJobIds.length === 0) return;
  await deleteEndedRematchWaits(db, workspaceId, canonicalJobIds ?? null);
  await insertNewRematchWaits(db, workspaceId, canonicalJobIds ?? null);
}
