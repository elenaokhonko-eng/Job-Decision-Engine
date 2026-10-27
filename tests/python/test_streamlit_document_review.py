from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest


def test_document_review_checkbox_persists_without_session_state_widget_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    app_path = Path(__file__).parent / "fixtures" / "streamlit_document_review_app.py"
    app = AppTest.from_file(str(app_path)).run()

    assert not app.exception
    assert app.session_state.get("review_saved") is None
    app.checkbox[0].check().run()

    assert not app.exception
    assert app.session_state["review_saved"] is True
