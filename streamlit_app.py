import hashlib
import html
import json
import os
import subprocess
import urllib.request
from io import BytesIO

import docx
import pandas as pd
import streamlit as st
from fpdf import FPDF
from streamlit_application_workflow import (
    application_api_path,
    is_document_generation_eligible,
    parse_application_document_pair_status,
    salary_disclosure_message,
)
from streamlit_application_review import render_document_pair_review_checkbox
from streamlit_database import read_only_database_ssl_options
from streamlit_formatters import as_number, format_percent, format_score, format_signal
from streamlit_workspace_contracts import (
    validate_application_row,
    validate_application_workspace_summary,
    validate_apply_now_row,
    validate_company_culture_coverage_summary,
    validate_company_culture_evidence_row,
    validate_company_culture_row,
    validate_profile_coverage_row,
    validate_profile_evidence_row,
    validate_ranked_job_row,
    validate_track_row,
)


# Load environment variables from Streamlit secrets, .env, and .env.local
def load_dotenv():
    # Load from Streamlit Cloud Secrets if available
    try:
        if hasattr(st, "secrets") and st.secrets:
            for key, val in st.secrets.items():
                if isinstance(val, str):
                    os.environ.setdefault(key, val)
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
                        os.environ.setdefault(key.strip(), val)

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
        raise RuntimeError("psycopg2-binary is required for the verified Streamlit read-only fallback.") from exc

    allow_local_postgres = os.environ.get("STREAMLIT_E2E_ALLOW_LOCAL_POSTGRES", "").strip().lower() == "true"
    ssl_options = read_only_database_ssl_options(
        database_url, allow_local_postgres=allow_local_postgres
    )
    if ssl_options["sslmode"] == "verify-full":
        try:
            import certifi
        except ImportError as exc:
            raise RuntimeError("certifi is required for verified Streamlit read-only connections.") from exc
        ssl_options["sslrootcert"] = certifi.where()

    connection = psycopg2.connect(
        database_url,
        connect_timeout=10,
        **ssl_options,
    )
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
      readiness.application_readiness,
      readiness.readiness_status,
      readiness.readiness_fingerprint,
      readiness.readiness_expires_at,
      readiness.readiness_reason_codes,
      readiness.availability_status,
      readiness.availability_recheck_at,
      s.blocked_task_count,
      s.requires_user_action,
      s.user_action_type,
      s.user_action_category,
      s.user_action_status,
      s.technical_error_count,
      s.pipeline_display_category
    FROM v_canonical_shortlist_actions_scoped s
    LEFT JOIN v_application_readiness_current readiness
      ON readiness.workspace_id = s.workspace_id
     AND readiness.canonical_job_id = s.canonical_job_id
     AND readiness.job_version_id::text = s.job_version_id::text
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
    LIMIT %s OFFSET %s
"""

APPLICATION_WORKSPACE_SUMMARY_QUERY = """
    SELECT workspace_id, user_id, total_jobs, apply_now_count, track_count,
           processing_count, rejected_unmatched_count, applied_count, technical_errors,
           top_ten_ready_count, skip_count, user_key
    FROM v_application_workspace_summary_scoped
    WHERE workspace_id = %s AND user_key = %s
    LIMIT 1
"""

TOP_TEN_READY_QUERY = """
    SELECT workspace_id, canonical_job_id, job_version_id, profile_version_id,
           match_run_id, deterministic_decision_id, ai_evaluation_id,
           ranking_policy_version, ranking_context_fingerprint, ranking_position,
           overall_rank_score, ranking_confidence, is_top_ten_ready,
           policy_recheck_required, recommendation_eligibility, recommendation_outcome,
           gate_status, primary_lane, title, company, canonical_url, location,
           workplace_type, lane_confidence, deterministic_match_score,
           deterministic_match_coverage, recommendation_evidence_completeness,
           evaluation_summary, requirement_fit_score, requirement_coverage_score,
           evidence_completeness_score, lane_confidence_score, autonomy_score,
           politics_risk_score, sensory_workload_risk_score, strategic_value_score,
           focus_protection_score, building_ratio_score, interaction_burden_score,
           base_rank_score, freshness_score, remote_freedom_score,
           final_application_priority_score, remote_from_home_base_score,
           temporary_abroad_score, country_flexibility_score,
           office_requirement_score, timezone_compatibility_score,
           employment_verifiability_score, stage3_preference_context_id,
           ranking_component_availability, ranking_component_provenance,
           current_artifact_status, version_mismatch,
           current_readiness.application_readiness, current_readiness.readiness_status,
           current_readiness.readiness_fingerprint,
           current_readiness.readiness_expires_at, current_readiness.readiness_reason_codes,
           current_readiness.availability_status, current_readiness.availability_recheck_at
    FROM v_top_ten_ready_jobs_stage3_scoped AS jobs
    LEFT JOIN LATERAL (
      SELECT application_readiness, readiness_status, readiness_fingerprint, readiness_expires_at,
             readiness_reason_codes, availability_status, availability_recheck_at
      FROM v_application_readiness_current readiness
      WHERE readiness.workspace_id = jobs.workspace_id
        AND readiness.canonical_job_id = jobs.canonical_job_id
        AND readiness.job_version_id::text = jobs.job_version_id::text
      LIMIT 1
    ) AS current_readiness ON TRUE
    WHERE jobs.workspace_id = %s
    ORDER BY ranking_position ASC
    LIMIT 10
"""

APPLY_NOW_JOBS_QUERY = """
    SELECT workspace_id, canonical_job_id, job_version_id, title, company,
           canonical_url, source, location, workplace_type, employment_type,
           description, gate_status, rejection_codes, gate_evidence_quotes,
           primary_lane, secondary_lanes, lane_confidence, priority_score,
           deterministic_match_score, deterministic_match_coverage,
           processing_state, processing_status, recommendation_eligibility,
           recommendation_outcome, recommendation_requirement_score,
           recommendation_coverage_score, recommendation_evidence_completeness,
           recommendation_decided_at, nd_friendly_score, politics_stress_score,
           sensory_overload_index, next_action, strategic_value, evaluation_summary,
           eval_provider, eval_is_fallback, version_mismatch, observed_at, evaluated_at,
           latest_match_run_id, current_artifact_status, current_artifact_reason,
           blocked_task_count, overall_rank_score, ranking_confidence,
           ranking_snapshot_id, policy_recheck_required, base_rank_score,
           freshness_score, remote_freedom_score, final_application_priority_score,
           remote_from_home_base_score, temporary_abroad_score,
           country_flexibility_score, office_requirement_score,
           timezone_compatibility_score, employment_verifiability_score,
           stage3_preference_context_id, ranking_component_availability,
           ranking_component_provenance, current_readiness.application_readiness,
           current_readiness.readiness_status,
           current_readiness.readiness_fingerprint, current_readiness.readiness_expires_at,
           current_readiness.readiness_reason_codes, current_readiness.availability_status,
           current_readiness.availability_recheck_at
    FROM v_apply_now_jobs_stage3_scoped AS jobs
    LEFT JOIN LATERAL (
      SELECT application_readiness, readiness_status, readiness_fingerprint, readiness_expires_at,
             readiness_reason_codes, availability_status, availability_recheck_at
      FROM v_application_readiness_current readiness
      WHERE readiness.workspace_id = jobs.workspace_id
        AND readiness.canonical_job_id = jobs.canonical_job_id
        AND readiness.job_version_id::text = jobs.job_version_id::text
      LIMIT 1
    ) AS current_readiness ON TRUE
    WHERE jobs.workspace_id = %s
    ORDER BY overall_rank_score DESC NULLS LAST,
             CASE recommendation_outcome WHEN 'PRIORITY' THEN 0 ELSE 1 END,
             deterministic_match_score DESC NULLS LAST,
             observed_at DESC NULLS LAST
    LIMIT 5000
