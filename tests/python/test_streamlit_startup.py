import importlib
import io
import json
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from streamlit_runtime import (
    code_version,
    is_hosted_runtime,
    open_api_json,
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


def _http_error_opener(status, body):
    def opener(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url, status, "Conflict", {}, io.BytesIO(body.encode("utf-8"))
        )

    return opener


def test_api_errors_surface_the_api_explanation_not_the_bare_http_status():
    request = urllib.request.Request("http://127.0.0.1:3000/api/v2/application-drafts")
    manual_error = json.dumps(
        {
            "ok": False,
            "code": "JOB_VERSION_CHANGED",
            "error": "JOB_VERSION_CHANGED",
            "message": "The posting changed after comparison; compare it again.",
        }
    )
    with pytest.raises(RuntimeError) as raised:
        open_api_json(request, 5, opener=_http_error_opener(409, manual_error))
    assert str(raised.value) == (
        "HTTP 409 JOB_VERSION_CHANGED: The posting changed after comparison; compare it again."
    )
    assert isinstance(raised.value.__cause__, urllib.error.HTTPError)

    with pytest.raises(RuntimeError, match=r"^HTTP 400: job id is required$"):
        open_api_json(
            request,
            5,
            opener=_http_error_opener(
                400, '{"ok": false, "error": "job id is required"}'
            ),
        )
    with pytest.raises(RuntimeError, match=r"^HTTP 502: Bad gateway$"):
        open_api_json(request, 5, opener=_http_error_opener(502, "Bad gateway"))


def _fake_git(outputs):
    def run(args, **kwargs):
        key = " ".join(args[1:])
        if key not in outputs:
            raise subprocess.CalledProcessError(128, args)
        return subprocess.CompletedProcess(args, 0, stdout=f"{outputs[key]}\n")

    return run


def test_code_version_shows_branch_and_short_commit_from_git():
    run = _fake_git(
        {
            "rev-parse --abbrev-ref HEAD": "feat/manual-ai-cover-letter",
            "rev-parse --short HEAD": "72b496f",
            "status --porcelain --untracked-files=no": "",
        }
    )
    assert code_version({}, run=run) == "feat/manual-ai-cover-letter @ 72b496f"


def test_code_version_flags_detached_head_and_local_changes():
    run = _fake_git(
        {
            "rev-parse --abbrev-ref HEAD": "HEAD",
            "rev-parse --short HEAD": "3a9cb82",
            "status --porcelain --untracked-files=no": " M streamlit_app.py",
        }
    )
    assert code_version({}, run=run) == "detached HEAD @ 3a9cb82 + local changes"


def test_code_version_prefers_deploy_variables_and_never_raises():
    assert code_version({"JDE_CODE_VERSION": "release-7"}) == "release-7"
    assert (
        code_version(
            {"RENDER_GIT_BRANCH": "main", "RENDER_GIT_COMMIT": "abcdef1234567"}
        )
        == "main @ abcdef1"
    )
    assert code_version({}, run=_fake_git({})) == "unknown"

    def missing_git(args, **kwargs):
        raise FileNotFoundError("git")

    assert code_version({}, run=missing_git) == "unknown"
