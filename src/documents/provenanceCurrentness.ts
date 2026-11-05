import pg from "pg";

import { loadCurrentApplicationReadiness, isCurrentReadyApplicationReadiness } from "../services/currentApplicationReadiness.js";
import { validateDocumentCurrentContext } from "./currentContext.js";

export interface PersistedDocumentCurrentnessInput {
  readonly canonicalJobId: string;
  readonly jobVersionId: string;
  readonly matchRunId: string | null;
  readonly profileVersionId: string | null;
  readonly deterministicDecisionId: string | null;
  readonly contextFingerprint: string | null;
}

export type PersistedDocumentCurrentnessResult =
  | { readonly current: true }
  | { readonly current: false; readonly reason: string };

export async function validatePersistedDocumentCurrentness(
  client: pg.PoolClient | pg.Pool,
  workspaceId: string,
  document: PersistedDocumentCurrentnessInput,
): Promise<PersistedDocumentCurrentnessResult> {
  const { rows } = await client.query(
    `SELECT
      job.archived_at,
      COALESCE(job.latest_job_version_id, current_job_version.id) AS current_job_version_id,
       job.latest_match_run_id,
       job.latest_deterministic_decision_id,
       profile.id AS active_profile_version_id,
       match_run.id AS match_run_id,
       match_run.job_version_id AS match_run_job_version_id,
       match_run.profile_version_id AS match_run_profile_version_id,
       match_run.status AS match_run_status,
       match_run.requirement_set_id AS match_run_requirement_set_id,
       current_job_version.active_requirement_set_id,
       match_run.job_content_hash AS match_run_job_content_hash,
       current_job_version.content_hash AS current_job_content_hash,
       match_run.context_fingerprint AS match_run_context_fingerprint,
       decision.id AS deterministic_decision_id,
       decision.job_version_id AS decision_job_version_id,
       decision.match_run_id AS decision_match_run_id,
       decision.context_fingerprint AS decision_context_fingerprint,
       decision.recommendation_eligibility AS decision_recommendation_eligibility,
       decision.recommendation_outcome AS decision_recommendation_outcome,
       current_shortlist.gate_status,
       current_shortlist.recommendation_eligibility,
       job.recommendation_outcome
     FROM canonical_jobs AS job
     LEFT JOIN job_versions AS current_job_version
       ON current_job_version.workspace_id = job.workspace_id
      AND current_job_version.canonical_job_id = job.id
      AND current_job_version.id = COALESCE(job.latest_job_version_id, (
        SELECT version.id
        FROM job_versions AS version
        WHERE version.workspace_id = job.workspace_id
          AND version.canonical_job_id = job.id
        ORDER BY version.observed_at DESC, version.id DESC
        LIMIT 1
      ))
     LEFT JOIN v_canonical_shortlist_scoped AS current_shortlist
       ON current_shortlist.workspace_id = job.workspace_id
      AND current_shortlist.canonical_job_id = job.id
      AND current_shortlist.job_version_id = current_job_version.id
     LEFT JOIN LATERAL (
       SELECT profile_version.id
       FROM profile_versions AS profile_version
       WHERE profile_version.workspace_id = job.workspace_id
         AND profile_version.status = 'ACTIVE'
       ORDER BY profile_version.created_at DESC, profile_version.id DESC
       LIMIT 1
     ) AS profile ON TRUE
     LEFT JOIN match_runs AS match_run
       ON match_run.workspace_id = job.workspace_id
      AND match_run.id = job.latest_match_run_id
      AND match_run.canonical_job_id = job.id
     LEFT JOIN deterministic_decisions AS decision
       ON decision.workspace_id = job.workspace_id
      AND decision.id = job.latest_deterministic_decision_id
      AND decision.canonical_job_id = job.id
     WHERE job.workspace_id = $1 AND job.id = $2
     LIMIT 1`,
    [workspaceId, document.canonicalJobId],
  );
  const current = rows[0];
  if (!current) return { current: false, reason: "JOB_NOT_AVAILABLE" };
  if (current.archived_at !== null && current.archived_at !== undefined) {
    return { current: false, reason: "JOB_ARCHIVED" };
  }

  const readiness = await loadCurrentApplicationReadiness(
    client,
    workspaceId,
    document.canonicalJobId,
    document.jobVersionId,
  );
  if (!isCurrentReadyApplicationReadiness(readiness)) {
    return { current: false, reason: "READINESS_NOT_READY" };
  }
  const context = validateDocumentCurrentContext({
    ...current,
    ...readiness,
    selected_job_version_id: document.jobVersionId,
    selected_profile_version_id: document.profileVersionId,
  });
  if (!context.ok) return { current: false, reason: context.reason };
  if (document.matchRunId !== current.match_run_id ||
      document.deterministicDecisionId !== current.deterministic_decision_id ||
      document.contextFingerprint !== current.decision_context_fingerprint) {
    return { current: false, reason: "DECISION_CONTEXT_CHANGED" };
  }
  return { current: true };
}