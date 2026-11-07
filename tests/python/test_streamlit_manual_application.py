import base64
import hashlib
from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import docx
import pytest
from streamlit.testing.v1 import AppTest

from streamlit_manual_application import (
    _document_job_step_lines,
    _download_bytes,
    _validate_payload,
    extract_uploaded_description,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_manual_application_requires_comparison_then_explicit_approval_and_downloads():
    app = AppTest.from_file(
        str(PROJECT_ROOT / "tests/python/manual_application_fixture.py")
    ).run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]

    app.text_input(key="manual_job_url").set_value("https://example.test/job")
    app.text_input(key="manual_job_title").set_value("Data Architect")
    app.text_input(key="manual_job_company").set_value("Example")
    app.button(key="manual_fetch_description").click().run(timeout=10)
    assert (
        "fetched from the selected public posting"
        in app.text_area(key="manual_job_description").value
    )
    assert app.session_state["manual_job_source_kind"] == "FETCHED"
    assert not any(
        button.label == "Generate customised CV and cover letter"
        for button in app.button
    )

    app.button(key="manual_compare").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert any("NEEDS_VERIFICATION" in warning.value for warning in app.warning), (
        [error.value for error in app.error],
        app.session_state["test_api_calls"],
    )
    assert any(
        "Requirement, evidence and gap review" in header.value
        for header in app.markdown
    )
    assert not any(
        button.label == "Generate customised CV and cover letter"
        for button in app.button
    )

    fingerprint = app.session_state["manual_comparison"]["comparison_fingerprint"]
    # The fit check shows before approval, with each uncovered MUST requirement.
    assert any("Only 1 of 3 MUST" in warning.value for warning in app.warning)
    assert "No evidence: Operate Azure cloud infrastructure" in [
        text.value for text in app.text
    ]
    table = app.dataframe[0].value
    assert "confidence 0.90. Why: Designing data systems is the requirement." in str(
        table.iloc[0]["Potential profile evidence"]
    )
    app.checkbox(key=f"manual_approval_checked_{fingerprint}").check()
    app.button(key="manual_approve").click().run(timeout=10)
    # A poor fit needs an explicit acknowledgement before approval is recorded.
    assert any("Fewer than half" in error.value for error in app.error)
    assert "manual_approval" not in app.session_state
    app.checkbox(key=f"manual_poor_fit_acknowledged_{fingerprint}").check()
    app.button(key="manual_approve").click().run(timeout=10)
    assert any(
        "approval is recorded" in success.value.lower() for success in app.success
    )
    # Role choices are offered before generating; only changes from the default are sent.
    assert app.selectbox(key=f"manual_role_{fingerprint}_eng-major").value == "FULL"
    # A default from the profile is labelled as such.
    assert app.selectbox(key=f"manual_role_{fingerprint}_eng-lab").label.endswith(
        "your profile default"
    )
    app.selectbox(key=f"manual_role_{fingerprint}_eng-lab").set_value("HIDDEN").run(
        timeout=10
    )
    # Two MUST requirements lack evidence, so the candid gap note is offered, on by default.
    gap_note = app.checkbox(key=f"manual_gap_note_{fingerprint}")
    assert gap_note.value is True
    gap_note.uncheck().run(timeout=10)
    app.button(key="manual_generate").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    documents_call = next(
        call
        for call in app.session_state["test_api_calls"]
        if call[1].endswith("/documents")
    )
    assert documents_call[2]["role_layout"] == {"eng-lab": "HIDDEN"}
    assert documents_call[2]["include_gap_note"] is False
    texts = [text.value for text in app.text]
    assert "Gap note (left out): I do not yet hold AZ-305." in texts
    assert any(
        text.startswith("Opening: I am applying for the Data Architect role")
        for text in texts
    )
    # Documents are fixed per approval, so the choices lock once they exist.
    app.run(timeout=10)
    assert app.selectbox(key=f"manual_role_{fingerprint}_eng-lab").disabled
    assert app.checkbox(key=f"manual_gap_note_{fingerprint}").disabled
    assert {button.label for button in app.download_button} == {
        "Download CV (DOCX)",
        "Download CV (PDF)",
        "Download Cover Letter (DOCX)",
        "Download Cover Letter (PDF)",
    }
    assert app.text_area(key="manual_cv_preview").value.startswith("# Candidate")
    assert any("cover letter was written by AI" in info.value for info in app.info)
    # The summary fell back in this fixture: the screen says so and shows why.
    assert any("AI CV summary not used" in warning.value for warning in app.warning)
    shown = [text.value.strip() for text in app.text]
    assert "The AI-written summary was not used because it failed validation." in shown
    assert "1. I designed data systems for regulated teams." in shown
    assert "Source: Designed data systems." in shown
    assert len(app.session_state["test_api_calls"]) >= 7

    app.text_input(key="manual_job_title").set_value("Changed role title").run(
        timeout=10
    )
    assert not app.exception
    assert not any(
        button.label == "Generate customised CV and cover letter"
        for button in app.button
    )
    assert not app.download_button


