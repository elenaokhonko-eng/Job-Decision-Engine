"""Startup checks shared by Streamlit's hosted and local runtimes."""

import json
import ipaddress
import os
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
    if any(str(env.get(key, "")).strip().lower() in {"1", "true", "yes"} for key in (
        "IS_STREAMLIT_CLOUD", "STREAMLIT_CLOUD", "JDEC_HOSTED_RUNTIME",
    )):
        return True
    if str(env.get("STREAMLIT_SHARING_MODE", "")).strip():
        return True
    api_base = str(env.get("JDEC_API_BASE_URL") or env.get("API_BASE_URL") or "").strip()
    if api_base:
        host = (urlsplit(api_base).hostname or "").lower().rstrip(".")
        if host in {"localhost", "host.docker.internal"} or host.endswith(".local"):
            return False
        try:
            if ipaddress.ip_address(host).is_private or ipaddress.ip_address(host).is_loopback or ipaddress.ip_address(host).is_link_local:
                return False
        except ValueError:
            pass
        return True
    return False


def validate_hosted_api_configuration(base_url, token):
    base = str(base_url or "").strip().rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise RuntimeError("Hosted Streamlit requires a valid HTTPS JDEC_API_BASE_URL.")
    if parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError("JDEC_API_BASE_URL must be the API origin without a path, query, or fragment.")
    if not str(token or "").strip():
        raise RuntimeError("Hosted Streamlit requires JDEC_API_TOKEN for authenticated API access.")
    return base


def validate_api_health(payload):
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError("Authenticated API health check returned an invalid response.")


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
        "X-Workspace-Key": str(env.get("WORKSPACE_KEY") or env.get("JDEC_WORKSPACE_KEY") or "default").strip(),
        "X-User-Key": str(env.get("WORKSPACE_USER_KEY") or env.get("USER_KEY") or "local_user").strip(),
        "Accept": "application/json",
    }
    request = urllib.request.Request(f"{base}/api/v2/health", headers=headers, method="GET")
    open_request = opener or urllib.request.urlopen
    try:
        with open_request(request, timeout=10) as response:
            status = getattr(response, "status", 200)
            if status < 200 or status >= 300:
                raise RuntimeError(f"Authenticated API health check returned HTTP {status}.")
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
