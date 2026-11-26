import type pg from "pg";

import { OWNER_SAVED_SOURCE_NAMES } from "../services/jobArchiveHardRejectedPolicy.js";
import {
  BLIND_REVIEW_EXCLUSIONS,
  BLIND_REVIEW_TIME_ZONE,
  blindReviewExclusion,
  isLinkedInLink,
  isLinkedInSource,
  postingKeys,
  postingLink,
  reviewDate,
  type BlindReviewExclusion,
} from "./blindReviewRules.js";

/**
 * The candidate pool for the blind review sheet (read only). The rules are in blindReviewRules.ts; this file reads the facts.
 * A job is drawn only if it is live, gate PASS, content complete, confirmed open on the draw date, not saved, not applied to,
 * not labelled before, not on LinkedIn and not a second record of a posting already in the pool. This is not the Streamlit Review list's filter: it does not look at the
 * recommendation outcome, and it is stricter on availability, saved jobs and LinkedIn.
 * Every job with a stored adjusted score is either drawn from or counted under exactly one reason.
 */
export interface BlindReviewCandidate {
  id: string;
  company_name: string | null;
  title: string;
  location: string;
  canonical_url: string;
  score: number;
  unmatched_must: number;
}

export interface BlindReviewPool {
  rows: BlindReviewCandidate[];
  excluded: Record<BlindReviewExclusion, number>;
  /** Jobs with a stored adjusted score: rows.length plus every count in `excluded`. */
  scored: number;
  /** Matched, gate-passed jobs with no stored adjusted score: not in `scored`, reported so the omission is not silent. */
  notYetDecided: number;
  /** Ids from earlier sheets that this database does not hold, so their other records cannot be recognised. */
  labelledNotFound: number;
  drawDate: string;
  timeZone: string;
}

type Queryable = Pick<pg.PoolClient, "query">;

interface Sighting {
  job_id: string | null;
  source_name: string | null;
  source_plugin_key: string | null;
  source_url: string | null;
  canonical_apply_url: string | null;
  company_name: string | null;
  title: string | null;
  location_raw: string | null;
}

interface JobRow {
  id: string;
  company_name: string | null;
  title: string;
  location: string | null;
  identity_location: string | null;
  canonical_url: string | null;
  score: number | null;
  unmatched_must: number;
  archived: boolean;
  test_fixture: boolean;
  gate_passed: boolean;
  manually_removed: boolean;
  has_application: boolean;
  content_complete: boolean;
  current_topk_match: boolean;
  awaiting_recompute: boolean;
  confirmed_closed: boolean;
  availability_current: boolean;
  availability_verified_at: Date | null;
  identity_hashes: Array<string | null> | null;
}

const isSavedSource = (name: string | null) =>
  (OWNER_SAVED_SOURCE_NAMES as readonly string[]).includes((name ?? "").trim().toUpperCase());

/** Every place a job was seen: observations of any of its versions, their discovery parents, and source dispositions. */
export async function loadSightings(client: Queryable, workspaceId: string): Promise<Sighting[]> {
  const { rows } = await client.query<Sighting>(
    `WITH RECURSIVE linked(job_id, observation_id) AS (
       (SELECT v.canonical_job_id, o.id
          FROM job_versions v JOIN raw_job_observations o ON o.job_version_id = v.id
         WHERE v.workspace_id = $1 AND o.workspace_id = $1
        UNION
        SELECT d.canonical_job_id, d.job_observation_id FROM source_candidate_dispositions d
         WHERE d.workspace_id = $1 AND d.canonical_job_id IS NOT NULL AND d.job_observation_id IS NOT NULL)
       UNION
       SELECT l.job_id, o.derived_from_observation_id
         FROM linked l JOIN raw_job_observations o ON o.id = l.observation_id
        WHERE o.workspace_id = $1 AND o.derived_from_observation_id IS NOT NULL
     )
     SELECT l.job_id::text AS job_id, o.source_name, o.source_plugin_key, o.source_url, o.canonical_apply_url,
            o.company_name, o.title, o.location_raw
       FROM raw_job_observations o
       LEFT JOIN linked l ON l.observation_id = o.id
      WHERE o.workspace_id = $1 AND (l.job_id IS NOT NULL OR UPPER(BTRIM(o.source_name)) = ANY($2::text[]))
     UNION ALL
     SELECT d.canonical_job_id::text, NULL, d.source_plugin_key, d.source_url, NULL, NULL, NULL, NULL
       FROM source_candidate_dispositions d
      WHERE d.workspace_id = $1 AND d.canonical_job_id IS NOT NULL`,
    [workspaceId, [...OWNER_SAVED_SOURCE_NAMES]],
  );
  return rows;
}