def _compared_app():
    app = AppTest.from_file(
        str(PROJECT_ROOT / "tests/python/manual_application_fixture.py")
    ).run(timeout=10)
    app.text_input(key="manual_job_url").set_value("https://example.test/job")
    app.text_input(key="manual_job_title").set_value("Data Architect")
    app.text_input(key="manual_job_company").set_value("Example")
    app.button(key="manual_fetch_description").click().run(timeout=10)
    app.button(key="manual_compare").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    fingerprint = app.session_state["manual_comparison"]["comparison_fingerprint"]
    app.checkbox(key=f"manual_approval_checked_{fingerprint}").check()
    app.checkbox(key=f"manual_poor_fit_acknowledged_{fingerprint}").check()
    return app, fingerprint


def _calls(app, suffix):
    return [
        call for call in app.session_state["test_api_calls"] if call[1].endswith(suffix)
    ]


def test_review_corrections_are_sent_with_the_approval_and_a_failed_summary_can_be_retried():
    app, fingerprint = _compared_app()
    evidence_key = f"manual_review_evidence_{fingerprint}_R-001"
    evidence = app.multiselect(key=evidence_key)
    # The picker searches every selectable fact and shows its role and dates.
    assert any(
        "golden-record" in option and "Regional CRM Architect" in option
        for option in evidence.options
    )
    assert evidence.value == ["fact-1"]
    # Unchanged rows send no corrections.
    app.button(key="manual_approve").click().run(timeout=10)
    assert "corrections" not in _calls(app, "/approve")[-1][2]

    # Choose a different fact, then approve: the change travels with the approval.
    app.multiselect(key=evidence_key).set_value(["fact-2"]).run(timeout=10)
    assert any("Approve again" in warning.value for warning in app.warning)
    assert not any(button.key == "manual_generate" for button in app.button)
    app.button(key="manual_approve").click().run(timeout=10)
    assert _calls(app, "/approve")[-1][2]["corrections"] == [
        {"requirement_key": "R-001", "status": "ACCEPTED", "evidence_ids": ["fact-2"]}
    ]

    # Marking a row partly met asks for the candidate's own gap sentence.
    decision = app.selectbox(key=f"manual_review_decision_{fingerprint}_R-001")
    decision.set_value("PARTIAL").run(timeout=10)
    app.text_input(key=f"manual_review_gap_{fingerprint}_R-001").set_value(
        "I have led data governance, but not for vendor market data."
    ).run(timeout=10)
    app.button(key="manual_approve").click().run(timeout=10)
    assert _calls(app, "/approve")[-1][2]["corrections"] == [
        {
            "requirement_key": "R-001",
            "status": "PARTIAL",
            "evidence_ids": ["fact-2"],
            "gap_sentence": "I have led data governance, but not for vendor market data.",
        }
    ]

    app.button(key="manual_generate").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    # The summary fell back, so it can be retried: a new revision that keeps the AI letter.
    app.button(key="manual_retry_summary").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    retry_approval = _calls(app, "/approve")[-1][2]
    assert retry_approval["new_revision"] is True
    assert retry_approval["corrections"][0]["status"] == "PARTIAL"
    retry_documents = _calls(app, "/documents")[-1][2]
    assert retry_documents["reuse_cover_letter_from"] == retry_approval.get(
        "approval_id", app.session_state["manual_approval"]["approval_id"]
    )


