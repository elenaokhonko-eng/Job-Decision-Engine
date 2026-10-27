"""Validate workspace-scoped Streamlit read-model rows.

Usage:
    Import the validators and apply them to rows returned by canonical views.

Example:
    validate_track_row(row, workspace_id)
"""

from collections.abc import Mapping
from decimal import Decimal
import math

from streamlit_application_workflow import has_current_ready_assessment


APPLICATION_STATUSES = frozenset(
    {
        "TO_APPLY",
        "APPLIED",
        "ASSESSMENT",
        "INTENT",
        "READY_TO_APPLY",
        "SUBMITTED",
        "FOLLOW_UP",
        "INTERVIEW",
        "OFFER",
        "REJECTED",
        "WITHDRAWN",
        "CLOSED",
    }
)


def _require_fields(row: Mapping[str, object], fields: tuple[str, ...]) -> None:
    missing = [field for field in fields if field not in row]
    if missing:
        raise ValueError(
            f"Read-model row is missing required fields: {', '.join(missing)}"
        )


def _require_scope(row: Mapping[str, object], workspace_id: object) -> None:
    if str(row.get("workspace_id")) != str(workspace_id):
        raise ValueError(
            "Read-model row workspace does not match the requested workspace."
        )


def _require_string(row: Mapping[str, object], field: str) -> None:
    value = row.get(field)
    if not isinstance(value, str):
        raise TypeError(f"Read-model field {field} must be a string.")
    if not value.strip():
        raise ValueError(f"Read-model field {field} must be a non-empty string.")


def _optional_score(row: Mapping[str, object], field: str) -> None:
    value = row.get(field)
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise TypeError(f"Read-model score {field} must be numeric or NULL.")
    numeric = float(value)
    if not math.isfinite(numeric) or numeric < 0 or numeric > 100:
        raise ValueError(
            f"Read-model score {field} must be finite and between 0 and 100."
        )


def _require_nonnegative_count(row: Mapping[str, object], field: str) -> None:
    value = row.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise TypeError(f"Read-model count {field} must be a non-negative integer.")
    numeric = float(value)
    if not math.isfinite(numeric) or numeric < 0 or not numeric.is_integer():
        raise ValueError(f"Read-model count {field} must be a non-negative integer.")


def validate_application_workspace_summary(
    row: Mapping[str, object], workspace_id: object, user_key: object
) -> None:
    """Validate the authenticated, unpaginated workspace metric projection.

    Args:
        row: A row returned by the workspace summary view.
        workspace_id: The workspace requested by the caller.
        user_key: The configured active workspace member key.

    Returns:
        None.

    Raises:
        ValueError: If scope, user identity, or counts are invalid.
        TypeError: If a count or identity has an invalid type.

    Example:
        validate_application_workspace_summary(row, workspace_id, user_key)
    """
    fields = (
        "workspace_id",
        "user_id",
        "user_key",
        "total_jobs",
        "apply_now_count",
        "track_count",
        "processing_count",
        "rejected_unmatched_count",
        "applied_count",
        "technical_errors",
        "skip_count",
        "top_ten_ready_count",
    )
    _require_fields(row, fields)
    _require_scope(row, workspace_id)
    _require_string(row, "user_id")
    if row.get("user_key") != user_key:
        raise ValueError(
            "Workspace summary user does not match the configured workspace member."
        )
    for field in fields[3:]:
        _require_nonnegative_count(row, field)


