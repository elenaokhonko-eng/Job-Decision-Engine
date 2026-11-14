"""Tests for the "Record employer confirmation" form and its helpers."""

from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from streamlit_job_confirmations import (
    build_confirmed_fact_request,
    checks_from_response,
    conflict_line,
    confirmed_fact_line,
    is_safe_source_url,
    needs_employer_confirmation,
    open_check_labels,
)

FIXTURE_APP = Path(__file__).parent / "fixtures" / "streamlit_job_confirmations_app.py"
JOB_ID = "c1000000-0000-4000-8000-000000000001"
VERSION_ID = "c2000000-0000-4000-8000-000000000001"


def test_form_applies_to_verify_or_needs_verification_rows_with_identity():
    base = {"canonical_job_id": JOB_ID, "job_version_id": VERSION_ID}
    assert needs_employer_confirmation({**base, "decision_eligibility": "VERIFY"})
    assert needs_employer_confirmation({**base, "recommendation_eligibility": "VERIFY"})
    assert needs_employer_confirmation(
        {
            **base,
            "decision_eligibility": "ELIGIBLE",
            "readiness_status": "NEEDS_VERIFICATION",
        }
    )
    assert not needs_employer_confirmation(
        {**base, "decision_eligibility": "ELIGIBLE", "readiness_status": "READY"}
    )
    assert not needs_employer_confirmation(
        {"canonical_job_id": JOB_ID, "decision_eligibility": "VERIFY"}
    )


@pytest.mark.parametrize(
    ("fact_type", "inputs", "value"),
    [
        ("WORK_MODE", {"work_mode": "HYBRID"}, {"work_mode": "HYBRID"}),
        (
            "OFFICE_DAYS",
            {"office_days_min": 2, "office_days_max": 3},
            {"office_days_min": 2, "office_days_max": 3},
        ),
        ("TRAVEL_PCT", {"travel_pct_max": 15}, {"travel_pct_max": 15}),
        ("ON_CALL", {"on_call_required": False}, {"on_call_required": False}),
        (
            "EMPLOYMENT_TYPE",
            {"employment_type": "PERMANENT"},
            {"employment_type": "PERMANENT"},
        ),
        ("LOCATION", {"location": "  Singapore "}, {"location": "Singapore"}),
    ],
)
def test_request_body_matches_the_api_contract(fact_type, inputs, value):
    body, error = build_confirmed_fact_request(
        VERSION_ID,
        fact_type,
        inputs,
        "RECRUITER_EMAIL",
        " Confirmed by email ",
        "https://careers.example.test/role",
    )
    assert error is None
    assert body == {
        "job_version_id": VERSION_ID,
        "fact_type": fact_type,
        "value": value,
        "source_type": "RECRUITER_EMAIL",
        "source_note": "Confirmed by email",
        "source_url": "https://careers.example.test/role",
    }


@pytest.mark.parametrize(
    ("fact_type", "inputs", "source_type", "note", "url", "message"),
    [
        ("WORK_MODE", {"work_mode": "FLEX"}, "OTHER", "", "", "hybrid"),
        (
            "OFFICE_DAYS",
            {"office_days_min": 4, "office_days_max": 2},
            "OTHER",
            "",
            "",
            "minimum",
        ),
        ("TRAVEL_PCT", {"travel_pct_max": 150}, "OTHER", "", "", "percentage"),
        ("LOCATION", {"location": " "}, "OTHER", "", "", "location"),
        ("WORK_MODE", {"work_mode": "HYBRID"}, "LINKEDIN", "", "", "came from"),
        ("WORK_MODE", {"work_mode": "HYBRID"}, "OTHER", "x" * 501, "", "note"),
        (
            "WORK_MODE",
            {"work_mode": "HYBRID"},
            "OTHER",
            "",
            "javascript:alert(1)",
            "link",
        ),
        ("SALARY", {}, "OTHER", "", "", "fact"),
    ],
)
def test_invalid_input_is_reported_without_a_body(
    fact_type, inputs, source_type, note, url, message
):
    body, error = build_confirmed_fact_request(
        VERSION_ID, fact_type, inputs, source_type, note, url
    )
    assert body is None
    assert message in error


def test_source_url_validation():
    assert is_safe_source_url("https://careers.example.test/jobs?id=1")
    for url in (
        "javascript:alert(1)",
        "data:text/html,x",
        "https://user:pw@example.test/",
        "https://example.test/a b",
        "example.test/jobs",
    ):
        assert not is_safe_source_url(url), url


def test_display_lines_are_plain_text():
    fact = {
        "fact_type": "OFFICE_DAYS",
        "fact_value": {"office_days_min": 2, "office_days_max": 3},
        "source_type": "HIRING_MANAGER",
        "source_note": "line one\nline two",
        "recorded_at": "2026-11-09T08:00:00.000Z",
    }
    assert confirmed_fact_line(fact) == (
        "Office days per week: 2-3 days (source: Hiring manager, recorded 2026-11-09)"
        " - line one line two"
    )
    assert open_check_labels({"open_checks": ["WORK_MODE", "LOCATION"]}) == [
        "Work mode",
        "Location / territory",
    ]
    with pytest.raises(TypeError):
        checks_from_response({"ok": True, "checks": {"open_checks": "WORK_MODE"}})
    assert checks_from_response({"ok": True, "checks": None, "history": []}) is None


def _open_form(app):
    app.checkbox(key="confirm_fixture_open").check().run(timeout=20)
    assert not app.exception, [(e.type, e.message) for e in app.exception]
    return app