def test_review_flags_risky_rows_collapses_optional_ones_and_reports_cv_length():
    app, fingerprint = _compared_app()
    # A flagged MUST row says why and starts as partly met; leaving it so sends nothing extra.
    assert any(
        "none of the proposed evidence" in warning.value for warning in app.warning
    )
    assert (
        app.selectbox(key=f"manual_review_decision_{fingerprint}_R-004").value
        == "PARTIAL"
    )
    assert [
        expander.label for expander in app.expander if "requirements" in expander.label
    ] == [
        "Check the MUST requirements (2)",
        "Optional requirements (1): suggested matches",
    ]
    app.button(key="manual_approve").click().run(timeout=10)
    assert "corrections" not in _calls(app, "/approve")[-1][2]

    # "Accept all suggested" puts every optional row back to its suggestion.
    optional = f"manual_review_decision_{fingerprint}_R-005"
    app.selectbox(key=optional).set_value("GAP").run(timeout=10)
    assert app.selectbox(key=optional).value == "GAP"
    app.button(key=f"manual_review_accept_optional_{fingerprint}").click().run(
        timeout=10
    )
    assert app.selectbox(key=optional).value == "ACCEPTED"

    # The requirement-matching section is opt-in, and a long CV is called out.
    app.button(key="manual_approve").click().run(timeout=10)
    app.checkbox(key=f"manual_match_section_{fingerprint}").check()
    app.button(key="manual_generate").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert _calls(app, "/documents")[-1][2]["include_match_section"] is True
    assert any("runs to 3 pages" in warning.value for warning in app.warning)


def test_fetched_source_edits_are_clearly_marked_for_user_review():
    app = AppTest.from_file(
        str(PROJECT_ROOT / "tests/python/manual_application_fixture.py")
    ).run(timeout=10)
    app.text_input(key="manual_job_url").set_value("https://example.test/job")
    app.text_input(key="manual_job_title").set_value("Data Architect")
    app.text_input(key="manual_job_company").set_value("Example")
    app.button(key="manual_fetch_description").click().run(timeout=10)
    app.text_area(key="manual_job_description").set_value(
        app.text_area(key="manual_job_description").value + " Reviewed manually."
    ).run(timeout=10)
    app.button(key="manual_compare").click().run(timeout=10)

    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert any("user-edited" in warning.value for warning in app.warning)
    assert any("not attested by that fetch" in warning.value for warning in app.warning)


PIPELINE_JOB = {
    "canonical_job_id": "11111111-1111-4111-8111-111111111111",
    "job_version_id": "22222222-2222-4222-8222-222222222222",
}


def _pipeline_job_app(failures=()):
    app = AppTest.from_file(
        str(PROJECT_ROOT / "tests/python/manual_application_fixture.py")
    )
    app.session_state["test_pipeline_job"] = PIPELINE_JOB
    app.session_state["test_compare_existing_failures"] = list(failures)
    return app.run(timeout=10)


def _compare_existing_calls(app):
    return [
        call
        for call in app.session_state["test_api_calls"]
        if call[1].endswith("/compare-existing")
    ]


def test_a_pipeline_job_opens_in_the_same_review_approve_and_generate_screens():
    app = _pipeline_job_app()
    app.button(key="test_pipeline_prepare_documents").click().run(timeout=10)

    assert not app.exception, [(error.type, error.message) for error in app.exception]
    selected = app.session_state["manual_comparison"]["selected_job"]
    assert selected["source"]["source_kind"] == "PIPELINE"
    assert any("Opened in the Add job tab" in item.value for item in app.success)
    assert any(
        "a job the pipeline found (GREENHOUSE)" in caption.value
        for caption in app.caption
    )
    assert any(
        "Requirement, evidence and gap review" in header.value
        for header in app.markdown
    )
    # The rest is the manual route unchanged: the approval checkbox for this comparison.
    fingerprint = app.session_state["manual_comparison"]["comparison_fingerprint"]
    assert app.checkbox(key=f"manual_approval_checked_{fingerprint}")
    assert len(_compare_existing_calls(app)) == 1


def test_a_concurrent_first_call_is_retried_once_automatically():
    app = _pipeline_job_app(
        [
            "HTTP 409 CONCURRENT_UPDATE: This job is already being prepared in another request."
        ]
    )
    app.button(key="test_pipeline_prepare_documents").click().run(timeout=10)

    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert len(_compare_existing_calls(app)) == 2
    assert (
        app.session_state["manual_comparison"]["selected_job"]["source"]["source_kind"]
        == "PIPELINE"
    )


