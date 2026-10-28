import base64
import hashlib
from io import BytesIO

import docx
import streamlit as st

from streamlit_manual_application import render_manual_application_flow


SCHEMA_VERSION = "manual_application_v1"
JOB_ID = "11111111-1111-4111-8111-111111111111"
JOB_VERSION_ID = "22222222-2222-4222-8222-222222222222"
OBSERVATION_ID = "33333333-3333-4333-8333-333333333333"
PROFILE_VERSION_ID = "44444444-4444-4444-8444-444444444444"
CANDIDATE_ID = "55555555-5555-4555-8555-555555555555"
REQUIREMENT_SET_ID = "66666666-6666-4666-8666-666666666666"
DRAFT_ID = "77777777-7777-4777-8777-777777777777"
APPROVAL_ID = "88888888-8888-4888-8888-888888888888"
FETCH_RECEIPT_ID = "99999999-9999-4999-8999-999999999999"
FINGERPRINT = "a" * 64
CONTACT_FINGERPRINT = "b" * 64
PREFERENCE_FINGERPRINT = "c" * 64
CONTEXT_FINGERPRINT = "d" * 64
DESCRIPTION = (
    "A detailed role description fetched from the selected public posting. " * 8
)


def _docx_bytes():
    document = docx.Document()
    document.add_paragraph("Candidate")
    stream = BytesIO()
    document.save(stream)
    return stream.getvalue()


def _artifact_bytes(format_name):
    if format_name == "PDF":
        return b"%PDF-1.4\nmanual application test\n%%EOF\n"
    return _docx_bytes()


