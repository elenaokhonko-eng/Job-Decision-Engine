"""AppTest fixture for status help and technical-error support actions with a fake API."""

import streamlit as st

import streamlit_job_status

WORKSPACE_ID = "d0000000-0000-4000-8000-000000000001"

ISSUES = [
    {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "d1000000-0000-4000-8000-000000000001",
        "job_version_id": "d2000000-0000-4000-8000-000000000001",
        "title": "Synthetic **solutions** architect",
        "company": "Synthetic Cloud Co",
        "processing_state": "PROCESSING_ERROR",
        "issue_class": "DESCRIPTION_INCOMPLETE",
        "issue_detail": "DESCRIPTION_CONTENT_INCOMPLETE: DESCRIPTION_HAS_INSUFFICIENT_SUBSTANTIVE_CONTENT",
        "task_ids": ["d3000000-0000-4000-8000-000000000001"],
        "available_actions": ["FETCH_DESCRIPTION", "PASTE_DESCRIPTION", "DISMISS"],
    },
    {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "d1000000-0000-4000-8000-000000000002",
        "job_version_id": "d2000000-0000-4000-8000-000000000002",
        "title": "Synthetic data engineer",
        "company": "Synthetic Data Co",
        "processing_state": "MATCHED",
        "issue_class": "TASK_DEAD_LETTER",
        "issue_detail": "Provider timeout",
        "task_ids": ["d3000000-0000-4000-8000-000000000002"],
        "available_actions": ["RETRY", "DISMISS"],
    },
]


def fake_api_request(method, path, params=None, body=None, timeout=30):
    """Record the call and answer like /api/v2/support-issues."""
    calls = st.session_state.setdefault("api_calls", [])
    calls.append({"method": method, "path": path, "body": body})
    if st.session_state.get("post_error"):
        raise RuntimeError(st.session_state["post_error"])
    if path.endswith("/retry-all"):
        return {
            "ok": True,
            "considered": 1,
            "retried": 1,
            "unchanged": 0,
            "results": [],
        }
    return {"ok": True, "outcome": "APPLIED", "message": f"Recorded {body['action']}."}


streamlit_job_status.render_status_help()
streamlit_job_status.render_support_issues(
    st.session_state.get("issues", ISSUES),
    fake_api_request,
    api_configured=st.session_state.get("api_configured", True),
)
