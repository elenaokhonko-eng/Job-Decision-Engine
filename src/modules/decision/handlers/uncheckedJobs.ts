/**
 * How many listed jobs the same-day availability check (src/tasks/manualAvailabilityCheck.ts) would still read. The
 * lists are final at zero. A link it never reads, one already read today, or a site that stopped answering today, leaves
 * the job as not verified and counts as done. Read only; no request. A test holds this equal to the check's own plan.
 */
import { createHash } from "node:crypto";

import { selectChecksOfDay, selectCheckStates, type DecisionQueryable } from "../../../platform/persistence/decision/index.js";

/** The day a check counts for, as the check itself counts it. */
export const CHECK_TIME_ZONE = "Asia/Singapore";

export interface CheckLinkRules {
  /** False for a link the check never reads (LinkedIn, aggregator, job board). */
  readable(link: string): boolean;
  /** The host the first request would go to. */
  requestHost(link: string): string;
}

export async function countUncheckedJobs(
  db: DecisionQueryable,
  workspaceId: string,
  jobIds: readonly string[],
  now: Date,
  rules: CheckLinkRules,
): Promise<number> {
  const today = await selectChecksOfDay(db, workspaceId, now, CHECK_TIME_ZONE);
  const read = new Set(today.flatMap((row) => (row.link_key ? [row.link_key] : [])));
  const stopped = new Set(today.flatMap((row) => (Array.isArray(row.stopped_sites) ? row.stopped_sites.map(String) : [])));
  let unchecked = 0;
  for (const state of await selectCheckStates(db, workspaceId, jobIds, now, CHECK_TIME_ZONE)) {
    const link = state.link?.trim();
    if (!link || state.open_today || state.checked_today || !rules.readable(link)) continue;
    let key: string;
    let host: string;
    try {
      const url = new URL(link);
      url.hash = "";
      key = createHash("sha256").update(url.toString()).digest("hex");
      host = rules.requestHost(link).toLowerCase();
    } catch {
      continue;
    }
    if (read.has(key) || stopped.has(host)) continue;
    read.add(key);
    unchecked += 1;
  }
  return unchecked;
}