def _artifact(item_type, format_name):
    mime = (
        "application/pdf"
        if format_name == "PDF"
        else "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    suffix = format_name.lower()
    prefix = "cv" if item_type == "CV" else "cover-letter"
    return {
        "type": item_type,
        "format": format_name,
        "filename": f"{prefix}.{suffix}",
        "mime_type": mime,
    }


def _comparison_response(source_content_status="COMPLETE"):
    evidence = {
        "id": "fact-1",
        "evidence_type": "FACT",
        "label": "data systems",
        "statement": "Designed data systems.",
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "draft_id": DRAFT_ID,
        "comparison_id": DRAFT_ID,
        "comparison_fingerprint": FINGERPRINT,
        "selected_job": {
            "schema_version": SCHEMA_VERSION,
            "canonicalJobId": JOB_ID,
            "jobVersionId": JOB_VERSION_ID,
            "sourceObservationId": OBSERVATION_ID,
            "contentHash": "job-content-hash",
            "title": "Data Architect",
            "company": "Example",
            "url": "https://example.test/job",
            "source": {
                "source_kind": "FETCHED",
                "source_content_status": source_content_status,
                "provider": "EMPLOYER_WEBSITE",
                "fetched_content_hash": hashlib.sha256(
                    DESCRIPTION.encode()
                ).hexdigest(),
                "source_evidence": {
                    "requestedUrl": "https://example.test/job",
                    "resolvedUrl": "https://example.test/job",
                    "redirectHistory": [],
                    "retrievedAt": "2026-10-28T00:00:00.000Z",
                    "httpStatus": 200,
                    "contentType": "text/html; charset=utf-8",
                    "responseHash": "f" * 64,
                },
            },
        },
        "comparison": {
            "schema_version": SCHEMA_VERSION,
            "comparator_version": "literal-overlap-v1",
            "canonical_job_id": JOB_ID,
            "job_version_id": JOB_VERSION_ID,
            "source_observation_id": OBSERVATION_ID,
            "source_evidence_fingerprint": "e" * 64,
            "job_content_hash": "job-content-hash",
            "profile_version_id": PROFILE_VERSION_ID,
            "candidate_profile_id": CANDIDATE_ID,
            "requirement_set_id": REQUIREMENT_SET_ID,
            "profile_contact_fact_ids": [],
            "profile_contact_fingerprint": CONTACT_FINGERPRINT,
            "preference_context_fingerprint": PREFERENCE_FINGERPRINT,
            "context_fingerprint": CONTEXT_FINGERPRINT,
            "title": "Data Architect",
            "company": "Example",
            "canonical_url": "https://example.test/job",
            "requirements": [
                {
                    "requirement_key": "R-001",
                    "requirement_type": "FUNCTION",
                    "importance": "MUST",
                    "requirement_text": "Experience building data systems",
                }
            ],
            "evidence": [evidence],
            "rows": [
                {
                    "requirement_key": "R-001",
                    "requirement_type": "FUNCTION",
                    "importance": "MUST",
                    "requirement": "Experience building data systems",
                    "evidence": [
                        {
                            "id": "fact-1",
                            "type": "FACT",
                            "label": "data systems",
                            "statement": "Designed data systems.",
                        }
                    ],
                    "gap": None,
                    "comparison_method": "literal-term overlap; potential evidence only",
                }
            ],
            "suitability_warnings": ["Automatic suitability gate: NEEDS_VERIFICATION."],
            "evidence_notice": "Potential matches are retrieval hints, not a suitability decision.",
        },
        "document_contact_ready": True,
        "missing_contact_fields": [],
        "requirements_extracted": True,
    }


def fake_api_request(method, path, params=None, body=None, timeout=30):
    st.session_state.setdefault("test_api_calls", []).append((method, path, body))
    if path.endswith("/candidate-profiles"):
        return {
            "schema_version": SCHEMA_VERSION,
            "ok": True,
            "profiles": [
                {"candidate_profile_id": CANDIDATE_ID, "display_name": "Candidate"}
            ],
        }
    if path.endswith("/fetch-description"):
        assert body["title"] == "Data Architect"
        assert body["company"] == "Example"
        return {
            "schema_version": SCHEMA_VERSION,
            "ok": True,
            "fetch_receipt_id": FETCH_RECEIPT_ID,
            "description": DESCRIPTION,
            "final_url": body["url"],
            "provider": "EMPLOYER_WEBSITE",
            "content_hash": hashlib.sha256(DESCRIPTION.encode()).hexdigest(),
            "source_evidence": {
                "requestedUrl": body["url"],
                "resolvedUrl": body["url"],
                "redirectHistory": [],
                "retrievedAt": "2026-10-28T00:00:00.000Z",
                "httpStatus": 200,
                "contentType": "text/html; charset=utf-8",
                "responseHash": "f" * 64,
            },
        }
    if path.endswith("/compare"):
        assert body["schema_version"] == SCHEMA_VERSION
        assert body["source_kind"] == "FETCHED"
        assert body["candidate_profile_id"] == CANDIDATE_ID
        assert body["fetch_receipt_id"] == FETCH_RECEIPT_ID
        source_content_status = (
            "COMPLETE" if body["description"] == DESCRIPTION.strip() else "USER_EDITED"
        )
        return _comparison_response(source_content_status)
    if path.endswith("/approve"):
        return {
            "schema_version": SCHEMA_VERSION,
            "ok": True,
            "approval_id": APPROVAL_ID,
            "approved": True,
            "comparison_fingerprint": FINGERPRINT,
        }
    if path.endswith("/documents"):
        artifacts = [
            _artifact(kind, format_name)
            for kind in ("CV", "COVER_LETTER")
            for format_name in ("DOCX", "PDF")
        ]
        return {
            "schema_version": SCHEMA_VERSION,
            "ok": True,
            "draft_id": DRAFT_ID,
            "approval_id": APPROVAL_ID,
            "comparison_fingerprint": FINGERPRINT,
            "preview": {
                "cv": "# Candidate\n- Designed data systems.",
                "cover_letter": "Dear team\n- Designed data systems.",
            },
            "artifacts": artifacts,
        }
    if "/documents/" in path:
        _, _, item_type, format_name = path.rsplit("/", 3)
        item_type = item_type.upper()
        format_name = format_name.upper()
        item = _artifact(item_type, format_name)
        content = _artifact_bytes(format_name)
        return {
            "schema_version": SCHEMA_VERSION,
            "ok": True,
            "filename": item["filename"],
            "mime_type": item["mime_type"],
            "sha256": hashlib.sha256(content).hexdigest(),
            "content_base64": base64.b64encode(content).decode("ascii"),
        }
    raise AssertionError(f"Unexpected API call: {method} {path}")


st.title("Manual Application Test")
render_manual_application_flow(fake_api_request)