def test_form_is_closed_until_the_user_opens_it_and_loads_checks_once():
    app = AppTest.from_file(str(FIXTURE_APP)).run(timeout=20)
    assert not app.exception
    assert "api_calls" not in app.session_state

    _open_form(app)
    texts = [element.value for element in app.text]
    assert "Open checks: Work mode, Employment type" in texts
    assert any(
        text.startswith("- Travel (maximum %): up to 10% (source: Recruiter call")
        for text in texts
    )
    # Job-derived text is rendered with st.text, never as Markdown or HTML.
    assert not any("<script>" in block.value for block in app.markdown)
    assert any("<script>" in text for text in texts)
    # The fact type defaults to the first open check.
    assert app.selectbox(key="confirm_fixture_fact_type").value == "WORK_MODE"

    app.run(timeout=20)
    assert [call["method"] for call in app.session_state["api_calls"]] == ["GET"]


def test_submitting_a_confirmation_posts_the_contract_body():
    app = _open_form(AppTest.from_file(str(FIXTURE_APP)).run(timeout=20))
    app.selectbox(key="confirm_fixture_work_mode").set_value("HYBRID")
    app.selectbox(key="confirm_fixture_source_type").set_value("RECRUITER_CALL")
    app.text_input(key="confirm_fixture_note").input("Phone screen")
    app.button[0].click().run(timeout=20)
    assert not app.exception, [(e.type, e.message) for e in app.exception]

    posts = [
        call for call in app.session_state["api_calls"] if call["method"] == "POST"
    ]
    assert posts == [
        {
            "method": "POST",
            "path": f"/api/v2/jobs/{JOB_ID}/confirmed-facts",
            "body": {
                "job_version_id": VERSION_ID,
                "fact_type": "WORK_MODE",
                "value": {"work_mode": "HYBRID"},
                "source_type": "RECRUITER_CALL",
                "source_note": "Phone screen",
                "source_url": None,
            },
        }
    ]
    assert any("Confirmation saved" in success.value for success in app.success)


def test_invalid_link_and_api_failure_are_shown_and_nothing_is_reported_saved():
    app = _open_form(AppTest.from_file(str(FIXTURE_APP)).run(timeout=20))
    app.text_input(key="confirm_fixture_url").input("javascript:alert(1)")
    app.button[0].click().run(timeout=20)
    assert any("source link" in error.value for error in app.error)
    assert not [c for c in app.session_state["api_calls"] if c["method"] == "POST"]

    app.text_input(key="confirm_fixture_url").input("")
    app.session_state["post_error"] = (
        "API request failed with HTTP 409: JOB_VERSION_NOT_CURRENT"
    )
    app.button[0].click().run(timeout=20)
    assert any("was not saved" in error.value for error in app.error)
    assert not app.success


def test_form_needs_the_api_and_a_matching_job_version():
    app = AppTest.from_file(str(FIXTURE_APP))
    app.session_state["api_configured"] = False
    _open_form(app.run(timeout=20))
    assert any("npm run workspace" in info.value for info in app.info)
    assert "api_calls" not in app.session_state

    stale = AppTest.from_file(str(FIXTURE_APP))
    stale.session_state["job"] = {
        "canonical_job_id": JOB_ID,
        "job_version_id": "c2000000-0000-4000-8000-0000000000ff",
        "decision_eligibility": "VERIFY",
    }
    _open_form(stale.run(timeout=20))
    assert any("newer version" in warning.value for warning in stale.warning)
    assert not stale.button


def test_conflict_line_shows_both_sides_as_plain_text():
    line = conflict_line(
        {
            "fact_type": "WORK_MODE",
            "confirmed_value": {"work_mode": "ONSITE"},
            "confirmed_source_type": "HIRING_MANAGER",
            "posting_evidence": {
                "state": "STATED",
                "source": "DESCRIPTION",
                "summary": "work mode remote",
                "evidence": "This position is\nfully remote",
            },
        }
    )
    assert line == (
        "Conflict - Work mode: you recorded On-site (source: Hiring manager); "
        "the posting states work mode remote (posting description): "
        '"This position is fully remote". '
        "The posting wins; the confirmation is not applied."
    )


def test_form_lists_conflicts_and_assessments_without_markdown():
    app = _open_form(AppTest.from_file(str(FIXTURE_APP)).run(timeout=20))
    texts = [element.value for element in app.text]
    conflicts = [
        text for text in texts if text.startswith("Conflict - Employment type")
    ]
    assert len(conflicts) == 1
    assert "you recorded Permanent (source: Recruiter email)" in conflicts[0]
    assert (
        "the posting states contract employment (posting description)" in conflicts[0]
    )
    assert "<b>contract</b>" in conflicts[0]
    assert not any("<b>" in block.value for block in app.markdown)
    assert any("[fills a fact the posting does not state]" in text for text in texts)


def test_withdrawing_a_confirmation_posts_to_the_withdraw_route():
    app = _open_form(AppTest.from_file(str(FIXTURE_APP)).run(timeout=20))
    app.text_input(key="confirm_fixture_withdraw_reason").input("Wrong job")
    app.button[1].click().run(timeout=20)
    assert not app.exception, [(e.type, e.message) for e in app.exception]
    posts = [c for c in app.session_state["api_calls"] if c["method"] == "POST"]
    assert posts == [
        {
            "method": "POST",
            "path": f"/api/v2/jobs/{JOB_ID}/confirmed-facts/"
            "c3000000-0000-4000-8000-000000000001/withdraw",
            "body": {"job_version_id": VERSION_ID, "reason": "Wrong job"},
        }
    ]
    assert any("withdrawn" in success.value for success in app.success)
