"""Tests for status buckets, the status help and the technical-error support actions."""

from pathlib import Path

from streamlit.testing.v1 import AppTest

from streamlit_job_status import (
    API_SETUP_HINT,
    CLOSED_OUT_BUCKETS,
    IN_BETWEEN_BUCKETS,
    STATUS_DEFINITIONS,
    bucket_metrics,
    build_support_action_request,
    support_issue_job_count,
)
from streamlit_workspace_contracts import STATUS_BUCKET_COUNT_FIELDS

FIXTURE_APP = Path(__file__).parent / "fixtures" / "streamlit_job_status_app.py"
REPO_ROOT = Path(__file__).resolve().parents[2]
ISSUE = {
    "canonical_job_id": "d1000000-0000-4000-8000-000000000001",
    "job_version_id": "d2000000-0000-4000-8000-000000000001",
    "issue_class": "DESCRIPTION_INCOMPLETE",
    "available_actions": ["FETCH_DESCRIPTION", "PASTE_DESCRIPTION", "DISMISS"],
}
FULL_POSTING = (
    "About the role: you will design data platforms. Responsibilities include building "
    "pipelines and reviewing models. Requirements: five years of experience with Python, "
    "SQL and cloud data services, plus strong written communication skills. "
) * 2


def _run_app(**state):
    app = AppTest.from_file(str(FIXTURE_APP))
    for key, value in state.items():
        app.session_state[key] = value
    return app.run()


def test_sidebar_buckets_cover_every_bucket_count_except_the_headline_ones():
    shown = {field for field, _label in IN_BETWEEN_BUCKETS + CLOSED_OUT_BUCKETS}
    headline = {"apply_now_count", "technical_error_count"}
    assert shown | headline == set(STATUS_BUCKET_COUNT_FIELDS)
    labels = [label for _field, label in IN_BETWEEN_BUCKETS]
    assert "Review (awaiting AI)" in labels
    assert "Track (below review threshold)" in labels
    assert "Needs verification" in labels


def test_bucket_metrics_report_unavailable_instead_of_zero():
    assert bucket_metrics(None, CLOSED_OUT_BUCKETS) == [
        ("Rejected", "Unavailable"),
        ("Unmatched", "Unavailable"),
        ("Removed", "Unavailable"),
    ]
    assert bucket_metrics(
        {"rejected_count": 3, "unmatched_count": 0, "removed_count": 2},
        CLOSED_OUT_BUCKETS,
    ) == [("Rejected", 3), ("Unmatched", 0), ("Removed", 2)]


def test_status_definitions_match_the_decision_policy_thresholds():
    text = dict(STATUS_DEFINITIONS)
    assert "50%" in text["Track"]
    assert "75%" in text["Review / Priority"]
    policy = (REPO_ROOT / "src" / "policy" / "decisionPolicy.ts").read_text(
        encoding="utf-8"
    )
    assert "{ op: 'gte', field: 'requirement_score', value: 0.5 }" in policy
    assert "{ op: 'gte', field: 'requirement_score', value: 0.75 }" in policy
    assert "{ op: 'gte', field: 'coverage_score', value: 0.55 }" in policy
    assert "{ op: 'gte', field: 'evidence_completeness', value: 0.7 }" in policy
    assert "lanes" in text["Unmatched"] and "qualification" in text["Unmatched"]
    assert "never" in text["Technical error"]


def test_action_request_bodies_follow_the_api_contract():
    body, error = build_support_action_request(ISSUE, "FETCH_DESCRIPTION")
    assert error is None
    assert body == {
        "job_version_id": ISSUE["job_version_id"],
        "issue_class": "DESCRIPTION_INCOMPLETE",
        "action": "FETCH_DESCRIPTION",
    }
    body, error = build_support_action_request(
        ISSUE, "PASTE_DESCRIPTION", f"  {FULL_POSTING}  "
    )
    assert error is None
    assert body["description"] == FULL_POSTING.strip()
    body, error = build_support_action_request(ISSUE, "PASTE_DESCRIPTION", "too short")
    assert body is None and "at least 200" in error
    body, error = build_support_action_request(ISSUE, "RETRY")
    assert body is None and "not available" in error


