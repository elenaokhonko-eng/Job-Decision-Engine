"""Streamlit controls for archive browsing, restoration, and preservation holds."""

from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime

import streamlit as st

ArchiveRestoreHandler = Callable[[Mapping[str, object], str], None]
ArchiveHoldHandler = Callable[[str, str, str, int], None]


def archive_age_basis_label(value: object) -> str:
    """Return a user-facing label for a persisted archive age basis.

    Args:
        value: The age-basis code persisted with the archive lifecycle state.

    Returns:
        A readable label, including the explicit unknown-publication disclosure.

    Example:
        archive_age_basis_label("OBSERVED_AGE_PUBLICATION_UNKNOWN")
    """
    labels = {
        "GENUINE_REPOST_DATE": "Genuine repost date",
        "AUTHORITATIVE_PUBLICATION_DATE": "Authoritative publication date",
        "OBSERVED_AGE_PUBLICATION_UNKNOWN": "Observed age; publication date unknown",
    }
    return labels.get(str(value), "Unknown age basis")


def format_archive_timestamp(value: object) -> str:
    """Format a timestamp without interpreting naive values as local time.

    Args:
        value: A PostgreSQL datetime or ISO-8601 timestamp string.

    Returns:
        A UTC timestamp for display, or ``Unknown`` when the value is invalid.

    Example:
        format_archive_timestamp("2026-10-01T12:00:00+00:00")
    """
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            return "Unknown"
    else:
        return "Unknown"
    if parsed.tzinfo is None:
        return "Unknown"
    return parsed.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")


def render_archive_jobs(
    rows: Sequence[Mapping[str, object]],
    on_restore: ArchiveRestoreHandler,
    *,
    restore_enabled: bool,
) -> None:
    """Render archived vacancy cards and invoke the restore handler on request.

    Args:
        rows: Validated rows from the workspace-scoped archive read model.
        on_restore: Callback receiving a selected row and an audit reason.
        restore_enabled: Whether the managed API is configured for mutations.

    Returns:
        None.

    Example:
        render_archive_jobs(rows, restore_job, restore_enabled=True)
    """
    if not rows:
        st.info("No archived jobs match this page.")
        return

    for row in rows:
        canonical_job_id = str(row.get("canonical_job_id", ""))
        title = str(row.get("title", "Untitled role"))
        company = str(row.get("company", "Unknown company"))
        with st.container(border=True):
            st.text(f"{title} at {company}")
            st.caption(f"Archived {format_archive_timestamp(row.get('archived_at'))}")
            st.text(f"Archive reason: {row.get('archive_reason') or 'Unknown'}")
            st.text(
                f"Age basis: {archive_age_basis_label(row.get('archive_age_basis'))}"
            )
            st.text(
                f"Reference date: {format_archive_timestamp(row.get('archive_reference_at'))}"
            )
            application_status = row.get("application_status")
            if application_status:
                st.text(f"Application history: {application_status}")
            active_hold_until = row.get("active_hold_until")
            if active_hold_until:
                st.text(
                    f"Preservation hold expires: {format_archive_timestamp(active_hold_until)}"
                )
            description = row.get("description")
            if isinstance(description, str) and description.strip():
                with st.expander("View preserved job description"):
                    st.text(description)
            reason = st.text_input(
                "Restore reason",
                value="User requested a fresh availability and readiness review.",
                key=f"archive_restore_reason_{canonical_job_id}",
                disabled=not restore_enabled,
            )
            if st.button(
                "Restore and reassess",
                key=f"archive_restore_{canonical_job_id}",
                disabled=not restore_enabled,
                icon=":material/restore:",
            ):
                on_restore(row, reason)


def render_archive_hold_form(
    on_create: ArchiveHoldHandler,
    *,
    enabled: bool,
) -> None:
    """Render a time-bounded preservation hold form for a canonical job.

    Args:
        on_create: Callback receiving job ID, reason, hold type, and expiration days.
        enabled: Whether the managed API is configured for mutations.

    Returns:
        None.

    Example:
        render_archive_hold_form(create_hold, enabled=True)
    """
    with st.expander("Protect a job from automatic archiving"):
        with st.form("job_archive_hold_form"):
            canonical_job_id = st.text_input(
                "Canonical job ID", key="archive_hold_job_id"
            )
            reason = st.text_input(
                "Why should this job be preserved?", key="archive_hold_reason"
            )
            hold_type = st.selectbox(
                "Hold purpose",
                options=["USER_PRESERVE", "AGENT2_PILOT"],
                key="archive_hold_type",
                format_func=lambda value: (
                    "Agent 2 pilot"
                    if value == "AGENT2_PILOT"
                    else "Preserve by request"
                ),
            )
            expires_in_days = st.number_input(
                "Hold duration in days",
                min_value=1,
                max_value=365,
                value=30,
                step=1,
                key="archive_hold_days",
            )
            submitted = st.form_submit_button(
                "Create preservation hold",
                key="archive_hold_submit",
                disabled=not enabled,
            )
        if submitted:
            if not canonical_job_id.strip() or not reason.strip():
                st.error("Enter a canonical job ID and a reason for the hold.")
                return
            on_create(
                canonical_job_id.strip(),
                reason.strip(),
                hold_type,
                int(expires_in_days),
            )