"""

TRACK_JOBS_QUERY = """
    SELECT workspace_id, canonical_job_id, job_version_id, title, company,
           canonical_url, source, location, workplace_type, employment_type,
           description, gate_status, primary_lane, lane_confidence,
           deterministic_match_score, deterministic_match_coverage,
           recommendation_eligibility, recommendation_outcome, version_mismatch,
           current_artifact_status, current_artifact_reason, blocked_task_count,
           deterministic_decision_id, deterministic_context_fingerprint,
           deterministic_trace_notes, current_readiness.application_readiness,
           current_readiness.readiness_status,
           current_readiness.readiness_fingerprint, current_readiness.readiness_expires_at,
           current_readiness.readiness_reason_codes, current_readiness.availability_status,
           current_readiness.availability_recheck_at
    FROM v_track_jobs_scoped AS jobs
    LEFT JOIN LATERAL (
      SELECT application_readiness, readiness_status, readiness_fingerprint, readiness_expires_at,
             readiness_reason_codes, availability_status, availability_recheck_at
      FROM v_application_readiness_current readiness
      WHERE readiness.workspace_id = jobs.workspace_id
        AND readiness.canonical_job_id = jobs.canonical_job_id
        AND readiness.job_version_id::text = jobs.job_version_id::text
      LIMIT 1
    ) AS current_readiness ON TRUE
    WHERE jobs.workspace_id = %s
    ORDER BY deterministic_match_score DESC NULLS LAST, observed_at DESC NULLS LAST
    LIMIT 5000
"""

APPLICATIONS_READ_MODEL_QUERY = """
    SELECT workspace_id, user_id, application_record_id, canonical_job_id,
           job_version_id, application_status, submission_url, cv_document_run_id,
           cover_letter_document_run_id, notes, target_submit_at, submitted_at,
           follow_up_at, last_action_at, created_at, updated_at, title, company,
           canonical_url, processing_state, recommendation_eligibility,
           recommendation_outcome, primary_lane, secondary_lanes, is_current_job_version,
           cv_document_status, cover_letter_document_status
    FROM v_application_workspace_scoped
    WHERE workspace_id = %s AND user_id = %s
    ORDER BY updated_at DESC, application_record_id DESC
    LIMIT %s
"""

PROFILE_EVIDENCE_READ_MODEL_QUERY = """
    SELECT workspace_id, canonical_job_id, job_version_id, profile_version_id,
           match_run_id, requirement_id, requirement_key, requirement_type,
           importance, requirement_text, requirement_quote, match_type, match_score,
           profile_fact_id, fact_type, profile_fact_statement, evidence_tier,
           fact_verification_status, engagement_id, engagement_type,
           experience_class, role_title, engagement_evidence,
           engagement_verification_status, project_evidence
    FROM v_job_profile_evidence_scoped
    WHERE workspace_id = %s AND canonical_job_id = %s AND job_version_id = %s
    ORDER BY CASE importance WHEN 'MUST' THEN 0 WHEN 'PREFERRED' THEN 1 ELSE 2 END,
             CASE match_type WHEN 'EXACT' THEN 0 WHEN 'SEMANTIC' THEN 1 ELSE 2 END,
             requirement_key
"""

PROFILE_COVERAGE_READ_MODEL_QUERY = """
    SELECT workspace_id, canonical_job_id, job_version_id, profile_version_id,
           profile_version_number, match_run_id, exact_match_count, semantic_match_count,
           must_exact_matched_count, must_semantic_matched_count,
           preferred_exact_matched_count, preferred_semantic_matched_count,
           must_requirement_count, must_matched_count, must_missing_count,
           preferred_requirement_count, preferred_matched_count, preferred_missing_count,
           professional_production_evidence_count, deployed_open_source_evidence_count,
           applied_project_evidence_count, course_project_evidence_count,
           knowledge_only_evidence_count, profile_fact_count, achievement_count,
           responsibility_count, project_count, skill_count, technology_count,
           domain_count, publication_count, open_source_count, active_credential_count,
           engagement_count
    FROM v_profile_coverage_scoped
    WHERE workspace_id = %s AND canonical_job_id = %s AND job_version_id = %s
    LIMIT 1
"""

COMPANY_CULTURE_READ_MODEL_QUERY = """
    SELECT workspace_id, workspace_company_id, company_name, normalized_company_name,
           company_job_count, observation_count, autonomy_score, autonomy_score_available,
           autonomy_observation_count, politics_risk_score, politics_risk_score_available,
           politics_risk_observation_count, sensory_workload_risk_score,
           sensory_workload_risk_score_available, sensory_workload_risk_observation_count,
           strategic_value_score, strategic_value_score_available,
           strategic_value_observation_count, focus_protection_score,
           focus_protection_score_available, focus_protection_observation_count,
           autonomy_score_status, politics_risk_score_status,
           sensory_workload_risk_score_status, strategic_value_score_status,
           focus_protection_score_status, confidence_level, last_updated
    FROM v_company_culture_analytics_scoped
    WHERE workspace_id = %s
    ORDER BY observation_count DESC, company_name ASC
    LIMIT %s
"""

COMPANY_CULTURE_EVIDENCE_QUERY = """
    SELECT workspace_id, workspace_company_id, company_name, canonical_job_id,
           job_version_id, ai_evaluation_id, role_title, observed_at, autonomy_signal,
           politics_risk_signal, sensory_workload_risk_signal, focus_protection_signal,
           evidence_by_signal, source_type, source_url, evidence_quote
    FROM v_company_culture_evidence_scoped
    WHERE workspace_id = %s AND workspace_company_id = %s
    ORDER BY observed_at DESC, ai_evaluation_id
    LIMIT %s
"""

COMPANY_CULTURE_COVERAGE_QUERY = """
    SELECT %s::uuid AS workspace_id,
           count(*)::integer AS companies_represented,
           count(*) FILTER (WHERE company_job_count > 0)::integer AS companies_with_jobs,
           count(*) FILTER (WHERE observation_count > 0)::integer AS companies_with_culture_observations,
           count(*) FILTER (WHERE confidence_level IN ('MEDIUM', 'HIGH'))::integer AS companies_with_medium_high_confidence
    FROM v_company_culture_analytics_scoped
    WHERE workspace_id = %s
"""


def _read_model_user_id(connection, workspace_id):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT u.id
            FROM workspace_users u
            JOIN workspace_memberships m ON m.user_id = u.id
            WHERE m.workspace_id = %s AND u.user_key = %s AND m.status = 'ACTIVE'
            LIMIT 1
            """,
            (workspace_id, get_workspace_user_key()),
        )
        row = cursor.fetchone()
    if not row:
        raise RuntimeError("No active database membership for the configured workspace user.")
    return row[0]


def _validate_workspace_rows(rows, workspace_id, validator, *scope_args):
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Workspace read model returned a non-object row.")
        validator(row, workspace_id, *scope_args)
    return rows


def fetch_application_workspace_summary():
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(
        APPLICATION_WORKSPACE_SUMMARY_QUERY,
        (workspace_id, get_workspace_user_key()),
    )
    if not rows:
        raise RuntimeError("No authoritative application workspace summary is available.")
    return _validate_workspace_rows(
        rows,
        workspace_id,
        validate_application_workspace_summary,
        get_workspace_user_key(),
    )[0]


def fetch_top_ten_ready_jobs():
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(TOP_TEN_READY_QUERY, (workspace_id,))
    return _validate_workspace_rows(rows, workspace_id, validate_ranked_job_row)


def fetch_apply_now_jobs():
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(APPLY_NOW_JOBS_QUERY, (workspace_id,))
    return _validate_workspace_rows(rows, workspace_id, validate_apply_now_row)


def fetch_track_jobs():
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(TRACK_JOBS_QUERY, (workspace_id,))
    return _validate_workspace_rows(rows, workspace_id, validate_track_row)


