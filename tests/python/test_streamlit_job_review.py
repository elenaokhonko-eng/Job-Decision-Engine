import ast
import re
from pathlib import Path

import pytest

from streamlit_job_review import (
    CATEGORY_OPTIONS,
    DEFAULT_CATEGORY_INDEX,
    REVIEW_CATEGORY,
    SERVER_PAGED_CATEGORIES,
    VERIFY_THEN_APPLY_CATEGORY,
    apply_now_exclusion_reasons,
    apply_now_exclusion_summary,
    escape_markdown,
    filter_by_sidebar,
    page_count,
    review_option_label,
    review_selector_options,
    unresolved_readiness_checks,
    verification_action_applies,
    verification_question_for_job,
)
from streamlit_workspace_contracts import validate_review_row

APP_PATH = Path(__file__).resolve().parents[2] / "streamlit_app.py"
WORKSPACE_ID = "11111111-1111-4111-8111-111111111111"
REVIEW_FIELDS = (
    "processing_state",
    "gate_status",
    "rejection_codes",
    "gate_evidence_quotes",
    "workability_facts",
    "primary_lane",
    "recommendation_eligibility",
    "recommendation_outcome",
    "readiness_status",
    "readiness_reason_codes",
    "application_readiness",
    "evaluation_summary",
    "current_artifact_status",
    "nd_friendly_score",
    "politics_stress_score",
    "sensory_overload_index",
)


def app_source() -> str:
    return APP_PATH.read_text(encoding="utf-8")


def read_query_constant(name: str) -> str:
    module = ast.parse(app_source())
    for node in module.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == name
            for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise AssertionError(f"Streamlit query constant {name} was not found.")


def selected_columns(query: str) -> set[str]:
    select_list = query.split("FROM", 1)[0]
    return {
        match.group(1)
        for match in re.finditer(
            r"(?:\b[a-z_]+\.)?\b([a-z_]+)\s*(?:,|$)", select_list, re.MULTILINE
        )
    }


def job(**overrides):
    row = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "22222222-2222-4222-8222-222222222222",
        "job_version_id": "33333333-3333-4333-8333-333333333333",
        "title": "Data Scientist",
        "company": "Example Labs",
        "source": "GREENHOUSE",
        "primary_lane": "CORE_AI_DATA",
        "processing_state": "MATCHED",
        "gate_status": "PASS",
        "rejection_codes": [],
        "gate_evidence_quotes": [],
        "recommendation_eligibility": "ELIGIBLE",
        "recommendation_outcome": "REVIEW",
        "current_artifact_status": "CURRENT_OR_NOT_APPLICABLE",
        "current_artifact_reason": None,
        "readiness_status": "READY",
        "readiness_fingerprint": "a" * 64,
        "readiness_expires_at": "2099-01-01T00:00:00+00:00",
        "readiness_reason_codes": [],
        "availability_status": "OPEN",
        "availability_recheck_at": "2099-01-01T00:00:00+00:00",
        "in_apply_now": False,
    }
    row.update(overrides)
    return row


@pytest.mark.parametrize(
    "name", ["TRACK_JOBS_QUERY", "VERIFY_THEN_APPLY_JOBS_QUERY", "REVIEW_JOBS_QUERY"]
)
def test_review_queries_select_every_field_the_detail_panel_shows(name):
    columns = selected_columns(read_query_constant(name))
    missing = [field for field in REVIEW_FIELDS if field not in columns]
    assert not missing, f"{name} does not select {missing}"


@pytest.mark.parametrize(
    "name", ["TRACK_JOBS_QUERY", "VERIFY_THEN_APPLY_JOBS_QUERY", "REVIEW_JOBS_QUERY"]
)
def test_review_queries_read_only_scoped_read_models(name):
    query = read_query_constant(name)
    tables = set(re.findall(r"\b(?:FROM|JOIN)\s+([a-z0-9_]+)", query))
    assert tables <= {
        "v_track_jobs_scoped",
        "v_canonical_shortlist_scoped",
        "v_application_readiness_current",
        "v_apply_now_jobs_stage3_scoped",
    }, tables
    assert "WHERE jobs.workspace_id = %s" in query