def validate_ranked_job_row(row: Mapping[str, object], workspace_id: object) -> None:
    """Validate one persisted Top 10 row and its workspace identity.

    Args:
        row: A row returned by the Top 10 read model.
        workspace_id: The workspace requested by the caller.

    Returns:
        None.

    Raises:
        ValueError: If currentness, eligibility, or scores are invalid.
        TypeError: If a score or identity has an invalid type.

    Example:
        validate_ranked_job_row(row, workspace_id)
    """
    _require_fields(
        row,
        (
            "workspace_id",
            "canonical_job_id",
            "job_version_id",
            "profile_version_id",
            "match_run_id",
            "deterministic_decision_id",
            "ai_evaluation_id",
            "ranking_policy_version",
            "ranking_context_fingerprint",
            "ranking_position",
            "overall_rank_score",
            "ranking_confidence",
            "is_top_ten_ready",
            "readiness_status",
            "readiness_fingerprint",
            "readiness_expires_at",
            "readiness_reason_codes",
            "availability_status",
            "availability_recheck_at",
            "policy_recheck_required",
            "recommendation_eligibility",
            "recommendation_outcome",
            "gate_status",
            "primary_lane",
        ),
    )
    _require_scope(row, workspace_id)
    for field in (
        "canonical_job_id",
        "job_version_id",
        "profile_version_id",
        "match_run_id",
        "deterministic_decision_id",
        "ai_evaluation_id",
        "ranking_context_fingerprint",
        "primary_lane",
    ):
        _require_string(row, field)
    if row.get("recommendation_eligibility") != "ELIGIBLE":
        raise ValueError("Top 10 rows must have a deterministic ELIGIBLE decision.")
    if row.get("recommendation_outcome") not in {"PRIORITY", "REVIEW"}:
        raise ValueError(
            "Top 10 rows must be current PRIORITY or REVIEW opportunities."
        )
    if row.get("gate_status") != "PASS" or row.get("is_top_ten_ready") is not True:
        raise ValueError(
            "Top 10 rows must have a passing gate and a ready ranking artifact."
        )
    if row.get("policy_recheck_required") is not False:
        raise ValueError("Top 10 rows cannot have a pending policy recheck.")
    if not has_current_ready_assessment(row):
        raise ValueError("Top 10 rows require a current READY assessment.")
    for field in (
        "overall_rank_score",
        "ranking_confidence",
        "requirement_fit_score",
        "requirement_coverage_score",
        "evidence_completeness_score",
        "lane_confidence_score",
        "autonomy_score",
        "politics_risk_score",
        "sensory_workload_risk_score",
        "strategic_value_score",
        "focus_protection_score",
        "building_ratio_score",
        "interaction_burden_score",
    ):
        if field in row:
            _optional_score(row, field)


def validate_apply_now_row(row: Mapping[str, object], workspace_id: object) -> None:
    """Validate a current deterministic Apply Now row and ranking fields.

    Args:
        row: A row returned by the Apply Now read model.
        workspace_id: The workspace requested by the caller.

    Returns:
        None.

    Raises:
        ValueError: If currentness, eligibility, or scores are invalid.
        TypeError: If a score or identity has an invalid type.

    Example:
        validate_apply_now_row(row, workspace_id)
    """
    _require_fields(
        row,
        (
            "workspace_id",
            "canonical_job_id",
            "job_version_id",
            "title",
            "company",
            "gate_status",
            "recommendation_eligibility",
            "recommendation_outcome",
            "current_artifact_status",
            "readiness_status",
            "readiness_fingerprint",
            "readiness_expires_at",
            "readiness_reason_codes",
            "availability_status",
            "availability_recheck_at",
            "policy_recheck_required",
            "overall_rank_score",
            "ranking_confidence",
        ),
    )
    _require_scope(row, workspace_id)
    for field in ("canonical_job_id", "job_version_id", "title", "company"):
        _require_string(row, field)
    if (
        row.get("gate_status") != "PASS"
        or row.get("recommendation_eligibility") != "ELIGIBLE"
    ):
        raise ValueError(
            "Apply Now rows require a passing gate and deterministic eligibility."
        )
    if row.get("recommendation_outcome") not in {"PRIORITY", "REVIEW"}:
        raise ValueError("Apply Now rows must be PRIORITY or REVIEW.")
    if row.get("current_artifact_status") not in {
        "CURRENT_OR_NOT_APPLICABLE",
        "EVALUATION_MISSING",
        "EVALUATION_STALE",
    }:
        raise ValueError("Apply Now row deterministic context is stale or incomplete.")
    if not has_current_ready_assessment(row):
        raise ValueError("Apply Now rows require a current READY assessment.")
    for field in (
        "overall_rank_score",
        "ranking_confidence",
        "deterministic_match_score",
        "deterministic_match_coverage",
        "recommendation_requirement_score",
        "recommendation_coverage_score",
        "recommendation_evidence_completeness",
    ):
        if field in row:
            _optional_score(row, field)


