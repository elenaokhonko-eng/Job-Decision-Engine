/**
 * Read-only before/after proof for a repair or rehearsal: no live job lost a stored result (lane, match, decision,
 * adjusted score) and no protected job (owner-saved, applied to, or held) changed status. Take a snapshot before and
 * after, then diff. Counts and ids only; never job content.
 */
import type pg from "pg";

import { OWNER_SAVED_SOURCE_NAMES } from "../services/jobArchiveHardRejectedPolicy.js";

type Queryable = Pick<pg.PoolClient, "query">;

export const RESULT_FIELDS = ["decision", "match", "lane", "score"] as const;
export type ResultField = (typeof RESULT_FIELDS)[number];

export interface RepairStateSnapshot {
  readonly liveJobs: number;
  readonly liveJobsWithDecision: number;
  readonly liveJobsWithMatch: number;
  readonly liveJobsWithLane: number;
  readonly liveJobsWithScore: number;
  readonly protectedJobs: number;
  /** Live jobs that were HARD_REJECTED or UNMATCHED when the snapshot was taken. */
  readonly terminalJobIds: readonly string[];
  /** Per live job: which results are stored. */
  readonly results: Readonly<Record<string, Readonly<Record<ResultField, boolean>>>>;
  /** Per protected job: a status string (archive state, application statuses, active holds; not the processing state). */
  readonly protectedStatus: Readonly<Record<string, string>>;
}

export async function snapshotRepairState(db: Queryable, workspaceId: string): Promise<RepairStateSnapshot> {
  const live = await db.query<{ id: string; terminal: boolean; decision: boolean; match: boolean; lane: boolean; score: boolean }>(
    `SELECT c.id::text AS id,
            COALESCE(c.processing_state, c.processing_status) IN ('HARD_REJECTED', 'UNMATCHED') AS terminal,
            c.latest_deterministic_decision_id IS NOT NULL AS decision,
            c.latest_match_run_id IS NOT NULL AS match,
            c.latest_lane_decision_id IS NOT NULL AS lane,
            c.recommendation_requirement_score IS NOT NULL AS score
       FROM canonical_jobs c
      WHERE c.workspace_id = $1::uuid AND c.archived_at IS NULL AND NOT c.is_test_fixture`,
    [workspaceId],
  );
  const results: Record<string, Record<ResultField, boolean>> = {};
  const terminalJobIds = live.rows.filter((row) => row.terminal).map((row) => row.id);
  for (const row of live.rows) results[row.id] = { decision: row.decision, match: row.match, lane: row.lane, score: row.score };

  const protectedRows = await db.query<{ id: string; status: string }>(
    `SELECT c.id::text AS id,
            'archived=' || (c.archived_at IS NOT NULL)::text
              || '|applications=' || COALESCE((SELECT string_agg(a.status, ',' ORDER BY a.status) FROM application_records a
                                                WHERE a.workspace_id = c.workspace_id AND a.canonical_job_id = c.id), '')
              || '|holds=' || COALESCE((SELECT COUNT(*)::text FROM job_archive_holds h
                                         WHERE h.workspace_id = c.workspace_id AND h.canonical_job_id = c.id
                                           AND h.released_at IS NULL AND h.expires_at > NOW()), '0') AS status
       FROM canonical_jobs c
      WHERE c.workspace_id = $1::uuid AND NOT c.is_test_fixture
        AND (
          EXISTS (SELECT 1 FROM application_records a WHERE a.workspace_id = c.workspace_id AND a.canonical_job_id = c.id)
          OR EXISTS (SELECT 1 FROM job_archive_holds h WHERE h.workspace_id = c.workspace_id AND h.canonical_job_id = c.id
                      AND h.released_at IS NULL AND h.expires_at > NOW())
          OR EXISTS (SELECT 1 FROM job_versions v JOIN raw_job_observations o ON o.workspace_id = v.workspace_id AND o.job_version_id = v.id
                      WHERE v.workspace_id = c.workspace_id AND v.canonical_job_id = c.id AND UPPER(o.source_name) = ANY($2::text[]))
        )`,
    [workspaceId, [...OWNER_SAVED_SOURCE_NAMES]],
  );
  const protectedStatus: Record<string, string> = {};
  for (const row of protectedRows.rows) protectedStatus[row.id] = row.status;

  const count = (field: ResultField): number => Object.values(results).filter((entry) => entry[field]).length;
  return {
    liveJobs: live.rows.length,
    liveJobsWithDecision: count("decision"),
    liveJobsWithMatch: count("match"),
    liveJobsWithLane: count("lane"),
    liveJobsWithScore: count("score"),
    protectedJobs: protectedRows.rows.length,
    terminalJobIds,
    results,
    protectedStatus,
  };
}

export interface RepairStateDiff {
  /**
   * A requirement score cleared on a job that is HARD_REJECTED or UNMATCHED after the run: expected, not a loss. The
   * decider takes the score from the match score, which a rejected job does not have, so a recompute clears it.
   */
  readonly expectedClears: ReadonlyArray<{ readonly jobId: string; readonly field: ResultField }>;
  /** A live job (in both snapshots) that had a stored result before and has none now. Ids only. */
  readonly lostResults: ReadonlyArray<{ readonly jobId: string; readonly field: ResultField }>;
  /** A protected job whose status string changed, or that is gone from the live protected set. */
  readonly protectedChanged: ReadonlyArray<{ readonly jobId: string; readonly before: string; readonly after: string }>;
  /** Live jobs that left the live set (archived or removed) between the snapshots. */
  readonly leftLiveSet: number;
  readonly ok: boolean;
}

export function diffRepairSnapshots(before: RepairStateSnapshot, after: RepairStateSnapshot): RepairStateDiff {
  const lostResults: Array<{ jobId: string; field: ResultField }> = [];
  const expectedClears: Array<{ jobId: string; field: ResultField }> = [];
  const terminalAfter = new Set(after.terminalJobIds);
  let leftLiveSet = 0;
  for (const [jobId, was] of Object.entries(before.results)) {
    const now = after.results[jobId];
    if (!now) { leftLiveSet += 1; continue; }
    for (const field of RESULT_FIELDS) {
      if (!was[field] || now[field]) continue;
      if (field === "score" && terminalAfter.has(jobId)) expectedClears.push({ jobId, field });
      else lostResults.push({ jobId, field });
    }
  }
  const protectedChanged: Array<{ jobId: string; before: string; after: string }> = [];
  for (const [jobId, was] of Object.entries(before.protectedStatus)) {
    const now = after.protectedStatus[jobId] ?? "MISSING";
    if (now !== was) protectedChanged.push({ jobId, before: was, after: now });
  }
  return { expectedClears, lostResults, protectedChanged, leftLiveSet, ok: lostResults.length === 0 && protectedChanged.length === 0 };
}
