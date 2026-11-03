"""Startup checks shared by Streamlit's hosted and local runtimes."""

import json
import ipaddress
import os
import subprocess
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def is_hosted_runtime(environment=None):
    env = os.environ if environment is None else environment
    mode = str(env.get("JDEC_RUNTIME_MODE", "")).strip().lower()
    if mode in {"local", "desktop", "development"}:
        return False
    if mode == "hosted":
        return True
    if any(
        str(env.get(key, "")).strip().lower() in {"1", "true", "yes"}
        for key in (
            "IS_STREAMLIT_CLOUD",
            "STREAMLIT_CLOUD",
            "JDEC_HOSTED_RUNTIME",
        )
    ):
        return True
    if str(env.get("STREAMLIT_SHARING_MODE", "")).strip():
        return True
    api_base = str(
        env.get("JDEC_API_BASE_URL") or env.get("API_BASE_URL") or ""
    ).strip()
    if api_base:
        host = (urlsplit(api_base).hostname or "").lower().rstrip(".")
        if host in {"localhost", "host.docker.internal"} or host.endswith(".local"):
            return False
        try:
            if (
                ipaddress.ip_address(host).is_private
                or ipaddress.ip_address(host).is_loopback
                or ipaddress.ip_address(host).is_link_local
            ):
                return False
        except ValueError:
            pass
        return True
    return False


def validate_hosted_api_configuration(base_url, token):
    base = str(base_url or "").strip().rstrip("/")
    parsed = urlsplit(base)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        raise RuntimeError("Hosted Streamlit requires a valid HTTPS JDEC_API_BASE_URL.")
    if parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError(
            "JDEC_API_BASE_URL must be the API origin without a path, query, or fragment."
        )
    if not str(token or "").strip():
        raise RuntimeError(
            "Hosted Streamlit requires JDEC_API_TOKEN for authenticated API access."
        )
    return base


def validate_api_health(payload):
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError(
            "Authenticated API health check returned an invalid response."
        )


def api_error_message(status, raw_body):
    """Prefer the API's own explanation over urllib's bare 'HTTP Error 409: Conflict'."""
    detail = str(raw_body or "").strip()
    try:
        payload = json.loads(detail)
    except ValueError:
        payload = None
    if isinstance(payload, dict):
        code = payload.get("code") or payload.get("error")
        message = payload.get("message") or payload.get("error")
        if message:
            prefix = (
                f"HTTP {status} {code}"
                if code and code != message
                else f"HTTP {status}"
            )
            return f"{prefix}: {message}"
    return f"HTTP {status}: {detail[:1000]}" if detail else f"HTTP {status}"


def open_api_json(request, timeout, opener=None):
    open_request = opener or urllib.request.urlopen
    try:
        with open_request(request, timeout=timeout) as response:
            if response.status == 204:
                return {}
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw_body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(api_error_message(error.code, raw_body)) from error


def ensure_hosted_api_ready(environment=None, opener=None):
    env = os.environ if environment is None else environment
    if not is_hosted_runtime(env):
        return False
    base = validate_hosted_api_configuration(
        env.get("JDEC_API_BASE_URL") or env.get("API_BASE_URL"),
        env.get("JDEC_API_TOKEN") or env.get("API_TOKEN"),
    )
    headers = {
        "Authorization": f"Bearer {(env.get('JDEC_API_TOKEN') or env.get('API_TOKEN')).strip()}",
        "X-Workspace-Key": str(
            env.get("WORKSPACE_KEY") or env.get("JDEC_WORKSPACE_KEY") or "default"
        ).strip(),
        "X-User-Key": str(
            env.get("WORKSPACE_USER_KEY") or env.get("USER_KEY") or "local_user"
        ).strip(),
        "Accept": "application/json",
    }
    request = urllib.request.Request(
        f"{base}/api/v2/health", headers=headers, method="GET"
    )
    open_request = opener or urllib.request.urlopen
    try:
        with open_request(request, timeout=10) as response:
            status = getattr(response, "status", 200)
            if status < 200 or status >= 300:
                raise RuntimeError(
                    f"Authenticated API health check returned HTTP {status}."
                )
            payload = json.loads(response.read().decode("utf-8"))
            validate_api_health(payload)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(
            f"Hosted Streamlit startup failed: authenticated API health check returned HTTP {error.code}: {detail}"
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise RuntimeError(
            f"Hosted Streamlit startup failed: authenticated API health check could not reach {base}/api/v2/health: {error}"
        ) from error
    return True


def code_version(environment=None, run=None, repo_dir=None):
    """Branch and short commit of the running code, for the sidebar, so a tester sees what they are testing.

    Uses JDE_CODE_VERSION or the Render deploy variables when set, otherwise asks git in the app's
    folder. Never raises: an unknown version must not stop the app from starting.
    """
    env = os.environ if environment is None else environment
    if env.get("JDE_CODE_VERSION"):
        return env["JDE_CODE_VERSION"]
    if env.get("RENDER_GIT_COMMIT"):
        branch = env.get("RENDER_GIT_BRANCH") or "unknown branch"
        return f"{branch} @ {env['RENDER_GIT_COMMIT'][:7]}"
    run_command = run or subprocess.run
    folder = repo_dir or os.path.dirname(os.path.abspath(__file__))

    def git(*args):
        result = run_command(
            ["git", *args],
            cwd=folder,
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        )
        return result.stdout.strip()

    try:
        branch = git("rev-parse", "--abbrev-ref", "HEAD")
        commit = git("rev-parse", "--short", "HEAD")
        dirty = bool(git("status", "--porcelain", "--untracked-files=no"))
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    label = "detached HEAD" if branch == "HEAD" else branch
    return f"{label} @ {commit}{' + local changes' if dirty else ''}"


DATABASE_UNAVAILABLE_CODE = "DATABASE_UNAVAILABLE"


def database_outage(api_url, api_get, probe_direct, database_url=""):
    """One message when the app's database cannot be used, else None.

    With an API configured, its workspace health check speaks for the database: only its
    DATABASE_UNAVAILABLE answer is an outage. An unreachable API is not, because the read-only
    fallback handles that. Without an API, a direct read-only connection is tried when
    DATABASE_URL is set. The message names the host, never the connection string.
    """
    if api_url:
        try:
            api_get("/api/v2/health")
        except RuntimeError as error:
            marker = f"{DATABASE_UNAVAILABLE_CODE}: "
            text = str(error)
            return text.split(marker, 1)[1] if marker in text else None
        return None
    if not database_url:
        return None
    try:
        probe_direct()
    except Exception as error:  # any driver failure means the database cannot be used
        host = urlsplit(database_url).hostname or "the configured host"
        lines = str(error).strip().splitlines()
        detail = lines[0][:240] if lines else type(error).__name__
        return (
            f"The database at {host} could not be used: {detail}. "
            "Check DATABASE_URL in .env.local, then restart both windows."
        )
    return None
