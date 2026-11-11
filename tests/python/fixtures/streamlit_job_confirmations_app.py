"""AppTest fixture for the employer-confirmation form with a fake API."""

import streamlit as st

import streamlit_job_confirmations

JOB = {
    "canonical_job_id": "c1000000-0000-4000-8000-000000000001",
    "job_version_id": "c2000000-0000-4000-8000-000000000001",
    "title": "Synthetic Data Engineer",
    "company": "Synthetic Fixture Co",
    "decision_eligibility": "VERIFY",
    "readiness_status": "NEEDS_VERIFICATION",
}

CHECKS = {
    "schema_version": "job_verification_checks_v1",
    "workspace_id": "c0000000-0000-4000-8000-000000000001",
    "canonical_job_id": JOB["canonical_job_id"],
    "job_version_id": JOB["job_version_id"],
    "gate_decision": "NEEDS_VERIFICATION",
    "gate_rejection_codes": ["GATE_UNKNOWN_WORK_MODE", "NEEDS_VERIFICATION"],
    "gate_evidence_quotes": ["Workplace model is unspecified"],
    "gate_workability_facts": {"office_days_max": None},
    "gate_decided_at": "2026-11-10T09:00:00.000Z",
    "open_checks": ["WORK_MODE", "EMPLOYMENT_TYPE"],
    "confirmed_facts": [
        {
            "confirmed_fact_id": "c3000000-0000-4000-8000-000000000001",
            "fact_type": "TRAVEL_PCT",
            "fact_value": {"travel_pct_max": 10},
            "source_type": "RECRUITER_CALL",
            "source_note": "**bold** <script>alert(1)</script> [link](javascript:alert(1))",
            "source_url": None,
            "supersedes_fact_id": None,
            "recorded_by_user_id": "c0000000-0000-4000-8000-000000000002",
            "recorded_at": "2026-11-09T08:00:00.000Z",
        }
    ],
    "confirmed_fact_history_count": 1,
    "rerun_pending": False,
}


def fake_api_request(method, path, params=None, body=None, timeout=30):
    """Record the call and answer like the v2 confirmed-facts routes."""
    calls = st.session_state.setdefault("api_calls", [])
    calls.append({"method": method, "path": path, "body": body})
    if method == "POST" and st.session_state.get("post_error"):
        raise RuntimeError(st.session_state["post_error"])
    if method == "GET":
        return {"ok": True, "checks": CHECKS, "history": CHECKS["confirmed_facts"]}
    return {
        "ok": True,
        "schema_version": "job_confirmed_fact_v1",
        "fact": {},
        "superseded_fact_id": None,
        "rerun": {
            "task_type": "APPLY_HARD_GATES",
            "task_id": "c4000000-0000-4000-8000-000000000001",
            "task_key": "APPLY_HARD_GATES:fixture",
            "inserted": True,
        },
    }


streamlit_job_confirmations.render_employer_confirmation(
    st.session_state.get("job", JOB),
    fake_api_request,
    "confirm_fixture",
    api_configured=st.session_state.get("api_configured", True),
)
