import crypto from "node:crypto";
import type pg from "pg";

import type { WorkspaceContext } from "../../workspace/context.js";

/** A synthetic current READY Apply Now job, written straight into the tables. Synthetic data only. */
export const AUTONOMY_QUOTE = "Work independently with minimal supervision.";

export interface JobIds {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly matchRunId: string;
  readonly decisionId: string;
  readonly decisionFingerprint: string;
  readonly jobContentHash: string;
  readonly evaluationId: string | null;
}

export async function createProfile(pool: pg.Pool, workspace: WorkspaceContext): Promise<string> {
  const profile = await pool.query<{ id: string }>(
    `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
     VALUES ($1, $2, 'Ranking Composite Fixture') RETURNING id`,
    [workspace.workspaceId, `ranking-composite-${crypto.randomUUID()}`],
  );
  const version = await pool.query<{ id: string }>(
    `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
     VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id`,
    [workspace.workspaceId, profile.rows[0]?.id, `profile-${crypto.randomUUID()}`],
  );
  return version.rows[0]!.id;
}

/** A current READY Apply Now job (same shape as the document provenance fixture). */
export async function createReadyJob(
  pool: pg.Pool,
  workspace: WorkspaceContext,
  profileVersionId: string,
  options: { laneConfidence: string; matchScore: number; withEvaluation: boolean; outcome?: "REVIEW" | "TRACK" },
): Promise<JobIds> {
  const ws = workspace.workspaceId;
  const canonical = await pool.query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url, location_summary, workplace_type,
       employment_type, primary_lane, processing_state, processing_status, gate_decision,
       recommendation_eligibility, recommendation_outcome, lane_confidence,
       deterministic_match_score, deterministic_match_coverage, recommendation_evidence_completeness,
       recommendation_requirement_score
     ) VALUES ($1, 'Composite Fixture', 'Data Engineer', $2, 'Remote', 'REMOTE', 'PERMANENT', 'CORE_AI_DATA',
       'MATCHED', 'MATCHED', 'PASS', 'ELIGIBLE', $6, $3, $4, 90, 0.95, $5) RETURNING id`,
    // Requirement fit is the stored ADJUSTED score (migration 121), a 0-1 fraction.
    [ws, `https://example.test/composite/${crypto.randomUUID()}`, options.laneConfidence, options.matchScore, options.matchScore / 100, options.outcome ?? "REVIEW"],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const jobContentHash = `job-content-${crypto.randomUUID()}`;
  const evidenceRevisionHash = "e".repeat(64);
  const description = [
    "About the role: Build and operate reliable data products used by research teams.",
    "Responsibilities: Design data services, deliver integrations, and support production releases.",
    "Requirements: Experience with SQL, cloud systems, and cross-functional technical delivery.",
  ].join(" ").repeat(8) + ` ${AUTONOMY_QUOTE}`;
  const version = await pool.query<{ id: string }>(
    `INSERT INTO job_versions (
       workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at,
       evidence_revision_hash, availability_status, availability_evidence, availability_verified_at, availability_recheck_at
     ) VALUES ($1, $2, 1, $3, $5, NOW(), $4, 'OPEN', $6::jsonb, '2098-01-01T00:00:00Z', '2099-01-01T00:00:00Z')
     RETURNING id`,
    [ws, canonicalJobId, jobContentHash, evidenceRevisionHash, description,
      JSON.stringify({ status: "OPEN", verification_method: "TEST_FIXTURE", reason_code: "SOURCE_CONFIRMED", evidence: [] })],
  );
  const jobVersionId = version.rows[0]!.id;
  await pool.query(`UPDATE job_versions SET first_seen_at = NOW(), last_seen_at = NOW() WHERE id = $1`, [jobVersionId]);
  const identity = await pool.query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version,
       quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'deterministic-test-v1', 'quoted-test-v1', 'quoted-prompt-test-v1', 'normalizer-test-v1', FALSE)
     RETURNING id`,
    [ws, canonicalJobId, `identity-${crypto.randomUUID()}`, jobContentHash],
  );
  const requirementSet = await pool.query<{ id: string }>(
    `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type, created_by_user_id)
     VALUES ($1, $2, $3, $4, 1, 'EXTRACTED', $5) RETURNING id`,
    [ws, identity.rows[0]!.id, canonicalJobId, jobVersionId, workspace.userId],
  );
  const requirementSetId = requirementSet.rows[0]!.id;
  await pool.query(`UPDATE job_versions SET active_requirement_set_id = $1 WHERE workspace_id = $2 AND id = $3`, [requirementSetId, ws, jobVersionId]);
  const matchRun = await pool.query<{ id: string }>(
    `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id,
       job_content_hash, context_fingerprint, status, requirement_count, matched_count, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', 1, 1, NOW()) RETURNING id`,
    [ws, canonicalJobId, jobVersionId, profileVersionId, requirementSetId, jobContentHash, `match-context-${crypto.randomUUID()}`],
  );
  const matchRunId = matchRun.rows[0]!.id;
  await pool.query(
    `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, decision, rejection_codes, evidence_quotes, workability_facts)
     VALUES ($1, $2, $3, 'PASS', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)`,
    [ws, canonicalJobId, jobVersionId],
  );
  await pool.query(
    `UPDATE canonical_jobs SET latest_job_version_id = $1, latest_match_run_id = $2, description_quality_status = 'COMPLETE'
      WHERE workspace_id = $3 AND id = $4`,
    [jobVersionId, matchRunId, ws, canonicalJobId],
  );
  await pool.query(
    `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, company_name, title,
       description_raw, raw_payload, raw_payload_hash, job_version_id)
     VALUES ($1, 'GREENHOUSE', $2, $3, 'Composite Fixture', 'Data Engineer', $4, $5::jsonb, $6, $7)`,
    [ws, `composite-${crypto.randomUUID()}`, `https://boards.greenhouse.io/example/jobs/${crypto.randomUUID()}`, description,
      JSON.stringify({ source_content_status: "COMPLETE" }), crypto.randomBytes(32).toString("hex"), jobVersionId],
  );
  const revisions = await pool.query<{ config_key: string; config_revision_id: string }>(
    `SELECT definition.config_key, active.config_revision_id
       FROM config_active_revisions active
       JOIN config_definitions definition ON definition.id = active.config_definition_id
      WHERE definition.workspace_id = $1 AND definition.config_key IN ('decision_policy', 'evidence_strength')`,
    [ws],
  );
  const snapshot = await pool.query<{ id: string }>(
    `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, decision_policy_config_revision_id,
       evidence_strength_policy_config_revision_id, resolved_snapshot)
     VALUES ($1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
    [ws, `policy-${crypto.randomUUID()}`,
      revisions.rows.find((row) => row.config_key === "decision_policy")?.config_revision_id ?? null,
      revisions.rows.find((row) => row.config_key === "evidence_strength")?.config_revision_id ?? null],
  );
  const policySnapshotId = snapshot.rows[0]!.id;
  const reference = await pool.query<{ value: string }>(
    `SELECT 'availability_verification_v1:'
       || to_char(availability_verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':'
       || to_char(availability_recheck_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value
       FROM job_versions WHERE workspace_id = $1 AND id = $2`,
    [ws, jobVersionId],
  );
  const readinessFingerprint = "f".repeat(64);
  const decisionFingerprint = `decision-context-${crypto.randomUUID()}`;
  const readiness = {
    schema_version: "application_readiness_v1", status: "READY", reason_codes: [],
    checks: [{
      key: "AVAILABILITY", status: "MET", importance: "MUST", reason_code: null,
      rationale: "Fixture availability evidence is current.", evidence_keys: [],
      policy_reference: reference.rows[0]?.value, assessed_at: "2098-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
    }],
    canonical_job_id: canonicalJobId, job_version_id: jobVersionId, profile_version_id: profileVersionId,
    requirement_set_id: requirementSetId, match_run_id: matchRunId, preference_context_id: null,
    policy_snapshot_id: policySnapshotId, policy_version: "fixture-policy-v1",
    qualification_comparator_version: "experience_scope_v2", evidence_revision_hash: evidenceRevisionHash,
    readiness_fingerprint: readinessFingerprint, evaluated_at: "2098-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
  };
  const decision = await pool.query<{ id: string }>(
    `INSERT INTO deterministic_decisions (workspace_id, canonical_job_id, job_version_id, match_run_id, policy_snapshot_id,
       decision_hash, decision_json, recommendation_eligibility, recommendation_outcome, context_fingerprint,
       created_by_user_id, preference_user_id, preference_context_id, readiness_json, evidence_revision_hash, readiness_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'ELIGIBLE', $12, $7, $8, NULL, NULL, $9::jsonb, $10, $11) RETURNING id`,
    [ws, canonicalJobId, jobVersionId, matchRunId, policySnapshotId, `decision-hash-${crypto.randomUUID()}`,
      decisionFingerprint, workspace.userId, JSON.stringify(readiness), evidenceRevisionHash, readinessFingerprint,
      options.outcome ?? "REVIEW"],
  );
  const decisionId = decision.rows[0]!.id;
  await pool.query(`UPDATE canonical_jobs SET latest_deterministic_decision_id = $1 WHERE workspace_id = $2 AND id = $3`, [decisionId, ws, canonicalJobId]);

  let evaluationId: string | null = null;
  if (options.withEvaluation) {
    const evaluation = await pool.query<{ id: string }>(
      `INSERT INTO ai_evaluations (workspace_id, canonical_job_id, job_version_id, profile_version_id, match_run_id,
         deterministic_decision_id, job_content_hash, context_fingerprint, full_evaluation_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
      [ws, canonicalJobId, jobVersionId, profileVersionId, matchRunId, decisionId, jobContentHash, decisionFingerprint,
        JSON.stringify({ culture_evidence: [{ signal: "AUTONOMY", quote: AUTONOMY_QUOTE }], building_research_ratio: 70, interaction_load: 30 })],
    );
    evaluationId = evaluation.rows[0]!.id;
  }
  return { canonicalJobId, jobVersionId, matchRunId, decisionId, decisionFingerprint, jobContentHash, evaluationId };
}