def test_a_changed_or_thin_posting_version_is_final_and_not_offered_again():
    app = _pipeline_job_app(
        ["HTTP 422 DESCRIPTION_INSUFFICIENT: The job description looks incomplete."]
    )
    app.button(key="test_pipeline_prepare_documents").click().run(timeout=10)

    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert any(
        warning.value
        == "Documents can't be prepared for this posting version: The job description looks incomplete."
        for warning in app.warning
    )
    assert "manual_comparison" not in app.session_state
    app.run(timeout=10)
    assert not any(
        button.key == "test_pipeline_prepare_documents" for button in app.button
    )
    assert len(_compare_existing_calls(app)) == 1


def test_an_unavailable_dependency_leaves_the_button_for_another_try():
    app = _pipeline_job_app(
        [
            "HTTP 503 DEPENDENCY_UNAVAILABLE: Deterministic requirement extraction failed."
        ]
    )
    app.button(key="test_pipeline_prepare_documents").click().run(timeout=10)

    assert any("Try again." in error.value for error in app.error)
    assert len(_compare_existing_calls(app)) == 1
    app.button(key="test_pipeline_prepare_documents").click().run(timeout=10)
    assert (
        app.session_state["manual_comparison"]["selected_job"]["source"]["source_kind"]
        == "PIPELINE"
    )


def test_documents_are_linked_to_the_tracker_only_when_the_user_chooses_them():
    app, _ = _compared_app()
    app.button(key="manual_approve").click().run(timeout=10)
    app.button(key="manual_generate").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    # Generating links nothing.
    assert _calls(app, "/use-for-application") == []
    assert any("Nothing is recorded until you choose" in c.value for c in app.caption)

    approval_id = app.session_state["manual_generated_documents"]["approval_id"]
    app.button(key=f"manual_use_{approval_id}").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert len(_calls(app, "/use-for-application")) == 1
    assert any(
        "Its status stays INTENT: nothing was submitted or sent." in s.value
        for s in app.success
    )
    assert any("Added by you" in info.value for info in app.info)
    # Once linked, the choice is not offered again for the same documents.
    app.run(timeout=10)
    assert not any(button.key == f"manual_use_{approval_id}" for button in app.button)


def _tracker_app(choice):
    app = AppTest.from_file(
        str(PROJECT_ROOT / "tests/python/manual_application_fixture.py")
    )
    app.session_state["test_tracker_selection"] = choice
    return app.run(timeout=10)


def test_the_tracker_opens_exactly_the_documents_chosen_for_the_application():
    app = _tracker_app("CHOSEN")
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert {button.label for button in app.download_button} == {
        "Download CV (DOCX)",
        "Download CV (PDF)",
        "Download Cover letter (DOCX)",
        "Download Cover letter (PDF)",
    }
    downloads = [call[1] for call in app.session_state["test_api_calls"]]
    assert all(
        path.startswith(
            "/api/v2/application-drafts/selections/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/documents/"
        )
        for path in downloads
    )
    assert any("Added by you" in info.value for info in app.info)


def test_the_tracker_refuses_a_file_that_is_not_the_chosen_version():
    app = _tracker_app("TAMPERED")
    assert any(
        "CV (DOCX) is unavailable: The downloaded file is not the version chosen"
        in error.value
        for error in app.error
    )
    assert "Download CV (DOCX)" not in {b.label for b in app.download_button}


def test_the_tracker_says_when_no_documents_are_chosen_yet():
    app = _tracker_app(None)
    assert any("No documents chosen yet" in c.value for c in app.caption)
    assert not app.download_button


def test_manual_upload_reader_accepts_text_files_without_rewriting_content():
    class Uploaded:
        name = "role.txt"

        @staticmethod
        def getvalue():
            return b"Job title: Analyst\nBuild data models."

    assert (
        extract_uploaded_description(Uploaded())
        == "Job title: Analyst\nBuild data models."
    )


def test_manual_upload_reader_extracts_docx_paragraphs_and_tables():
    document = docx.Document()
    document.add_paragraph("Role summary")
    table = document.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Build data models"
    table.cell(0, 1).text = "Work with stakeholders"
    stream = BytesIO()
    document.save(stream)

    class Uploaded:
        name = "role.docx"

        @staticmethod
        def getvalue():
            return stream.getvalue()

    extracted = extract_uploaded_description(Uploaded())
    assert "Role summary" in extracted
    assert "Build data models\tWork with stakeholders" in extracted