def test_review_query_lists_every_review_decision_whatever_its_gate_or_artifact():
    query = read_query_constant("REVIEW_JOBS_QUERY")
    assert "jobs.recommendation_outcome = 'REVIEW'" in query
    assert "LEFT JOIN LATERAL" in query
    for narrowing in (
        "gate_status =",
        "current_artifact_status",
        "recommendation_eligibility =",
    ):
        assert narrowing not in query.split("WHERE", 1)[1]


def test_review_category_sits_between_verify_and_track_and_top_10_stays_first():
    assert CATEGORY_OPTIONS[0] == "Top 10"
    assert CATEGORY_OPTIONS[DEFAULT_CATEGORY_INDEX] == "Apply Now"
    index = CATEGORY_OPTIONS.index(REVIEW_CATEGORY)
    assert CATEGORY_OPTIONS[index - 1] == VERIFY_THEN_APPLY_CATEGORY
    assert CATEGORY_OPTIONS[index + 1] == "Track"


def test_review_rows_validate_with_unresolved_gate_or_missing_readiness():
    validate_review_row(
        job(
            gate_status="NEEDS_VERIFICATION",
            recommendation_eligibility="VERIFY",
            rejection_codes=["GATE_UNKNOWN_WORK_MODE"],
            readiness_status=None,
            readiness_reason_codes=None,
        ),
        WORKSPACE_ID,
    )
    with pytest.raises(ValueError, match="REVIEW"):
        validate_review_row(job(recommendation_outcome="TRACK"), WORKSPACE_ID)
    with pytest.raises(ValueError, match="workspace"):
        validate_review_row(job(), "99999999-9999-4999-8999-999999999999")
    with pytest.raises(TypeError, match="rejection_codes"):
        validate_review_row(job(rejection_codes="GATE_UNKNOWN_WORK_MODE"), WORKSPACE_ID)


def test_selector_lists_every_job_in_the_category_not_only_ai_evaluated_ones():
    rows = [
        job(processing_state="MATCHED", recommendation_outcome="TRACK"),
        job(
            canonical_job_id="44444444-4444-4444-8444-444444444444",
            processing_state="AI_EVALUATED",
        ),
        job(
            canonical_job_id="55555555-5555-4555-8555-555555555555",
            processing_state="NEEDS_VERIFICATION",
            recommendation_eligibility="VERIFY",
        ),
    ]
    options = review_selector_options(rows)
    assert list(options.values()) == rows
    assert len(set(options)) == 3
    label = review_option_label(rows[0])
    assert "Example Labs" in label and "Data Scientist" in label
    assert "[TRACK/ELIGIBLE, MATCHED]" in label
    assert "UNKNOWN" not in label


def test_selector_keys_stay_on_the_same_job_when_the_list_changes():
    first = job()
    second = job(canonical_job_id="44444444-4444-4444-8444-444444444444")
    key = next(
        key
        for key, row in review_selector_options([first, second]).items()
        if row is second
    )
    assert review_selector_options([second])[key] is second
    assert len(review_selector_options([first, first])) == 2


def test_verification_action_shows_on_verify_rows_of_track_and_review_only():
    verify_row = job(recommendation_eligibility="VERIFY")
    eligible_row = job()
    assert verification_action_applies(eligible_row, VERIFY_THEN_APPLY_CATEGORY)
    assert verification_action_applies(verify_row, "Track")
    assert verification_action_applies(verify_row, REVIEW_CATEGORY)
    assert not verification_action_applies(eligible_row, "Track")
    assert not verification_action_applies(eligible_row, REVIEW_CATEGORY)
    for category in ("Apply Now", "Top 10", "All", "Processing", "Skip"):
        assert not verification_action_applies(verify_row, category)
    assert not verification_action_applies(
        job(recommendation_eligibility="VERIFY", job_version_id=None), "Track"
    )
    # The listing's derived decision fields take precedence over the read-model fields.
    assert verification_action_applies(job(decision_eligibility="VERIFY"), "Track")


