-- Migration 067: expose full, privacy-safe active-profile coverage counts.
--
-- Migration 066 introduced the profile coverage read model. This additive
-- replacement adds profile-ledger category counts for the selected active
-- profile and exact/semantic requirement-match breakdowns. PRIVATE_INTERNAL
-- facts remain excluded; no profile facts are copied or rewritten.

CREATE OR REPLACE VIEW v_profile_coverage_scoped AS
WITH active_match_contexts AS (
  SELECT
    job.workspace_id,
    job.id AS canonical_job_id,
    job_version.id AS job_version_id,
    job_version.active_requirement_set_id AS requirement_set_id,
    active_profile.id AS profile_version_id,
    active_profile.version_number AS profile_version_number,
    match_run.id AS match_run_id
  FROM canonical_jobs AS job
  JOIN job_versions AS job_version
    ON job_version.workspace_id = job.workspace_id
   AND job_version.canonical_job_id = job.id
   AND job_version.id = job.latest_job_version_id
  JOIN LATERAL (
    SELECT profile.id, profile.version_number
    FROM profile_versions AS profile
    WHERE profile.workspace_id = job.workspace_id
      AND profile.status = 'ACTIVE'
    ORDER BY profile.created_at DESC, profile.id DESC
    LIMIT 1
  ) AS active_profile ON TRUE
  JOIN match_runs AS match_run
    ON match_run.workspace_id = job.workspace_id
   AND match_run.id = job.latest_match_run_id
   AND match_run.canonical_job_id = job.id
   AND match_run.job_version_id = job_version.id
   AND match_run.profile_version_id = active_profile.id
   AND match_run.status = 'COMPLETED'
   AND job_version.active_requirement_set_id IS NOT NULL
   AND match_run.requirement_set_id = job_version.active_requirement_set_id
   AND match_run.job_content_hash = job_version.content_hash
   AND match_run.context_fingerprint IS NOT NULL
  WHERE job.is_test_fixture = FALSE
),
requirement_coverage AS (
  SELECT
    context.workspace_id,
    context.canonical_job_id,
    context.job_version_id,
    context.profile_version_id,
    context.match_run_id,
    COUNT(evidence.id) FILTER (WHERE evidence.match_type = 'EXACT')::INTEGER AS exact_match_count,
    COUNT(evidence.id) FILTER (WHERE evidence.match_type = 'SEMANTIC')::INTEGER AS semantic_match_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'MUST' AND evidence.match_type = 'EXACT')::INTEGER AS must_exact_matched_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'MUST' AND evidence.match_type = 'SEMANTIC')::INTEGER AS must_semantic_matched_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'PREFERRED' AND evidence.match_type = 'EXACT')::INTEGER AS preferred_exact_matched_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'PREFERRED' AND evidence.match_type = 'SEMANTIC')::INTEGER AS preferred_semantic_matched_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'MUST')::INTEGER AS must_requirement_count,
    COUNT(requirement.id) FILTER (
      WHERE requirement.importance = 'MUST'
        AND evidence.match_type IN ('EXACT', 'SEMANTIC')
    )::INTEGER AS must_matched_count,
    COUNT(requirement.id) FILTER (
      WHERE requirement.importance = 'MUST'
        AND (evidence.match_type IS NULL OR evidence.match_type NOT IN ('EXACT', 'SEMANTIC'))
    )::INTEGER AS must_missing_count,
    COUNT(requirement.id) FILTER (WHERE requirement.importance = 'PREFERRED')::INTEGER AS preferred_requirement_count,
    COUNT(requirement.id) FILTER (
      WHERE requirement.importance = 'PREFERRED'
        AND evidence.match_type IN ('EXACT', 'SEMANTIC')
    )::INTEGER AS preferred_matched_count,
    COUNT(requirement.id) FILTER (
      WHERE requirement.importance = 'PREFERRED'
        AND (evidence.match_type IS NULL OR evidence.match_type NOT IN ('EXACT', 'SEMANTIC'))
    )::INTEGER AS preferred_missing_count
  FROM active_match_contexts AS context
  JOIN job_requirements AS requirement
    ON requirement.workspace_id = context.workspace_id
   AND requirement.canonical_job_id = context.canonical_job_id
   AND requirement.job_version_id = context.job_version_id
   AND requirement.requirement_set_id = context.requirement_set_id
   AND requirement.status IN ('EXTRACTED', 'VALIDATED')
  LEFT JOIN requirement_evidence_matches AS evidence
    ON evidence.workspace_id = context.workspace_id
   AND evidence.match_run_id = context.match_run_id
   AND evidence.requirement_id = requirement.id
  GROUP BY
    context.workspace_id,
    context.canonical_job_id,
    context.job_version_id,
    context.profile_version_id,
    context.match_run_id
),
profile_evidence_counts AS (
  SELECT
    fact.workspace_id,
    fact.profile_version_id,
    COUNT(*)::INTEGER AS profile_fact_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'ACHIEVEMENT')::INTEGER AS achievement_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'RESPONSIBILITY')::INTEGER AS responsibility_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'PROJECT')::INTEGER AS project_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'SKILL')::INTEGER AS skill_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'TECHNOLOGY')::INTEGER AS technology_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'DOMAIN')::INTEGER AS domain_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'PUBLICATION')::INTEGER AS publication_count,
    COUNT(*) FILTER (WHERE fact.fact_type = 'OPEN_SOURCE')::INTEGER AS open_source_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'PROFESSIONAL_PRODUCTION')::INTEGER AS professional_production_evidence_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'DEPLOYED_OPEN_SOURCE')::INTEGER AS deployed_open_source_evidence_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'APPLIED_PROJECT')::INTEGER AS applied_project_evidence_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'COURSE_PROJECT')::INTEGER AS course_project_evidence_count,
    COUNT(*) FILTER (WHERE fact.evidence_tier = 'KNOWLEDGE_ONLY')::INTEGER AS knowledge_only_evidence_count
  FROM profile_facts AS fact
  WHERE fact.confidentiality <> 'PRIVATE_INTERNAL'
  GROUP BY fact.workspace_id, fact.profile_version_id
),
profile_credential_counts AS (
  SELECT
    credential.workspace_id,
    credential.profile_version_id,
    COUNT(*) FILTER (WHERE credential.status = 'ACTIVE')::INTEGER AS active_credential_count
  FROM profile_credentials AS credential
  GROUP BY credential.workspace_id, credential.profile_version_id
),
profile_engagement_counts AS (
  SELECT
    engagement.workspace_id,
    engagement.profile_version_id,
    COUNT(*)::INTEGER AS engagement_count
  FROM profile_engagements AS engagement
  GROUP BY engagement.workspace_id, engagement.profile_version_id
)
SELECT
  context.workspace_id,
  context.canonical_job_id,
  context.job_version_id,
  context.profile_version_id,
  context.profile_version_number,
  context.match_run_id,
  COALESCE(coverage.exact_match_count, 0)::INTEGER AS exact_match_count,
  COALESCE(coverage.semantic_match_count, 0)::INTEGER AS semantic_match_count,
  COALESCE(coverage.must_exact_matched_count, 0)::INTEGER AS must_exact_matched_count,
  COALESCE(coverage.must_semantic_matched_count, 0)::INTEGER AS must_semantic_matched_count,
  COALESCE(coverage.preferred_exact_matched_count, 0)::INTEGER AS preferred_exact_matched_count,
  COALESCE(coverage.preferred_semantic_matched_count, 0)::INTEGER AS preferred_semantic_matched_count,
  COALESCE(coverage.must_requirement_count, 0)::INTEGER AS must_requirement_count,
  COALESCE(coverage.must_matched_count, 0)::INTEGER AS must_matched_count,
  COALESCE(coverage.must_missing_count, 0)::INTEGER AS must_missing_count,
  COALESCE(coverage.preferred_requirement_count, 0)::INTEGER AS preferred_requirement_count,
  COALESCE(coverage.preferred_matched_count, 0)::INTEGER AS preferred_matched_count,
  COALESCE(coverage.preferred_missing_count, 0)::INTEGER AS preferred_missing_count,
  COALESCE(evidence.professional_production_evidence_count, 0)::INTEGER AS professional_production_evidence_count,
  COALESCE(evidence.deployed_open_source_evidence_count, 0)::INTEGER AS deployed_open_source_evidence_count,
  COALESCE(evidence.applied_project_evidence_count, 0)::INTEGER AS applied_project_evidence_count,
  COALESCE(evidence.course_project_evidence_count, 0)::INTEGER AS course_project_evidence_count,
  COALESCE(evidence.knowledge_only_evidence_count, 0)::INTEGER AS knowledge_only_evidence_count,
  COALESCE(evidence.profile_fact_count, 0)::INTEGER AS profile_fact_count,
  COALESCE(evidence.achievement_count, 0)::INTEGER AS achievement_count,
  COALESCE(evidence.responsibility_count, 0)::INTEGER AS responsibility_count,
  COALESCE(evidence.project_count, 0)::INTEGER AS project_count,
  COALESCE(evidence.skill_count, 0)::INTEGER AS skill_count,
  COALESCE(evidence.technology_count, 0)::INTEGER AS technology_count,
  COALESCE(evidence.domain_count, 0)::INTEGER AS domain_count,
  COALESCE(evidence.publication_count, 0)::INTEGER AS publication_count,
  COALESCE(evidence.open_source_count, 0)::INTEGER AS open_source_count,
  COALESCE(credentials.active_credential_count, 0)::INTEGER AS active_credential_count,
  COALESCE(engagements.engagement_count, 0)::INTEGER AS engagement_count
FROM active_match_contexts AS context
LEFT JOIN requirement_coverage AS coverage
  ON coverage.workspace_id = context.workspace_id
 AND coverage.canonical_job_id = context.canonical_job_id
 AND coverage.job_version_id = context.job_version_id
 AND coverage.profile_version_id = context.profile_version_id
 AND coverage.match_run_id = context.match_run_id
LEFT JOIN profile_evidence_counts AS evidence
  ON evidence.workspace_id = context.workspace_id
 AND evidence.profile_version_id = context.profile_version_id
LEFT JOIN profile_credential_counts AS credentials
  ON credentials.workspace_id = context.workspace_id
 AND credentials.profile_version_id = context.profile_version_id
LEFT JOIN profile_engagement_counts AS engagements
  ON engagements.workspace_id = context.workspace_id
 AND engagements.profile_version_id = context.profile_version_id;

COMMENT ON VIEW v_profile_coverage_scoped IS
  'Current active-profile coverage and privacy-safe profile fact-category, credential, engagement, match-type and evidence-tier counts.';
