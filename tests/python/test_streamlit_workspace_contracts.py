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


WORKSPACE_ID = "workspace-1"


def test_workspace_summary_contract_validates_scope_member_and_counts():
    summary = {
        "workspace_id": WORKSPACE_ID,
        "user_id": "user-1",
        "user_key": "member-1",
        "total_jobs": 10,
        "apply_now_count": 2,
        "track_count": 3,
        "processing_count": 1,
        "rejected_unmatched_count": 4,
        "applied_count": 0,
        "technical_errors": 0,
        "skip_count": 0,
        "top_ten_ready_count": 1,
    }
    validate_application_workspace_summary(summary, WORKSPACE_ID, "member-1")
    try:
        validate_application_workspace_summary(
            summary | {"processing_count": -1}, WORKSPACE_ID, "member-1"
        )
    except ValueError:
        pass
    else:
        raise AssertionError("Workspace summary accepted a negative count")


def test_company_culture_evidence_and_coverage_contracts_validate_provenance():
    evidence = {
        "workspace_id": WORKSPACE_ID,
        "workspace_company_id": "company-1",
        "company_name": "Example",
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "ai_evaluation_id": "evaluation-1",
        "evidence_by_signal": {"autonomy": {"quote": "Team autonomy"}},
        "source_type": "JOB_DESCRIPTION",
        "autonomy_signal": 65.0,
    }
    validate_company_culture_evidence_row(evidence, WORKSPACE_ID)
    try:
        validate_company_culture_evidence_row(
            evidence | {"evidence_by_signal": []}, WORKSPACE_ID
        )
    except TypeError:
        pass
    else:
        raise AssertionError("Company evidence accepted an invalid provenance map")

    coverage = {
        "workspace_id": WORKSPACE_ID,
        "companies_represented": 5,
        "companies_with_jobs": 4,
        "companies_with_culture_observations": 2,
        "companies_with_medium_high_confidence": 1,
    }
    validate_company_culture_coverage_summary(coverage, WORKSPACE_ID)


def test_apply_now_contract_requires_deterministic_apply_eligibility():
    row = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "title": "Engineer",
        "company": "Example",
        "gate_status": "PASS",
        "recommendation_eligibility": "ELIGIBLE",
        "recommendation_outcome": "REVIEW",
        "current_artifact_status": "EVALUATION_MISSING",
        "policy_recheck_required": False,
        "overall_rank_score": None,
        "ranking_confidence": None,
    }
    validate_apply_now_row(row, WORKSPACE_ID)

    try:
        validate_apply_now_row(row | {"recommendation_outcome": "TRACK"}, WORKSPACE_ID)
    except ValueError:
        pass
    else:
        raise AssertionError("Apply Now contract accepted a TRACK decision")


def test_top_ten_contract_requires_all_current_artifacts_and_no_recheck():
    row = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "profile_version_id": "profile-1",
        "match_run_id": "match-1",
        "deterministic_decision_id": "decision-1",
        "ai_evaluation_id": "evaluation-1",
        "ranking_policy_version": 1,
        "ranking_context_fingerprint": "context-1",
        "ranking_position": 1,
        "overall_rank_score": 82.5,
        "ranking_confidence": 97.5,
        "is_top_ten_ready": True,
        "policy_recheck_required": False,
        "recommendation_eligibility": "ELIGIBLE",
        "recommendation_outcome": "REVIEW",
        "gate_status": "PASS",
        "primary_lane": "CORE_AI_DATA",
    }
    validate_ranked_job_row(row, WORKSPACE_ID)

    try:
        validate_ranked_job_row(row | {"policy_recheck_required": True}, WORKSPACE_ID)
    except ValueError:
        pass
    else:
        raise AssertionError("Top 10 contract accepted a pending policy recheck")


def test_track_contract_requires_decision_trace_notes():
    row = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "title": "Engineer",
        "company": "Example",
        "gate_status": "PASS",
        "recommendation_outcome": "TRACK",
        "deterministic_decision_id": "decision-1",
        "deterministic_context_fingerprint": "context-1",
        "deterministic_trace_notes": ["coverage below review threshold"],
    }
    validate_track_row(row, WORKSPACE_ID)


def test_application_contract_rejects_cross_user_rows():
    row = {
        "workspace_id": WORKSPACE_ID,
        "user_id": "user-1",
        "application_record_id": "application-1",
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "title": "Engineer",
        "company": "Example",
        "application_status": "TO_APPLY",
        "cv_document_status": "NOT_GENERATED",
        "cover_letter_document_status": "STALE",
    }
    validate_application_row(row, WORKSPACE_ID, "user-1")
    try:
        validate_application_row(row, WORKSPACE_ID, "user-2")
    except ValueError:
        pass
    else:
        raise AssertionError("Application contract accepted another user's row")


def test_company_culture_contract_preserves_unknown_signals():
    row = {
        "workspace_id": WORKSPACE_ID,
        "workspace_company_id": "company-1",
        "company_name": "Example",
        "company_job_count": 3,
        "observation_count": 1,
        "autonomy_score": None,
        "politics_risk_score": 23.5,
        "sensory_workload_risk_score": None,
        "focus_protection_score": None,
        "confidence_level": "LOW",
        "last_updated": None,
    }
    validate_company_culture_row(row, WORKSPACE_ID)
    try:
        validate_company_culture_row(
            row | {"autonomy_score": float("nan")}, WORKSPACE_ID
        )
    except ValueError:
        pass
    else:
        raise AssertionError("Company culture contract accepted a non-finite score")


def test_profile_evidence_and_coverage_contracts_require_workspace_scope():
    evidence = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "profile_version_id": "profile-1",
        "match_run_id": "match-1",
        "requirement_id": "requirement-1",
        "requirement_key": "R-001",
        "importance": "MUST",
        "requirement_text": "Production ML systems",
        "match_type": "EXACT",
        "match_score": 0.91,
        "evidence_tier": "PROFESSIONAL_PRODUCTION",
    }
    validate_profile_evidence_row(evidence, WORKSPACE_ID)
    try:
        validate_profile_evidence_row(evidence, "other-workspace")
    except ValueError:
        pass
    else:
        raise AssertionError("Profile evidence contract accepted another workspace")

    coverage = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "profile_version_id": "profile-1",
        "profile_version_number": 7,
        "match_run_id": "match-1",
        "must_matched_count": 4,
        "must_missing_count": 0,
        "preferred_matched_count": 2,
        "preferred_missing_count": 1,
        "exact_match_count": 4,
        "semantic_match_count": 2,
        "active_credential_count": 1,
        "engagement_count": 3,
    }
    validate_profile_coverage_row(coverage, WORKSPACE_ID)
    try:
        validate_profile_coverage_row(
            coverage | {"profile_version_number": "7"}, WORKSPACE_ID
        )
    except TypeError:
        pass
    else:
        raise AssertionError(
            "Profile coverage contract accepted a string version number"
        )