def fetch_applications_from_read_model(limit=250):
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
        user_id = _read_model_user_id(connection, workspace_id)
    finally:
        connection.close()
    rows = _read_model_query(APPLICATIONS_READ_MODEL_QUERY, (workspace_id, user_id, limit))
    return _validate_workspace_rows(rows, workspace_id, validate_application_row, user_id)


def fetch_job_profile_evidence(canonical_job_id, job_version_id):
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(
        PROFILE_EVIDENCE_READ_MODEL_QUERY,
        (workspace_id, canonical_job_id, job_version_id),
    )
    return _validate_workspace_rows(rows, workspace_id, validate_profile_evidence_row)


def fetch_profile_coverage(canonical_job_id, job_version_id):
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(
        PROFILE_COVERAGE_READ_MODEL_QUERY,
        (workspace_id, canonical_job_id, job_version_id),
    )
    validated = _validate_workspace_rows(rows, workspace_id, validate_profile_coverage_row)
    if not validated:
        raise RuntimeError("No current profile coverage row is available for this job.")
    return validated[0]


def fetch_company_analytics_from_db():
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(COMPANY_CULTURE_READ_MODEL_QUERY, (workspace_id, 2000))
    return _validate_workspace_rows(rows, workspace_id, validate_company_culture_row)


def fetch_company_culture_coverage():
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(COMPANY_CULTURE_COVERAGE_QUERY, (workspace_id, workspace_id))
    if not rows:
        raise RuntimeError("Company culture coverage summary is unavailable.")
    return _validate_workspace_rows(
        rows, workspace_id, validate_company_culture_coverage_summary
    )[0]


def fetch_company_culture_evidence(workspace_company_id):
    connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(connection)
    finally:
        connection.close()
    rows = _read_model_query(
        COMPANY_CULTURE_EVIDENCE_QUERY,
        (workspace_id, workspace_company_id, 100),
    )
    return _validate_workspace_rows(rows, workspace_id, validate_company_culture_evidence_row)


def fetch_jobs_from_postgres_read_model():
    workspace_connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(workspace_connection)
    finally:
        workspace_connection.close()
    return _read_model_query(SHORTLIST_READ_MODEL_QUERY, (workspace_id, 5000))


def fetch_rejected_jobs_from_postgres_read_model(limit=200, offset=0):
    workspace_connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(workspace_connection)
    finally:
        workspace_connection.close()
    return _read_model_query(REJECTED_READ_MODEL_QUERY, (workspace_id, limit, offset))


def fetch_preference_modes_from_postgres_read_model():
    query = """
        SELECT
          mode_key,
          display_name,
          description,
          is_active,
          content,
          created_at,
          updated_at
        FROM workspace_user_preference_modes
        WHERE workspace_id = %s AND user_id = %s
        ORDER BY is_active DESC, updated_at DESC
    """
    workspace_connection = _open_read_only_connection()
    try:
        workspace_id = _read_model_workspace_id(workspace_connection)
        user_id = _read_model_user_id(workspace_connection, workspace_id)
    finally:
        workspace_connection.close()
    return _read_model_query(query, (workspace_id, user_id))

def api_request(method, path, params=None, body=None, timeout=30):
    import urllib.parse

    base = get_api_base_url()
    if not base:
        raise RuntimeError(
            "Managed API base URL is not configured. Set JDEC_API_BASE_URL for API operations."
        )
    normalized_path = application_api_path(path)
    url = f"{base}{normalized_path}"
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
    if not get_api_base_url():
        return default_accessibility_settings()
    try:
        resp = api_request("GET", "/api/v2/accessibility", timeout=15)
        if isinstance(resp, dict) and resp.get("ok"):
            settings = resp.get("settings") or {}
            merged = dict(default_accessibility_settings())
            merged.update(settings if isinstance(settings, dict) else {})
            return merged
    except Exception:
        pass
    return default_accessibility_settings()

def update_accessibility_settings(patch):
    resp = api_request("PUT", "/api/v2/accessibility", body=patch, timeout=15)
    if isinstance(resp, dict) and resp.get("ok"):
        return resp.get("settings") or {}
    raise Exception(resp.get("error") if isinstance(resp, dict) else "Unknown API error")

def fetch_preference_modes():
    if get_api_base_url():
        try:
            resp = api_request("GET", "/api/v2/preference-modes", timeout=20)
            if isinstance(resp, dict) and resp.get("ok"):
                modes = resp.get("modes") or []
                return modes if isinstance(modes, list) else []
        except Exception:
            pass

    try:
        return fetch_preference_modes_from_postgres_read_model()
    except Exception:
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
    travel_number = as_number(travel_pct)
    return {
        "office_days_min": office_days if isinstance(office_days, int) else None,
        "office_days_max": office_days if isinstance(office_days, int) else None,
        "travel_pct_max": float(travel_number) if travel_number is not None else None,
        "employment_type": "CONTRACT" if is_contract is True else "UNKNOWN",
        "location_restriction": None if location_elig in ("PASS", "UNKNOWN", None) else "RESTRICTED",
    }

def derive_deterministic_recommendation(job):
    # The backend projection is authoritative. Artifact freshness describes
    # optional AI/document work and must not overwrite a current deterministic
    # recommendation exposed by a COMPLETED read-model row.
    if job.get("requires_user_action") is True:
        return "VERIFY", "TRACK", None, None, job.get("recommendation_evidence_completeness")

    pipeline_category = str(job.get("pipeline_display_category") or "PROCESSING_AUTOMATICALLY")
    if pipeline_category in ("PROCESSING_AUTOMATICALLY", "TECHNICAL_ERROR"):
        return "ELIGIBLE", "TRACK", None, None, job.get("recommendation_evidence_completeness")

    eligibility = job.get("recommendation_eligibility")
    outcome = job.get("recommendation_outcome")
    if eligibility not in ("ELIGIBLE", "VERIFY", "INELIGIBLE"):
        eligibility = "INELIGIBLE" if job.get("processing_state") in ("HARD_REJECTED", "UNMATCHED") else "ELIGIBLE"
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
    page_title="Job Decision Engine — Application Command Centre",
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

def run_checked_command(command_args, step_label, extra_env=None):
    """Run a local command safely and surface stdout/stderr to the UI."""
    command_env = os.environ.copy()
    if extra_env:
        command_env.update(extra_env)
    result = subprocess.run(
        command_args,
        capture_output=True,
        text=True,
        check=True,
        shell=False,
        env=command_env,
    )
    if result.stdout:
        st.code(result.stdout, language="text")
    if result.stderr:
        st.warning(f"{step_label} stderr:\n{result.stderr}")
    return result

def ensure_draft_application(job):
    application_key = f"{job['canonical_job_id']}:{job['job_version_id']}"
    cached = st.session_state.setdefault("pilot_application_ids", {}).get(application_key)
    if cached:
        return cached

    response = api_request(
        "POST",
        "/api/v2/applications",
        body={
            "canonical_job_id": job["canonical_job_id"],
            "job_version_id": job["job_version_id"],
            "status": "INTENT",
            "submission_url": job.get("canonical_url"),
        },
    )
    application = response.get("application") if isinstance(response, dict) else None
    application_id = application.get("application_record_id") if isinstance(application, dict) else None
    if not isinstance(response, dict) or not response.get("ok") or not application_id:
        raise RuntimeError("The API did not confirm creation of a draft application.")
    st.session_state["pilot_application_ids"][application_key] = application_id
    return application_id


