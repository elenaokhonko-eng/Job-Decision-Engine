"""Status buckets, plain-language status help, and technical-error support actions.

The counts come from the canonical read models (``v_application_workspace_summary_scoped`` and
``v_job_status_bucket_counts_scoped``); the technical-error rows come from
``v_job_support_issues_scoped``. Actions go through the authenticated API
(``/api/v2/support-issues``), which only runs an action the row offers.
"""

from collections.abc import Callable, Mapping, Sequence

import streamlit as st

from streamlit_job_review import escape_markdown

ApiRequest = Callable[..., Mapping[str, object]]

API_SETUP_HINT = (
    "This needs the app's local API, which isn't running. Close the app and start it "
    "with `npm run workspace` from the project folder: it starts the API and the "
    "dashboard together."
)

# Sidebar: jobs that passed the gates but are not in Apply Now / Top 10 and not closed out.
IN_BETWEEN_BUCKETS = (
    ("review_awaiting_ai_count", "Review (awaiting AI)"),
    ("review_evaluated_not_ready_count", "Review (evaluated, not ready)"),
    ("track_count", "Track (below review threshold)"),
    ("needs_verification_count", "Needs verification"),
    ("skip_count", "Skip (decided not to apply)"),
    ("processing_count", "Processing"),
)
CLOSED_OUT_BUCKETS = (
    ("rejected_count", "Rejected"),
    ("unmatched_count", "Unmatched"),
    ("removed_count", "Removed"),
)

# Checked against src/policy/decisionPolicy.ts, src/pipeline/recommendationDecider.ts,
# src/pipeline/laneRouter.ts, src/pipeline/deterministicMatcher.ts and migration 112.
STATUS_DEFINITIONS = (
    (
        "Rejected",
        (
            "The job failed a hard workability gate (for example work mode, location or "
            "residency, employment type, office days or travel) — a deterministic check with "
            "stored reason codes. It is permanent for that posting version and the daily "
            "archive run archives it the day it is rejected (jobs you saved on LinkedIn or "
            "MyCareersFuture, or are applying to, are kept)."
        ),
    ),
    (
        "Unmatched",
        (
            "The job passed the hard gates, but either the role fits none of your target "
            "lanes, or the posting requires a qualification your profile does not show (a "
            "mandatory degree, certificate or years of experience)."
        ),
    ),
    (
        "Removed",
        "You removed or dismissed the job. Its record and history are kept.",
    ),
    (
        "Skip",
        (
            "A completed recommendation after the gates: not worth applying. Typical causes: "
            "readiness is blocked (the job is closed, or a workability fact such as the work "
            "mode is incompatible with your preferences), the salary is below your floor, no "
            "requirement matched your profile evidence, or the routing policy found no lane."
        ),
    ),
    (
        "Track",
        (
            "Some match, but the requirement score is below the 50% Review threshold — or the "
            "scores are incomplete, the salary needs checking, or the seniority is above your "
            "experience in that career track. Track jobs are not sent for AI evaluation."
        ),
    ),
    (
        "Review / Priority",
        (
            "Requirement score of at least 50% (Priority: at least 75%, with 55% coverage and "
            "70% evidence completeness, gates passed). These go to AI evaluation and can reach "
            "Apply Now / Top 10 once evaluated and ready. 'Awaiting AI' means not evaluated "
            "yet (each run has a bounded AI budget); 'evaluated, not ready' means a readiness "
            "check is still open."
        ),
    ),
    (
        "Needs verification",
        (
            "A workability fact (work mode, office days, location, travel, employment type) "
            "is unknown. Answer it or record what the employer told you; it is never "
            "turned into a rejection."
        ),
    ),
    (
        "Processing",
        (
            "Still moving through the pipeline (normalizing, gates, routing, matching) or "
            "waiting for a current match after something changed."
        ),
    ),
    (
        "Technical error",
        (
            "Something operational failed (for example the posting text could not be "
            "fetched). It is never a career decision; use the actions to resolve it."
        ),
    ),
)

ISSUE_CLASS_LABELS = {
    "DESCRIPTION_INCOMPLETE": "The posting's description is incomplete",
    "TASK_DEAD_LETTER": "A pipeline step failed after its automatic retries",
    "BLOCKED_DEPENDENCY": "A pipeline step is waiting on a missing prerequisite",
    "EVALUATION_FAILED": "AI evaluation failed after its automatic retries",
    "PROCESSING_ERROR": "Processing stopped with an error",
}
ACTION_LABELS = {
    "FETCH_DESCRIPTION": "Fetch full description",
    "PASTE_DESCRIPTION": "Paste description",
    "RETRY": "Retry",
    "DISMISS": "Dismiss (not interested)",
}
PASTE_MIN_CHARS = 200
FEEDBACK_KEY = "support_issue_feedback"


def bucket_metrics(
    counts: Mapping[str, object] | None,
    buckets: Sequence[tuple[str, str]],
) -> list[tuple[str, object]]:
    """Return (label, value) pairs; every value is 'Unavailable' when counts are missing."""
    if counts is None:
        return [(label, "Unavailable") for _field, label in buckets]
    return [(label, counts.get(field, "Unavailable")) for field, label in buckets]


