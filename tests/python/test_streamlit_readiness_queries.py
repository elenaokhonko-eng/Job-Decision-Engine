import ast
from pathlib import Path

from streamlit_application_workflow import is_document_generation_eligible


QUERY_NAMES = (
    "SHORTLIST_READ_MODEL_QUERY",
    "APPLY_NOW_JOBS_QUERY",
    "TRACK_JOBS_QUERY",
    "TOP_TEN_READY_QUERY",
)
READINESS_FIELDS = (
    "readiness_status",
    "readiness_fingerprint",
    "readiness_expires_at",
    "readiness_reason_codes",
    "availability_status",
    "availability_recheck_at",
)


def read_query_constant(name: str) -> str:
    app_path = Path(__file__).resolve().parents[2] / "streamlit_app.py"
    module = ast.parse(app_path.read_text(encoding="utf-8"))
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == name
            for target in node.targets
        ):
            value = ast.literal_eval(node.value)
            if isinstance(value, str):
                return value
    raise AssertionError(f"Streamlit query constant {name} was not found.")


def test_direct_shortlist_queries_project_all_readiness_fields():
    for name in QUERY_NAMES:
        query = read_query_constant(name)
        assert "v_application_readiness_current" in query
        for field in READINESS_FIELDS:
            assert field in query, f"{name} does not select {field}"


def test_ready_apply_now_row_exposes_documents_and_unresolved_readiness_blocks_them():
    ready_row = {
        "canonical_job_id": "22222222-2222-4222-8222-222222222222",
        "job_version_id": "33333333-3333-4333-8333-333333333333",
        "latest_match_run_id": "44444444-4444-4444-8444-444444444444",
        "gate_status": "PASS",
        "decision_eligibility": "ELIGIBLE",
        "decision_outcome": "REVIEW",
        "current_artifact_status": "EVALUATION_MISSING",
        "readiness_status": "READY",
        "readiness_fingerprint": "a" * 64,
        "readiness_expires_at": "2099-01-01T00:00:00Z",
        "readiness_reason_codes": [],
        "availability_status": "OPEN",
        "availability_recheck_at": "2099-01-01T00:00:00Z",
    }
    assert is_document_generation_eligible(ready_row)

    unresolved_row = ready_row | {
        "readiness_status": "NEEDS_VERIFICATION",
        "readiness_reason_codes": ["COMPENSATION_BASIS_UNRESOLVED"],
    }
    assert not is_document_generation_eligible(unresolved_row)
