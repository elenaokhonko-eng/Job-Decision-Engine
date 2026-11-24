import type pg from "pg";
import { z } from "zod";
import {
  archiveJobsAsPostingNotConfirmable,
  isProtected,
  protectionColumnsSql,
  readSchemaCapabilities,
  type ArchiveProtectionFlags,
} from "../services/jobArchive.js";

const uuidSchema = z.string().uuid();

/** A snippet-only job whose fetch has not succeeded expires this many days after it was last seen ... */
export const SNIPPET_EXPIRY_LAST_SEEN_DAYS = 7;
/** ... or this many days after it was first seen, unless a fetch is still within its retry budget. */
export const SNIPPET_EXPIRY_FIRST_SEEN_DAYS = 21;

export type SnippetExpiryTrigger = "LAST_SEEN" | "FIRST_SEEN";

export interface ExpiredSnippetCandidate {
  canonicalJobId: string;
  trigger: SnippetExpiryTrigger;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** A protection (active application, document run, lease, manual review, hold) keeps the job out of the archive. */
  protected: boolean;
  /** A FETCH_JOB_CONTENT task is still pending, running or retrying within its attempt budget: the fetch may yet succeed. */
  fetchInFlight: boolean;
}

/**
 * Live snippet-only jobs whose content never arrived and whose time is up: every observation is a bare Gmail
 * alert (nothing from an employer page or a saved-jobs export), the job has no complete content
 * (v_job_content_state), and either nothing was seen for `lastSeenDays` or the first sighting is `firstSeenDays`
 * old. Manually removed jobs are never candidates. Read only; protected jobs are returned flagged so the caller
 * can count and skip them. A job whose FETCH_JOB_CONTENT task is still pending, running or retrying within its attempt budget is
 * flagged `fetchInFlight` and is not archived (an outage must not archive a job the fetch could still complete);
 * the budget is finite, so the job expires once the task is exhausted, dead-lettered, parked or completed.
 */
export async function findExpiredSnippetOnlyJobs(
  client: pg.PoolClient,
  input: { workspaceId: string; now?: Date; lastSeenDays?: number; firstSeenDays?: number },
): Promise<ExpiredSnippetCandidate[]> {
  uuidSchema.parse(input.workspaceId);
  const lastSeenDays = input.lastSeenDays ?? SNIPPET_EXPIRY_LAST_SEEN_DAYS;
  const firstSeenDays = input.firstSeenDays ?? SNIPPET_EXPIRY_FIRST_SEEN_DAYS;
  for (const days of [lastSeenDays, firstSeenDays]) {
    if (!Number.isInteger(days) || days < 1) throw new RangeError("Snippet expiry days must be whole numbers, 1 or more.");
  }
  if (firstSeenDays < lastSeenDays) throw new RangeError("The first-seen limit cannot be shorter than the last-seen limit.");
  const capabilities = await readSchemaCapabilities(client);
  const result = await client.query<
    ArchiveProtectionFlags & { canonical_job_id: string; first_seen_at: Date; last_seen_at: Date; last_seen_expired: boolean; fetch_in_flight: boolean }
  >(
    `SELECT canonical.id::text AS canonical_job_id,
            seen.first_seen_at,
            seen.last_seen_at,
            (seen.last_seen_at <= $1::timestamptz - make_interval(days => $3::int)) AS last_seen_expired,
            EXISTS (
              SELECT 1 FROM pipeline_tasks fetch_task
                JOIN raw_job_observations fetch_observation
                  ON fetch_observation.workspace_id = fetch_task.workspace_id
                 AND fetch_observation.id::text = fetch_task.payload->>'observation_id'
                JOIN job_versions fetch_version
                  ON fetch_version.workspace_id = fetch_observation.workspace_id
                 AND fetch_version.id = fetch_observation.job_version_id
               WHERE fetch_task.workspace_id = canonical.workspace_id
                 AND fetch_task.task_type = 'FETCH_JOB_CONTENT'
                 AND fetch_task.status IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
                 AND fetch_task.attempt_count < fetch_task.max_attempts
                 AND fetch_version.canonical_job_id = canonical.id
            ) AS fetch_in_flight,
            ${protectionColumnsSql(capabilities)}
       FROM canonical_jobs canonical
       JOIN v_job_content_state content_state
         ON content_state.workspace_id = canonical.workspace_id AND content_state.canonical_job_id = canonical.id
       CROSS JOIN LATERAL (
         SELECT MIN(observation.retrieved_at) AS first_seen_at, MAX(observation.retrieved_at) AS last_seen_at
           FROM job_versions any_version
           JOIN raw_job_observations observation
             ON observation.workspace_id = any_version.workspace_id AND observation.job_version_id = any_version.id
          WHERE any_version.workspace_id = canonical.workspace_id AND any_version.canonical_job_id = canonical.id
       ) seen
      WHERE canonical.workspace_id = $2::uuid
        AND canonical.archived_at IS NULL
        AND canonical.is_test_fixture = FALSE
        AND COALESCE(canonical.processing_state, canonical.processing_status) <> 'MANUALLY_REMOVED'
        AND NOT content_state.content_complete
        AND seen.first_seen_at IS NOT NULL
        AND (
          seen.last_seen_at <= $1::timestamptz - make_interval(days => $3::int)
          OR seen.first_seen_at <= $1::timestamptz - make_interval(days => $4::int)
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_versions v
            JOIN raw_job_observations o ON o.workspace_id = v.workspace_id AND o.job_version_id = v.id
           WHERE v.workspace_id = canonical.workspace_id AND v.canonical_job_id = canonical.id
             AND o.source_name <> 'GMAIL_ALERT'
        )
      ORDER BY canonical.id`,
    [input.now ?? new Date(), input.workspaceId, lastSeenDays, firstSeenDays],
  );
  return result.rows.map((row) => ({
    canonicalJobId: row.canonical_job_id,
    trigger: row.last_seen_expired ? "LAST_SEEN" : "FIRST_SEEN",
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    protected: isProtected(row),
    fetchInFlight: row.fetch_in_flight,
  }));
}



/**
 * Automatic expiry of snippet-only jobs. A job known only from an alert snippet, whose posting fetch has not
 * succeeded, is archived POSTING_NOT_CONFIRMABLE 7 days after it was last seen or 21 days after it
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
  /** Candidates left alone because their fetch task is still within its retry budget. */
  deferredFetchInFlight: number;
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
  const eligible = candidates.filter((candidate) => !candidate.protected && !candidate.fetchInFlight);
  const protectedSkipped = candidates.filter((candidate) => candidate.protected).length;
  const deferredFetchInFlight = candidates.filter((candidate) => !candidate.protected && candidate.fetchInFlight).length;
  const byTrigger: Record<SnippetExpiryTrigger, number> = { LAST_SEEN: 0, FIRST_SEEN: 0 };
  for (const candidate of eligible) byTrigger[candidate.trigger] += 1;
  const report: SnippetExpiryReport = {
    mode: input.apply ? "APPLY" : "DRY_RUN",
    candidates: candidates.length,
    toArchive: eligible.length,
    protectedSkipped,
    deferredFetchInFlight,
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
