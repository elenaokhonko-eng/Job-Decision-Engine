import type pg from "pg";

/**
 * The candidate pool for the blind review sheet. A job is drawn only if the Review list could show it: live (not archived, not a
 * fixture, not manually removed), gate PASS, posting content complete (v_job_content_state), the posting confirmed currently open
 * (v_job_availability_current), and not carrying a kept result that awaits recompute (same condition as `ranking_stale`).
 * Every job that has a stored adjusted score but is left out is counted under exactly one reason (the first that applies), so the
 * omission is never silent.
 */
export type BlindReviewExclusion =
  | "ARCHIVED"
  | "TEST_FIXTURE"
  | "NOT_GATE_PASSED"
  | "MANUALLY_REMOVED"
  | "AWAITING_CONTENT"
  | "NOT_CONFIRMED_OPEN"
  | "RANKING_STALE"
  | "NO_POSTING_LINK"
  | "SAVED_BY_USER"
  | "ALREADY_LABELLED";

export interface BlindReviewCandidate {
  id: string;
  company_name: string | null;
  title: string;
  location: string;
  canonical_url: string | null;
  score: number;
  unmatched_must: number;
}

export interface BlindReviewPool {
  rows: BlindReviewCandidate[];
  excluded: Record<BlindReviewExclusion, number>;
}

const EXCLUSIONS: readonly BlindReviewExclusion[] = [
  "ARCHIVED", "TEST_FIXTURE", "NOT_GATE_PASSED", "MANUALLY_REMOVED", "AWAITING_CONTENT", "NOT_CONFIRMED_OPEN",
  "RANKING_STALE", "NO_POSTING_LINK", "SAVED_BY_USER", "ALREADY_LABELLED",
];

export async function loadBlindReviewPool(
  client: Pick<pg.PoolClient, "query">,
  input: { workspaceId: string; savedSourceName: string; excludedIds: readonly string[] },
): Promise<BlindReviewPool> {
  const { rows } = await client.query(
    `SELECT id, company_name, title, location, canonical_url, score, unmatched_must, exclusion
       FROM (
         SELECT cj.id, cj.company_name, cj.normalized_title AS title,
                COALESCE(NULLIF(BTRIM(cj.location), ''), 'not stated') AS location, cj.canonical_url,
                (cj.recommendation_requirement_score * 100)::float AS score,
                (SELECT COUNT(*) FROM requirement_evidence_matches m JOIN job_requirements r ON r.id = m.requirement_id
                  WHERE m.match_run_id = cj.latest_match_run_id AND r.importance = 'MUST' AND m.match_type IN ('NO_MATCH','UNKNOWN')
                    AND r.requirement_type NOT IN ('EXPERIENCE_YEARS','DEGREE','CREDENTIAL','WORK_AUTH','OFFICE_DAYS','WORK_MODE','EMPLOYMENT_TYPE','TRAVEL','ON_CALL','SHIFT_WORK'))::int AS unmatched_must,
                CASE
                  WHEN cj.archived_at IS NOT NULL THEN 'ARCHIVED'
                  WHEN cj.is_test_fixture IS TRUE THEN 'TEST_FIXTURE'
                  WHEN cj.gate_decision IS DISTINCT FROM 'PASS' THEN 'NOT_GATE_PASSED'
                  WHEN COALESCE(cj.processing_state, cj.processing_status) = 'MANUALLY_REMOVED' THEN 'MANUALLY_REMOVED'
                  WHEN content.content_complete IS NOT TRUE THEN 'AWAITING_CONTENT'
                  WHEN COALESCE(av.availability_current, FALSE) IS NOT TRUE THEN 'NOT_CONFIRMED_OPEN'
                  WHEN cj.recommendation_outcome IS NOT NULL
                       AND COALESCE(cj.processing_state, cj.processing_status) IN ('PREQUALIFIED','NEEDS_VERIFICATION','RAW_STAGED','GATE_PASSED','LANE_ROUTED')
                    THEN 'RANKING_STALE'
                  WHEN cj.canonical_url !~* '^https?://' OR cj.canonical_url ~* '^https?://himalayas\.app/jobs/([0-9a-f]{16,}|api)' THEN 'NO_POSTING_LINK'
                  WHEN EXISTS (SELECT 1 FROM raw_job_observations o JOIN job_versions v ON v.id = o.job_version_id
                                WHERE o.workspace_id = cj.workspace_id AND o.source_name = $2 AND v.canonical_job_id = cj.id) THEN 'SAVED_BY_USER'
                  WHEN cj.id = ANY($3::uuid[]) THEN 'ALREADY_LABELLED'
                  ELSE NULL
                END AS exclusion
           FROM canonical_jobs cj
           JOIN match_runs mr ON mr.id = cj.latest_match_run_id AND mr.status = 'COMPLETED' AND mr.policy_version LIKE '%topk_capability_semantic_v1'
           LEFT JOIN v_job_content_state content ON content.workspace_id = cj.workspace_id AND content.canonical_job_id = cj.id
           LEFT JOIN v_job_availability_current av ON av.workspace_id = cj.workspace_id AND av.canonical_job_id = cj.id AND av.job_version_id::text = cj.latest_job_version_id::text
          WHERE cj.workspace_id = $1 AND cj.recommendation_requirement_score IS NOT NULL AND cj.canonical_url IS NOT NULL
       ) pool
      ORDER BY score DESC, id`,
    [input.workspaceId, input.savedSourceName, [...input.excludedIds]],
  );
  const excluded = Object.fromEntries(EXCLUSIONS.map((reason) => [reason, 0])) as Record<BlindReviewExclusion, number>;
  const eligible: BlindReviewCandidate[] = [];
  for (const row of rows) {
    if (row.exclusion) excluded[row.exclusion as BlindReviewExclusion] += 1;
    else eligible.push({ id: row.id, company_name: row.company_name, title: row.title, location: row.location, canonical_url: row.canonical_url, score: row.score, unmatched_must: row.unmatched_must });
  }
  return { rows: eligible, excluded };
}