def parse_document_run(result, expected_type, job, application_id):
    for line in reversed(result.stdout.splitlines()):
        try:
            manifest = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(manifest, dict) or manifest.get("event") != "DOCUMENT_GENERATION_COMPLETED":
            continue
        if (
            manifest.get("documentType") != expected_type
            or manifest.get("applicationRecordId") != application_id
            or manifest.get("canonicalJobId") != job["canonical_job_id"]
            or manifest.get("jobVersionId") != job["job_version_id"]
            or not manifest.get("profileVersionId")
            or not manifest.get("deterministicDecisionId")
            or not manifest.get("contextFingerprint")
            or not manifest.get("documentRunId")
            or not isinstance(manifest.get("outputs"), dict)
            or not isinstance(manifest["outputs"].get("docx"), dict)
            or not manifest["outputs"]["docx"].get("path")
            or not manifest["outputs"]["docx"].get("sha256")
        ):
            raise RuntimeError("Generated document run does not match the selected application and job version.")
        return manifest
    raise RuntimeError("The document command did not return an exact document-run manifest.")


def verified_document_bytes(output):
    path = output.get("path") if isinstance(output, dict) else None
    expected_hash = output.get("sha256") if isinstance(output, dict) else None
    if not isinstance(path, str) or not isinstance(expected_hash, str):
        raise TypeError("The document manifest does not contain a path and SHA-256 hash.")
    export_root = os.path.realpath(os.path.join("scripts", "exports"))
    artifact_path = os.path.realpath(path)
    try:
        within_exports = os.path.commonpath([export_root, artifact_path]) == export_root
    except ValueError:
        within_exports = False
    if not within_exports or not os.path.isfile(artifact_path):
        raise RuntimeError("The document manifest points outside the local exports directory or to a missing file.")
    with open(artifact_path, "rb") as artifact:
        content = artifact.read()
    if hashlib.sha256(content).hexdigest() != expected_hash:
        raise RuntimeError("The document file hash does not match its persisted run manifest.")
    return os.path.basename(artifact_path), content


def show_document_run_downloads(manifest, key_prefix):
    st.caption(f"Document run: {manifest['documentRunId']}")
    outputs = manifest.get("outputs") or {}
    for output_type in ("docx", "pdf"):
        output = outputs.get(output_type)
        if output is None:
            continue
        filename, content = verified_document_bytes(output)
        st.download_button(
            label=f"Download {output_type.upper()}: {filename}",
            data=content,
            file_name=filename,
            mime=output.get("mimeType", "application/octet-stream"),
            key=f"{key_prefix}_{manifest['documentRunId']}_{output_type}",
        )


def render_job_document_actions(job, key_prefix):
    pair_key = f"{job['canonical_job_id']}:{job['job_version_id']}"
    pairs = st.session_state.setdefault("application_document_pairs", {})
    pair = pairs.setdefault(pair_key, {})
    cv_col, letter_col = st.columns(2)
    with cv_col:
        if st.button("Generate CV", key=f"{key_prefix}_cv", width="stretch"):
            with st.spinner("Generating a current, evidence-grounded CV... "):
                application_id = ensure_draft_application(job)
                result = run_checked_command(
                    ["npx", "tsx", "scripts/generate_cv.ts", str(job["canonical_job_id"]), str(job["job_version_id"])],
                    "generate_cv",
                    {"JDEC_APPLICATION_RECORD_ID": application_id},
                )
                pair["cv"] = parse_document_run(result, "CV", job, application_id)
    with letter_col:
        if st.button("Generate cover letter", key=f"{key_prefix}_letter", width="stretch"):
            with st.spinner("Generating a current, evidence-grounded cover letter... "):
                application_id = ensure_draft_application(job)
                result = run_checked_command(
                    ["npx", "tsx", "scripts/generate_cover_letter.ts", str(job["canonical_job_id"]), str(job["job_version_id"])],
                    "generate_cover_letter",
                    {"JDEC_APPLICATION_RECORD_ID": application_id},
                )
                pair["cover_letter"] = parse_document_run(result, "COVER_LETTER", job, application_id)

    cv = pair.get("cv")
    letter = pair.get("cover_letter")
    if not cv or not letter:
        for document_type, manifest in (("cv", cv), ("cover_letter", letter)):
            if manifest:
                show_document_run_downloads(manifest, f"{key_prefix}_{document_type}_download")
        st.info("Generate both customised documents for this exact job version to complete the application document pair.")
        return

    matching_context = all(
        cv.get(field) == letter.get(field)
        for field in (
            "applicationRecordId",
            "canonicalJobId",
            "jobVersionId",
            "profileVersionId",
            "deterministicDecisionId",
            "contextFingerprint",
        )
    )
    if not matching_context:
        st.warning("The CV and cover letter use different application context. Regenerate the stale document before review.")
        show_document_run_downloads(cv, f"{key_prefix}_cv_historical")
        show_document_run_downloads(letter, f"{key_prefix}_letter_historical")
        return

    verification = run_checked_command(
        [
            "npx",
            "tsx",
            "scripts/validate_application_document_pair.ts",
            cv["applicationRecordId"],
            cv["documentRunId"],
            letter["documentRunId"],
        ],
        "validate_document_pair",
    )
    application_status = parse_application_document_pair_status(
        verification.stdout,
        application_record_id=cv["applicationRecordId"],
        cv_document_run_id=cv["documentRunId"],
        cover_letter_document_run_id=letter["documentRunId"],
    )
    if not application_status.get("pairCurrent"):
        st.warning("This document pair is no longer current or attached to this draft application. Regenerate before marking it ready.")
        show_document_run_downloads(cv, f"{key_prefix}_cv_stale")
        show_document_run_downloads(letter, f"{key_prefix}_letter_stale")
        return

    show_document_run_downloads(cv, f"{key_prefix}_cv_download")
    show_document_run_downloads(letter, f"{key_prefix}_letter_download")
    review_key = f"{key_prefix}_pair_reviewed_{cv['documentRunId']}_{letter['documentRunId']}"
    already_reviewed = bool(application_status.get("reviewedAt"))

    def persist_pair_review() -> None:
        review_response = api_request(
            "PATCH",
            f"/api/v2/applications/{cv['applicationRecordId']}",
            body={
                "event_payload": {
                    "event": "DOCUMENT_PAIR_REVIEWED",
                    "cv_document_run_id": cv["documentRunId"],
                    "cover_letter_document_run_id": letter["documentRunId"],
                    "cv_sha256": cv["outputs"]["docx"]["sha256"],
                    "cover_letter_sha256": letter["outputs"]["docx"]["sha256"],
                },
            },
        )
        if not isinstance(review_response, dict) or not review_response.get("ok"):
            raise RuntimeError("The API did not persist the document review event.")
        st.success("Document review recorded on the draft application.")

    reviewed = render_document_pair_review_checkbox(
        review_key=review_key,
        already_reviewed=already_reviewed,
        on_review=persist_pair_review,
    )
    if application_status.get("documentReady") or reviewed:
        st.success("Document pair reviewed. The application remains a draft; no employer submission was recorded.")

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
        "requires_user_action",
        "pipeline_display_category",
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
    api_url = get_api_base_url()
    if api_url:
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
            st.info(
                f"Managed API at {api_url} is unavailable; displaying the canonical PostgreSQL read model in read-only mode."
            )

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
        return valid_rows
    except Exception as fallback_error:
        st.error(
            f"Failed to fetch the canonical shortlist from PostgreSQL read model: {fallback_error}"
        )
        return []

