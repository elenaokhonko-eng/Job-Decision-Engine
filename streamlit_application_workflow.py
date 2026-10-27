"""Eligibility helpers for the Streamlit application workspace."""

from collections.abc import Mapping
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path

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


def load_verified_document_bytes(
    output: Mapping[str, object], export_root: Path = Path("scripts") / "exports"
) -> tuple[str, bytes]:
    """Load a hash-verified document from the local exports directory.

    Args:
        output: Document output manifest containing a path and SHA-256 hash.
        export_root: Directory where downloaded or generated artifacts are stored.

    Returns:
        The safe local filename and verified document bytes.

    Raises:
        TypeError: If the manifest path or hash is missing or invalid.
        RuntimeError: If no local export matches the manifest hash.

    Example:
        >>> name, content = load_verified_document_bytes(
        ...     {"path": "/runner/scripts/exports/cv.docx", "sha256": "..."},
        ...     Path("scripts") / "exports",
        ... )
    """
    if not isinstance(output, Mapping):
        raise TypeError("The document manifest output is not an object.")
    manifest_path = output.get("path")
    expected_hash = output.get("sha256")
    if not isinstance(manifest_path, str) or not isinstance(expected_hash, str):
        raise TypeError(
            "The document manifest does not contain a path and SHA-256 hash."
        )

    root = export_root.resolve()
    source_path = Path(manifest_path)
    candidates = []
    if source_path.is_absolute():
        candidates.append(source_path.resolve())
    else:
        candidates.append((Path.cwd() / source_path).resolve())
    if source_path.name:
        candidates.extend(
            candidate.resolve() for candidate in root.rglob(source_path.name)
        )

    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            candidate.relative_to(root)
        except ValueError:
            continue
        if not candidate.is_file():
            continue
        content = candidate.read_bytes()
        if hashlib.sha256(content).hexdigest() == expected_hash:
            return candidate.name, content

    raise RuntimeError(
        "The document manifest does not resolve to a local export with the expected SHA-256 hash."
    )


def render_document_run_downloads(
    streamlit: object,
    manifest: Mapping[str, object],
    key_prefix: str,
    export_root: Path = Path("scripts") / "exports",
) -> None:
    """Render hash-verified local copies of a document run's artifacts.

    Args:
        streamlit: Streamlit module or compatible UI object.
        manifest: Exact document-run manifest emitted by a generator.
        key_prefix: Stable widget-key prefix for this document context.
        export_root: Local directory containing downloaded CI or generated artifacts.

    Returns:
        None.

    Raises:
        TypeError: If the output manifest has an unsupported shape.
        RuntimeError: If an artifact is absent or its hash does not match.

    Example:
        >>> render_document_run_downloads(st, document_manifest, "application_cv")
    """
    document_run_id = manifest.get("documentRunId")
    if not isinstance(document_run_id, str) or not document_run_id:
        raise TypeError("The document manifest does not contain a document run ID.")
    outputs = manifest.get("outputs")
    if not isinstance(outputs, Mapping):
        raise TypeError("The document manifest does not contain outputs.")
    streamlit.caption(f"Document run: {document_run_id}")
    for output_type in ("docx", "pdf"):
        output = outputs.get(output_type)
        if output is None:
            continue
        if not isinstance(output, Mapping):
            raise TypeError(
                f"The {output_type.upper()} manifest entry is not an object."
            )
        filename, content = load_verified_document_bytes(output, export_root)
        streamlit.download_button(
            label=f"Download {output_type.upper()}: {filename}",
            data=content,
            file_name=filename,
            mime=output.get("mimeType", "application/octet-stream"),
            key=f"{key_prefix}_{document_run_id}_{output_type}",
        )


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


def salary_disclosure_message(job: Mapping[str, object]) -> str | None:
    """Return the user-facing note for a non-blocking undisclosed salary.

    Args:
        job: A readiness-enriched canonical read-model row.

    Returns:
        The recruiter follow-up note when base salary is undisclosed; otherwise None.
    """
    readiness = job.get("application_readiness")
    if isinstance(readiness, str):
        try:
            readiness = json.loads(readiness)
        except json.JSONDecodeError:
            return None
    if not isinstance(readiness, Mapping):
        return None
    checks = readiness.get("checks")
    if not isinstance(checks, list):
        return None
    for check in checks:
        if (
            isinstance(check, Mapping)
            and check.get("key") == "COMPENSATION"
            and check.get("reason_code") == "COMPENSATION_UNDISCLOSED"
        ):
            return "Salary undisclosed—confirm with recruiter."
    return None


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