def validate_track_row(row: Mapping[str, object], workspace_id: object) -> None:
    """Validate a current deterministic Track row and its decision trace.

    Args:
        row: A row returned by the Track read model.
        workspace_id: The workspace requested by the caller.

    Returns:
        None.

    Raises:
        ValueError: If scope, currentness, or decision trace is invalid.
        TypeError: If the decision trace has an invalid type.

    Example:
        validate_track_row(row, workspace_id)
    """
    _require_fields(
        row,
        (
            "workspace_id",
            "canonical_job_id",
            "job_version_id",
            "title",
            "company",
            "gate_status",
            "recommendation_outcome",
            "deterministic_decision_id",
            "deterministic_context_fingerprint",
            "deterministic_trace_notes",
        ),
    )
    _require_scope(row, workspace_id)
    for field in (
        "canonical_job_id",
        "job_version_id",
        "title",
        "company",
        "deterministic_decision_id",
        "deterministic_context_fingerprint",
    ):
        _require_string(row, field)
    if row.get("gate_status") != "PASS" or row.get("recommendation_outcome") != "TRACK":
        raise ValueError(
            "Track rows must represent a current gate-passed TRACK decision."
        )
    if not isinstance(row.get("deterministic_trace_notes"), list):
        raise TypeError("Track decision trace notes must be an array.")


def validate_application_row(
    row: Mapping[str, object], workspace_id: object, user_id: object
) -> None:
    """Validate one application record for workspace and user scope.

    Args:
        row: A row returned by the application tracker.
        workspace_id: The workspace requested by the caller.
        user_id: The authenticated workspace member identifier.

    Returns:
        None.

    Raises:
        ValueError: If scope, status, or document freshness is invalid.
        TypeError: If identity fields have invalid types.

    Example:
        validate_application_row(row, workspace_id, user_id)
    """
    _require_fields(
        row,
        (
            "workspace_id",
            "user_id",
            "application_record_id",
            "canonical_job_id",
            "job_version_id",
            "title",
            "company",
            "application_status",
            "cv_document_status",
            "cover_letter_document_status",
        ),
    )
    _require_scope(row, workspace_id)
    if str(row.get("user_id")) != str(user_id):
        raise ValueError(
            "Application row user does not match the authenticated workspace member."
        )
    for field in (
        "application_record_id",
        "canonical_job_id",
        "job_version_id",
        "title",
        "company",
    ):
        _require_string(row, field)
    if row.get("application_status") not in APPLICATION_STATUSES:
        raise ValueError("Application row has an unsupported status.")
    if row.get("cv_document_status") not in {"NOT_GENERATED", "READY", "STALE"}:
        raise ValueError("CV document status is invalid.")
    if row.get("cover_letter_document_status") not in {
        "NOT_GENERATED",
        "READY",
        "STALE",
    }:
        raise ValueError("Cover-letter document status is invalid.")


def validate_company_culture_row(
    row: Mapping[str, object], workspace_id: object
) -> None:
    """Validate workspace-scoped company culture scores and counts.

    Args:
        row: A row returned by the company-culture read model.
        workspace_id: The workspace requested by the caller.

    Returns:
        None.

    Raises:
        ValueError: If scope, confidence, score, or count values are invalid.
        TypeError: If a score or count has an invalid type.

    Example:
        validate_company_culture_row(row, workspace_id)
    """
    _require_fields(
        row,
        (
            "workspace_id",
            "workspace_company_id",
            "company_name",
            "company_job_count",
            "observation_count",
            "autonomy_score",
            "politics_risk_score",
            "sensory_workload_risk_score",
            "focus_protection_score",
            "confidence_level",
            "last_updated",
        ),
    )
    _require_scope(row, workspace_id)
    for field in ("workspace_company_id", "company_name"):
        _require_string(row, field)
    for field in (
        "autonomy_score",
        "politics_risk_score",
        "sensory_workload_risk_score",
        "focus_protection_score",
        "strategic_value_score",
    ):
        if field in row:
            _optional_score(row, field)
    for field in ("company_job_count", "observation_count"):
        _require_nonnegative_count(row, field)
    if row.get("confidence_level") not in {"UNKNOWN", "LOW", "MEDIUM", "HIGH"}:
        raise ValueError("Company culture confidence level is invalid.")


def validate_profile_evidence_row(
    row: Mapping[str, object], workspace_id: object
) -> None:
    """Validate one current requirement-to-profile evidence row.

    Args:
        row: A row returned by the profile evidence read model.
        workspace_id: The workspace requested by the caller.

    Returns:
        None.

    Raises:
        ValueError: If scope, evidence, match type, or score is invalid.
        TypeError: If a score or field has an invalid type.

    Example:
        validate_profile_evidence_row(row, workspace_id)
    """
    _require_fields(
        row,
        (
            "workspace_id",
            "canonical_job_id",
            "job_version_id",
            "profile_version_id",
            "match_run_id",
            "requirement_id",
            "requirement_key",
            "importance",
            "requirement_text",
            "match_type",
            "match_score",
        ),
    )
    _require_scope(row, workspace_id)
    for field in (
        "canonical_job_id",
        "job_version_id",
        "profile_version_id",
        "match_run_id",
        "requirement_id",
        "requirement_key",
        "requirement_text",
    ):
        _require_string(row, field)
    if row.get("importance") not in {"MUST", "PREFERRED", "NICE_TO_HAVE"}:
        raise ValueError("Profile evidence importance is invalid.")
    if row.get("match_type") not in {"EXACT", "SEMANTIC", "NO_MATCH", "UNKNOWN"}:
        raise ValueError("Profile evidence match type is invalid.")
    _optional_score(row, "match_score")
    if row.get("evidence_tier") == "PRIVATE_INTERNAL":
        raise ValueError("Private internal profile evidence must not be exposed.")