def render_status_help() -> None:
    """A short expander with plain-language definitions of the statuses."""
    with st.sidebar.expander("What do these statuses mean?", expanded=False):
        for label, text in STATUS_DEFINITIONS:
            st.markdown(f"**{label}** — {text}")


def build_support_action_request(
    issue: Mapping[str, object],
    action: str,
    description: str | None = None,
) -> tuple[dict[str, object] | None, str | None]:
    """Build the POST body for one support action, or return a user-facing error."""
    if action not in (issue.get("available_actions") or ()):
        return (
            None,
            f"{ACTION_LABELS.get(action, action)} is not available for this issue.",
        )
    body: dict[str, object] = {
        "job_version_id": str(issue.get("job_version_id")),
        "issue_class": str(issue.get("issue_class")),
        "action": action,
    }
    if action == "PASTE_DESCRIPTION":
        text = (description or "").strip()
        if len(text) < PASTE_MIN_CHARS:
            return None, (
                f"Paste the full posting (at least {PASTE_MIN_CHARS} characters, "
                "including the responsibilities and requirements)."
            )
        body["description"] = text
    return body, None


def support_issue_job_count(
    issues: Sequence[Mapping[str, object]] | None,
) -> int | None:
    """Number of distinct jobs with an open technical error."""
    if issues is None:
        return None
    return len({str(issue.get("canonical_job_id")) for issue in issues})


def _run_action(
    api_request: ApiRequest,
    issue: Mapping[str, object],
    action: str,
    description: str | None = None,
) -> None:
    body, error = build_support_action_request(issue, action, description)
    if error:
        st.error(error)
        return
    path = f"/api/v2/support-issues/{issue.get('canonical_job_id')}/actions"
    try:
        response = api_request("POST", path, body=body, timeout=60)
    except (RuntimeError, OSError, ValueError) as exc:
        st.error(f"{ACTION_LABELS[action]} failed: {exc}")
        return
    st.session_state[FEEDBACK_KEY] = str(
        response.get("message") or f"{ACTION_LABELS[action]} recorded."
    )
    st.rerun()


def _render_issue(
    issue: Mapping[str, object],
    index: int,
    api_request: ApiRequest,
    api_configured: bool,
) -> None:
    key = f"support_{issue.get('canonical_job_id')}_{issue.get('issue_class')}_{index}"
    with st.container(border=True):
        st.markdown(
            f"**{escape_markdown(str(issue.get('title') or 'Untitled role'))}** — "
            f"{escape_markdown(str(issue.get('company') or 'Unknown company'))}"
        )
        issue_class = str(issue.get("issue_class"))
        st.caption(
            f"{ISSUE_CLASS_LABELS.get(issue_class, issue_class)} · "
            f"state {issue.get('processing_state')}"
        )
        detail = issue.get("issue_detail")
        if detail:
            st.text(str(detail)[:500])
        actions = [str(action) for action in issue.get("available_actions") or ()]
        if not api_configured:
            st.info(API_SETUP_HINT)
            return
        buttons = [action for action in actions if action != "PASTE_DESCRIPTION"]
        if buttons:
            columns = st.columns(len(buttons))
            for column, action in zip(columns, buttons):
                with column:
                    if st.button(ACTION_LABELS[action], key=f"{key}_{action}"):
                        _run_action(api_request, issue, action)
        if "PASTE_DESCRIPTION" in actions:
            with st.expander("Paste description", expanded=False):
                pasted = st.text_area(
                    "Full posting text (responsibilities and requirements)",
                    key=f"{key}_paste_text",
                    height=200,
                )
                if st.button("Save pasted description", key=f"{key}_paste_submit"):
                    _run_action(api_request, issue, "PASTE_DESCRIPTION", pasted)


def _run_retry_all(api_request: ApiRequest) -> None:
    try:
        result = api_request(
            "POST", "/api/v2/support-issues/retry-all", body={}, timeout=120
        )
    except (RuntimeError, OSError, ValueError) as exc:
        st.error(f"Retry all failed: {exc}")
        return
    st.session_state[FEEDBACK_KEY] = (
        f"Retried {result.get('retried', 0)} of {result.get('considered', 0)}; "
        f"{result.get('unchanged', 0)} needed no retry."
    )
    st.rerun()


def render_support_issues(
    issues: Sequence[Mapping[str, object]],
    api_request: ApiRequest,
    api_configured: bool,
) -> None:
    """List technical-error issues with the actions their class offers."""
    feedback = st.session_state.pop(FEEDBACK_KEY, None)
    if feedback:
        st.success(feedback)
    if not issues:
        st.info("No technical support items.")
        return
    retryable = [
        issue for issue in issues if "RETRY" in (issue.get("available_actions") or ())
    ]
    if (
        retryable
        and api_configured
        and st.button(
            f"Retry all retryable ({len(retryable)})", key="support_retry_all"
        )
    ):
        _run_retry_all(api_request)
    for index, issue in enumerate(issues[:100]):
        _render_issue(issue, index, api_request, api_configured)