def fetch_rejected_jobs_from_db():
    """Fetch rejected jobs from the API, with a read-only view fallback."""
    api_url = get_api_base_url()
    if api_url:
        try:
            resp = api_request("GET", "/api/v2/rejected", params={"limit": 50}, timeout=60)
            rows = resp.get("jobs") or []
            if not isinstance(rows, list):
                raise Exception("API returned invalid rejected-jobs payload (jobs is not a list).")
            return [dict(r) for r in rows if isinstance(r, dict)]
        except Exception:
            pass

    try:
        rows = fetch_rejected_jobs_from_postgres_read_model()
        return [dict(row) for row in rows if isinstance(row, dict)]
    except Exception as fallback_error:
        st.error(
            f"Failed to fetch rejected jobs from PostgreSQL read model: {fallback_error}"
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

def save_application_status(job, status, application=None):
    if not get_api_base_url():
        st.error("Application tracking changes require the managed API. Configure JDEC_API_BASE_URL and JDEC_API_TOKEN.")
        return

    if application and application.get("application_record_id"):
        response = api_request(
            "PATCH",
            f"/applications/{application['application_record_id']}",
            body={"status": status},
        )
    else:
        response = api_request(
            "POST",
            "/applications",
            body={
                "canonical_job_id": job["canonical_job_id"],
                "job_version_id": job["job_version_id"],
                "status": status,
                "submission_url": job.get("canonical_url"),
            },
        )
    if not isinstance(response, dict) or not response.get("ok"):
        raise RuntimeError("The application tracker did not confirm the status change.")
    st.success(f"Application tracker updated to {status}.")
    st.rerun()


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
st.title("Job Decision Engine — Application Command Centre")
st.caption("Discover, rank, prepare, and track grounded job applications.")
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
api_base_url = get_api_base_url()
if api_base_url:
    st.sidebar.caption(f"🔌 Connected to Managed API (`{api_base_url}`)")
else:
    st.sidebar.caption("📦 PostgreSQL Direct Read Model (Live)")

# Unpaginated counts come only from the authoritative V5 workspace read model.
application_workspace_summary = {}
summary_error = None
try:
    application_workspace_summary = fetch_application_workspace_summary()
except Exception as exc:
    summary_error = str(exc)

if summary_error:
    st.sidebar.error(f"Application workspace summary is unavailable: {summary_error}")
    metric_values = {label: "Unavailable" for label in (
        "Top 10 Ready", "Apply Now", "Track", "Processing",
        "Rejected / Unmatched", "Applied", "Technical Errors",
    )}
else:
    metric_values = {
        "Top 10 Ready": application_workspace_summary["top_ten_ready_count"],
        "Apply Now": application_workspace_summary["apply_now_count"],
        "Track": application_workspace_summary["track_count"],
        "Processing": application_workspace_summary["processing_count"],
        "Rejected / Unmatched": application_workspace_summary["rejected_unmatched_count"],
        "Applied": application_workspace_summary["applied_count"],
        "Technical Errors": application_workspace_summary["technical_errors"],
    }

processing_count = metric_values["Processing"]
rejected_count = metric_values["Rejected / Unmatched"]
technical_error_count = metric_values["Technical Errors"]

st.sidebar.subheader("Application workspace")
for metric_label, metric_value in metric_values.items():
    st.sidebar.metric(metric_label, metric_value)

try:
    top_ten_ready_jobs = fetch_top_ten_ready_jobs()
except Exception as exc:
    top_ten_ready_jobs = None
    st.error(f"Top 10 Ranked is unavailable: {exc}")

try:
    application_records = fetch_applications_from_read_model()
except Exception as exc:
    application_records = None
    st.error(f"Application tracker is unavailable: {exc}")

application_by_job = None
if application_records is not None:
    application_by_job = {
        (record["canonical_job_id"], record["job_version_id"]): record
        for record in application_records
    }


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
status_filter = st.sidebar.selectbox(
    "Filter Pipeline Status",
    [
        "All Statuses",
        "RAW_STAGED",
        "PREQUALIFIED",
        "ROUTING_DEFERRED",
        "LANE_ROUTED",
        "QUEUED_FOR_AI",
        "EVALUATING",
        "AI_EVALUATED",
        "MATCHED",
        "UNMATCHED",
        "NEEDS_VERIFICATION",
        "PROCESSING_ERROR",
    ],
)
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
tab_dashboard, tab_applications, tab_add_job, tab_linkedin, tab_analytics, tab_cv = st.tabs([
    "Application command centre",
    "Application tracker",
    "Add job",
    "LinkedIn saved jobs",
    "Company culture analytics",
    "CV customizer",
])

with tab_dashboard:
    st.header("Application command centre")
    st.caption("PRIORITY = strongest opportunity; REVIEW = apply after review; TRACK = more fit evidence needed; SKIP = completed negative decision.")
    st.markdown("## Top 10 — apply first")

    if top_ten_ready_jobs is None:
        st.error("Ranked opportunities could not be loaded from the current ranking read model.")
    elif not top_ten_ready_jobs:
        st.info("No jobs currently meet the current-context Top 10 ranking readiness requirements.")
    else:
        for rank_position, ranked_job in enumerate(top_ten_ready_jobs, start=1):
            title = ranked_job.get("title") or "Untitled role"
            company = ranked_job.get("company") or "Unknown company"
            job_key = (ranked_job.get("canonical_job_id"), ranked_job.get("job_version_id"))
            application_record = application_by_job.get(job_key) if application_by_job is not None else None
            ranked_job["decision_eligibility"] = ranked_job.get("recommendation_eligibility")
            ranked_job["decision_outcome"] = ranked_job.get("recommendation_outcome")
            with st.container(border=True):
                st.subheader(f"#{rank_position} {title}")
                st.caption(f"{company} · {ranked_job.get('location') or 'Location unknown'} · {ranked_job.get('primary_lane') or 'Lane unknown'}")
                salary_note = salary_disclosure_message(ranked_job)
                if salary_note:
                    st.caption(salary_note)
                score_columns = st.columns(4)
                score_columns[0].metric("Overall rank", format_score(ranked_job.get("overall_rank_score")))
                score_columns[1].metric("Ranking confidence", format_percent(ranked_job.get("ranking_confidence")))
                score_columns[2].metric("Requirement fit", format_score(ranked_job.get("requirement_fit_score")))
                score_columns[3].metric("Coverage", format_percent(ranked_job.get("requirement_coverage_score")))
                detail_columns = st.columns(4)
                detail_columns[0].metric("Evidence completeness", format_percent(ranked_job.get("evidence_completeness_score")))
                detail_columns[1].metric("Autonomy", format_signal(ranked_job.get("autonomy_score")))
                detail_columns[2].metric("Politics risk", format_signal(ranked_job.get("politics_risk_score")))
                detail_columns[3].metric("Sensory/workload risk", format_signal(ranked_job.get("sensory_workload_risk_score")))
                st.caption(
                    f"Stage 3 — base: {format_score(ranked_job.get('base_rank_score'))} · "
                    f"freshness: {format_score(ranked_job.get('freshness_score'))} · "
                    f"remote freedom: {format_score(ranked_job.get('remote_freedom_score'))} · "
                    f"employment verifiability: {format_score(ranked_job.get('employment_verifiability_score'))}"
                )
                st.caption(
                    f"Focus protection: {format_signal(ranked_job.get('focus_protection_score'))} · "
                    f"Building/research: {format_percent(ranked_job.get('building_ratio_score'))} · "
                    f"Interaction burden: {format_percent(ranked_job.get('interaction_burden_score'))} · "
                    f"Strategic value: {format_percent(ranked_job.get('strategic_value_score'))}"
                )
                st.caption(
                    f"Decision: {ranked_job.get('recommendation_outcome')} · "
                    f"{ranked_job.get('evaluation_summary') or 'No concise evaluation summary is available.'}"
                )
                action_columns = st.columns(3)
                posting_url = safe_http_url(ranked_job.get("canonical_url"))
                with action_columns[0]:
                    if posting_url:
                        st.link_button("Open application", posting_url, width="stretch")
                    else:
                        st.caption("Posting URL unavailable")
                with action_columns[1]:
                    if application_records is None:
                        st.button("Tracker unavailable", key=f"top_{rank_position}_tracker_unavailable", disabled=True)
                    elif application_record is None:
                        if st.button("Add to tracker", key=f"top_{rank_position}_to_apply", width="stretch"):
                            try:
                                save_application_status(ranked_job, "TO_APPLY")
                            except Exception as exc:
                                st.error(f"Could not update the application tracker: {exc}")
                    elif application_record.get("application_status") != "APPLIED":
                        if st.button("Mark applied", key=f"top_{rank_position}_applied", width="stretch"):
                            try:
                                save_application_status(ranked_job, "APPLIED", application_record)
                            except Exception as exc:
                                st.error(f"Could not update the application tracker: {exc}")
                    else:
                        st.success("Applied")
                with action_columns[2]:
                    current_status = application_record.get("application_status") if application_record else "Not tracked"
                    cv_status = application_record.get("cv_document_status") if application_record else "NOT_GENERATED"
                    letter_status = application_record.get("cover_letter_document_status") if application_record else "NOT_GENERATED"
                    st.caption(f"Application: {current_status} · CV: {cv_status} · Cover letter: {letter_status}")
                try:
                    render_job_document_actions(ranked_job, f"top_{rank_position}")
                except subprocess.CalledProcessError as exc:
                    st.error(f"Document generation failed with exit code {exc.returncode}.")
                    if exc.stderr:
                        st.code(exc.stderr, language="text")
                except Exception as exc:
                    st.error(f"Document generation failed: {exc}")

    evidence_options = {}
    if top_ten_ready_jobs is not None:
        evidence_options = {
            f"#{index} {job.get('title') or 'Untitled role'} — {job.get('company') or 'Unknown company'}": job
            for index, job in enumerate(top_ten_ready_jobs, start=1)
        }
    if evidence_options:
        with st.expander("Why I fit — inspect requirement and profile evidence", expanded=False):
            selected_evidence_label = st.selectbox("Ranked job", list(evidence_options), key="top_ten_evidence_job")
            selected_evidence_job = evidence_options[selected_evidence_label]
            try:
                evidence_rows = fetch_job_profile_evidence(
                    selected_evidence_job["canonical_job_id"], selected_evidence_job["job_version_id"]
                )
                if evidence_rows:
                    st.dataframe(evidence_rows, hide_index=True, alt="Current job requirements matched to verified profile evidence")
                else:
                    st.info("No current requirement-to-profile evidence rows are available for this job.")
                coverage = fetch_profile_coverage(
                    selected_evidence_job["canonical_job_id"], selected_evidence_job["job_version_id"]
                )
                if coverage:
                    st.write({
                        "Active profile version": coverage.get("profile_version_number"),
                        "Profile facts": coverage.get("profile_fact_count"),
                        "Credentials": coverage.get("active_credential_count"),
                        "Engagements": coverage.get("engagement_count"),
                        "Skills": coverage.get("skill_count"),
                        "Technologies": coverage.get("technology_count"),
                        "Domains": coverage.get("domain_count"),
                        "Projects": coverage.get("project_count"),
                        "Achievements": coverage.get("achievement_count"),
                        "Publications": coverage.get("publication_count"),
                        "MUST matched": coverage.get("must_matched_count"),
                        "MUST missing": coverage.get("must_missing_count"),
                        "PREFERRED matched": coverage.get("preferred_matched_count"),
                        "PREFERRED missing": coverage.get("preferred_missing_count"),
                        "Exact evidence": coverage.get("exact_match_count"),
                        "Semantic evidence": coverage.get("semantic_match_count"),
                        "Professional evidence": coverage.get("professional_production_evidence_count"),
                        "Applied-project evidence": coverage.get("applied_project_evidence_count"),
                        "Course evidence": coverage.get("course_project_evidence_count"),
                    })
            except Exception as exc:
                st.error(f"Current profile evidence could not be loaded: {exc}")

    category_options = ["Top 10", "Apply Now", "Track", "Processing", "Applied", "Skip", "Rejected / Unmatched", "All"]
    workspace_category = st.selectbox("Opportunity category", category_options, index=1, key="application_workspace_category")
    category_counts = {
        "Top 10": application_workspace_summary.get("top_ten_ready_count"),
        "Apply Now": application_workspace_summary.get("apply_now_count"),
        "Track": application_workspace_summary.get("track_count"),
        "Processing": application_workspace_summary.get("processing_count"),
        "Applied": application_workspace_summary.get("applied_count"),
        "Skip": application_workspace_summary.get("skip_count"),
        "Rejected / Unmatched": application_workspace_summary.get("rejected_unmatched_count"),
        "All": application_workspace_summary.get("total_jobs"),
    }
    category_count = category_counts.get(workspace_category)
    st.subheader(f"{workspace_category} ({category_count if category_count is not None else 'unavailable'})")
    page_size = 25
    total_pages = max(1, ((int(category_count) + page_size - 1) // page_size) if category_count is not None else 1)
    category_page = st.number_input(
        "Page", min_value=1, max_value=total_pages, value=1, step=1,
        key=f"application_workspace_page_{workspace_category}",
    )
    category_offset = (int(category_page) - 1) * page_size

    try:
        if workspace_category == "Top 10":
            category_rows = fetch_top_ten_ready_jobs()
        elif workspace_category == "Apply Now":
            category_rows = fetch_apply_now_jobs()
        elif workspace_category == "Track":
            category_rows = fetch_track_jobs()
        elif workspace_category == "Applied":
            category_rows = None if application_records is None else [
                record for record in application_records
                if record.get("application_status") in (
                    "APPLIED", "ASSESSMENT", "SUBMITTED", "FOLLOW_UP", "INTERVIEW",
                    "OFFER", "REJECTED", "WITHDRAWN"
                )
            ]
        elif workspace_category == "Rejected / Unmatched":
            category_rows = fetch_rejected_jobs_from_postgres_read_model(page_size, category_offset)
        elif workspace_category == "Processing":
            category_rows = [job for job in jobs_list if job.get("pipeline_display_category") == "PROCESSING_AUTOMATICALLY"]
        elif workspace_category == "Skip":
            category_rows = [job for job in jobs_list if job.get("decision_outcome") == "SKIP"]
        else:
            category_rows = jobs_list
    except Exception as exc:
        category_rows = None
        st.error(f"{workspace_category} read model is unavailable: {exc}")

    if category_rows is None:
        st.error("This category is unavailable because its authoritative read model could not be loaded.")
        filtered_jobs = []
    else:
        if workspace_category not in ("Applied", "Rejected / Unmatched"):
            for category_job in category_rows:
                category_job["decision_eligibility"] = category_job.get("recommendation_eligibility")
                category_job["decision_outcome"] = category_job.get("recommendation_outcome")
            global_job_ids = {job.get("canonical_job_id") for job in filtered_jobs}
            category_rows = [job for job in category_rows if job.get("canonical_job_id") in global_job_ids]
        filtered_jobs = category_rows

    processing_jobs = [
        job for job in jobs_list
        if job.get("pipeline_display_category") == "PROCESSING_AUTOMATICALLY"
    ]
    technical_error_jobs = [
        job for job in jobs_list
        if job.get("pipeline_display_category") == "TECHNICAL_ERROR"
    ]
    unmatched_jobs = [
        job for job in jobs_list
        if job.get("pipeline_display_category") == "REJECTED_UNMATCHED"
    ]

    st.markdown("---")
    with st.expander(f"⚙️ Processing automatically ({processing_count})", expanded=False):
        st.caption("These jobs are advancing or retrying automatically. No user action is required.")
        if processing_jobs:
            st.dataframe([
                {
                    "Title": job.get("title"),
                    "Company": job.get("company"),
                    "State": job.get("processing_state"),
                    "Reason": job.get("current_artifact_reason") or "Automatic pipeline work",
                }
                for job in processing_jobs[:100]
            ], width="stretch")
        else:
            st.info("No jobs are awaiting automatic pipeline work.")

    with st.expander(f"🔴 Rejected / Unmatched ({rejected_count})", expanded=False):
        st.caption("Terminal career outcomes. These are not retry queues.")
        if unmatched_jobs:
            st.dataframe([
                {
                    "Title": job.get("title"),
                    "Company": job.get("company"),
                    "Reason": job.get("rejection_reason") or "UNMATCHED",
                }
                for job in unmatched_jobs[:100]
            ], width="stretch")
        else:
            st.info("No unmatched jobs in the current shortlist.")

    with st.expander(f"🛠️ Technical errors requiring support ({technical_error_count})", expanded=False):
        st.caption("These are dead-lettered processing dependencies, not career-review items.")
        if technical_error_jobs:
            st.dataframe([
                {
                    "Title": job.get("title"),
                    "Company": job.get("company"),
                    "State": job.get("processing_state"),
                    "Reason": job.get("current_artifact_reason") or job.get("rejection_reason"),
                }
                for job in technical_error_jobs[:100]
            ], width="stretch")
        else:
            st.info("No technical support items.")

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

            match_score = as_number(j.get("deterministic_match_score"))
            match_sort = -(match_score if match_score is not None else -1)

            priority_score = as_number(j.get("priority_score"))
            priority_sort = -(priority_score if priority_score is not None else -1)
            rank_score = as_number(j.get("overall_rank_score"))
            rank_sort = -(rank_score if rank_score is not None else -1)
            rank_missing = 1 if rank_score is None else 0

            return (rank_missing, rank_sort, outcome_rank, eligibility_rank, status_rank, match_sort, priority_sort)

        sorted_filtered_jobs = sorted(filtered_jobs, key=status_sort_key)
        listing_page_size = 25
        listing_page_count = max(1, (len(sorted_filtered_jobs) + listing_page_size - 1) // listing_page_size)
        listing_page = st.number_input(
            "Listings page",
            min_value=1,
            max_value=listing_page_count,
            value=1,
            step=1,
            key=f"application_listing_page_{workspace_category}",
        )
        start_index = (int(listing_page) - 1) * listing_page_size
        active_jobs = sorted_filtered_jobs[start_index:start_index + listing_page_size]
        rejected_jobs = [] if workspace_category == "Rejected / Unmatched" else rejected_jobs_audit

        st.subheader(f"{workspace_category} opportunities")
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
                        salary_note = salary_disclosure_message(job)
                        if salary_note:
                            st.caption(salary_note)

                        url = safe_http_url(job.get("canonical_url"))
                        if url:
                            st.markdown(f"**Verification Link:** [Go to Careers Portal]({url})")
                        else:
                            st.markdown("**Verification Link:** N/A")

                        match_score = job.get("deterministic_match_score")
                        coverage = job.get("deterministic_match_coverage")
                        match_str = format_score(match_score)
                        cov_str = format_percent(coverage)

                        evidence_pct = job.get("decision_evidence_completeness")
                        evidence_str = format_percent(evidence_pct, fraction=True, decimals=0)

                        st.markdown(f"**Deterministic match:** `{match_str}` | **Coverage:** `{cov_str}` | **Evidence completeness:** `{evidence_str}`")

                        aut = job.get("nd_friendly_score")
                        pol = job.get("politics_stress_score")
                        env = job.get("sensory_overload_index")

                        aut_str = format_percent(aut, decimals=0)
                        pol_str = format_percent(pol, decimals=0)
                        env_str = format_percent(env, decimals=0)

                        st.markdown(f"**Workplace signals:** Autonomy {aut_str} | Politics {pol_str} | Sensory {env_str}")
                        if outcome == "TRACK":
                            trace_notes = job.get("deterministic_trace_notes")
                            if isinstance(trace_notes, list) and trace_notes:
                                st.info(f"Why this is TRACK: {'; '.join(str(note) for note in trace_notes)}")
                            else:
                                st.info("Worth tracking: current deterministic fit/evidence is not yet sufficient for Apply Now. No gate or recommendation thresholds are changed by ranking.")
                            st.caption("Revisit when stronger current requirement coverage or profile evidence is available.")
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

                        if is_document_generation_eligible(job):
                            application_key = (job.get("canonical_job_id"), job.get("job_version_id"))
                            application_record = application_by_job.get(application_key) if application_by_job is not None else None
                            if application_records is None:
                                st.warning("Application tracker is unavailable; document generation remains available.")
                            elif application_record is None:
                                if st.button("Add to tracker", key=f"active_to_apply_{job.get('canonical_job_id')}"):
                                    try:
                                        save_application_status(job, "TO_APPLY")
                                    except Exception as exc:
                                        st.error(f"Could not update the application tracker: {exc}")
                            elif application_record.get("application_status") != "APPLIED":
                                if st.button("Mark applied", key=f"active_applied_{job.get('canonical_job_id')}"):
                                    try:
                                        save_application_status(job, "APPLIED", application_record)
                                    except Exception as exc:
                                        st.error(f"Could not update the application tracker: {exc}")
                            try:
                                render_job_document_actions(job, f"active_{job.get('canonical_job_id')}")
                            except subprocess.CalledProcessError as exc:
                                st.error(f"Document generation failed with exit code {exc.returncode}.")
                                if exc.stderr:
                                    st.code(exc.stderr, language="text")
                            except Exception as exc:
                                st.error(f"Document generation failed: {exc}")
                        
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
                                f"**Autonomy:** {format_signal(job.get('nd_friendly_score'))} | "
                                f"**Politics:** {format_signal(job.get('politics_stress_score'))} | "
                                f"**Sensory:** {format_signal(job.get('sensory_overload_index'))}"
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

            match_str = format_score(match_score)
            cov_str = format_percent(coverage)
            evidence_str = format_percent(evidence_pct, fraction=True, decimals=0)
            
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

            aut_str = format_percent(aut, decimals=0)
            pol_str = format_percent(pol, decimals=0)
            env_str = format_percent(env, decimals=0)

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
                    st.dataframe(preview_df, width="stretch")
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

with tab_applications:
    st.subheader("Application tracker")
    if application_records is None:
        st.error("Application tracker data is unavailable from the current workspace read model.")
    elif not application_records:
        st.info("No application records yet. Add a current Apply Now job to your tracker from the ranked list.")
    else:
        st.caption("Status changes are written through the managed API and recorded as append-only application events.")
        tracker_rows = [
            {
                "Company": record.get("company"),
                "Role": record.get("title"),
                "Status": record.get("application_status"),
                "Recommendation": record.get("recommendation_outcome"),
                "Rank context": "Current job version" if record.get("is_current_job_version") else "Historical job version",
                "CV": record.get("cv_document_status") or "NOT_GENERATED",
                "Cover letter": record.get("cover_letter_document_status") or "NOT_GENERATED",
                "Last updated": record.get("updated_at"),
            }
            for record in application_records
        ]
        st.dataframe(tracker_rows, hide_index=True, alt="Current and historical application tracker records")
        tracker_labels = {
            f"{record.get('company') or 'Unknown company'} — {record.get('title') or 'Untitled role'} ({record.get('application_status')})": record
            for record in application_records
        }
        selected_tracker_label = st.selectbox("Update application status", list(tracker_labels), key="application_tracker_record")
        selected_tracker_record = tracker_labels[selected_tracker_label]
        tracker_statuses = [
            "TO_APPLY", "APPLIED", "ASSESSMENT", "INTERVIEW", "OFFER",
            "REJECTED", "WITHDRAWN", "CLOSED", "INTENT", "READY_TO_APPLY",
            "SUBMITTED", "FOLLOW_UP",
        ]
        next_status = st.selectbox(
            "Status",
            tracker_statuses,
            index=tracker_statuses.index(selected_tracker_record["application_status"]),
            key=f"application_tracker_status_{selected_tracker_record['application_record_id']}",
        )
        if st.button("Save application status", key="save_application_tracker_status"):
            try:
                save_application_status({}, next_status, selected_tracker_record)
            except Exception as exc:
                st.error(f"Application status update failed: {exc}")
        st.caption(f"CV linked: {'yes' if selected_tracker_record.get('cv_document_run_id') else 'not generated'} · Cover letter linked: {'yes' if selected_tracker_record.get('cover_letter_document_run_id') else 'not generated'}")
        if get_api_base_url():
            try:
                event_response = api_request(
                    "GET",
                    f"/applications/{selected_tracker_record['application_record_id']}/events",
                    params={"limit": 50},
                )
                events = event_response.get("events") if isinstance(event_response, dict) else None
                if isinstance(events, list) and events:
                    st.dataframe(events, hide_index=True, alt="Application status-change event history")
            except Exception as exc:
                st.warning(f"Application history is temporarily unavailable: {exc}")

with tab_analytics:
    st.subheader("Company autonomy and culture analytics")
    st.write("Company culture scores are aggregated only from persisted, job-linked evaluation observations. Missing signals remain UNKNOWN.")

    try:
        analytics_data = fetch_company_analytics_from_db()
    except Exception as exc:
        analytics_data = None
        st.error(f"Company culture read model is unavailable: {exc}")

    if analytics_data is not None and analytics_data:
        try:
            company_coverage = fetch_company_culture_coverage()
            with st.container(horizontal=True):
                st.metric("Companies represented", company_coverage["companies_represented"])
                st.metric("Companies with jobs", company_coverage["companies_with_jobs"])
                st.metric("Culture observations present", company_coverage["companies_with_culture_observations"])
                st.metric("Medium/high confidence", company_coverage["companies_with_medium_high_confidence"])
        except Exception as exc:
            st.warning(f"Company coverage summary is unavailable: {exc}")
        display_rows = []
        chart_rows = []
        for row in analytics_data:
            display_rows.append({
                "Company": row.get("company_name"),
                "Jobs represented": row.get("company_job_count"),
                "Roles assessed": row.get("observation_count"),
                "Autonomy": format_signal(row.get("autonomy_score")),
                "Politics risk": format_signal(row.get("politics_risk_score")),
                "Sensory/workload risk": format_signal(row.get("sensory_workload_risk_score")),
                "Focus protection": format_signal(row.get("focus_protection_score")),
                "Evidence confidence": row.get("confidence_level") or "UNKNOWN",
                "Safety / compatibility assessment": (
                    "UNKNOWN" if row.get("confidence_level") in (None, "UNKNOWN", "LOW")
                    else "Evidence available — human review"
                ),
                "Last updated": row.get("last_updated"),
            })
            autonomy = as_number(row.get("autonomy_score"))
            politics = as_number(row.get("politics_risk_score"))
            if autonomy is not None or politics is not None:
                chart_rows.append({
                    "Company": row.get("company_name"),
                    "Autonomy": float(autonomy) if autonomy is not None else None,
                    "Politics risk": float(politics) if politics is not None else None,
                })

        st.dataframe(
            display_rows,
            hide_index=True,
            alt="Company culture estimates with role coverage, confidence, and last updated time",
        )
        company_options = {
            row["company_name"]: row
            for row in analytics_data
            if row.get("company_name") and row.get("workspace_company_id")
        }
        if company_options:
            selected_company_name = st.selectbox(
                "Inspect company-level evidence",
                list(company_options),
                key="company_culture_evidence_company",
            )
            try:
                observations = fetch_company_culture_evidence(
                    company_options[selected_company_name]["workspace_company_id"]
                )
                observation_rows = []
                for observation in observations:
                    evidence_map = observation.get("evidence_by_signal")
                    if isinstance(evidence_map, str):
                        evidence_map = json.loads(evidence_map)
                    if not isinstance(evidence_map, dict):
                        evidence_map = {}
                    def culture_quote(signal):
                        evidence = evidence_map.get(signal)
                        return evidence.get("quote") if isinstance(evidence, dict) else None
                    observation_rows.append({
                        "Role": observation.get("role_title"),
                        "Observed": observation.get("observed_at"),
                        "Autonomy evidence": culture_quote("AUTONOMY"),
                        "Politics evidence": culture_quote("POLITICS_RISK"),
                        "Sensory/workload evidence": culture_quote("SENSORY_WORKLOAD_RISK"),
                        "Focus evidence": culture_quote("FOCUS_PROTECTION"),
                        "Source": observation.get("source_type"),
                    })
                if observation_rows:
                    st.dataframe(
                        observation_rows,
                        hide_index=True,
                        alt="Job-description evidence supporting the selected company culture signals",
                    )
                else:
                    st.info("No job-level culture evidence is available for this company yet.")
            except Exception as exc:
                st.error(f"Company culture evidence could not be loaded: {exc}")
        if chart_rows:
            st.subheader("Observed autonomy and politics-risk scores")
            st.bar_chart(pd.DataFrame(chart_rows).set_index("Company"), alt="Observed company autonomy and politics-risk scores")
        else:
            st.info("Culture observations exist, but no numeric company signal is available yet.")
    elif analytics_data is not None:
        st.info("No company culture observations have been materialized yet. Unassessed companies remain UNKNOWN.")

    st.markdown("---")
    st.subheader("Source Health (Compliance-Aware)")
    st.caption("Counts are based on staged raw observations. Compliance metadata comes from source plugin manifests.")
    if get_api_base_url():
        try:
            resp = api_request("GET", "/api/v2/sources/health", timeout=30)
            sources = resp.get("sources") if isinstance(resp, dict) else None
            if isinstance(resp, dict) and resp.get("ok") and isinstance(sources, list) and sources:
                sdf = pd.DataFrame(sources)
                st.dataframe(sdf, width="stretch")
            elif isinstance(resp, dict) and resp.get("ok") and isinstance(sources, list) and not sources:
                st.info("No source plugin rows found yet. Run `npm run sources:sync` and ingest at least one source.")
            else:
                st.warning(f"Source health endpoint returned an unexpected payload: {resp}")
        except Exception as e:
            st.error(f"Failed to fetch source health from API: {e}")
    else:
        st.info("Source plugin health analytics are available when connected to the backend API.")

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

    include_track_jobs = st.checkbox(
        "Include TRACK jobs",
        value=False,
        help="Add current TRACK opportunities to document generation choices.",
        key="include_track_documents",
    )
    eligible_jobs = [
        job
        for job in jobs_list
        if is_document_generation_eligible(job, include_track=include_track_jobs)
    ]
    try:
        ranked_application_jobs = fetch_apply_now_jobs()
        rank_by_job_version = {
            (job["canonical_job_id"], job["job_version_id"]): as_number(job.get("overall_rank_score"))
            for job in ranked_application_jobs
        }
    except Exception as exc:
        ranked_application_jobs = None
        rank_by_job_version = {}
        st.warning(f"Final ranking data is unavailable for CV selection: {exc}")
    top_ten_positions = {
        (job["canonical_job_id"], job["job_version_id"]): position
        for position, job in enumerate(top_ten_ready_jobs or [], start=1)
    } if top_ten_ready_jobs is not None else {}
    def document_job_sort_key(job):
        job_version = (job.get("canonical_job_id"), job.get("job_version_id"))
        final_rank = rank_by_job_version.get(job_version)
        return (
            0 if job_version in top_ten_positions else 1,
            0 if job.get("decision_outcome") == "PRIORITY" else 1,
            top_ten_positions.get(job_version, 999),
            -(final_rank if final_rank is not None else -1),
        )

    eligible_jobs.sort(key=document_job_sort_key)

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

        render_job_document_actions(selected_job, f"selected_{selected_job['canonical_job_id']}")

# Footer section
st.markdown("---")
st.markdown("<p class='disclaimer'>Job Decision Engine V5 • Recommendations and documents remain human-reviewed</p>", unsafe_allow_html=True)