def validate_profile_coverage_row(
    row: Mapping[str, object], workspace_id: object
) -> None:
    """Validate active-profile coverage counts for the current job context.

    Args:
        row: A row returned by the profile coverage read model.
        workspace_id: The workspace requested by the caller.

    Returns:
        None.

    Raises:
        ValueError: If scope, lineage, or counts are invalid.
        TypeError: If an identity or count has an invalid type.

    Example:
        validate_profile_coverage_row(row, workspace_id)
    """
    _require_fields(
        row,
        (
            "workspace_id",
            "canonical_job_id",
            "job_version_id",
            "profile_version_id",
            "profile_version_number",
            "match_run_id",
            "must_matched_count",
            "must_missing_count",
            "preferred_matched_count",
            "preferred_missing_count",
            "exact_match_count",
            "semantic_match_count",
            "active_credential_count",
            "engagement_count",
        ),
    )
    _require_scope(row, workspace_id)
    for field in (
        "canonical_job_id",
        "job_version_id",
        "profile_version_id",
        "match_run_id",
    ):
        _require_string(row, field)
    _require_nonnegative_count(row, "profile_version_number")
    if float(row["profile_version_number"]) < 1:
        raise ValueError("Profile coverage version number must be a positive integer.")
    for field in (
        "must_matched_count",
        "must_missing_count",
        "preferred_matched_count",
        "preferred_missing_count",
        "exact_match_count",
        "semantic_match_count",
        "active_credential_count",
        "engagement_count",
    ):
        _require_nonnegative_count(row, field)


def validate_company_culture_evidence_row(
    row: Mapping[str, object], workspace_id: object
) -> None:
    """Validate job-linked company evidence and its signal provenance.

    Args:
        row: A row returned by the company culture evidence view.
        workspace_id: The workspace requested by the caller.

    Returns:
        None.

    Raises:
        ValueError: If scope, lineage, or scores are invalid.
        TypeError: If the provenance map or a score has an invalid type.

    Example:
        validate_company_culture_evidence_row(row, workspace_id)
    """
    fields = (
        "workspace_id",
        "workspace_company_id",
        "company_name",
        "canonical_job_id",
        "job_version_id",
        "ai_evaluation_id",
        "evidence_by_signal",
        "source_type",
    )
    _require_fields(row, fields)
    _require_scope(row, workspace_id)
    for field in (
        "workspace_company_id",
        "company_name",
        "canonical_job_id",
        "job_version_id",
        "ai_evaluation_id",
        "source_type",
    ):
        _require_string(row, field)
    if not isinstance(row.get("evidence_by_signal"), dict):
        raise TypeError("Company culture evidence map must be a JSON object.")
    for field in (
        "autonomy_signal",
        "politics_risk_signal",
        "sensory_workload_risk_signal",
        "focus_protection_signal",
        "strategic_value_signal",
    ):
        if field in row:
            _optional_score(row, field)


def validate_company_culture_coverage_summary(
    row: Mapping[str, object], workspace_id: object
) -> None:
    """Validate unpaginated company and culture coverage totals.

    Args:
        row: A row returned by the company culture coverage query.
        workspace_id: The workspace requested by the caller.

    Returns:
        None.

    Raises:
        ValueError: If scope or coverage counts are invalid.
        TypeError: If a coverage count has an invalid type.

    Example:
        validate_company_culture_coverage_summary(row, workspace_id)
    """
    fields = (
        "workspace_id",
        "companies_represented",
        "companies_with_jobs",
        "companies_with_culture_observations",
        "companies_with_medium_high_confidence",
    )
    _require_fields(row, fields)
    _require_scope(row, workspace_id)
    for field in fields[1:]:
        _require_nonnegative_count(row, field)
