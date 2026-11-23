import type pg from "pg";
import {
  archiveJobsAsPostingNotConfirmable,
  findExpiredSnippetOnlyJobs,
  SNIPPET_EXPIRY_FIRST_SEEN_DAYS,
  SNIPPET_EXPIRY_LAST_SEEN_DAYS,
  type SnippetExpiryTrigger,
} from "../services/jobArchive.js";

/**
 * Automatic expiry of snippet-only jobs. A job known only from an alert snippet, whose posting fetch has not
 * succeeded, is archived POSTING_NOT_CONFIRMABLE 7 days after it was last seen and in any case 21 days after it
 * was first seen. "Not confirmable" is not "closed": the posting's state is unknown, the archive is reversible
 * through restoreArchivedJob, and a reappearing posting is restored. Jobs with an active application, document
 * run, lease, manual review or archive hold are skipped and counted. Nothing is deleted.
 *
 * Idempotent: an archived job is no longer live, so a second run finds nothing new. The caller supplies the
 * transaction; a dry run (apply = false) only reads.
 */

export interface SnippetExpiryReport {
  mode: "DRY_RUN" | "APPLY";
  candidates: number;
  toArchive: number;
  protectedSkipped: number;
  byTrigger: Record<SnippetExpiryTrigger, number>;
  archived: number;
  /** Ids only, never titles or employers. */
  archivedJobIds: string[];
}

export interface SnippetExpiryInput {
  workspaceId: string;
  apply: boolean;
  now?: Date;
  actor: string;
  /** Recorded on the archive run so the whole batch can be traced and reversed. */
  restorePoint?: string;
  lastSeenDays?: number;
  firstSeenDays?: number;
}

export async function expireSnippetOnlyJobs(client: pg.PoolClient, input: SnippetExpiryInput): Promise<SnippetExpiryReport> {
  const lastSeenDays = input.lastSeenDays ?? SNIPPET_EXPIRY_LAST_SEEN_DAYS;
  const firstSeenDays = input.firstSeenDays ?? SNIPPET_EXPIRY_FIRST_SEEN_DAYS;
  const candidates = await findExpiredSnippetOnlyJobs(client, { workspaceId: input.workspaceId, now: input.now, lastSeenDays, firstSeenDays });
  const eligible = candidates.filter((candidate) => !candidate.protected);
  const byTrigger: Record<SnippetExpiryTrigger, number> = { LAST_SEEN: 0, FIRST_SEEN: 0 };
  for (const candidate of eligible) byTrigger[candidate.trigger] += 1;
  const report: SnippetExpiryReport = {
    mode: input.apply ? "APPLY" : "DRY_RUN",
    candidates: candidates.length,
    toArchive: eligible.length,
    protectedSkipped: candidates.length - eligible.length,
    byTrigger,
    archived: 0,
    archivedJobIds: [],
  };
  if (!input.apply) return report;

  for (const trigger of ["LAST_SEEN", "FIRST_SEEN"] as const) {
    const ids = eligible.filter((candidate) => candidate.trigger === trigger).map((candidate) => candidate.canonicalJobId);
    if (ids.length === 0) continue;
    const archived = await archiveJobsAsPostingNotConfirmable(client, {
      workspaceId: input.workspaceId,
      canonicalJobIds: ids,
      actor: input.actor,
      details: {
        rule: "snippet-only-expiry",
        trigger,
        last_seen_days: lastSeenDays,
        first_seen_days: firstSeenDays,
        ...(input.restorePoint ? { restore_point: input.restorePoint } : {}),
        reason: "Alert snippet only; the posting fetch did not succeed in time and its state is unknown (not closed).",
      },
    });
    report.archived += archived.length;
    report.archivedJobIds.push(...archived);
  }
  return report;
}
