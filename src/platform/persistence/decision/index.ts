/**
 * Reads for the review lists (src/modules/decision). Read only: posting records of earlier modules and their read-model
 * views.
 */
export interface DecisionQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ReviewJobRow {
  id: string;
  company_name: string | null;
  title: string | null;
  location: string | null;
  canonical_url: string | null;
  workplace_type: string | null;
  processing_state: string | null;
  gate_decision: string | null;
  archived: boolean;
  test_fixture: boolean;
  content_complete: boolean;
  availability_state: string | null;
  /** The closed state rests only on a manual check that read it from page wording and asked for it to be checked by hand. */
  closed_by_page_wording_only: boolean;
  description: string | null;
  identity_hashes: Array<string | null> | null;
}

/**
 * Every record that is not a test fixture, archived ones included (their postings must still be recognised), plus the
 * named records (rated before) whatever their state. An archived record carries no description.
 */
export async function selectReviewJobs(
  db: DecisionQueryable,
  workspaceId: string,
  alsoIds: readonly string[],
): Promise<ReviewJobRow[]> {
  const { rows } = await db.query(
    `SELECT job.id::text AS id, job.company_name, job.normalized_title AS title,
            COALESCE(NULLIF(BTRIM(job.location), ''), job.location_summary) AS location,
            job.canonical_url, job.workplace_type,
            COALESCE(job.processing_state, job.processing_status) AS processing_state,
            job.gate_decision,
            job.archived_at IS NOT NULL AS archived,
            job.is_test_fixture IS TRUE AS test_fixture,
            content.content_complete IS TRUE AS content_complete,
            availability.availability_state,
            -- Only while the stored verdict is that check's own (same instant), no source expiry has passed, and no other
            -- read of this version since it was last seen open confirmed the closure.
            (availability.availability_state = 'CLOSED'
              AND (availability.source_expires_at IS NULL OR availability.source_expires_at > NOW())
              AND EXISTS (
                SELECT 1 FROM job_availability_recheck_events by_hand
                 WHERE by_hand.workspace_id = job.workspace_id AND by_hand.canonical_job_id = job.id
                   AND by_hand.job_version_id = version.id AND by_hand.decision = 'MARK_CLOSED'
                   AND by_hand.details->>'check_by_hand' = 'true'
                   AND by_hand.occurred_at BETWEEN version.availability_verified_at - INTERVAL '1 second'
                                               AND version.availability_verified_at + INTERVAL '1 second')
              AND NOT EXISTS (
                SELECT 1 FROM job_availability_recheck_events confirmed
                 WHERE confirmed.workspace_id = job.workspace_id AND confirmed.canonical_job_id = job.id
                   AND confirmed.job_version_id = version.id AND confirmed.decision = 'MARK_CLOSED'
                   AND confirmed.details->>'check_by_hand' IS DISTINCT FROM 'true'
                   AND confirmed.occurred_at > COALESCE((
                     SELECT MAX(seen.occurred_at) FROM job_availability_recheck_events seen
                      WHERE seen.workspace_id = job.workspace_id AND seen.canonical_job_id = job.id
                        AND seen.job_version_id = version.id AND seen.decision = 'MARK_OPEN'), '-infinity'::timestamptz))
            ) IS TRUE AS closed_by_page_wording_only,
            CASE WHEN job.archived_at IS NULL THEN version.description_text END AS description,
            (SELECT ARRAY_AGG(any_version.source_posting_identity_hash) FROM job_versions any_version
              WHERE any_version.workspace_id = job.workspace_id AND any_version.canonical_job_id = job.id) AS identity_hashes
       FROM canonical_jobs job
       LEFT JOIN v_job_content_state content
         ON content.workspace_id = job.workspace_id AND content.canonical_job_id = job.id
       LEFT JOIN job_versions version
         ON version.workspace_id = job.workspace_id AND version.id = content.job_version_id
       LEFT JOIN v_job_availability_current availability
         ON availability.workspace_id = job.workspace_id AND availability.canonical_job_id = job.id
        AND availability.job_version_id::text = content.job_version_id::text
      WHERE job.workspace_id = $1::uuid
        AND (job.is_test_fixture IS NOT TRUE OR job.id::text = ANY($2::text[]))
      ORDER BY job.id`,
    [workspaceId, [...alsoIds]],
  );
  return rows as ReviewJobRow[];
}

export interface SightingRow {
  /** null for a saved export not linked to any canonical job. */
  job_id: string | null;
  source_name: string | null;
  source_url: string | null;
  canonical_apply_url: string | null;
  company_name: string | null;
  title: string | null;
  location_raw: string | null;
}