export async function loadBlindReviewPool(
  client: Queryable,
  input: { workspaceId: string; excludedIds: readonly string[]; now: Date },
): Promise<BlindReviewPool> {
  const labelled = new Set(input.excludedIds.map((id) => id.toLowerCase()));
  const sightings = await loadSightings(client, input.workspaceId);
  const byJob = new Map<string, Sighting[]>();
  const saved = new Set<string>();
  const takenKeys = new Set<string>();
  for (const s of sightings) {
    if (s.job_id) byJob.set(s.job_id, [...(byJob.get(s.job_id) ?? []), s]);
    if (!isSavedSource(s.source_name)) continue;
    if (s.job_id) saved.add(s.job_id);
    // A saved posting also counts when it is not (yet) linked to any canonical job.
    for (const key of postingKeys({ company: s.company_name, title: s.title, location: s.location_raw, urls: [s.source_url, s.canonical_apply_url], identityHashes: [] })) {
      takenKeys.add(key);
    }
  }

  const { rows: jobs } = await client.query<JobRow>(
    `SELECT cj.id::text AS id, cj.company_name, cj.normalized_title AS title,
            NULLIF(BTRIM(cj.location), '') AS location, COALESCE(cj.location, cj.location_summary) AS identity_location, cj.canonical_url,
            (cj.recommendation_requirement_score * 100)::float AS score,
            (SELECT COUNT(*) FROM requirement_evidence_matches m JOIN job_requirements r ON r.id = m.requirement_id
              WHERE m.match_run_id = cj.latest_match_run_id AND r.importance = 'MUST' AND m.match_type IN ('NO_MATCH','UNKNOWN')
                AND r.requirement_type NOT IN ('EXPERIENCE_YEARS','DEGREE','CREDENTIAL','WORK_AUTH','OFFICE_DAYS','WORK_MODE','EMPLOYMENT_TYPE','TRAVEL','ON_CALL','SHIFT_WORK'))::int AS unmatched_must,
            cj.archived_at IS NOT NULL AS archived,
            cj.is_test_fixture IS TRUE AS test_fixture,
            cj.gate_decision IS NOT DISTINCT FROM 'PASS' AS gate_passed,
            COALESCE(cj.processing_state, cj.processing_status) IS NOT DISTINCT FROM 'MANUALLY_REMOVED' AS manually_removed,
            EXISTS (SELECT 1 FROM application_records a WHERE a.workspace_id = cj.workspace_id AND a.canonical_job_id = cj.id) AS has_application,
            content.content_complete IS TRUE AS content_complete,
            mr.id IS NOT NULL AS current_topk_match,
            COALESCE(cj.recommendation_outcome IS NOT NULL
                     AND COALESCE(cj.processing_state, cj.processing_status) IN ('PREQUALIFIED','NEEDS_VERIFICATION','RAW_STAGED','GATE_PASSED','LANE_ROUTED'), FALSE) AS awaiting_recompute,
            av.availability_state IS NOT DISTINCT FROM 'CLOSED' AS confirmed_closed,
            av.availability_current IS TRUE AS availability_current,
            av.availability_verified_at,
            (SELECT ARRAY_AGG(v.source_posting_identity_hash) FROM job_versions v
              WHERE v.workspace_id = cj.workspace_id AND v.canonical_job_id = cj.id) AS identity_hashes
       FROM canonical_jobs cj
       LEFT JOIN match_runs mr ON mr.id = cj.latest_match_run_id AND mr.status = 'COMPLETED' AND mr.policy_version LIKE '%topk_capability_semantic_v1'
       LEFT JOIN v_job_content_state content ON content.workspace_id = cj.workspace_id AND content.canonical_job_id = cj.id
       LEFT JOIN v_job_availability_current av ON av.workspace_id = cj.workspace_id AND av.canonical_job_id = cj.id AND av.job_version_id::text = cj.latest_job_version_id::text
      WHERE cj.workspace_id = $1
        -- Scored jobs, matched jobs (for the not-yet-decided count) and the jobs whose posting keys are taken.
        AND (cj.recommendation_requirement_score IS NOT NULL OR cj.latest_match_run_id IS NOT NULL OR cj.id::text = ANY($2::text[])
             OR EXISTS (SELECT 1 FROM application_records a WHERE a.workspace_id = cj.workspace_id AND a.canonical_job_id = cj.id))
      ORDER BY score DESC, id`,
    [input.workspaceId, [...labelled, ...saved]],
  );

  const record = (job: JobRow) => {
    const seen = byJob.get(job.id) ?? [];
    return {
      company: job.company_name,
      title: job.title,
      location: job.identity_location,
      urls: [job.canonical_url, ...seen.flatMap((s) => [s.source_url, s.canonical_apply_url])],
      identityHashes: job.identity_hashes ?? [],
    };
  };
  let labelledFound = 0;
  for (const job of jobs) {
    if (labelled.has(job.id)) labelledFound += 1;
    if (labelled.has(job.id) || saved.has(job.id) || job.has_application) {
      for (const key of postingKeys(record(job))) takenKeys.add(key);
    }
  }

  const excluded = Object.fromEntries(BLIND_REVIEW_EXCLUSIONS.map((reason) => [reason, 0])) as Record<BlindReviewExclusion, number>;
  const eligible: Array<{ keys: string[]; candidate: BlindReviewCandidate }> = [];
  const unverified: string[][] = [];
  let scored = 0;
  let notYetDecided = 0;
  for (const job of jobs) {
    if (job.score === null) {
      if (!job.archived && !job.test_fixture && job.gate_passed && job.current_topk_match) notYetDecided += 1;
      continue;
    }
    scored += 1;
    const seen = byJob.get(job.id) ?? [];
    const link = postingLink(job.canonical_url);
    const exclusion = blindReviewExclusion({
      archived: job.archived,
      testFixture: job.test_fixture,
      gatePassed: job.gate_passed,
      manuallyRemoved: job.manually_removed,
      savedByUser: saved.has(job.id),
      hasApplication: job.has_application,
      labelled: labelled.has(job.id),
      samePostingAsTaken: postingKeys(record(job)).some((key) => takenKeys.has(key)),
      // LinkedIn is left out even when the job was also seen on an employer board.
      linkedIn: isLinkedInLink(job.canonical_url)
        || seen.some((s) => isLinkedInSource(s.source_name, s.source_plugin_key) || isLinkedInLink(s.source_url) || isLinkedInLink(s.canonical_apply_url)),
      contentComplete: job.content_complete,
      hasPostingLink: link !== null,
      currentTopKMatch: job.current_topk_match,
      awaitingRecompute: job.awaiting_recompute,
      confirmedClosed: job.confirmed_closed,
      availabilityCurrent: job.availability_current,
      availabilityVerifiedAt: job.availability_verified_at,
    }, input.now);
    if (exclusion === "NOT_VERIFIED_OPEN_ON_DRAW_DATE") unverified.push(postingKeys(record(job)));
    else if (exclusion) excluded[exclusion] += 1;
    else {
      eligible.push({
        keys: postingKeys(record(job)),
        candidate: {
          id: job.id, company_name: job.company_name, title: job.title, location: job.location ?? "not stated",
          canonical_url: link!, score: job.score, unmatched_must: job.unmatched_must,
        },
      });
    }
  }
  // One posting, one entry: the best-scored eligible record stays. Unverified records are checked after the eligible ones, so
  // the unverified count is the number of further postings that confirming would add.
  const pooledKeys = new Set<string>();
  const isDuplicate = (keys: string[]) => {
    const duplicate = keys.some((key) => pooledKeys.has(key));
    for (const key of keys) pooledKeys.add(key);
    return duplicate;
  };
  const rows: BlindReviewCandidate[] = [];
  for (const { keys, candidate } of eligible) {
    if (isDuplicate(keys)) excluded.DUPLICATE_POSTING += 1;
    else rows.push(candidate);
  }
  for (const keys of unverified) excluded[isDuplicate(keys) ? "DUPLICATE_POSTING" : "NOT_VERIFIED_OPEN_ON_DRAW_DATE"] += 1;
  return {
    rows, excluded, scored, notYetDecided, labelledNotFound: labelled.size - labelledFound,
    drawDate: reviewDate(input.now), timeZone: BLIND_REVIEW_TIME_ZONE,
  };
}
