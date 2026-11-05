export interface DocumentCurrentContext {
  readonly archived_at?: Date | string | null;
  readonly current_job_version_id: string | null;
  readonly selected_job_version_id: string | null;
  readonly active_profile_version_id: string | null;
  readonly selected_profile_version_id: string | null;
  readonly latest_match_run_id: string | null;
  readonly match_run_id: string | null;
  readonly match_run_job_version_id: string | null;
  readonly match_run_profile_version_id: string | null;
  readonly match_run_status: string | null;
  readonly match_run_requirement_set_id: string | null;
  readonly active_requirement_set_id: string | null;
  readonly match_run_job_content_hash: string | null;
  readonly current_job_content_hash: string | null;
  readonly match_run_context_fingerprint: string | null;
  readonly latest_deterministic_decision_id: string | null;
  readonly deterministic_decision_id: string | null;
  readonly decision_job_version_id: string | null;
  readonly decision_match_run_id: string | null;
  readonly decision_context_fingerprint: string | null;
  readonly decision_recommendation_eligibility: string | null;
  readonly decision_recommendation_outcome: string | null;
  readonly readiness_status: string | null;
  readonly readiness_fingerprint: string | null;
  readonly readiness_expires_at: string | Date | null;
  readonly readiness_reason_codes: readonly string[] | null;
  readonly gate_status: string | null;
  readonly recommendation_eligibility: string | null;
  readonly recommendation_outcome: string | null;
}

export type DocumentCurrentnessResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "JOB_ARCHIVED" | "JOB_VERSION_STALE" | "PROFILE_STALE" | "MATCH_STALE" | "DECISION_STALE" | "READINESS_NOT_READY";
    };

function isPresent(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCurrentReadyAssessment(context: DocumentCurrentContext): boolean {
  const expiry = context.readiness_expires_at instanceof Date
    ? context.readiness_expires_at.getTime()
    : context.readiness_expires_at === null
      ? Number.NaN
      : Date.parse(context.readiness_expires_at);
  return context.readiness_status === "READY" &&
    isPresent(context.readiness_fingerprint) &&
    context.readiness_reason_codes?.length === 0 &&
    Number.isFinite(expiry) &&
    expiry > Date.now();
}

export function validateDocumentCurrentContext(context: DocumentCurrentContext): DocumentCurrentnessResult {
  if (context.archived_at !== null && context.archived_at !== undefined) {
    return { ok: false, reason: "JOB_ARCHIVED" };
  }

  if (
    !isPresent(context.current_job_version_id) ||
    context.selected_job_version_id !== context.current_job_version_id
  ) {
    return { ok: false, reason: "JOB_VERSION_STALE" };
  }

  if (
    !isPresent(context.active_profile_version_id) ||
    context.selected_profile_version_id !== context.active_profile_version_id
  ) {
    return { ok: false, reason: "PROFILE_STALE" };
  }

  if (
    !isPresent(context.latest_match_run_id) ||
    context.match_run_id !== context.latest_match_run_id ||
    context.match_run_job_version_id !== context.current_job_version_id ||
    context.match_run_profile_version_id !== context.active_profile_version_id ||
    context.match_run_status !== "COMPLETED" ||
    !isPresent(context.active_requirement_set_id) ||
    !isPresent(context.match_run_requirement_set_id) ||
    context.match_run_requirement_set_id !== context.active_requirement_set_id ||
    !isPresent(context.current_job_content_hash) ||
    !isPresent(context.match_run_job_content_hash) ||
    context.match_run_job_content_hash !== context.current_job_content_hash ||
    !isPresent(context.match_run_context_fingerprint)
  ) {
    return { ok: false, reason: "MATCH_STALE" };
  }

  if (!hasCurrentReadyAssessment(context)) {
    return { ok: false, reason: "READINESS_NOT_READY" };
  }

  if (
    !isPresent(context.latest_deterministic_decision_id) ||
    context.deterministic_decision_id !== context.latest_deterministic_decision_id ||
    context.decision_job_version_id !== context.current_job_version_id ||
    context.decision_match_run_id !== context.match_run_id ||
    !isPresent(context.decision_context_fingerprint) ||
    context.gate_status !== "PASS" ||
    context.recommendation_eligibility !== "ELIGIBLE" ||
    context.decision_recommendation_eligibility !== "ELIGIBLE" ||
    context.decision_recommendation_outcome !== context.recommendation_outcome
  ) {
    return { ok: false, reason: "DECISION_STALE" };
  }

  return { ok: true };
}