def test_manual_upload_reader_rejects_oversized_expanded_docx():
    stream = BytesIO()
    with ZipFile(stream, "w", ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", "x" * 5_000_001)

    class Uploaded:
        name = "large.docx"

        @staticmethod
        def getvalue():
            return stream.getvalue()

    with pytest.raises(ValueError, match="expands beyond"):
        extract_uploaded_description(Uploaded())


def test_download_bytes_validates_contract_hash_and_file_signature():
    content = b"%PDF-1.4\nvalid test file\n%%EOF\n"
    artifact = {"type": "CV", "format": "PDF", "filename": "cv.pdf"}

    def api_request(method, path, timeout):
        assert method == "GET"
        assert path.endswith("/documents/cv/pdf")
        return {
            "schema_version": "manual_application_v1",
            "ok": True,
            "filename": "download.pdf",
            "mime_type": "application/pdf",
            "sha256": hashlib.sha256(content).hexdigest(),
            "content_base64": base64.b64encode(content).decode("ascii"),
        }

    assert _download_bytes(
        api_request, "11111111-1111-4111-8111-111111111111", artifact
    ) == (content, "download.pdf")

    def tampered_response(method, path, timeout):
        result = api_request(method, path, timeout)
        result["sha256"] = "0" * 64
        return result

    with pytest.raises(ValueError, match="SHA-256"):
        _download_bytes(
            tampered_response, "11111111-1111-4111-8111-111111111111", artifact
        )


def test_python_rejects_api_payloads_that_do_not_match_versioned_zod_contracts():
    with pytest.raises(ValueError, match="contract violation"):
        _validate_payload(
            "ManualApprovalResponse",
            {
                "schema_version": "manual_application_v1",
                "ok": True,
                "approval_id": "not-a-uuid",
                "approved": True,
                "comparison_fingerprint": "a" * 64,
            },
        )


def _approved_app():
    app, fingerprint = _compared_app()
    app.button(key="manual_approve").click().run(timeout=10)
    assert "manual_approval" in app.session_state
    return app, fingerprint


def test_generation_starts_a_job_then_polls_without_any_long_request():
    app, _ = _approved_app()
    app.button(key="manual_generate").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    # One start request, then status checks until the job finished; no request may wait 30 s+.
    job_calls = [
        (method, path, timeout)
        for method, path, timeout in app.session_state["test_api_timeouts"]
        if path.endswith("/documents") or "/document-jobs/" in path
    ]
    assert [method for method, _, _ in job_calls] == ["POST", "GET", "GET"]
    assert all(timeout <= 30 for _, _, timeout in job_calls)
    assert "manual_document_job" not in app.session_state
    assert app.session_state["manual_generated_documents"]["artifacts"]
    # The steps say what happened, including that the summary model was rate limited.
    steps = " ".join(caption.value for caption in app.caption)
    assert "AI CV summary: AI not used; built from your statements" in steps
    assert "rate limited (429)" in steps
    assert {button.label for button in app.download_button} == {
        "Download CV (DOCX)",
        "Download CV (PDF)",
        "Download Cover Letter (DOCX)",
        "Download Cover Letter (PDF)",
    }


def test_a_failed_generation_job_shows_the_api_error_message():
    app, _ = _approved_app()
    app.session_state["test_document_job_failure"] = {
        "code": "APPROVAL_STALE",
        "message": "Approved inputs changed while documents were being prepared.",
        "http_status": 409,
    }
    app.button(key="manual_generate").click().run(timeout=10)
    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert any(
        "APPROVAL_STALE: Approved inputs changed while documents were being prepared."
        in error.value
        for error in app.error
    )
    assert "manual_generated_documents" not in app.session_state
    assert "manual_document_job" not in app.session_state
    # The button is offered again so the candidate can retry.
    assert not app.button(key="manual_generate").disabled


def test_document_job_step_lines_describe_progress_without_model_text():
    job = {
        "steps": [
            {
                "step": "SUMMARY",
                "status": "COMPLETED",
                "elapsed_ms": 12000,
                "failure_kind": None,
            },
            {
                "step": "LETTER",
                "status": "FALLBACK",
                "elapsed_ms": 60000,
                "failure_kind": "TIMEOUT",
            },
            {
                "step": "FILES",
                "status": "RUNNING",
                "elapsed_ms": None,
                "failure_kind": None,
            },
        ]
    }
    assert _document_job_step_lines(job) == [
        "AI CV summary: done in 12 s",
        "AI cover letter: AI not used; built from your statements (the AI call ran out of time) in 60 s",
        "DOCX and PDF files: in progress",
    ]
