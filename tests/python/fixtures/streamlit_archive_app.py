"""AppTest fixture for archive browsing, restoration, and hold creation."""

import streamlit as st

from streamlit_archive import render_archive_hold_form, render_archive_jobs

ARCHIVED_JOB = {
    "schema_version": "job_archive_v1",
    "workspace_id": "workspace-1",
    "canonical_job_id": "job-1",
    "job_version_id": "version-1",
    "title": "Archived data engineer",
    "company": "Example Corp",
    "canonical_url": None,
    "description": "A preserved description.",
    "source": "ATS",
    "location": "Singapore",
    "workplace_type": "REMOTE",
    "processing_state": "MATCHED",
    "recommendation_outcome": "TRACK",
    "archived_at": "2026-10-01T00:00:00Z",
    "archive_reason": "JOB_OLDER_THAN_THREE_CALENDAR_MONTHS",
    "archive_age_basis": "OBSERVED_AGE_PUBLICATION_UNKNOWN",
    "archive_reference_at": "2026-06-01T00:00:00Z",
    "application_status": "APPLIED",
    "active_hold_until": None,
}


def restore_job(row, reason):
    """Record a simulated restore action for the AppTest assertion."""
    st.session_state["restored_job_id"] = row["canonical_job_id"]
    st.session_state["restore_reason"] = reason


def create_hold(job_id, reason, hold_type, expires_in_days):
    """Record a simulated preservation hold for the AppTest assertion."""
    st.session_state["created_hold"] = (job_id, reason, hold_type, expires_in_days)


render_archive_jobs([ARCHIVED_JOB], restore_job, restore_enabled=True)
render_archive_hold_form(create_hold, enabled=True)
