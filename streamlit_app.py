import os
import sys
import subprocess
import urllib.request
import json
import html
import glob
import time
import datetime
import pandas as pd
import streamlit as st
import docx
from fpdf import FPDF
from io import BytesIO

# Load environment variables from Streamlit secrets, .env, and .env.local
def load_dotenv():
    # Load from Streamlit Cloud Secrets if available
    try:
        if hasattr(st, "secrets") and st.secrets:
            for key, val in st.secrets.items():
                if isinstance(val, str):
                    os.environ[key] = val
    except Exception:
        pass

    # Load from local .env and .env.local files
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for name in [".env", ".env.local"]:
        filename = os.path.join(script_dir, name)
        if os.path.exists(filename):
            with open(filename, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        key, val = line.split("=", 1)
                        val = val.strip("'\"")
                        os.environ[key.strip()] = val

load_dotenv()

def get_api_base_url():
    # Hosted Streamlit cannot reach a developer machine's localhost. An empty
    # value intentionally selects the read-only canonical PostgreSQL fallback
    # for reads; API-backed mutations still require an explicit managed URL.
    base = (os.environ.get("JDEC_API_BASE_URL") or os.environ.get("API_BASE_URL") or "").strip()
    return base.rstrip("/")

def get_api_token():
    return (os.environ.get("JDEC_API_TOKEN") or os.environ.get("API_TOKEN") or "").strip()

def get_workspace_user_key():
    return (os.environ.get("WORKSPACE_USER_KEY") or os.environ.get("USER_KEY") or "local_user").strip()


# The hosted Streamlit process is not the API process.  Keep the API as the
# preferred boundary, but allow read-only rendering from the canonical read
# models when the API is local-only, unavailable, or not separately deployed.
# This fallback never writes to PostgreSQL and never joins legacy job tables.
def _open_read_only_connection():
    database_url = (os.environ.get("DATABASE_URL") or "").strip()
    if not database_url:
        raise RuntimeError("DATABASE_URL is not configured for the read-only Streamlit fallback.")

    try:
        import psycopg2
    except ImportError as exc:
        raise RuntimeError("psycopg2-binary is required for the Streamlit read-only fallback.") from exc

    connection = psycopg2.connect(database_url, connect_timeout=10)
    connection.set_session(readonly=True, autocommit=True)
    return connection


def _read_model_workspace_id(connection):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT w.id
            FROM workspaces w
            JOIN workspace_memberships m ON m.workspace_id = w.id
            JOIN workspace_users u ON u.id = m.user_id
            WHERE w.workspace_key = %s
              AND u.user_key = %s
              AND m.status = 'ACTIVE'
            LIMIT 1
            """,
            (get_workspace_key(), get_workspace_user_key()),
        )
        row = cursor.fetchone()
    if not row:
        raise RuntimeError(
            f"No active database membership for workspace_key={get_workspace_key()} "
            f"and user_key={get_workspace_user_key()}"
        )
    return row[0]


def _read_model_query(query, params):
    try:
        from psycopg2.extras import RealDictCursor
    except ImportError as exc:
        raise RuntimeError("psycopg2-binary is required for the Streamlit read-only fallback.") from exc

    connection = _open_read_only_connection()
    try:
        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]
    finally:
        connection.close()


SHORTLIST_READ_MODEL_QUERY = """
    SELECT
      s.canonical_job_id,
      s.job_version_id,
      s.title,
      s.company,
      s.canonical_url,
      s.source,
      s.location,
      s.workplace_type,
      s.employment_type,
      s.description,
      s.gate_status,
      s.rejection_codes,
      s.gate_evidence_quotes,
      s.primary_lane,
      s.secondary_lanes,
      s.lane_confidence,
      s.priority_score,
      s.deterministic_match_score,
      s.deterministic_match_coverage,
      s.processing_state,
      s.processing_status,
      s.recommendation_eligibility,
      s.recommendation_outcome,
      s.recommendation_requirement_score,
      s.recommendation_coverage_score,
      s.recommendation_evidence_completeness,
      s.recommendation_decided_at,
      s.nd_friendly_score,
      s.politics_stress_score,
      s.sensory_overload_index,
      s.next_action,
      s.strategic_value,
      s.recommended_cv_version,
      s.evaluation_summary,
      s.eval_provider,
      s.eval_is_fallback,
      s.version_mismatch,
      s.observed_at,
      s.evaluated_at,
      s.lane_matches,
      s.workability_facts,
      s.queue_status,
      s.latest_match_run_id,
      s.cv_document_run_id,
      s.cover_letter_document_run_id,
      s.document_ready,
      s.current_artifact_status,
      s.current_artifact_reason,
      s.blocked_task_count
    FROM v_canonical_shortlist_scoped s
    WHERE s.workspace_id = %s
    ORDER BY s.observed_at DESC NULLS LAST, s.canonical_job_id DESC
    LIMIT %s
"""

REJECTED_READ_MODEL_QUERY = """
    SELECT
      a.id AS canonical_job_id,
      a.job_version_id,
      a.title,
      a.company,
      a.careers_portal_url AS canonical_url,
      a.source,
      a.status AS processing_state,
      a.rejection_reason,
      a.gate_status,
      a.rejection_codes,
      a.gate_evidence_quotes,
      a.description,
      a.nd_friendly_score,
      a.politics_stress_score,
      a.sensory_overload_index,
      a."postedDate"::timestamptz AS observed_at
    FROM v_rejected_jobs_audit_scoped a
    WHERE a.workspace_id = %s
    ORDER BY observed_at DESC NULLS LAST, a.id DESC
    LIMIT %s
"""


def fetch_jobs_from_postgres_read_model():
    workspace_connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(workspace_connection)
    finally:
        workspace_connection.close()
    return _read_model_query(SHORTLIST_READ_MODEL_QUERY, (workspace_id, 5000))


def fetch_rejected_jobs_from_postgres_read_model():
    workspace_connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(workspace_connection)
    finally:
        workspace_connection.close()
    return _read_model_query(REJECTED_READ_MODEL_QUERY, (workspace_id, 200))

def api_request(method, path, params=None, body=None, timeout=30):
    import urllib.parse

    base = get_api_base_url()
    if not base:
        raise RuntimeError(
            "Managed API base URL is not configured. Set JDEC_API_BASE_URL for API operations."
        )
    url = f"{base}{path}"
    if params:
        query = urllib.parse.urlencode(params)
        url = f"{url}?{query}"

    headers = {"Content-Type": "application/json"}
    token = get_api_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    headers["X-Workspace-Key"] = get_workspace_key()
    headers["X-User-Key"] = get_workspace_user_key()

    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        if response.status == 204:
            return {}
        raw = response.read().decode("utf-8")
        return json.loads(raw) if raw else {}

def default_accessibility_settings():
    return {
        "quiet_mode": False,
        "reduced_motion": False,
        "high_contrast": False,
        "density": "comfortable",
        "font_scale": 1.0,
        "show_emojis": True,
    }

def fetch_accessibility_settings():
    resp = api_request("GET", "/api/v2/accessibility", timeout=15)
    if isinstance(resp, dict) and resp.get("ok"):
        settings = resp.get("settings") or {}
        merged = dict(default_accessibility_settings())
        merged.update(settings if isinstance(settings, dict) else {})
        return merged
    return default_accessibility_settings()

def update_accessibility_settings(patch):
    resp = api_request("PUT", "/api/v2/accessibility", body=patch, timeout=15)
    if isinstance(resp, dict) and resp.get("ok"):
        return resp.get("settings") or {}
    raise Exception(resp.get("error") if isinstance(resp, dict) else "Unknown API error")

def fetch_preference_modes():
    resp = api_request("GET", "/api/v2/preference-modes", timeout=20)
    if isinstance(resp, dict) and resp.get("ok"):
        modes = resp.get("modes") or []
        return modes if isinstance(modes, list) else []
    return []

def create_preference_mode(mode_key, display_name, description, content):
    body = {
        "mode_key": mode_key,
        "display_name": display_name,
        "description": description,
        "content": content,
    }
    resp = api_request("POST", "/api/v2/preference-modes", body=body, timeout=20)
    if isinstance(resp, dict) and resp.get("ok"):
        return resp.get("mode") or {}
    raise Exception(resp.get("error") if isinstance(resp, dict) else "Unknown API error")

def preview_preference_mode(content):
    resp = api_request("POST", "/api/v2/preference-modes/preview", body={"content": content}, timeout=20)
    if isinstance(resp, dict) and resp.get("ok"):
        return resp.get("policy") or {}
    raise Exception(resp.get("error") if isinstance(resp, dict) else "Unknown API error")

def activate_preference_mode(mode_key):
    resp = api_request("POST", "/api/v2/preference-modes/activate", body={"mode_key": mode_key}, timeout=20)
    if isinstance(resp, dict) and resp.get("ok"):
        return resp.get("mode") or {}
    raise Exception(resp.get("error") if isinstance(resp, dict) else "Unknown API error")

def escape_text(value):
    return html.escape(str(value if value is not None else ""))

def safe_http_url(value):
    url = str(value or "").strip()
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return None

def normalize_workability_facts(raw):
    if not isinstance(raw, dict):
        return {
            "office_days_min": None,
            "office_days_max": None,
            "travel_pct_max": None,
            "employment_type": "UNKNOWN",
            "location_restriction": None,
        }

    # Canonical gate facts shape
    if "office_days_max" in raw or "employment_type" in raw:
        return {
            "office_days_min": raw.get("office_days_min"),
            "office_days_max": raw.get("office_days_max"),
            "travel_pct_max": raw.get("travel_pct_max"),
            "employment_type": raw.get("employment_type") or "UNKNOWN",
            "location_restriction": raw.get("location_restriction"),
        }

    # Legacy evaluation-request shape
    office_days = raw.get("officeDays")
    travel_pct = raw.get("travelPercentage")
    is_contract = raw.get("isContract")
    location_elig = raw.get("locationEligibility")
    return {
        "office_days_min": office_days if isinstance(office_days, int) else None,
        "office_days_max": office_days if isinstance(office_days, int) else None,
        "travel_pct_max": travel_pct if isinstance(travel_pct, (int, float)) else None,
        "employment_type": "CONTRACT" if is_contract is True else "UNKNOWN",
        "location_restriction": None if location_elig in ("PASS", "UNKNOWN", None) else "RESTRICTED",
    }

def derive_deterministic_recommendation(job):
    # The backend decision is authoritative. Streamlit must not recompute a
    # recommendation from stale score columns or turn missing artifacts into a
    # recommendation.
    artifact_status = str(job.get("current_artifact_status") or "CURRENTNESS_UNKNOWN")
    if artifact_status != "CURRENT_OR_NOT_APPLICABLE":
        return "VERIFY", "TRACK", None, None, job.get("recommendation_evidence_completeness")

    eligibility = job.get("recommendation_eligibility")
    outcome = job.get("recommendation_outcome")
    if eligibility not in ("ELIGIBLE", "VERIFY", "INELIGIBLE"):
        gate_status = job.get("gate_status")
        eligibility = "ELIGIBLE" if gate_status == "PASS" else "VERIFY" if gate_status == "NEEDS_VERIFICATION" else "INELIGIBLE"
    if outcome not in ("PRIORITY", "REVIEW", "TRACK", "SKIP"):
        outcome = "SKIP" if eligibility == "INELIGIBLE" else "TRACK"

    return (
        eligibility,
        outcome,
        job.get("recommendation_requirement_score"),
        job.get("recommendation_coverage_score"),
        job.get("recommendation_evidence_completeness"),
    )


# Configure the page setting with modern style
st.set_page_config(
    page_title="Job Decision Engine - High-Autonomy Career Architect",
    page_icon="💼",
    layout="wide",
    initial_sidebar_state="expanded"
)

# Custom dark-theme styling for professional visual aesthetics
st.markdown("""
<style>
    .reportview-container {
        background-color: #0F0F0F;
    }
    .metric-card {
        background-color: #161616;
        border: 1px solid #2A2A2A;
        padding: 15px;
        border-radius: 10px;
        text-align: center;
    }
    .title-accent {
        color: #D4AF37;
        font-family: 'serif';
    }
    .disclaimer {
        font-family: monospace;
        font-size: 11px;
        color: #888888;
    }
    .top-rec-card {
        background-color: #1a1a24;
        color: #e0e0e0;
        border-left: 5px solid #22c55e;
        padding: 15px;
        margin-bottom: 12px;
        border-radius: 6px;
    }
    .top-rec-card h4 {
        color: #ffffff;
        margin-top: 0;
        margin-bottom: 8px;
    }
    .top-rec-card p {
        color: #cccccc;
        margin-bottom: 4px;
        font-size: 14px;
    }
</style>
""", unsafe_allow_html=True)

# Workspace config (Streamlit uses /api/v2; no direct DB connections)
def get_workspace_key():
    return (os.environ.get("WORKSPACE_KEY") or "default").strip()

def run_checked_command(command_args, step_label):
    """Run a local command safely and surface stdout/stderr to the UI."""
    result = subprocess.run(
        command_args,
        capture_output=True,
        text=True,
        check=True,
        shell=False,
        env=os.environ,
    )
    if result.stdout:
        st.code(result.stdout, language="text")
    if result.stderr:
        st.warning(f"{step_label} stderr:\n{result.stderr}")
    return result

def show_generated_document_downloads(started_at, key_prefix):
    """Offer files created by the just-completed local document command."""
    export_paths = sorted(
        glob.glob(os.path.join("scripts", "exports", "*")),
        key=os.path.getmtime,
        reverse=True,
    )
    generated = [p for p in export_paths if os.path.isfile(p) and os.path.getmtime(p) >= started_at]
    if not generated:
        st.info("No local artifacts were created. In hosted mode, retrieve workflow artifacts from GitHub Actions.")
        return

    st.markdown("### Download generated artifacts")
    for index, artifact_path in enumerate(generated):
        with open(artifact_path, "rb") as artifact:
            st.download_button(
                label=f"Download {os.path.basename(artifact_path)}",
                data=artifact.read(),
                file_name=os.path.basename(artifact_path),
                key=f"{key_prefix}_{index}",
            )

def validate_shortlist_row_shape(row):
    required = [
        "canonical_job_id",
        "job_version_id",
        "title",
        "company",
        "canonical_url",
        "source",
        "location",
        "workplace_type",
        "processing_state",
        "observed_at",
    ]
    missing = [key for key in required if row.get(key) is None]
    if missing:
        return False, f"Missing required fields: {', '.join(missing)}"

    gate = row.get("gate_status")
    if gate not in ("PASS", "NEEDS_VERIFICATION", "HARD_REJECT"):
        return False, f"Invalid gate_status: {gate}"

    return True, "OK"

def fetch_jobs_from_db():
    """
    Fetch the canonical shortlist via /api/v2 (cursor-paginated), with a
    read-only PostgreSQL read-model fallback for hosted Streamlit deployments
    that do not have a reachable API process.
    """
    try:
        all_rows = []
        cursor = None
        pages = 0

        while True:
            pages += 1
            params = {"limit": 500}
            if cursor:
                params["cursor"] = cursor

            resp = api_request("GET", "/api/v2/shortlist", params=params, timeout=60)
            rows = resp.get("jobs") or []
            if not isinstance(rows, list):
                raise Exception("API returned invalid shortlist payload (jobs is not a list).")

            all_rows.extend(rows)
            cursor = resp.get("next_cursor")

            if not cursor:
                break
            if pages >= 20:
                st.warning("Shortlist pagination stopped after 20 pages to avoid excessive load.")
                break

        valid_rows = []
        invalid_count = 0
        for row in all_rows:
            row_dict = dict(row) if isinstance(row, dict) else {}
            ok, reason = validate_shortlist_row_shape(row_dict) if row_dict else (False, "Row is not a JSON object")
            if ok:
                valid_rows.append(row_dict)
            else:
                invalid_count += 1
                st.warning(f"Dropped invalid shortlist row from read model: {reason}")

        if invalid_count > 0:
            st.warning(f"Filtered out {invalid_count} invalid shortlist rows due to schema mismatch.")

        return valid_rows
    except Exception as api_error:
        try:
            fallback_rows = fetch_jobs_from_postgres_read_model()
            valid_rows = []
            invalid_count = 0
            for row in fallback_rows:
                row_dict = dict(row) if isinstance(row, dict) else {}
                ok, reason = validate_shortlist_row_shape(row_dict) if row_dict else (False, "Row is not a JSON object")
                if ok:
                    valid_rows.append(row_dict)
                else:
                    invalid_count += 1
                    st.warning(f"Dropped invalid PostgreSQL read-model row: {reason}")
            if invalid_count > 0:
                st.warning(f"Filtered out {invalid_count} invalid PostgreSQL read-model rows.")
            st.warning(
                "API unavailable; displaying the canonical PostgreSQL read model in read-only mode. "
                f"API error: {api_error}"
            )
            return valid_rows
        except Exception as fallback_error:
            st.error(
                "Failed to fetch the canonical shortlist from both the API and PostgreSQL read model. "
                f"API error: {api_error}; read-model error: {fallback_error}"
            )
            return []

def fetch_rejected_jobs_from_db():
    """Fetch rejected jobs from the API, with a read-only view fallback."""
    try:
        resp = api_request("GET", "/api/v2/rejected", params={"limit": 50}, timeout=60)
        rows = resp.get("jobs") or []
        if not isinstance(rows, list):
            raise Exception("API returned invalid rejected-jobs payload (jobs is not a list).")
        return [dict(r) for r in rows if isinstance(r, dict)]
    except Exception as api_error:
        try:
            rows = fetch_rejected_jobs_from_postgres_read_model()
            st.warning(
                "Rejected-job API unavailable; displaying the canonical PostgreSQL audit read model. "
                f"API error: {api_error}"
            )
            return [dict(row) for row in rows if isinstance(row, dict)]
        except Exception as fallback_error:
            st.error(
                "Failed to fetch rejected jobs from both the API and PostgreSQL read model. "
                f"API error: {api_error}; read-model error: {fallback_error}"
            )
            return []

def delete_job_from_db(job_id):
    """Soft-delete a canonical job by marking it MANUALLY_REMOVED (via /api/v2)."""
    try:
        resp = api_request("DELETE", f"/api/v2/jobs/{job_id}", timeout=30)
        if resp.get("ok") and resp.get("updated"):
            st.success("Listing removed successfully (soft-delete — record preserved for audit).")
            return True
        if resp.get("ok") and not resp.get("updated"):
            st.warning("Job was not updated (not found or already removed).")
            return False
        st.error(f"Failed to remove job (unexpected API response): {resp}")
        return False
    except Exception as e:
        st.error(f"Failed to remove job: {e}")
        return False

def save_new_job_to_db(job):
    """Stage a manually-added job via /api/v2 so it enters the canonical pipeline."""
    try:
        body = {
            "title": job.get("title"),
            "company": job.get("company"),
            "source": job.get("source") or "MANUAL_STREAMLIT",
            "description": job.get("description"),
            "salaryRange": job.get("salaryRange"),
            "location": job.get("location"),
            "careers_portal_url": job.get("careers_portal_url"),
        }
        resp = api_request("POST", "/api/v2/observations/manual", body=body, timeout=60)
        if resp.get("ok") and resp.get("inserted"):
            st.success("✅ Job staged successfully. It will be normalized, gated, and evaluated in the next run.")
            return True
        if resp.get("ok") and not resp.get("inserted"):
            st.warning("Job was already staged previously (duplicate raw payload).")
            return True
        st.error(f"Failed to stage job (unexpected API response): {resp}")
        return False
    except Exception as e:
        st.error(f"Failed to save job: {e}")
        return False

def convert_markdown_to_docx(md_text):
    doc = docx.Document()
    for line in md_text.split("\n"):
        line = line.strip()
        if not line:
            doc.add_paragraph()
            continue
        if line.startswith("# "):
            doc.add_heading(line[2:], level=1)
        elif line.startswith("## "):
            doc.add_heading(line[3:], level=2)
        elif line.startswith("### "):
            doc.add_heading(line[4:], level=3)
        elif line.startswith("* ") or line.startswith("- "):
            p = doc.add_paragraph(style='List Bullet')
            text = line[2:]
            parts = text.split("**")
            for idx, part in enumerate(parts):
                run = p.add_run(part)
                if idx % 2 == 1:
                    run.bold = True
        else:
            p = doc.add_paragraph()
            parts = line.split("**")
            for idx, part in enumerate(parts):
                run = p.add_run(part)
                if idx % 2 == 1:
                    run.bold = True
    bio = BytesIO()
    doc.save(bio)
    return bio.getvalue()

class PDFResume(FPDF):
    def header(self):
        pass
    def footer(self):
        # Removed page numbers for ATS compatibility
        pass

def convert_markdown_to_pdf(md_text):
    # Sanitize Unicode characters that helvetica (latin-1) cannot encode
    replacements = {
        '\u2013': '-', '\u2014': '-', '\u2018': "'", '\u2019': "'", 
        '\u201c': '"', '\u201d': '"', '\u2022': '*', '\u00A0': ' ',
        '\u2026': '...'
    }
    for k, v in replacements.items():
        md_text = md_text.replace(k, v)
    # Strip any remaining non-latin1 characters
    md_text = md_text.encode('latin-1', 'ignore').decode('latin-1')
    
    import re
    # Break extremely long words/URLs that crash FPDF multi_cell (40 chars to be ultra safe)
    md_text = re.sub(r'(\S{40})', r'\1 ', md_text)
    
    pdf = PDFResume()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_font("helvetica", size=10)
    
    for line in md_text.split("\n"):
        line = line.strip()
        if not line:
            pdf.ln(4)
            continue
            
        try:
            # Force cursor to left margin to prevent 'Not enough horizontal space' errors
            pdf.set_x(pdf.l_margin)
            if line.startswith("# "):
                pdf.set_font("helvetica", "B", 16)
                pdf.multi_cell(0, 10, line[2:])
                pdf.ln(2)
            elif line.startswith("## "):
                pdf.set_font("helvetica", "B", 13)
                pdf.multi_cell(0, 8, line[3:])
                pdf.ln(1)
            elif line.startswith("### "):
                pdf.set_font("helvetica", "B", 11)
                pdf.multi_cell(0, 6, line[4:])
                pdf.ln(1)
            elif line.startswith("* ") or line.startswith("- "):
                pdf.set_font("helvetica", "", 10)
                text = line[2:]
                text_clean = text.replace("**", "")
                pdf.multi_cell(0, 5, f"-  {text_clean}")
            else:
                pdf.set_font("helvetica", "", 10)
                text_clean = line.replace("**", "")
                pdf.multi_cell(0, 5, text_clean)
        except Exception as e:
            # Fallback for lines that completely break FPDF
            pdf.set_font("helvetica", "", 10)
            pdf.multi_cell(0, 5, "[Error rendering line]")
            
    return bytes(pdf.output())

def python_generate_content(contents, system_instruction=None, response_mime_type=None, response_schema=None):
    # Load keys
    gemini_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GEMINI_FLASH_API_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")
    
    # 1. Try OpenAI models in fallback sequence
    if openai_key:
        models_to_try = [
            os.environ.get("OPENAI_MODEL", "gpt-5.6-sol"),
            "gpt-5.6-terra",
            "o3-mini",
            "gpt-4o"
        ]
        
        # Remove duplicates preserving order
        unique_models = []
        for m in models_to_try:
            if m not in unique_models:
                unique_models.append(m)
                
        openai_success = False
        openai_text = ""
        
        for model_name in unique_models:
            try:
                url = "https://api.openai.com/v1/chat/completions"
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {openai_key}"
                }
                messages = []
                if system_instruction:
                    messages.append({"role": "system", "content": system_instruction})
                messages.append({"role": "user", "content": contents})
                
                body = {
                    "model": model_name,
                    "messages": messages,
                    "temperature": 0.0,
                    "max_completion_tokens": 16384
                }
                if response_schema:
                    body["response_format"] = {
                        "type": "json_schema",
                        "json_schema": {
                            "name": "structured_response",
                            "schema": response_schema,
                            "strict": True
                        }
                    }
                elif response_mime_type == "application/json":
                    body["response_format"] = {"type": "json_object"}
                    
                req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=90) as response:
                    res_data = json.loads(response.read().decode("utf-8"))
                    openai_text = res_data["choices"][0]["message"]["content"]
                    openai_success = True
                    break # Break out of the loop on success
            except Exception as openai_err:
                st.warning(f"⚠️ OpenAI model {model_name} failed: {openai_err}. Trying next fallback...")
                continue
                
        if openai_success:
            return openai_text

    # 2. Try Gemini second
    if gemini_key:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key={gemini_key}"
            headers = {"Content-Type": "application/json"}
            
            body = {
                "contents": [{"parts": [{"text": contents}]}],
                "generationConfig": {}
            }
            if response_schema:
                body["generationConfig"]["responseSchema"] = response_schema
                body["generationConfig"]["responseMimeType"] = "application/json"
            elif response_mime_type:
                body["generationConfig"]["responseMimeType"] = response_mime_type
                
            if system_instruction:
                body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
                
            req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=90) as response:
                res_data = json.loads(response.read().decode("utf-8"))
                text = res_data["candidates"][0]["content"]["parts"][0]["text"]
                return text
        except Exception as gemini_err:
            st.warning(f"⚠️ Gemini request failed: {gemini_err}.")
            
    raise Exception("All configured models (OpenAI, Gemini) failed or no API keys are set.")

def ingest_linkedin_saved_json(jobs):
    try:
        resp = api_request("POST", "/api/v2/observations/linkedin", body={"jobs": jobs}, timeout=120)
        if not resp.get("ok"):
            st.error(f"LinkedIn import failed (unexpected API response): {resp}")
            return 0, 0
        return int(resp.get("inserted") or 0), int(resp.get("skipped") or 0)
    except Exception as e:
        st.error(f"LinkedIn import failed: {e}")
        return 0, 0

def fetch_company_analytics_from_db():
    try:
        resp = api_request("GET", "/api/v2/analytics/companies", timeout=60)
        rows = resp.get("companies") or []
        if not isinstance(rows, list):
            raise Exception("API returned invalid companies payload (companies is not a list).")
        return [dict(r) for r in rows if isinstance(r, dict)]
    except Exception as e:
        st.error(f"Failed to fetch company analytics: {e}")
        return []

# Fetch data
jobs_list = fetch_jobs_from_db()
rejected_jobs_audit = fetch_rejected_jobs_from_db()

for job in jobs_list:
    eligibility, outcome, req_score, cov_score, evidence_completeness = derive_deterministic_recommendation(job)
    job["decision_eligibility"] = eligibility
    job["decision_outcome"] = outcome
    job["decision_requirement_score"] = req_score
    job["decision_coverage_score"] = cov_score
    job["decision_evidence_completeness"] = evidence_completeness

# Title
st.title("💼 Job Decision Engine — Streamlit Console (v4.1)")
st.markdown("### *Multi-Stage Weighted High-Autonomy Technical Architect & Builder Console*")
st.markdown("---")

# Sidebar - Filters & Stats
with st.sidebar.expander("Accessibility & Preferences", expanded=False):
    if "accessibility_settings" not in st.session_state:
        try:
            st.session_state["accessibility_settings"] = fetch_accessibility_settings()
        except Exception as e:
            st.warning(f"Unable to load accessibility settings: {e}")
            st.session_state["accessibility_settings"] = default_accessibility_settings()

    settings = st.session_state.get("accessibility_settings") or default_accessibility_settings()

    quiet_mode = st.toggle(
        "Quiet mode (reduce visual noise)",
        value=bool(settings.get("quiet_mode")),
        help="Keeps the UI predictable and reduces emphasis on bright accents.",
        key="acc_quiet_mode",
    )
    density = st.selectbox(
        "Density",
        options=["comfortable", "compact"],
        index=0 if settings.get("density") != "compact" else 1,
        help="Compact mode reduces padding and large visual blocks.",
        key="acc_density",
    )
    font_scale = st.slider(
        "Font scale",
        min_value=0.80,
        max_value=1.50,
        value=float(settings.get("font_scale") or 1.0),
        step=0.05,
        help="Changes the base font size (useful for readability and fatigue management).",
        key="acc_font_scale",
    )
    show_emojis = st.toggle(
        "Show emojis",
        value=bool(settings.get("show_emojis", True)),
        help="Turn off decorative emojis if they distract you.",
        key="acc_show_emojis",
    )
    high_contrast = st.toggle(
        "High contrast",
        value=bool(settings.get("high_contrast")),
        help="Uses higher contrast colors.",
        key="acc_high_contrast",
    )
    reduced_motion = st.toggle(
        "Reduced motion",
        value=bool(settings.get("reduced_motion")),
        help="Disables optional animations.",
        key="acc_reduced_motion",
    )

    patch = {}
    if quiet_mode != bool(settings.get("quiet_mode")):
        patch["quiet_mode"] = quiet_mode
    if density != settings.get("density"):
        patch["density"] = density
    if abs(float(font_scale) - float(settings.get("font_scale") or 1.0)) > 1e-6:
        patch["font_scale"] = float(font_scale)
    if show_emojis != bool(settings.get("show_emojis", True)):
        patch["show_emojis"] = show_emojis
    if high_contrast != bool(settings.get("high_contrast")):
        patch["high_contrast"] = high_contrast
    if reduced_motion != bool(settings.get("reduced_motion")):
        patch["reduced_motion"] = reduced_motion

    if patch:
        try:
            updated = update_accessibility_settings(patch)
            merged = dict(settings)
            merged.update(updated if isinstance(updated, dict) else {})
            st.session_state["accessibility_settings"] = merged
            st.success("Saved.")
            st.rerun()
        except Exception as e:
            st.error(f"Failed to save settings: {e}")

    st.markdown("---")

    if "preference_modes" not in st.session_state:
        try:
            st.session_state["preference_modes"] = fetch_preference_modes()
        except Exception as e:
            st.warning(f"Unable to load preference modes: {e}")
            st.session_state["preference_modes"] = []

    modes = st.session_state.get("preference_modes") or []
    mode_labels = []
    mode_key_by_label = {}
    active_label = None
    for m in modes:
        if not isinstance(m, dict):
            continue
        key = str(m.get("mode_key") or "").strip()
        name = str(m.get("display_name") or key).strip()
        if not key:
            continue
        label = f"{name} ({key})"
        if m.get("is_active") is True:
            label = f"{label} [active]"
            active_label = label
        mode_labels.append(label)
        mode_key_by_label[label] = key

    st.caption("Preference modes let you save multiple day modes (e.g. focus-heavy vs social-heavy days).")
    if mode_labels:
        chosen_label = st.selectbox(
            "Preference modes",
            options=mode_labels,
            index=mode_labels.index(active_label) if active_label in mode_labels else 0,
        )
        if st.button("Set active mode", key="pref_activate"):
            try:
                activate_preference_mode(mode_key_by_label[chosen_label])
                st.session_state["preference_modes"] = fetch_preference_modes()
                st.success("Updated active mode.")
                st.rerun()
            except Exception as e:
                st.error(f"Failed to activate mode: {e}")
        if st.button("Preview resolved policy before activation", key="pref_preview_existing"):
            selected_mode = next((m for m in modes if m.get("mode_key") == mode_key_by_label[chosen_label]), None)
            try:
                st.json(preview_preference_mode((selected_mode or {}).get("content") or {}))
            except Exception as e:
                st.error(f"Failed to preview resolved policy: {e}")
    else:
        st.info("No modes saved yet. Create one below.")

    with st.expander("Create a new preference mode", expanded=False):
        name = st.text_input("Display name", value="Focus day", key="pref_new_name")
        mode_key = st.text_input(
            "Mode key (lowercase, underscores)",
            value="focus_day",
            help="Example: focus_day, high_energy_day, interview_week",
            key="pref_new_key",
        )
        desc = st.text_area("Description (optional)", value="", key="pref_new_desc")
        allowed_work_modes = st.multiselect(
            "Allowed work modes",
            options=["REMOTE", "HYBRID", "ONSITE"],
            default=["REMOTE", "HYBRID"],
            key="pref_work_modes",
        )
        max_office_days = st.slider("Max office days/week", min_value=0, max_value=5, value=2, key="pref_office_days")
        max_travel = st.slider("Max travel (%)", min_value=0, max_value=100, value=10, key="pref_travel")
        authorized_regions = st.multiselect(
            "Authorized work regions",
            options=["SINGAPORE", "UNITED_STATES", "CANADA", "EUROPEAN_UNION", "UNITED_KINGDOM", "AUSTRALIA", "NEW_ZEALAND"],
            default=["SINGAPORE"],
            help="Explicit foreign work-location or authorization requirements outside this list are rejected when the policy toggle is enabled.",
            key="pref_authorized_regions",
        )
        hybrid_without_days = st.toggle(
            "Accept hybrid roles without an exact office-day count",
            value=True,
            help="Hybrid is accepted unless the posting explicitly requires the configured hard-fail office-day threshold.",
            key="pref_hybrid_without_days",
        )
        remote_without_territory = st.toggle(
            "Accept remote roles without a stated territory",
            value=True,
            help="Do not require manual verification when the posting does not state a foreign territory.",
            key="pref_remote_without_territory",
        )
        reject_foreign_territory = st.toggle(
            "Reject explicit foreign-only territories",
            value=True,
            help="Reject explicit US-only, EU-only, Australia-only, or similar work-location restrictions outside the configured regions.",
            key="pref_reject_foreign_territory",
        )
        unknown_work_auth = st.toggle(
            "Verify unstated work-authorisation jurisdiction",
            value=False,
            help="When off, only explicit foreign authorisation requirements block the job.",
            key="pref_unknown_work_auth",
        )

        content = {
            "schema_version": "2.2.0",
            "mode_key": mode_key,
            "hard_constraints": {
                "work_modes": allowed_work_modes,
                "max_office_days_per_week": int(max_office_days),
                "employment_types": ["FULL_TIME"],
                "max_travel_pct": int(max_travel),
                "on_call_allowed": True,
                "shift_work_allowed": True,
                "authorized_regions": authorized_regions,
                "hybrid_without_office_days_allowed": hybrid_without_days,
                "remote_without_territory_allowed": remote_without_territory,
                "reject_explicit_foreign_territory": reject_foreign_territory,
                "unknown_work_authorization_needs_verification": unknown_work_auth,
            },
            "soft_preferences": {},
            "unknown_handling": {
                "hard_constraint": "VERIFY",
                "soft_preference": "NEUTRAL_EXCLUDED_FROM_DENOMINATOR",
                "show_verification_questions": True,
            },
        }

        if st.button("Save mode", key="pref_save"):
            try:
                create_preference_mode(mode_key, name, desc or None, content)
                st.session_state["preference_modes"] = fetch_preference_modes()
                st.success("Mode saved.")
                st.rerun()
            except Exception as e:
                st.error(f"Failed to save mode: {e}")
        if st.button("Preview resolved policy", key="pref_preview_new"):
            try:
                st.json(preview_preference_mode(content))
            except Exception as e:
                st.error(f"Failed to preview resolved policy: {e}")

    st.markdown("---")

st.sidebar.header("🎯 Navigation & Filters")

# Metrics
total_jobs = len(jobs_list)
evaluated_count = sum(1 for j in jobs_list if j.get("processing_state") == "AI_EVALUATED" and not j.get("version_mismatch"))
recommendation_states = {"PREQUALIFIED", "LANE_ROUTED", "MATCHED", "QUEUED_FOR_AI", "AI_EVALUATED"}
priority_count = sum(1 for j in jobs_list if j.get("processing_state") in recommendation_states and j.get("decision_outcome") == "PRIORITY")
review_count = sum(1 for j in jobs_list if j.get("processing_state") in recommendation_states and j.get("decision_outcome") == "REVIEW")
verify_count = sum(1 for j in jobs_list if j.get("gate_status") == "NEEDS_VERIFICATION")
toxic_count = sum(1 for j in jobs_list if isinstance(j.get("politics_stress_score"), (int, float)) and j.get("politics_stress_score") >= 70)

st.sidebar.subheader("📊 Engine Statistics")
st.sidebar.metric("Total Vault Jobs", total_jobs)
st.sidebar.metric("Fully Evaluated", evaluated_count)
st.sidebar.metric("Top Recommended (Priority)", priority_count)
st.sidebar.metric("Recommended (Review)", review_count)
st.sidebar.metric("Needs Verification", verify_count)
st.sidebar.metric("Toxicity Flags", toxic_count)

st.sidebar.markdown("---")
st.sidebar.subheader("📅 Automated Schedules")
st.sidebar.info("""
* **Daily Ingestion & Evaluation**: Runs daily at **10:00 AM SGT** (02:00 UTC) via GitHub Actions.
* **Weekly LinkedIn Auto-Sync**: Runs every **Sunday at 10:00 AM SGT** (02:00 UTC) via GitHub Actions.
""")

st.sidebar.subheader("⚡ Pipeline Action Controls")

is_local = os.path.exists(".env.local")
github_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_PAT")

# Button 1: Ingest & Process Pipeline (GitHub Actions or Local)
if st.sidebar.button("⚡ Run Job Discovery & Evaluation Pipeline", help="Runs the full pipeline: Ingest Gmail & ATS adapters, Normalize, Hard Gate, Semantic Lane Route, Budget, and AI Evaluate."):
    if not is_local and not github_token:
        st.sidebar.error("⚠️ GITHUB_TOKEN is missing in Streamlit secrets. Please configure it to trigger GitHub Action workflows from the cloud.")
    else:
        if github_token:
            with st.spinner("Triggering GitHub Actions ingest.yml workflow..."):
                try:
                    req = urllib.request.Request(
                        "https://api.github.com/repos/elenaokhonko-eng/Job-Decision-Engine/actions/workflows/ingest.yml/dispatches",
                        data=json.dumps({"ref": "main"}).encode("utf-8"),
                        headers={"Authorization": f"Bearer {github_token}", "Accept": "application/vnd.github.v3+json", "User-Agent": "StreamlitConsole"},
                        method="POST"
                    )
                    with urllib.request.urlopen(req) as resp:
                        if resp.status in (204, 200, 201):
                            st.success("🐙 Triggered GitHub Actions Job Discovery Ingestion (ingest.yml) workflow!")
                            st.balloons()
                except Exception as gh_err:
                    st.error(f"GitHub Trigger Error: {gh_err}")
        else:
            with st.spinner("Running full pipeline locally..."):
                try:
                    st.info("Step 1/4: Ingesting Gmail alerts...")
                    run_checked_command(["npx", "tsx", "scripts/ingest_gmail.ts"], "ingest_gmail")
                    
                    st.info("Step 2/4: Polling ATS & Job Board adapters...")
                    run_checked_command(["npx", "tsx", "scripts/run_adapters.ts"], "run_adapters")
                    
                    st.info("Step 3/4: Parsing email alerts & staging observations...")
                    run_checked_command(["npx", "tsx", "scripts/parse_emails.ts"], "parse_emails")

                    st.info("Step 4/4: Running Discovery Pipeline (Normalize, Gate, Route, Budget)...")
                    run_checked_command(["npx", "tsx", "scripts/process_pipeline.ts"], "process_pipeline")

                    st.info("Step 5/5: Running AI Evaluation Queue Processor...")
                    run_checked_command(["npx", "tsx", "scripts/evaluate_queue.ts"], "evaluate_queue")
                    st.success("✅ Full pipeline execution finished!")
                    st.balloons()
                except subprocess.CalledProcessError as cpe:
                    st.error(f"Execution failed at step with exit code {cpe.returncode}.")
                    if cpe.stdout:
                        st.code(cpe.stdout, language="text")
                    if cpe.stderr:
                        st.error(cpe.stderr)
                except Exception as e:
                    st.error(f"Execution Error: {e}")
        st.rerun()

st.sidebar.markdown("---")
st.sidebar.subheader("🔍 Filter Listings")
search_query = st.sidebar.text_input("Keyword Search", "")
lane_filter = st.sidebar.selectbox("Filter Target Lane", ["All Lanes", "CORE_AI_DATA", "LEGAL_REGTECH", "HEALTH_BIO_PHARMA", "INVESTMENT_MARKETS_FINTECH", "UNCLASSIFIED"])
status_filter = st.sidebar.selectbox("Filter Pipeline Status", ["All Statuses", "AI_EVALUATED", "QUEUED_FOR_AI", "LANE_ROUTED", "PREQUALIFIED", "NEEDS_VERIFICATION", "ROUTING_DEFERRED"])
source_values = sorted({(j.get("source") or "UNKNOWN") for j in jobs_list})
board_filter = st.sidebar.selectbox("Filter Source", ["All Sources", *source_values])
track_values = sorted({(j.get("primary_lane") or "UNASSIGNED") for j in jobs_list})
track_filter = st.sidebar.selectbox("Filter Track", ["All Tracks", "Unassigned", *track_values])

# Apply filters
filtered_jobs = jobs_list
if lane_filter and lane_filter != "All Lanes":
    filtered_jobs = [j for j in filtered_jobs if j.get("primary_lane") == lane_filter]
if status_filter and status_filter != "All Statuses":
    filtered_jobs = [j for j in filtered_jobs if j.get("processing_state") == status_filter]
if search_query:
    filtered_jobs = [j for j in filtered_jobs if search_query.lower() in (j.get("title") or "").lower() or search_query.lower() in (j.get("company") or "").lower() or search_query.lower() in (j.get("description") or "").lower()]
if board_filter != "All Sources":
    filtered_jobs = [j for j in filtered_jobs if (j.get("source") or "UNKNOWN") == board_filter]
if track_filter != "All Tracks":
    if track_filter == "Unassigned":
        filtered_jobs = [j for j in filtered_jobs if not j.get("primary_lane") or j.get("primary_lane") == "UNASSIGNED"]
    else:
        filtered_jobs = [j for j in filtered_jobs if j.get("primary_lane") == track_filter]

# Main Dashboard Layout tabs
tab_dashboard, tab_add_job, tab_linkedin, tab_analytics, tab_cv = st.tabs(["📁 Postgres Job Vault", "➕ Add Job Ad", "🔗 LinkedIn Saved Jobs", "🔥 ND Culture Analytics", "📄 CV Customizer"])

with tab_dashboard:
    def top_rec_sort_key(j):
        outcome_rank = 0 if j.get("decision_outcome") == "PRIORITY" else 1
        eligibility_rank = 0 if j.get("decision_eligibility") == "ELIGIBLE" else 1
        req = j.get("decision_requirement_score")
        cov = j.get("decision_coverage_score")
        evidence = j.get("decision_evidence_completeness")
        nd = j.get("nd_friendly_score")
        pol = j.get("politics_stress_score")
        return (
            outcome_rank,
            eligibility_rank,
            -(req if isinstance(req, (int, float)) else -1),
            -(cov if isinstance(cov, (int, float)) else -1),
            -(evidence if isinstance(evidence, (int, float)) else 0),
            -(nd if isinstance(nd, (int, float)) else -1),
            (pol if isinstance(pol, (int, float)) else 999),
            escape_text(j.get("company")),
            escape_text(j.get("title")),
        )

    # Deterministic Top Recommended list (LLM next_action is displayed but not authoritative).
    top_recommended = [
        j for j in jobs_list
        if j.get("processing_state") in recommendation_states
        and not j.get("version_mismatch")
        and j.get("decision_outcome") in ("PRIORITY", "REVIEW")
    ]
    top_recommended = sorted(top_recommended, key=top_rec_sort_key)[:10]

    st.subheader("🏆 Top Recommended Opportunities")
    if not top_recommended:
        st.info("No deterministic priority or review recommendations found yet. Run the discovery & evaluation pipeline.")
    else:
        cols = st.columns(2)
        for idx, rjob in enumerate(top_recommended):
            col_idx = idx % 2
            with cols[col_idx]:
                version_warn = " ⚠️ Stale Evaluation" if rjob.get("version_mismatch") else ""

                title = escape_text(rjob.get("title") or "")
                company = escape_text(rjob.get("company") or "")
                lane = escape_text(rjob.get("primary_lane") or "UNCLASSIFIED")
                location = escape_text(rjob.get("location") or "Unknown")
                workplace = escape_text(rjob.get("workplace_type") or "UNKNOWN")

                outcome = escape_text(rjob.get("decision_outcome") or "TRACK")
                eligibility = escape_text(rjob.get("decision_eligibility") or "VERIFY")

                match_score = rjob.get("deterministic_match_score")
                coverage = rjob.get("deterministic_match_coverage")
                match_str = f"{float(match_score):.1f}/100" if isinstance(match_score, (int, float)) else "N/A"
                cov_str = f"{float(coverage):.1f}%" if isinstance(coverage, (int, float)) else "N/A"

                evidence_pct = rjob.get("decision_evidence_completeness")
                evidence_str = f"{int(float(evidence_pct) * 100)}%" if isinstance(evidence_pct, (int, float)) else "N/A"

                llm_action = escape_text(rjob.get("next_action") or "N/A")
                lane_conf = escape_text(rjob.get("lane_confidence") or "None")

                nd = rjob.get("nd_friendly_score")
                pol = rjob.get("politics_stress_score")
                nd_str = f"{int(nd)}%" if isinstance(nd, (int, float)) else "N/A"
                pol_str = f"{int(pol)}%" if isinstance(pol, (int, float)) else "N/A"

                summary = escape_text(rjob.get("evaluation_summary") or "N/A")

                st.markdown(f"""
                <div class="top-rec-card">
                    <h4>⭐ #{idx+1} {title} {version_warn}</h4>
                    <p><b>Company:</b> {company} | <b>Lane:</b> <code>{lane}</code></p>
                    <p><b>Location:</b> {location} ({workplace})</p>
                    <p><b>Deterministic:</b> <code>{outcome}</code> ({eligibility}) | <b>Match:</b> {match_str} | <b>Coverage:</b> {cov_str} | <b>Evidence:</b> {evidence_str}</p>
                    <p><b>LLM suggestion:</b> <code style='color:#22c55e;'>{llm_action}</code> | <b>Lane confidence:</b> {lane_conf}</p>
                    <p><b>Workplace Culture:</b> Autonomy: {nd_str} | Politics: {pol_str}</p>
                    <p><b>Summary:</b> {summary}</p>
                </div>
                """, unsafe_allow_html=True)
                url = safe_http_url(rjob.get("canonical_url") or rjob.get("careers_portal_url"))
                if url:
                    st.markdown(f"🔗 [Verify Job Ad & Apply]({url})")
                else:
                    st.write("Verify Job Ad & Apply URL unavailable.")

    st.markdown("---")

    # Interactive search filters inside the main tab
    search_col1, search_col2 = st.columns(2)
    with search_col1:
        search_title = st.text_input("🔍 Search Job Title", "", key="search_title_main")
    with search_col2:
        search_company = st.text_input("🏢 Search Company Name", "", key="search_company_main")

    if search_title:
        filtered_jobs = [j for j in filtered_jobs if search_title.lower() in (j.get("title") or "").lower()]
    if search_company:
        filtered_jobs = [j for j in filtered_jobs if search_company.lower() in (j.get("company") or "").lower()]

    col_left, col_right = st.columns([2, 3])

    with col_left:
        # Sort and split active vs rejected jobs
        def status_sort_key(j):
            outcome = j.get("decision_outcome") or "TRACK"
            eligibility = j.get("decision_eligibility") or "VERIFY"
            status = j.get("processing_state") or "UNKNOWN"

            outcome_rank = {"PRIORITY": 0, "REVIEW": 1, "TRACK": 2, "SKIP": 3}.get(outcome, 9)
            eligibility_rank = {"ELIGIBLE": 0, "VERIFY": 1, "INELIGIBLE": 2}.get(eligibility, 9)
            status_rank = {
                "AI_EVALUATED": 0,
                "QUEUED_FOR_AI": 1,
                "MATCHED": 2,
                "LANE_ROUTED": 3,
                "PREQUALIFIED": 4,
                "NEEDS_VERIFICATION": 5,
                "RAW_STAGED": 6,
                "ROUTING_DEFERRED": 7,
            }.get(status, 99)

            match_score = j.get("deterministic_match_score")
            match_sort = -(float(match_score) if isinstance(match_score, (int, float)) else -1.0)

            priority_score = j.get("priority_score")
            priority_sort = -(float(priority_score) if isinstance(priority_score, (int, float)) else -1.0)

            return (outcome_rank, eligibility_rank, status_rank, match_sort, priority_sort)

        sorted_filtered_jobs = sorted(filtered_jobs, key=status_sort_key)
        active_jobs = sorted_filtered_jobs
        rejected_jobs = rejected_jobs_audit

        st.subheader("📋 Available Listings Vault")
        if not active_jobs and not rejected_jobs:
            st.info("No matching jobs in the current Postgres database.")
        else:
            # Render Active (Green & Orange) Jobs
            if active_jobs:
                st.write(f"Showing {len(active_jobs)} listings:")
                for idx, job in enumerate(active_jobs):
                    status = job.get("processing_state") or "UNKNOWN"
                    company = job.get("company") or "Unknown"
                    title = job.get("title") or "Job Title"

                    gate_status = job.get("gate_status") or "NEEDS_VERIFICATION"
                    outcome = job.get("decision_outcome") or "TRACK"
                    eligibility = job.get("decision_eligibility") or "VERIFY"

                    if gate_status == "HARD_REJECT":
                        badge_style = "⛔"
                    elif gate_status == "NEEDS_VERIFICATION":
                        badge_style = "🔎"
                    elif status == "AI_EVALUATED" and outcome == "PRIORITY":
                        badge_style = "⭐"
                    elif status == "AI_EVALUATED" and outcome == "REVIEW":
                        badge_style = "🟡"
                    else:
                        badge_style = "📌"
                    
                    with st.expander(f"{badge_style} {title} — {company} ({status})"):
                        st.markdown(f"**Decision:** `{outcome}` ({eligibility}) | **Gate:** `{gate_status}`")
                        artifact_status = job.get("current_artifact_status") or "CURRENTNESS_UNKNOWN"
                        artifact_reason = job.get("current_artifact_reason")
                        blocked_count = job.get("blocked_task_count") or 0
                        if artifact_status != "CURRENT_OR_NOT_APPLICABLE":
                            st.warning(
                                f"Pipeline artifact status: `{artifact_status}`"
                                + (f" — {artifact_reason}" if artifact_reason else "")
                                + (f"; blocked tasks: {blocked_count}" if blocked_count else "")
                            )
                        st.markdown(f"**Source:** `{job.get('source') or 'UNKNOWN'}`")
                        st.markdown(f"**Lane:** `{job.get('primary_lane') or 'UNCLASSIFIED'}` | **Lane confidence:** `{job.get('lane_confidence') or 'None'}`")
                        st.markdown(f"**Location:** {job.get('location') or 'Unknown'} ({job.get('workplace_type') or 'UNKNOWN'}) | **Employment:** `{job.get('employment_type') or 'UNKNOWN'}`")

                        url = safe_http_url(job.get("canonical_url"))
                        if url:
                            st.markdown(f"**Verification Link:** [Go to Careers Portal]({url})")
                        else:
                            st.markdown("**Verification Link:** N/A")

                        match_score = job.get("deterministic_match_score")
                        coverage = job.get("deterministic_match_coverage")
                        match_str = f"{float(match_score):.1f}/100" if isinstance(match_score, (int, float)) else "N/A"
                        cov_str = f"{float(coverage):.1f}%" if isinstance(coverage, (int, float)) else "N/A"

                        evidence_pct = job.get("decision_evidence_completeness")
                        evidence_str = f"{int(float(evidence_pct) * 100)}%" if isinstance(evidence_pct, (int, float)) else "N/A"

                        st.markdown(f"**Deterministic match:** `{match_str}` | **Coverage:** `{cov_str}` | **Evidence completeness:** `{evidence_str}`")

                        aut = job.get("nd_friendly_score")
                        pol = job.get("politics_stress_score")
                        env = job.get("sensory_overload_index")

                        aut_str = f"{int(aut)}%" if isinstance(aut, (int, float)) else "N/A"
                        pol_str = f"{int(pol)}%" if isinstance(pol, (int, float)) else "N/A"
                        env_str = f"{int(env)}%" if isinstance(env, (int, float)) else "N/A"

                        st.markdown(f"**Workplace signals:** Autonomy {aut_str} | Politics {pol_str} | Sensory {env_str}")
                        st.markdown(f"**LLM suggestion:** `{job.get('next_action') or 'N/A'}` (display only)")
                        
                        desc_text = job.get("description", "")
                        parsed_desc = None
                        if isinstance(desc_text, dict):
                            parsed_desc = desc_text
                            desc_text = parsed_desc.get("job_description", "")
                        elif isinstance(desc_text, str) and desc_text.strip().startswith("{"):
                            try:
                                parsed_desc = json.loads(desc_text)
                                desc_text = parsed_desc.get("job_description", "")
                            except Exception:
                                pass
                        st.text_area("Full Description Brief", desc_text or "", height=100, disabled=True, key=f"active_desc_{idx}")
                        
                        if st.button("🗑️ Delete Listing", key=f"active_del_{job.get('canonical_job_id') or idx}"):
                            if delete_job_from_db(job.get("canonical_job_id")):
                                st.rerun()
            else:
                if rejected_jobs:
                    st.info(f"💡 No active matches found, but {len(rejected_jobs)} matching listings are in the Rejected/Discarded folder below.")
                else:
                    st.info("No active listings match the current filters.")

            # Render Rejected (Red) Jobs inside an expander
            if rejected_jobs:
                st.markdown("---")
                is_search_active = bool(search_title or search_company or search_query)
                with st.expander(f"🔴 View Rejected/Discarded Listings ({len(rejected_jobs)} jobs)", expanded=is_search_active):
                    # Limit rendering of rejected popovers to top 50 to prevent severe browser lag
                    display_limit = 50
                    for idx, job in enumerate(rejected_jobs[:display_limit]):
                        company = job.get("company", "Unknown")
                        title = job.get("title", "Job Title")
                        
                        with st.popover(f"🔴 {title} — {company}"):
                            st.markdown(f"**Source Board:** `{job.get('source')}`")
                            url = safe_http_url(job.get("canonical_url"))
                            if url:
                                st.markdown(f"**Verification Link:** [Go to Careers Portal]({url})")
                            else:
                                st.markdown("**Verification Link:** N/A")
                            st.markdown(f"**Status:** `{job.get('processing_state')}` | **Gate:** `{job.get('gate_status') or 'N/A'}`")
                            st.markdown(f"**Reason Codes:** {', '.join(job.get('rejection_codes') or []) or 'N/A'}")
                            st.markdown(f"**Evidence:** {'; '.join(job.get('gate_evidence_quotes') or []) or job.get('rejection_reason') or 'N/A'}")
                            st.markdown(
                                f"**Autonomy:** {job.get('nd_friendly_score') or 'N/A'} | "
                                f"**Politics:** {job.get('politics_stress_score') or 'N/A'} | "
                                f"**Sensory:** {job.get('sensory_overload_index') or 'N/A'}"
                            )
                            
                            desc_text = job.get("description", "")
                            parsed_desc = None
                            if isinstance(desc_text, dict):
                                parsed_desc = desc_text
                                desc_text = parsed_desc.get("job_description", "")
                            elif isinstance(desc_text, str) and desc_text.strip().startswith("{"):
                                try:
                                    parsed_desc = json.loads(desc_text)
                                    desc_text = parsed_desc.get("job_description", "")
                                except Exception:
                                    pass
                            st.text_area("Full Description Brief", desc_text or "", height=100, disabled=True, key=f"rej_desc_{idx}")
                            
                            if job.get("processing_state") != "MANUALLY_REMOVED" and st.button("🗑️ Remove Listing", key=f"rej_del_{job.get('canonical_job_id') or idx}"):
                                if delete_job_from_db(job.get("canonical_job_id")):
                                    st.rerun()
                    if len(rejected_jobs) > display_limit:
                        st.caption(f"⚠️ Showing first {display_limit} rejected listings to maintain UI performance. Use the search inputs above to filter down further.")

    with col_right:
        st.subheader("🤖 Scoring & Match Analysis Details")
        st.write("Select an evaluated job/version to view deterministic match scores, gate evidence, and the latest AI evaluation summary.")
        
        evaluated_jobs = [j for j in filtered_jobs if j.get("processing_state") == "AI_EVALUATED"]
        
        def format_job_option(j):
            outcome = j.get("decision_outcome") or "TRACK"
            eligibility = j.get("decision_eligibility") or "VERIFY"
            version_warn = " ⚠️ stale" if j.get("version_mismatch") else ""
            suffix = str(j.get("job_version_id") or "")[:8]
            return f"{j.get('company') or 'Unknown'} — {j.get('title') or 'Job Title'} [{outcome}/{eligibility}]{version_warn} ({suffix})"
            
        selected_job_title = st.selectbox(
            "Select evaluated job/version", 
            [format_job_option(j) for j in evaluated_jobs] if evaluated_jobs else ["No Evaluated Jobs Available"]
        )
        
        # Get actual job object
        job_to_show = None
        if evaluated_jobs and selected_job_title != "No Evaluated Jobs Available":
            options = {format_job_option(j): j for j in evaluated_jobs}
            job_to_show = options.get(selected_job_title)

        if job_to_show:
            st.markdown(f"#### Selected: **{job_to_show.get('title') or ''}** at *{job_to_show.get('company') or ''}*")
            url = safe_http_url(job_to_show.get("canonical_url"))
            if url:
                st.markdown(f"🔗 [View Posting]({url})")
            else:
                st.caption("Posting URL unavailable or invalid.")

            if job_to_show.get("version_mismatch"):
                st.warning("Stale evaluation detected: the canonical job/version changed since the last stored AI evaluation.")
            
            # Show score metrics
            st.markdown("---")
            outcome = job_to_show.get("decision_outcome") or "TRACK"
            eligibility = job_to_show.get("decision_eligibility") or "VERIFY"
            st.markdown(f"### Deterministic Decision: `{outcome}` ({eligibility})")

            match_score = job_to_show.get("deterministic_match_score")
            coverage = job_to_show.get("deterministic_match_coverage")
            evidence_pct = job_to_show.get("decision_evidence_completeness")

            match_str = f"{float(match_score):.1f}/100" if isinstance(match_score, (int, float)) else "N/A"
            cov_str = f"{float(coverage):.1f}%" if isinstance(coverage, (int, float)) else "N/A"
            evidence_str = f"{int(float(evidence_pct) * 100)}%" if isinstance(evidence_pct, (int, float)) else "N/A"
            
            metric_a, metric_b, metric_c = st.columns(3)
            with metric_a:
                st.metric("Deterministic Match", match_str)
            with metric_b:
                st.metric("Match Coverage", cov_str)
            with metric_c:
                st.metric("Evidence Completeness", evidence_str)

            st.markdown("#### Workplace Signals (from AI evaluation payload)")
            aut = job_to_show.get("nd_friendly_score")
            pol = job_to_show.get("politics_stress_score")
            env = job_to_show.get("sensory_overload_index")

            aut_str = f"{int(aut)}%" if isinstance(aut, (int, float)) else "N/A"
            pol_str = f"{int(pol)}%" if isinstance(pol, (int, float)) else "N/A"
            env_str = f"{int(env)}%" if isinstance(env, (int, float)) else "N/A"

            sig1, sig2, sig3 = st.columns(3)
            with sig1:
                st.metric("Autonomy", aut_str)
            with sig2:
                st.metric("Politics", pol_str)
            with sig3:
                st.metric("Sensory", env_str)

            st.markdown("#### Gate Evidence")
            st.markdown(f"**Gate status:** `{job_to_show.get('gate_status') or 'N/A'}`")
            st.markdown(f"**Reason codes:** {', '.join(job_to_show.get('rejection_codes') or []) or 'None'}")
            st.markdown(f"**Evidence quotes:** {'; '.join(job_to_show.get('gate_evidence_quotes') or []) or 'None'}")

            st.markdown("#### Workability Facts")
            st.json(normalize_workability_facts(job_to_show.get("workability_facts") or {}))

            st.markdown("#### AI Evaluation (display-only)")
            st.write(job_to_show.get("evaluation_summary") or "N/A")
            st.caption(f"Provider: {job_to_show.get('eval_provider') or 'N/A'} | Fallback: {job_to_show.get('eval_is_fallback')}")
            st.caption(f"LLM suggestion: {job_to_show.get('next_action') or 'N/A'} | Strategic value: {job_to_show.get('strategic_value') or 'N/A'}")
        else:
            st.info("No evaluated jobs in view. Run the discovery & evaluation pipeline to populate AI_EVALUATED rows.")

with tab_add_job:
    st.subheader("➕ Import a New Job Advertisement")
    st.write("Add raw jobs manually to the Postgres Vault. The daily evaluation cron job will automatically score and route them.")
    if "manual_import_success" in st.session_state:
        st.success(st.session_state["manual_import_success"])
        del st.session_state["manual_import_success"]

    with st.form("custom_job_form"):
        title = st.text_input("Job Title", "Principal AI Architect")
        company = st.text_input("Company Name", "Novartis Pharmaceuticals")
        source = st.selectbox("Source Portal", ["LinkedIn", "MyCareersFuture", "eFinancialCareers", "Gmail"])
        salary = st.text_input("Salary Range Indicator", "SGD 22,000 - SGD 26,000 / month")
        location = st.text_input("Location", "Singapore (Remote)")
        careers_url = st.text_input("Careers Portal Direct Link (Verification)", "https://www.novartis.com/careers")
        desc = st.text_area("Job Description Raw text", "Paste raw details here...")
        
        submitted = st.form_submit_button("Import & Save to Postgres Vault")
        if submitted:
            new_job = {
                "title": title,
                "company": company,
                "source": source,
                "salaryRange": salary,
                "location": location,
                "careers_portal_url": careers_url if careers_url else f"https://www.{company.lower().replace(' ', '')}.com/careers",
                "description": desc
            }
            if save_new_job_to_db(new_job):
                st.session_state["manual_import_success"] = f"✅ Successfully added '{title}' to the Staging Vault! It is now pending evaluation. To evaluate it immediately, click the '🧠 2. Run LLM Evaluation & Processing' button in the sidebar."
                st.rerun()

with tab_linkedin:
    st.subheader("🔗 Import Saved LinkedIn Jobs")
    st.write("Sync your saved LinkedIn jobs and stage them in your Postgres database for evaluation. Auto-unsave is disabled to keep ingestion read-only.")
    
    col_auto, col_manual = st.columns(2)
    
    with col_auto:
        st.markdown("### 🤖 Option A: Headless Auto-Sync")
        st.warning("Auto-sync/unsave is disabled by policy to keep source ingestion non-destructive.")
        st.caption("Use Option B (manual export and upload) for read-only ingestion.")

    with col_manual:
        st.markdown("### 📋 Option B: Manual Export & Upload")
        st.write("If your cookie expires or you prefer manual control, run the browser console script below and upload the exported JSON file.")
        script_code = r"""(async function extractSavedJobs() {
  if (window._jobScraperRunning) {
    alert("Job scraper is already running! Please wait for it to finish or refresh the page.");
    return;
  }
  window._jobScraperRunning = true;

  // Create visual overlay for progress
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);color:white;z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:sans-serif;font-size:18px;';
  const statusText = document.createElement('div');
  statusText.innerText = "🚀 Starting LinkedIn Saved Jobs extraction...";
  const progressText = document.createElement('div');
  progressText.style.marginTop = '10px';
  progressText.style.fontSize = '24px';
  progressText.style.fontWeight = 'bold';
  overlay.appendChild(statusText);
  overlay.appendChild(progressText);
  document.body.appendChild(overlay);

  try {
    const uniqueJobs = [];
    const processedUrls = new Set();
    let pageNum = 1;
    let hasNextPage = true;
    
    while (hasNextPage && pageNum <= 40) {
      statusText.innerText = `📄 Scanning Page ${pageNum}...`;
      
      // Scroll to bottom to ensure elements render
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 2000));
      
      // Find all job links on this page
      const jobLinks = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
      let pageCount = 0;
      
      for (const a of jobLinks) {
        const title = (a.innerText || "").trim();
        if (!title || title.length < 3) continue;
        
        let jobId = '';
        const match = a.href.match(/\/jobs\/view\/(\d+)/);
        if (match) jobId = match[1];
        
        if (jobId) {
          const standardUrl = `https://www.linkedin.com/jobs/view/${jobId}/`;
          
          if (!processedUrls.has(standardUrl)) {
            processedUrls.add(standardUrl);
            
            const container = a.closest('li') || a.closest('.entity-list-item') || a.closest('div');
            let company = 'Unknown Company';
            let location = 'Singapore';
            
            if (container) {
              const companyEl = container.querySelector('.entity-list-item__subtitle, .reusable-search__result-subtitle, .job-card-container__company-name');
              if (companyEl) company = companyEl.innerText.trim();
              
              const locationEl = container.querySelector('.entity-list-item__caption, .reusable-search__result-caption, .job-card-container__metadata-item');
              if (locationEl) location = locationEl.innerText.trim();
              
              if (company === 'Unknown Company') {
                const innerSpans = Array.from(container.querySelectorAll('span, div, p'));
                for (const span of innerSpans) {
                  const t = span.innerText.trim();
                  if (t.includes('·') && !t.includes('\n')) {
                    const parts = t.split('·');
                    company = parts[0].trim();
                    location = parts[1].trim();
                    break;
                  }
                }
              }
            }
            
            uniqueJobs.push({ title, company, url: standardUrl, location });
            pageCount++;
          }
        }
      }
      
      progressText.innerText = `Found ${uniqueJobs.length} unique jobs so far.`;
      
      // Find Next button
      const nextBtn = document.querySelector('.artdeco-pagination__button--next') || 
                      Array.from(document.querySelectorAll('button, a')).find(el => {
                        const text = el.innerText.trim().toLowerCase();
                        return (text.includes('next') || el.ariaLabel?.toLowerCase().includes('next')) && !el.disabled && !el.classList.contains('disabled');
                      });
                      
      if (nextBtn && !nextBtn.disabled && !nextBtn.classList.contains('artdeco-button--disabled')) {
        statusText.innerText = `➡️ Moving to Next page...`;
        nextBtn.click();
        pageNum++;
        await new Promise(r => setTimeout(r, 3000));
      } else {
        statusText.innerText = `🏁 No more pages found. Ending scan.`;
        hasNextPage = false;
      }
    }
    
    if (uniqueJobs.length === 0) {
      alert("⚠️ No saved jobs identified. Make sure you are on the 'Saved' tab of your Job Tracker.");
      window._jobScraperRunning = false;
      document.body.removeChild(overlay);
      return;
    }
    
    statusText.innerText = "🧠 Fetching job descriptions...";
    const finalizedJobs = [];
    
    // Robust XHR wrapper to bypass broken extensions intercepting fetch
    function robustGet(url) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.setRequestHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8');
        xhr.withCredentials = true;
        xhr.onload = () => resolve(xhr.responseText);
        xhr.onerror = () => reject(new Error('XHR Error'));
        xhr.send();
      });
    }
    
    // Sequential fetching to avoid rate limits
    for (let i = 0; i < uniqueJobs.length; i++) {
      const job = uniqueJobs[i];
      progressText.innerText = `Fetching description ${i + 1} of ${uniqueJobs.length}...\n${job.title}`;
      
      try {
        const html = await robustGet(job.url);
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const descEl = doc.querySelector('.jobs-description-content') || 
                      doc.querySelector('.show-more-less-html__markup') || 
                      doc.querySelector('[id^="job-details"]') || 
                      doc.querySelector('.jobs-box__html-content') ||
                      doc.querySelector('.jobs-description');
        const description = descEl ? descEl.innerText.trim() : '';
        
        finalizedJobs.push({
          title: job.title,
          company: job.company,
          url: job.url,
          location: job.location,
          description: description || "Full description not available. Please visit job link to apply."
        });
      } catch (err) {
        console.error(`❌ Failed: ${job.title}`, err);
        finalizedJobs.push({
          title: job.title,
          company: job.company,
          url: job.url,
          location: job.location,
          description: "Failed to fetch description automatically."
        });
      }
      
      // Delay to avoid LinkedIn 429 rate limit or SDUI oops page
      await new Promise(r => setTimeout(r, 2000));
    }
    
    statusText.innerText = "🎉 All done! Downloading JSON...";
    progressText.innerText = "";
    
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(finalizedJobs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "linkedin_saved_jobs.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    
    await new Promise(r => setTimeout(r, 2000));
  } catch (err) {
    console.error("Critical error during extraction:", err);
    alert("Extraction failed. See console for details.");
  } finally {
    window._jobScraperRunning = false;
    document.body.removeChild(overlay);
  }
})();"""
        st.code(script_code, language="javascript")
        
        uploaded_file = st.file_uploader("Upload your exported 'linkedin_saved_jobs.json' file", type=["json"])
        
        if uploaded_file is not None:
            try:
                jobs_data = json.load(uploaded_file)
                if not isinstance(jobs_data, list):
                    st.error("Invalid file structure. Root must be a JSON array.")
                else:
                    st.success(f"Successfully parsed JSON. Found **{len(jobs_data)}** jobs in file.")
                    
                    # Show preview
                    st.markdown("#### **Jobs Preview**")
                    preview_df = pd.DataFrame([
                        {"Title": j.get("title"), "Company": j.get("company"), "Location": j.get("location"), "URL": j.get("url")}
                        for j in jobs_data[:10]
                    ])
                    st.dataframe(preview_df, use_container_width=True)
                    if len(jobs_data) > 10:
                        st.write(f"*... and {len(jobs_data) - 10} more jobs.*")
                    
                    # Ingest button
                    if st.button("📥 Import All Saved Jobs to Staging Vault"):
                        with st.spinner("Inserting jobs into staging table..."):
                            inserted, skipped = ingest_linkedin_saved_json(jobs_data)
                            st.success(f"✅ Ingestion complete! **{inserted}** new jobs imported, **{skipped}** skipped as duplicates/invalid.")
                            st.rerun()
            except Exception as e:
                st.error(f"Error reading JSON file: {e}")

with tab_analytics:
    st.subheader("🔥 Company Autonomy & Culture Analytics")
    st.write("Consolidated employer ratings compiled directly from Postgres database tables.")

    analytics_data = fetch_company_analytics_from_db()

    if analytics_data:
        df = pd.DataFrame(analytics_data)
        
        # Map safety verdicts
        def get_verdict(row):
            st = row.get("Status")
            if row.get("Approved"):
                return "🟢 HIGH AUTONOMY / OPTIMAL FOCUS"
            if st in ("STRONG MATCH", "PRIORITY_APPLY", "HIGH_FIT_HIGH_RISK"):
                return "✅ PRIORITY"
            elif st in ("REVIEW REQUIRED", "APPLY_AFTER_VERIFICATION"):
                return "⚠️ REVIEW REQUIRED"
            elif row.get("Toxic"):
                return "🔴 HIGH POLITICS / BUREAUCRATIC"
            else:
                return "🟡 REVIEW REQUIRED"
                
        df["Safety Verdict"] = df.apply(get_verdict, axis=1)
        
        # Display table
        st.dataframe(df[["Company", "Industry", "Avg Autonomy Score", "Avg Politics Score", "Avg Sensory Index", "Avg Focus Score", "Safety Verdict"]], use_container_width=True)
        
        st.markdown("### 🏆 Top High-Autonomy Environments vs. ⚠️ Stress Alerts")
        st.bar_chart(df.set_index("Company")[["Avg Autonomy Score", "Avg Politics Score"]])
    else:
        st.info("No compiled analytics are available. Please run the evaluation engine pipeline to score listings.")

    st.markdown("---")
    st.subheader("Source Health (Compliance-Aware)")
    st.caption("Counts are based on staged raw observations. Compliance metadata comes from source plugin manifests.")
    try:
        resp = api_request("GET", "/api/v2/sources/health", timeout=30)
        sources = resp.get("sources") if isinstance(resp, dict) else None
        if isinstance(resp, dict) and resp.get("ok") and isinstance(sources, list) and sources:
            sdf = pd.DataFrame(sources)
            st.dataframe(sdf, use_container_width=True)
        elif isinstance(resp, dict) and resp.get("ok") and isinstance(sources, list) and not sources:
            st.info("No source plugin rows found yet. Run `npm run sources:sync` and ingest at least one source.")
        else:
            st.warning(f"Source health endpoint returned an unexpected payload: {resp}")
    except Exception as e:
        st.error(f"Failed to fetch source health from API: {e}")

with tab_cv:
    st.subheader("📄 Canonical Documents")
    st.write("Generate CV and cover letter from canonical job/version records and the active PostgreSQL evidence ledger.")

    profile_source = "PostgreSQL active profile (document generator)"
    profile_data = None
    if os.environ.get("MASTER_PROFILE_JSON"):
        try:
            profile_data = json.loads(os.environ["MASTER_PROFILE_JSON"])
            profile_source = "MASTER_PROFILE_JSON"
        except Exception as e:
            st.error(f"Invalid MASTER_PROFILE_JSON: {e}")
    elif os.path.exists("master_profile.json"):
        try:
            with open("master_profile.json", "r", encoding="utf-8") as f:
                profile_data = json.load(f)
            profile_source = "master_profile.json"
        except Exception as e:
            st.error(f"Failed to parse master_profile.json: {e}")
    else:
        st.info("Documents use the active PostgreSQL profile and match run; a local MASTER_PROFILE_JSON file is not required.")

    if profile_data:
        facts = profile_data.get("profile_facts") or profile_data.get("facts") or []
        fact_ids = [f.get("id") for f in facts if isinstance(f, dict) and f.get("id")]
        st.caption(f"Evidence source: {profile_source} | facts loaded: {len(fact_ids)}")
        if len(fact_ids) == 0:
            st.warning("The optional local profile ledger has no IDs; the document generator will use the active database profile.")

    eligible_jobs = [
        j
        for j in jobs_list
        if j.get("canonical_job_id")
        and j.get("job_version_id")
        and j.get("processing_state")
        in ("AI_EVALUATED", "QUEUED_FOR_AI", "LANE_ROUTED", "PREQUALIFIED")
        and j.get("decision_outcome") in ("PRIORITY", "REVIEW")
    ]

    if not eligible_jobs:
        st.info("No canonical shortlist jobs with version IDs are currently available.")
    else:
        def _job_label(j):
            return f"{j.get('company')} - {j.get('title')} [{j.get('processing_state')}] ({str(j.get('job_version_id'))[:8]})"

        options = {_job_label(j): j for j in eligible_jobs}
        selected_label = st.selectbox("Select canonical job/version", list(options.keys()))
        selected_job = options[selected_label]

        st.markdown(f"**Canonical Job ID:** {selected_job.get('canonical_job_id')}")
        st.markdown(f"**Job Version ID:** {selected_job.get('job_version_id')}")
        st.markdown(f"**Company:** {selected_job.get('company')} | **Role:** {selected_job.get('title')}")
        url = safe_http_url(selected_job.get("canonical_url"))
        if url:
            st.markdown(f"🔗 [View Posting]({url})")

        with st.expander("Preview job description"):
            description = selected_job.get("description") or ""
            if isinstance(description, dict):
                st.json(description)
            else:
                st.text_area("Description", str(description), height=220, disabled=True)

        btn_col1, btn_col2 = st.columns(2)
        with btn_col1:
            if st.button("Generate customized CV", use_container_width=True):
                with st.spinner("Generating CV from canonical job/version..."):
                    try:
                        started_at = time.time()
                        run_checked_command(
                            [
                                "npx",
                                "tsx",
                                "scripts/generate_cv.ts",
                                str(selected_job.get("canonical_job_id")),
                                str(selected_job.get("job_version_id"))
                            ],
                            "generate_cv"
                        )
                        st.success("CV generation completed. See scripts/exports for artifacts.")
                        show_generated_document_downloads(started_at, "cv_download")
                    except subprocess.CalledProcessError as e:
                        st.error(f"CV generation failed with exit code {e.returncode}.")
                        if e.stdout:
                            st.code(e.stdout, language="text")
                        if e.stderr:
                            st.error(e.stderr)

        with btn_col2:
            if st.button("Generate cover letter", use_container_width=True):
                with st.spinner("Generating cover letter from canonical job/version..."):
                    try:
                        started_at = time.time()
                        run_checked_command(
                            [
                                "npx",
                                "tsx",
                                "scripts/generate_cover_letter.ts",
                                str(selected_job.get("canonical_job_id")),
                                str(selected_job.get("job_version_id"))
                            ],
                            "generate_cover_letter"
                        )
                        st.success("Cover letter generation completed. See scripts/exports for artifacts.")
                        show_generated_document_downloads(started_at, "cover_letter_download")
                    except subprocess.CalledProcessError as e:
                        st.error(f"Cover letter generation failed with exit code {e.returncode}.")
                        if e.stdout:
                            st.code(e.stdout, language="text")
                        if e.stderr:
                            st.error(e.stderr)

# Footer section
st.markdown("---")
st.markdown("<p class='disclaimer'>Job Decision Engine v4.0 • Powered by Neon Postgres & GitHub Actions Automation</p>", unsafe_allow_html=True)