def test_verification_question_names_the_open_workability_facts():
    question = verification_question_for_job(
        job(
            rejection_codes=[
                "NEEDS_VERIFICATION",
                "GATE_UNKNOWN_WORK_MODE",
                "NEEDS_VERIFICATION_OFFICE_DAYS",
            ]
        )
    )
    assert "remote, hybrid, or on-site" in question
    assert "days per week" in question
    territory = verification_question_for_job(
        job(
            rejection_codes=[
                "NEEDS_VERIFICATION",
                "NEEDS_VERIFICATION_HIRING_TERRITORY",
            ]
        )
    )
    assert "hire someone based in Singapore" in territory
    assert "days per week" not in territory
    travel = verification_question_for_job(
        job(rejection_codes=["NEEDS_VERIFICATION", "NEEDS_VERIFICATION_TRAVEL"])
    )
    assert "travel percentage" in travel
    assert "days per week" not in travel
    assert "gate evidence" in verification_question_for_job(job(rejection_codes=None))
    track_verify = job(
        recommendation_eligibility="VERIFY",
        readiness_status="NEEDS_VERIFICATION",
        readiness_reason_codes=["POLICY_FACT_UNRESOLVED"],
    )
    assert "POLICY_FACT_UNRESOLVED" in verification_question_for_job(track_verify)


def test_unresolved_readiness_checks_lists_only_checks_needing_verification():
    row = job(
        application_readiness={
            "checks": [
                {
                    "key": "WORKABILITY",
                    "status": "NEEDS_VERIFICATION",
                    "reason_code": "WORK_MODE_UNVERIFIED",
                },
                {"key": "COMPENSATION", "status": "READY", "reason_code": None},
                "not a check",
            ]
        }
    )
    assert unresolved_readiness_checks(row) == ["WORKABILITY: WORK_MODE_UNVERIFIED"]
    assert unresolved_readiness_checks(job(application_readiness=None)) == []


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"current_artifact_status": "MATCH_STALE"}, "re-match"),
        ({"current_artifact_status": "DECISION_STALE"}, "decide again"),
        (
            {
                "current_artifact_status": "BLOCKED_DEPENDENCY",
                "current_artifact_reason": "PROFILE_EMBEDDINGS_MISSING",
            },
            "PROFILE_EMBEDDINGS_MISSING",
        ),
        (
            {
                "gate_status": "NEEDS_VERIFICATION",
                "rejection_codes": ["GATE_UNKNOWN_WORK_MODE"],
            },
            "GATE_UNKNOWN_WORK_MODE",
        ),
        ({"recommendation_eligibility": "VERIFY"}, "Eligibility is VERIFY"),
        (
            {
                "readiness_status": "NEEDS_VERIFICATION",
                "readiness_reason_codes": ["POLICY_FACT_UNRESOLVED"],
            },
            "POLICY_FACT_UNRESOLVED",
        ),
    ],
)
def test_review_rows_explain_why_they_are_not_in_apply_now(overrides, expected):
    reasons = apply_now_exclusion_reasons(job(**overrides))
    assert len(reasons) == 1
    assert expected in reasons[0]
    assert apply_now_exclusion_summary(job(**overrides)).startswith("Not in Apply Now:")


def test_apply_now_membership_comes_from_the_read_model_not_the_python_rules():
    # Meets every condition the helper can check, but the Stage 3 Apply Now
    # view does not list it (e.g. no ranking snapshot): never claim membership.
    assert apply_now_exclusion_reasons(job()) == []
    summary = apply_now_exclusion_summary(job(in_apply_now=False))
    assert summary.startswith("Not in Apply Now:")
    assert "ranking" in summary
    assert apply_now_exclusion_summary(job(in_apply_now=True)) == "Listed in Apply Now."
    unknown = apply_now_exclusion_summary(job(in_apply_now=None))
    assert "unknown" in unknown and "Listed in Apply Now" not in unknown


