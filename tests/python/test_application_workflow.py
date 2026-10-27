import hashlib
import json
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from streamlit_application_workflow import (
    application_api_path,
    is_document_generation_eligible,
    load_verified_document_bytes,
    parse_application_document_pair_status,
    salary_disclosure_message,
)


def test_application_routes_are_namespaced_under_api_v2():
    assert application_api_path("/applications") == "/api/v2/applications"
    assert (
        application_api_path("applications/record-id")
        == "/api/v2/applications/record-id"
    )
    assert (
        application_api_path("/api/v2/applications/record-id/events")
        == "/api/v2/applications/record-id/events"
    )


def test_streamlit_renders_download_buttons_for_ci_document_pair(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    export_root = tmp_path / "scripts" / "exports"
    artifact_dir = export_root / "application-documents"
    artifact_dir.mkdir(parents=True)
    manifests = {}
    for document_type in ("cv", "cover_letter"):
        outputs = {}
        for output_type, suffix, content in (
            ("docx", "docx", f"{document_type} docx".encode()),
            ("pdf", "pdf", f"{document_type} pdf".encode()),
        ):
            filename = f"{document_type}.{suffix}"
            (artifact_dir / filename).write_bytes(content)
            outputs[output_type] = {
                "path": f"/home/runner/work/repository/scripts/exports/{filename}",
                "sha256": hashlib.sha256(content).hexdigest(),
                "mimeType": "application/octet-stream",
            }
        manifests[document_type] = {
            "documentRunId": f"{document_type}-run",
            "outputs": outputs,
        }

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    monkeypatch.setenv("JDEC_TEST_EXPORT_ROOT", str(export_root))
    monkeypatch.setenv("JDEC_TEST_DOCUMENT_MANIFESTS", json.dumps(manifests))
    app_path = Path(__file__).parent / "fixtures" / "streamlit_document_download_app.py"
    app = AppTest.from_file(str(app_path)).run()

    assert not app.exception
    download_buttons = app.get("download_button")
    assert len(download_buttons) == 4
    assert {button.label for button in download_buttons} == {
        "Download DOCX: cv.docx",
        "Download PDF: cv.pdf",
        "Download DOCX: cover_letter.docx",
        "Download PDF: cover_letter.pdf",
    }


def test_loads_downloaded_ci_artifact_from_local_exports_by_name_and_hash(
    tmp_path: Path,
):
    export_root = tmp_path / "scripts" / "exports"
    artifact_dir = export_root / "application-documents"
    artifact_dir.mkdir(parents=True)
    content = b"synthetic DOCX payload"
    filename = "Candidate_CV_Example.docx"
    (artifact_dir / filename).write_bytes(content)
    expected_hash = hashlib.sha256(content).hexdigest()

    name, loaded = load_verified_document_bytes(
        {
            "path": f"/home/runner/work/repository/scripts/exports/{filename}",
            "sha256": expected_hash,
        },
        export_root,
    )

    assert name == filename
    assert loaded == content


def test_rejects_non_object_document_output():
    with pytest.raises(TypeError, match="manifest output"):
        load_verified_document_bytes([], Path("scripts") / "exports")


def test_rejects_local_download_when_manifest_hash_does_not_match(tmp_path: Path):
    export_root = tmp_path / "scripts" / "exports"
    export_root.mkdir(parents=True)
    (export_root / "document.docx").write_bytes(b"different content")

    with pytest.raises(RuntimeError, match="SHA-256"):
        load_verified_document_bytes(
            {
                "path": "/home/runner/work/repository/scripts/exports/document.docx",
                "sha256": hashlib.sha256(b"expected content").hexdigest(),
            },
            export_root,
        )


def test_parses_read_only_document_pair_status_for_exact_run_ids():
    manifest = {
        "event": "APPLICATION_DOCUMENT_PAIR_VALIDATED",
        "applicationRecordId": "application-1",
        "cvDocumentRunId": "cv-run-1",
        "coverLetterDocumentRunId": "letter-run-1",
        "pairCurrent": True,
    }
    output = f"logging output\n{json.dumps(manifest)}\n"

    parsed = parse_application_document_pair_status(
        output,
        application_record_id="application-1",
        cv_document_run_id="cv-run-1",
        cover_letter_document_run_id="letter-run-1",
    )
    assert parsed["pairCurrent"] is True


def test_rejects_document_pair_status_for_different_run_ids():
    manifest = {
        "event": "APPLICATION_DOCUMENT_PAIR_VALIDATED",
        "applicationRecordId": "application-1",
        "cvDocumentRunId": "other-cv",
        "coverLetterDocumentRunId": "letter-run-1",
    }
    output = json.dumps(manifest)

    with pytest.raises(ValueError, match="does not match"):
        parse_application_document_pair_status(
            output,
            application_record_id="application-1",
            cv_document_run_id="cv-run-1",
            cover_letter_document_run_id="letter-run-1",
        )


def current_review_job(**overrides):
    job = {
        "canonical_job_id": "job-id",
        "job_version_id": "version-id",
        "latest_match_run_id": "match-id",
        "gate_status": "PASS",
        "decision_eligibility": "ELIGIBLE",
        "decision_outcome": "REVIEW",
        "processing_state": "MATCHED",
        "current_artifact_status": "EVALUATION_MISSING",
        "readiness_status": "READY",
        "readiness_fingerprint": "a" * 64,
        "readiness_expires_at": "2099-01-01T00:00:00Z",
        "readiness_reason_codes": [],
        "availability_status": "OPEN",
        "availability_recheck_at": "2099-01-01T00:00:00Z",
        "version_mismatch": False,
        "eval_provider": None,
    }
    return job | overrides


def test_includes_current_matched_review_without_optional_ai_evaluation():
    assert is_document_generation_eligible(current_review_job())


def test_undisclosed_salary_is_visible_but_does_not_block_documents():
    job = current_review_job(
        application_readiness={
            "checks": [
                {
                    "key": "COMPENSATION",
                    "status": "NEEDS_VERIFICATION",
                    "importance": "PREFERRED",
                    "reason_code": "COMPENSATION_UNDISCLOSED",
                }
            ]
        }
    )

    assert (
        salary_disclosure_message(job) == "Salary undisclosed—confirm with recruiter."
    )
    assert is_document_generation_eligible(job)


def test_excludes_stale_or_incomplete_deterministic_context():
    assert not is_document_generation_eligible(
        current_review_job(latest_match_run_id=None)
    )
    assert not is_document_generation_eligible(
        current_review_job(current_artifact_status="MATCH_STALE")
    )
    assert not is_document_generation_eligible(
        current_review_job(current_artifact_status="DECISION_STALE")
    )


def test_excludes_jobs_without_current_ready_assessment():
    assert not is_document_generation_eligible(
        current_review_job(readiness_status=None)
    )
    assert not is_document_generation_eligible(
        current_review_job(
            readiness_status="NEEDS_VERIFICATION",
            readiness_reason_codes=["SALARY_BASIS_UNRESOLVED"],
        )
    )
    assert not is_document_generation_eligible(
        current_review_job(readiness_status="PROCESSING")
    )
    assert not is_document_generation_eligible(
        current_review_job(readiness_reason_codes=["SALARY_BASIS_UNRESOLVED"])
    )
    assert not is_document_generation_eligible(
        current_review_job(readiness_fingerprint=None)
    )
    assert not is_document_generation_eligible(
        current_review_job(readiness_expires_at="2000-01-01T00:00:00Z")
    )
    assert not is_document_generation_eligible(
        current_review_job(availability_status="CLOSED")
    )
    assert not is_document_generation_eligible(
        current_review_job(availability_recheck_at="2000-01-01T00:00:00Z")
    )


def test_allows_current_deterministic_context_with_a_stale_optional_evaluation():
    assert is_document_generation_eligible(
        current_review_job(
            version_mismatch=True, current_artifact_status="EVALUATION_STALE"
        )
    )


def test_excludes_ineligible_or_non_apply_now_jobs_by_default():
    assert not is_document_generation_eligible(
        current_review_job(decision_eligibility="INELIGIBLE")
    )
    assert not is_document_generation_eligible(
        current_review_job(decision_outcome="SKIP")
    )
    assert not is_document_generation_eligible(
        current_review_job(decision_outcome="TRACK")
    )


def test_includes_track_jobs_only_when_explicitly_requested():
    track_job = current_review_job(decision_outcome="TRACK")
    assert not is_document_generation_eligible(track_job)
    assert is_document_generation_eligible(track_job, include_track=True)
