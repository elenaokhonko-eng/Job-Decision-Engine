"""AppTest coverage for the archived-job controls."""

from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest


def _archive_app_path() -> Path:
    return Path(__file__).parent / "fixtures" / "streamlit_archive_app.py"


def test_archive_card_renders_age_disclosure_and_calls_restore(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify the restore interaction and publication-date-unknown disclosure."""
    project_root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(project_root))
    app = AppTest.from_file(str(_archive_app_path())).run()

    assert not app.exception
    assert any(
        "Observed age; publication date unknown" in text.value for text in app.text
    )
    app.text_input(key="archive_restore_reason_job-1").set_value("Agent 2 pilot review")
    app.button(key="archive_restore_job-1").click().run()

    assert not app.exception
    assert app.session_state["restored_job_id"] == "job-1"
    assert app.session_state["restore_reason"] == "Agent 2 pilot review"


def test_archive_hold_form_submits_a_temporary_agent_pilot_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify a user can create a bounded hold for the selected pilot job."""
    project_root = Path(__file__).resolve().parents[2]
    monkeypatch.syspath_prepend(str(project_root))
    app = AppTest.from_file(str(_archive_app_path())).run()

    app.text_input(key="archive_hold_job_id").set_value(
        "12345678-1234-4234-8234-123456789abc"
    )
    app.text_input(key="archive_hold_reason").set_value("Selected live-job pilot")
    app.selectbox(key="archive_hold_type").select("AGENT2_PILOT")
    app.number_input(key="archive_hold_days").set_value(21)
    app.button(key="archive_hold_submit").click().run()

    assert not app.exception
    assert app.session_state["created_hold"] == (
        "12345678-1234-4234-8234-123456789abc",
        "Selected live-job pilot",
        "AGENT2_PILOT",
        21,
    )
