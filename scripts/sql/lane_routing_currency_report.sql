-- READ-ONLY report: how many AI-enqueue candidates were routed under the active lane routing
-- content, by revision id (the pre-fix rule) and by routing content (the migration 101 rule).
--
-- It reads only and does not depend on migration 101: routing content is compared directly as
-- (content - 'budget'), which is exactly what lane_routing_content_hash() hashes.
-- Run it inside a read-only transaction, for example:
--   BEGIN READ ONLY; \i scripts/sql/lane_routing_currency_report.sql ROLLBACK;
--
-- Candidates match the explanation enqueuer: not archived, state LANE_ROUTED or MATCHED, a
-- routed primary lane, recommendation_eligibility ELIGIBLE, outcome PRIORITY or REVIEW. TRACK is
-- not AI-evaluated (src/pipeline/profileMatchCurrency.ts), so it does not qualify.

WITH active_lane AS (
  SELECT li.workspace_id,
         li.lane_key,
         lr.id::text AS lane_revision_id,
         lr.content - 'budget' AS routing_content
  FROM lane_identities li
  JOIN lane_active_revisions lar ON lar.lane_identity_id = li.id
  JOIN lane_revisions lr ON lr.id = lar.lane_revision_id
  WHERE li.status = 'ACTIVE'
),
candidate AS (
  SELECT c.workspace_id,
         c.id AS canonical_job_id,
         c.primary_lane,
         ld.lane_snapshot
  FROM canonical_jobs c
  LEFT JOIN lane_decisions ld
    ON ld.workspace_id = c.workspace_id
   AND ld.id = c.latest_lane_decision_id
   AND ld.job_version_id = c.latest_job_version_id
  WHERE c.archived_at IS NULL
    AND COALESCE(c.processing_state, c.processing_status) IN ('LANE_ROUTED', 'MATCHED')
    AND c.primary_lane IS NOT NULL
    AND c.primary_lane <> 'UNCLASSIFIED'
    AND COALESCE(c.recommendation_eligibility, 'VERIFY') = 'ELIGIBLE'
    AND c.recommendation_outcome IN ('PRIORITY', 'REVIEW')
),
routed_lane AS (
  SELECT candidate.canonical_job_id,
         entry.value->>'lane_key' AS lane_key,
         entry.value->>'lane_revision_id' AS lane_revision_id,
         CASE WHEN routed_identity.lane_key = entry.value->>'lane_key'
              THEN routed_revision.content - 'budget' END AS routing_content
  FROM candidate
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(candidate.lane_snapshot->'active_lane_revisions') = 'array'
         THEN candidate.lane_snapshot->'active_lane_revisions'
         ELSE '[]'::jsonb END
  ) AS entry(value)
  LEFT JOIN lane_revisions routed_revision ON routed_revision.id::text = entry.value->>'lane_revision_id'
  LEFT JOIN lane_identities routed_identity ON routed_identity.id = routed_revision.lane_identity_id
),
per_job AS (
  SELECT candidate.canonical_job_id,
         EXISTS (
           SELECT 1
           FROM routed_lane r
           JOIN active_lane a
             ON a.workspace_id = candidate.workspace_id
            AND a.lane_key = r.lane_key
            AND a.lane_revision_id = r.lane_revision_id
           WHERE r.canonical_job_id = candidate.canonical_job_id
             AND r.lane_key = candidate.primary_lane
         ) AS primary_revision_id_active,
         COALESCE(candidate.lane_snapshot->>'source' = 'LANE_REGISTRY_DB', FALSE)
         AND EXISTS (SELECT 1 FROM routed_lane r WHERE r.canonical_job_id = candidate.canonical_job_id)
         AND NOT EXISTS (
           SELECT 1
           FROM (SELECT lane_key, routing_content FROM routed_lane
                 WHERE canonical_job_id = candidate.canonical_job_id) r
           FULL OUTER JOIN (SELECT lane_key, routing_content FROM active_lane
                            WHERE workspace_id = candidate.workspace_id) a
             ON a.lane_key = r.lane_key
           WHERE r.lane_key IS NULL
              OR a.lane_key IS NULL
              OR r.routing_content IS NULL
              OR r.routing_content <> a.routing_content
         ) AS routing_content_current
  FROM candidate
)
SELECT COUNT(*)::int AS qualifying_jobs,
       COUNT(*) FILTER (WHERE primary_revision_id_active)::int AS eligible_by_revision_id_before_fix,
       COUNT(*) FILTER (WHERE routing_content_current)::int AS eligible_by_routing_content_after_fix,
       COUNT(*) FILTER (WHERE NOT routing_content_current)::int AS needing_reroute_after_fix
FROM per_job;