/** Every place a job was seen: observations of any version, their discovery parents, and source dispositions. */
export async function selectJobSightings(
  db: DecisionQueryable,
  workspaceId: string,
  savedSourceNames: readonly string[],
): Promise<SightingRow[]> {
  const { rows } = await db.query(
    `WITH RECURSIVE linked(job_id, observation_id) AS (
       (SELECT v.canonical_job_id, o.id
          FROM job_versions v JOIN raw_job_observations o ON o.job_version_id = v.id
         WHERE v.workspace_id = $1::uuid AND o.workspace_id = $1::uuid
        UNION
        SELECT d.canonical_job_id, d.job_observation_id FROM source_candidate_dispositions d
         WHERE d.workspace_id = $1::uuid AND d.canonical_job_id IS NOT NULL AND d.job_observation_id IS NOT NULL)
       UNION
       SELECT l.job_id, o.derived_from_observation_id
         FROM linked l JOIN raw_job_observations o ON o.id = l.observation_id
        WHERE o.workspace_id = $1::uuid AND o.derived_from_observation_id IS NOT NULL
     )
     SELECT l.job_id::text AS job_id, o.source_name, o.source_url, o.canonical_apply_url,
            o.company_name, o.title, o.location_raw
       FROM raw_job_observations o
       LEFT JOIN linked l ON l.observation_id = o.id
      WHERE o.workspace_id = $1::uuid AND (l.job_id IS NOT NULL OR UPPER(BTRIM(o.source_name)) = ANY($2::text[]))
     UNION ALL
     SELECT d.canonical_job_id::text, NULL, d.source_url, NULL, NULL, NULL, NULL
       FROM source_candidate_dispositions d
      WHERE d.workspace_id = $1::uuid AND d.canonical_job_id IS NOT NULL`,
    [workspaceId, [...savedSourceNames]],
  );
  return rows as SightingRow[];
}

export interface SimilarityRow {
  job_id: string;
  requirement_type: string;
  importance: string;
  match_type: string;
  semantic_score: number | null;
}

/**
 * The capability rows of each job's current completed match: those the matcher compared with a profile fact (it writes
 * the `semantic_score` key only on them), whatever score policy the run used.
 */
export async function selectMatchSimilarities(db: DecisionQueryable, workspaceId: string): Promise<SimilarityRow[]> {
  const { rows } = await db.query(
    `SELECT job.id::text AS job_id, requirement.requirement_type, requirement.importance, matched.match_type,
            (matched.evidence->>'semantic_score')::float8 AS semantic_score
       FROM canonical_jobs job
       JOIN match_runs run
         ON run.workspace_id = job.workspace_id AND run.id = job.latest_match_run_id
        AND run.status = 'COMPLETED' AND run.job_version_id = job.latest_job_version_id
       JOIN requirement_evidence_matches matched
         ON matched.workspace_id = job.workspace_id AND matched.match_run_id = run.id
       JOIN job_requirements requirement ON requirement.id = matched.requirement_id
      WHERE job.workspace_id = $1::uuid AND job.archived_at IS NULL
        AND jsonb_exists(matched.evidence, 'semantic_score')`,
    [workspaceId],
  );
  return rows as SimilarityRow[];
}

export interface CheckStateRow {
  job_id: string;
  link: string | null;
  /** The stored verdict is open and was verified on the day. */
  open_today: boolean;
  /** A manual check of this job version ran on the day. */
  checked_today: boolean;
}

/** What the availability check would look at for each job: the same observation it reads the link from. */
export async function selectCheckStates(
  db: DecisionQueryable,
  workspaceId: string,
  jobIds: readonly string[],
  now: Date,
  timeZone: string,
): Promise<CheckStateRow[]> {
  const { rows } = await db.query(
    `SELECT job.id::text AS job_id,
            COALESCE(observation.source_url, observation.canonical_apply_url, job.canonical_url) AS link,
            COALESCE(availability.availability_current
              AND (availability.availability_verified_at AT TIME ZONE $4) ::date = ($3::timestamptz AT TIME ZONE $4)::date,
              FALSE) AS open_today,
            EXISTS (SELECT 1 FROM job_availability_recheck_events event
                     WHERE event.workspace_id = job.workspace_id AND event.canonical_job_id = job.id
                       AND event.job_version_id = job.latest_job_version_id AND event.details->>'trigger' = 'MANUAL'
                       AND (event.occurred_at AT TIME ZONE $4)::date = ($3::timestamptz AT TIME ZONE $4)::date) AS checked_today
       FROM canonical_jobs job
       JOIN LATERAL (
         SELECT seen.source_url, seen.canonical_apply_url
           FROM raw_job_observations seen
          WHERE seen.workspace_id = job.workspace_id AND seen.job_version_id = job.latest_job_version_id
          ORDER BY (seen.source_name = 'GMAIL_ALERT') ASC, seen.retrieved_at DESC, seen.id ASC
          LIMIT 1
       ) observation ON TRUE
       LEFT JOIN v_job_availability_current availability
         ON availability.workspace_id = job.workspace_id AND availability.canonical_job_id = job.id
        AND availability.job_version_id::text = job.latest_job_version_id::text
      WHERE job.workspace_id = $1::uuid AND job.id::text = ANY($2::text[])`,
    [workspaceId, [...jobIds], now, timeZone],
  );
  return rows as CheckStateRow[];
}

/** The links already read, and the sites that stopped answering, in the day's manual checks. */
export async function selectChecksOfDay(
  db: DecisionQueryable,
  workspaceId: string,
  now: Date,
  timeZone: string,
): Promise<Array<{ link_key: string | null; stopped_sites: unknown }>> {
  const { rows } = await db.query(
    `SELECT details->>'link_key' AS link_key, details->'stopped_sites' AS stopped_sites
       FROM job_availability_recheck_events
      WHERE workspace_id = $1::uuid AND details->>'trigger' = 'MANUAL'
        AND (occurred_at AT TIME ZONE $3)::date = ($2::timestamptz AT TIME ZONE $3)::date`,
    [workspaceId, now, timeZone],
  );
  return rows as Array<{ link_key: string | null; stopped_sites: unknown }>;
}