def test_review_query_reads_apply_now_membership_from_the_stage3_view():
    query = read_query_constant("REVIEW_JOBS_QUERY")
    assert "FROM v_apply_now_jobs_stage3_scoped AS apply_now" in query
    assert ") AS in_apply_now" in query
    assert "apply_now.job_version_id::text = jobs.job_version_id::text" in query


def test_review_rows_require_a_boolean_apply_now_flag():
    row = job()
    del row["in_apply_now"]
    with pytest.raises(ValueError, match="in_apply_now"):
        validate_review_row(row, WORKSPACE_ID)
    with pytest.raises(TypeError, match="in_apply_now"):
        validate_review_row(job(in_apply_now=None), WORKSPACE_ID)


def test_listing_decision_line_is_plain_text_not_markdown():
    source = app_source()
    assert (
        'st.text(f"Decision: {outcome} ({eligibility}) | Gate: {gate_status}")'
        in source
    )
    assert "**Decision:** `{outcome}`" not in source


def test_sidebar_filters_apply_to_self_sourced_categories():
    rows = [
        job(title="ML Engineer", primary_lane="CORE_AI_DATA", source="LEVER"),
        job(title="Legal Analyst", primary_lane="LEGAL_REGTECH", source="GREENHOUSE"),
        job(title="Unrouted", primary_lane=None, source=None),
    ]
    common = {
        "lane_filter": "All Lanes",
        "status_filter": "All Statuses",
        "board_filter": "All Sources",
        "track_filter": "All Tracks",
    }
    assert filter_by_sidebar(rows, **common) == rows
    assert filter_by_sidebar(rows, **(common | {"lane_filter": "LEGAL_REGTECH"})) == [
        rows[1]
    ]
    assert filter_by_sidebar(rows, **(common | {"board_filter": "UNKNOWN"})) == [
        rows[2]
    ]
    assert filter_by_sidebar(rows, **(common | {"track_filter": "Unassigned"})) == [
        rows[2]
    ]
    assert filter_by_sidebar(rows, **(common | {"status_filter": "AI_EVALUATED"})) == []
    assert filter_by_sidebar(rows, **common, search_query="legal") == [rows[1]]


def test_page_count_handles_unknown_and_partial_pages():
    assert page_count(None) == 1
    assert page_count(0) == 1
    assert page_count(25) == 1
    assert page_count(26) == 2
    assert SERVER_PAGED_CATEGORIES == {"Archive", "Rejected", "Unmatched", "Removed"}


def test_app_shows_one_page_control_per_category_and_reviews_every_job():
    source = app_source()
    category_section = source.split('"Opportunity category"', 1)[1].split(
        "with col_right:", 1
    )[0]
    page_inputs = re.findall(r'number_input\(\s*"([^"]+)"', category_section)
    # One server-paged control (Archive, Rejected) and one listing control for
    # every other category, in mutually exclusive branches.
    assert page_inputs == ["Page", "Page"]
    assert (
        category_section.count("if workspace_category in SERVER_PAGED_CATEGORIES:") == 2
    )
    assert '"Listings page"' not in source
    assert "if workspace_category in SERVER_PAGED_CATEGORIES:" in source
    assert 'processing_state") == "AI_EVALUATED"]' not in source
    assert "No Evaluated Jobs Available" not in source
    assert "review_selector_options(" in source
    assert (
        "unsafe_allow_html"
        not in source.split("with col_right:", 1)[1].split("with tab_add_job:", 1)[0]
    )


def test_markdown_escaping_neutralises_links_html_and_formatting():
    escaped = escape_markdown(
        "[click](javascript:alert(1)) <b>x</b> **bold** $x$\nnext"
    )
    for raw in ("[click]", "](", "<b>", "**", "$x$"):
        assert raw not in escaped
    assert "\n" not in escaped
    assert escape_markdown(None) == ""
