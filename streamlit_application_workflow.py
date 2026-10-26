"""Eligibility helpers for the Streamlit application workspace."""

from collections.abc import Mapping

CURRENT_DETERMINISTIC_CONTEXTS = frozenset(
    {
        "CURRENT_OR_NOT_APPLICABLE",
        "EVALUATION_MISSING",
        "EVALUATION_STALE",
    }
)
APPLY_NOW_OUTCOMES = frozenset({"PRIORITY", "REVIEW"})
API_V2_PREFIX = "/api/v2"


def application_api_path(path: str) -> str:
    """Return an application route under the mounted API v2 prefix."""
    normalized = "/" + path.strip("/")
    if normalized == API_V2_PREFIX or normalized.startswith(f"{API_V2_PREFIX}/"):
        return normalized
    return f"{API_V2_PREFIX}{normalized}"


def is_document_generation_eligible(
    job: Mapping[str, object], *, include_track: bool = False
) -> bool:
    """Check whether a job has a current deterministic basis for documents.

    Args:
        job: A row from the canonical shortlist read model with its UI decision projection.
        include_track: Whether a current TRACK decision may be selected.

    Returns:
        True only when the current job version, match, gate, and deterministic
        recommendation are usable for document generation. AI evaluation is optional.

    Example:
        >>> is_document_generation_eligible({
        ...     "canonical_job_id": "job-id",
        ...     "job_version_id": "version-id",
        ...     "latest_match_run_id": "match-id",
        ...     "gate_status": "PASS",
        ...     "decision_eligibility": "ELIGIBLE",
        ...     "decision_outcome": "REVIEW",
        ...     "current_artifact_status": "EVALUATION_MISSING",
        ... })
        True
    """
    if not job.get("canonical_job_id") or not job.get("job_version_id"):
        return False
    if not job.get("latest_match_run_id") or job.get("gate_status") != "PASS":
        return False
    if job.get("decision_eligibility") != "ELIGIBLE":
        return False
    if job.get("current_artifact_status") not in CURRENT_DETERMINISTIC_CONTEXTS:
        return False

    outcomes = APPLY_NOW_OUTCOMES | ({"TRACK"} if include_track else set())
    return job.get("decision_outcome") in outcomes
