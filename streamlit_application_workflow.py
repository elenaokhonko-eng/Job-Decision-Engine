"""Eligibility helpers for the Streamlit application workspace."""

from collections.abc import Mapping
from datetime import UTC, datetime
import json

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


def parse_application_document_pair_status(
    stdout: str,
    *,
    application_record_id: str,
    cv_document_run_id: str,
    cover_letter_document_run_id: str,
) -> dict[str, object]:
    for line in reversed(stdout.splitlines()):
        try:
            status = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            not isinstance(status, dict)
            or status.get("event") != "APPLICATION_DOCUMENT_PAIR_VALIDATED"
        ):
            continue
        if (
            status.get("applicationRecordId") != application_record_id
            or status.get("cvDocumentRunId") != cv_document_run_id
            or status.get("coverLetterDocumentRunId") != cover_letter_document_run_id
        ):
            raise ValueError(
                "Document-pair status does not match the selected application and run IDs."
            )
        return status
    raise ValueError("The document-pair validator returned no structured status.")


def _is_future_timestamp(value: object) -> bool:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return False
    else:
        return False
    return parsed.tzinfo is not None and parsed > datetime.now(UTC)


def has_current_ready_assessment(job: Mapping[str, object]) -> bool:
    """Check that the read-model row carries a current, unexpired READY assessment.

    Args:
        job: A row from a readiness-enriched canonical read model.

    Returns:
        True only when readiness and availability evidence are current and resolved.

    Example:
        >>> has_current_ready_assessment({
        ...     "readiness_status": "READY",
        ...     "readiness_fingerprint": "a" * 64,
        ...     "readiness_reason_codes": [],
        ...     "readiness_expires_at": "2099-01-01T00:00:00Z",
        ...     "availability_status": "OPEN",
        ...     "availability_recheck_at": "2099-01-01T00:00:00Z",
        ... })
        True
    """
    readiness_fingerprint = job.get("readiness_fingerprint")
    readiness_reason_codes = job.get("readiness_reason_codes")
    return (
        job.get("readiness_status") == "READY"
        and isinstance(readiness_fingerprint, str)
        and len(readiness_fingerprint) == 64
        and all(character in "0123456789abcdef" for character in readiness_fingerprint)
        and isinstance(readiness_reason_codes, list)
        and not readiness_reason_codes
        and job.get("availability_status") == "OPEN"
        and _is_future_timestamp(job.get("readiness_expires_at"))
        and _is_future_timestamp(job.get("availability_recheck_at"))
    )


def is_document_generation_eligible(
    job: Mapping[str, object], *, include_track: bool = False
) -> bool:
    """Check whether a job has a current deterministic basis for documents.

    Args:
        job: A row from the canonical shortlist read model with its UI decision projection.
        include_track: Whether a current TRACK decision may be selected.

    Returns:
        True only when the current job version, match, gate, recommendation, and
        unexpired READY assessment are usable for document generation. AI evaluation is optional.

    Example:
        >>> is_document_generation_eligible({
        ...     "canonical_job_id": "job-id",
        ...     "job_version_id": "version-id",
        ...     "latest_match_run_id": "match-id",
        ...     "gate_status": "PASS",
        ...     "decision_eligibility": "ELIGIBLE",
        ...     "decision_outcome": "REVIEW",
        ...     "current_artifact_status": "EVALUATION_MISSING",
        ...     "readiness_status": "READY",
        ...     "readiness_fingerprint": "a" * 64,
        ...     "readiness_reason_codes": [],
        ...     "readiness_expires_at": "2099-01-01T00:00:00Z",
        ...     "availability_status": "OPEN",
        ...     "availability_recheck_at": "2099-01-01T00:00:00Z",
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
    if not has_current_ready_assessment(job):
        return False

    outcomes = APPLY_NOW_OUTCOMES | ({"TRACK"} if include_track else set())
    return job.get("decision_outcome") in outcomes
