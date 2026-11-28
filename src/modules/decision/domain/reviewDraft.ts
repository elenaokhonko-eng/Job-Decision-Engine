/**
 * The lists are final only after the same-day availability check. Until then a run is a draft: it remembers where each
 * listed job stood, so that a job the check finds closed can be reported (role type and rank) after the rating. The
 * next-ranked job takes its place because the lists are simply built again without it. The memory is sealed (encoded),
 * as the key is: nothing shows what was dropped before the jobs are rated. Pure.
 */
import type { ReviewLists } from "./reviewLists.js";

export interface ListedPosition {
  readonly id: string;
  readonly roleType: string | null;
  /** Rank in its role-type list; null for a job listed only as a comparison. */
  readonly roleRank: number | null;
  readonly overallRank: number | null;
  readonly comparison: boolean;
}

export interface DroppedJob extends ListedPosition {
  /** CLOSED: found closed. OTHER: no longer eligible for another reason. */
  readonly reason: "CLOSED" | "OTHER";
}

export interface DraftState {
  /** The last known position of every job a draft has listed and that has not been dropped. */
  readonly listed: readonly ListedPosition[];
  readonly dropped: readonly DroppedJob[];
}

export const EMPTY_DRAFT: DraftState = { listed: [], dropped: [] };

export function listedPositions(lists: ReviewLists): ListedPosition[] {
  const positions = new Map<string, ListedPosition>();
  const at = (id: string) => positions.get(id) ?? { id, roleType: null, roleRank: null, overallRank: null, comparison: false };
  for (const list of lists.byType) {
    list.jobs.forEach((job, index) => positions.set(job.id, { ...at(job.id), roleType: list.type.key, roleRank: index + 1 }));
  }
  lists.overall.forEach((job, index) => positions.set(job.id, { ...at(job.id), overallRank: index + 1 }));
  for (const job of lists.comparison) {
    positions.set(job.id, { ...at(job.id), roleType: job.classification.roleType, comparison: true });
  }
  return [...positions.values()];
}

export function updateDraft(
  previous: DraftState,
  lists: ReviewLists,
  closedIds: ReadonlySet<string>,
  eligibleIds: ReadonlySet<string>,
): DraftState {
  const dropped = [...previous.dropped];
  const kept = new Map<string, ListedPosition>();
  for (const position of previous.listed) {
    if (closedIds.has(position.id)) dropped.push({ ...position, reason: "CLOSED" });
    else if (!eligibleIds.has(position.id)) dropped.push({ ...position, reason: "OTHER" });
    else kept.set(position.id, position);
  }
  for (const position of listedPositions(lists)) kept.set(position.id, position);
  return { listed: [...kept.values()], dropped };
}

export const sealDraft = (state: DraftState): string =>
  `${JSON.stringify({ schema_version: "review_lists_draft_v1", sealed: Buffer.from(JSON.stringify(state), "utf8").toString("base64") })}\n`;

export function openDraft(text: string): DraftState {
  const draft = JSON.parse(text) as { schema_version?: string; sealed?: string };
  if (draft.schema_version !== "review_lists_draft_v1" || typeof draft.sealed !== "string") {
    throw new Error("Key file or draft is not of this version.");
  }
  return JSON.parse(Buffer.from(draft.sealed, "base64").toString("utf8")) as DraftState;
}
