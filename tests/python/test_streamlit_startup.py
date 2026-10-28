import importlib
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from streamlit_runtime import (
    is_hosted_runtime,
    validate_api_health,
    validate_hosted_api_configuration,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_streamlit_entrypoint_and_all_direct_helpers_import_together():
    for module_name in (
        "streamlit_application_workflow",
        "streamlit_database",
        "streamlit_formatters",
        "streamlit_workspace_contracts",
        "streamlit_manual_application",
    ):
        importlib.import_module(module_name)


def test_streamlit_startup_app_test_has_no_import_or_script_exception(monkeypatch):
    monkeypatch.setenv("JDEC_RUNTIME_MODE", "local")
    monkeypatch.setenv("JDEC_API_BASE_URL", "")
    monkeypatch.setenv("API_BASE_URL", "")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("WORKSPACE_KEY", "test-workspace")
    monkeypatch.setenv("WORKSPACE_USER_KEY", "test-user")

    app = AppTest.from_file(str(PROJECT_ROOT / "streamlit_app.py")).run(timeout=10)

    assert not app.exception, [(error.type, error.message) for error in app.exception]
    assert any(title.value for title in app.title)
    assert "Add job" in [tab.label for tab in app.tabs]


def test_hosted_runtime_requires_an_authenticated_reachable_api():
    assert is_hosted_runtime({"JDEC_RUNTIME_MODE": "hosted"})
    assert not is_hosted_runtime({"JDEC_RUNTIME_MODE": "local"})
    assert is_hosted_runtime(
        {"IS_STREAMLIT_CLOUD": "true", "JDEC_API_BASE_URL": "https://api.example.test"},
    )
    assert not is_hosted_runtime({"JDEC_API_BASE_URL": "http://127.0.0.1:8765"})
    assert is_hosted_runtime({"JDEC_API_BASE_URL": "https://api.example.test"})
    assert not is_hosted_runtime({})

    with pytest.raises(RuntimeError, match="JDEC_API_BASE_URL"):
        validate_hosted_api_configuration("", "token")
    with pytest.raises(RuntimeError, match="JDEC_API_TOKEN"):
        validate_hosted_api_configuration("https://api.example.test", "")
    with pytest.raises(RuntimeError, match="health check"):
        validate_api_health({"ok": False})

    assert (
        validate_hosted_api_configuration("https://api.example.test/", "token")
        == "https://api.example.test"
    )
    validate_api_health({"ok": True})