def test_support_issue_job_count_counts_jobs_not_issue_rows():
    assert support_issue_job_count(None) is None
    assert support_issue_job_count([]) == 0
    rows = [
        {"canonical_job_id": "a", "issue_class": "DESCRIPTION_INCOMPLETE"},
        {"canonical_job_id": "a", "issue_class": "TASK_DEAD_LETTER"},
        {"canonical_job_id": "b", "issue_class": "PROCESSING_ERROR"},
    ]
    assert support_issue_job_count(rows) == 2


def test_each_issue_gets_the_actions_of_its_class():
    app = _run_app()
    assert not app.exception
    labels = [button.label for button in app.button]
    assert labels.count("Fetch full description") == 1
    assert labels.count("Retry") == 1
    assert labels.count("Dismiss (not interested)") == 2
    assert "Retry all retryable (1)" in labels
    assert "Save pasted description" in labels
    help_text = " ".join(markdown.value for markdown in app.markdown)
    assert "**Rejected**" in help_text and "**Unmatched**" in help_text
    # Untrusted job text is escaped before it reaches Markdown.
    assert "Synthetic \\*\\*solutions\\*\\* architect" in help_text


def test_retry_posts_the_issue_identity_and_shows_the_api_message():
    app = _run_app()
    next(button for button in app.button if button.label == "Retry").click().run()
    assert not app.exception
    call = app.session_state["api_calls"][-1]
    assert call["method"] == "POST"
    assert (
        call["path"]
        == "/api/v2/support-issues/d1000000-0000-4000-8000-000000000002/actions"
    )
    assert call["body"] == {
        "job_version_id": "d2000000-0000-4000-8000-000000000002",
        "issue_class": "TASK_DEAD_LETTER",
        "action": "RETRY",
    }
    assert [success.value for success in app.success] == ["Recorded RETRY."]


def test_paste_description_sends_the_text_and_rejects_short_text_locally():
    app = _run_app()
    app.text_area[0].input("too short").run()
    next(
        button for button in app.button if button.label == "Save pasted description"
    ).click().run()
    assert "api_calls" not in app.session_state
    assert any("at least 200" in error.value for error in app.error)

    app.text_area[0].input(FULL_POSTING).run()
    next(
        button for button in app.button if button.label == "Save pasted description"
    ).click().run()
    call = app.session_state["api_calls"][-1]
    assert call["body"]["action"] == "PASTE_DESCRIPTION"
    assert call["body"]["description"] == FULL_POSTING.strip()


def test_retry_all_and_api_errors_are_reported():
    app = _run_app()
    next(
        button for button in app.button if button.label.startswith("Retry all")
    ).click().run()
    assert (
        app.session_state["api_calls"][-1]["path"] == "/api/v2/support-issues/retry-all"
    )
    assert [success.value for success in app.success] == [
        "Retried 1 of 1; 0 needed no retry."
    ]

    failing = _run_app(
        post_error="HTTP 409 ISSUE_NOT_OPEN: This issue is no longer open."
    )
    next(
        button
        for button in failing.button
        if button.label == "Dismiss (not interested)"
    ).click().run()
    assert any("ISSUE_NOT_OPEN" in error.value for error in failing.error)


def test_without_the_api_the_rows_point_to_npm_run_workspace():
    app = _run_app(api_configured=False)
    assert not app.exception
    assert not [button for button in app.button if button.label == "Retry"]
    assert any("npm run workspace" in info.value for info in app.info)
    assert "npm run workspace" in API_SETUP_HINT
    assert "JDEC_API_BASE_URL" not in API_SETUP_HINT


def test_no_issues_shows_an_empty_state():
    app = _run_app(issues=[])
    assert [info.value for info in app.info] == ["No technical support items."]
