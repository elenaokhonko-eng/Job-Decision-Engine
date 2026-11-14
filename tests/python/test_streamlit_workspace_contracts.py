from pathlib import Path
import re

import pytest

from streamlit_workspace_contracts import (
    LANE_FILTER_OPTIONS,
    TARGET_LANE_KEYS,
    UNCLASSIFIED_LANE,
    validate_application_row,
    validate_application_workspace_summary,
    validate_apply_now_row,
    validate_archive_job_row,
    validate_company_culture_coverage_summary,
    validate_company_culture_evidence_row,
    validate_company_culture_row,
    validate_document_selection_row,
    validate_profile_coverage_row,
    validate_profile_evidence_row,
    validate_ranked_job_row,
    validate_status_bucket_counts,
    validate_status_bucket_row,
    validate_support_issue_row,
    validate_track_row,
    validate_verify_then_apply_row,
)

WORKSPACE_ID = "workspace-1"
REPO_ROOT = Path(__file__).resolve().parents[2]


def test_target_lane_keys_match_the_lane_registry():
    registry = (REPO_ROOT / "config" / "lanes" / "registry.yml").read_text(
        encoding="utf-8"
    )
    registry_keys = tuple(
        re.findall(r"^\s*-\s*lane_key:\s*([A-Z0-9_]+)\s*$", registry, re.MULTILINE)
    )

    assert TARGET_LANE_KEYS == registry_keys
    assert "TECHNICAL_PRODUCT_TRANSFORMATION" in TARGET_LANE_KEYS
    assert "INVESTIGATIONS_ENFORCEMENT" in TARGET_LANE_KEYS
    assert LANE_FILTER_OPTIONS == ("All Lanes", *registry_keys, UNCLASSIFIED_LANE)


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
        "rejected_count": 2,
        "unmatched_count": 1,
        "removed_count": 1,
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
    with pytest.raises(ValueError, match="do not add up"):
        validate_application_workspace_summary(
            summary | {"unmatched_count": 2}, WORKSPACE_ID, "member-1"
        )
    without_split = {
        key: value for key, value in summary.items() if key != "removed_count"
    }
    with pytest.raises(ValueError, match="removed_count"):
        validate_application_workspace_summary(without_split, WORKSPACE_ID, "member-1")


def _bucket_counts(**overrides):
    counts = {
        "workspace_id": WORKSPACE_ID,
        "total_jobs": 11,
        "apply_now_count": 1,
        "review_awaiting_ai_count": 1,
        "review_evaluated_not_ready_count": 1,
        "track_count": 1,
        "needs_verification_count": 1,
        "processing_count": 1,
        "skip_count": 1,
        "technical_error_count": 1,
        "rejected_count": 1,
        "unmatched_count": 1,
        "removed_count": 1,
    }
    return counts | overrides


def test_status_bucket_counts_must_partition_total_jobs():
    validate_status_bucket_counts(_bucket_counts(), WORKSPACE_ID)
    with pytest.raises(ValueError, match="total_jobs"):
        validate_status_bucket_counts(_bucket_counts(total_jobs=12), WORKSPACE_ID)
    with pytest.raises(ValueError, match="workspace"):
        validate_status_bucket_counts(_bucket_counts(), "other-workspace")


def test_status_bucket_row_requires_a_known_bucket():
    row = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "title": "Engineer",
        "company": "Example",
        "processing_state": "UNMATCHED",
        "status_bucket": "UNMATCHED",
        "status_reason": "NO_ACTIVE_LANE_MATCH",
    }
    validate_status_bucket_row(row, WORKSPACE_ID)
    with pytest.raises(ValueError, match="known bucket"):
        validate_status_bucket_row(
            row | {"status_bucket": "REJECTED_UNMATCHED"}, WORKSPACE_ID
        )


def test_support_issue_row_offers_only_known_actions():
    row = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "title": "Engineer",
        "company": "Example",
        "processing_state": "PROCESSING_ERROR",
        "issue_class": "DESCRIPTION_INCOMPLETE",
        "issue_detail": "DESCRIPTION_CONTENT_INCOMPLETE",
        "task_ids": ["task-1"],
        "available_actions": ["FETCH_DESCRIPTION", "PASTE_DESCRIPTION", "DISMISS"],
    }
    validate_support_issue_row(row, WORKSPACE_ID)
    with pytest.raises(ValueError, match="unknown actions"):
        validate_support_issue_row(
            row | {"available_actions": ["DELETE"]}, WORKSPACE_ID
        )
    with pytest.raises(ValueError, match="at least one action"):
        validate_support_issue_row(row | {"available_actions": []}, WORKSPACE_ID)
    with pytest.raises(ValueError, match="class"):
        validate_support_issue_row(row | {"issue_class": "HARD_REJECTED"}, WORKSPACE_ID)


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
        "readiness_status": "READY",
        "readiness_fingerprint": "a" * 64,
        "readiness_expires_at": "2099-01-01T00:00:00Z",
        "readiness_reason_codes": [],
        "availability_status": "OPEN",
        "availability_recheck_at": "2099-01-01T00:00:00Z",
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

    try:
        validate_apply_now_row(
            row
            | {
                "readiness_status": "NEEDS_VERIFICATION",
                "readiness_reason_codes": ["COMPENSATION_BASIS_UNRESOLVED"],
            },
            WORKSPACE_ID,
        )
    except ValueError:
        pass
    else:
        raise AssertionError("Apply Now contract accepted unresolved readiness")


def test_verify_then_apply_contract_requires_matched_review_and_unresolved_readiness():
    row = {
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "title": "Director, AI Solution Architect",
        "company": "Example AI",
        "gate_status": "NEEDS_VERIFICATION",
        "rejection_codes": ["GATE_UNKNOWN_WORK_MODE", "NEEDS_VERIFICATION"],
        "gate_evidence_quotes": ["Workplace model is unspecified."],
        "processing_state": "MATCHED",
        "recommendation_eligibility": "VERIFY",
        "recommendation_outcome": "REVIEW",
        "deterministic_match_score": 82.0,
        "readiness_status": "NEEDS_VERIFICATION",
        "readiness_reason_codes": ["POLICY_FACT_UNRESOLVED"],
    }
    validate_verify_then_apply_row(row, WORKSPACE_ID)

    try:
        validate_verify_then_apply_row(
            row | {"readiness_status": "READY"}, WORKSPACE_ID
        )
    except ValueError:
        pass
    else:
        raise AssertionError("Verify-then-apply contract accepted a READY row")

    try:
        validate_verify_then_apply_row(
            row | {"processing_state": "NEEDS_VERIFICATION"}, WORKSPACE_ID
        )
    except ValueError:
        pass
    else:
        raise AssertionError(
            "Verify-then-apply contract accepted a row without a completed match"
        )


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
        "readiness_status": "READY",
        "readiness_fingerprint": "a" * 64,
        "readiness_expires_at": "2099-01-01T00:00:00Z",
        "readiness_reason_codes": [],
        "availability_status": "OPEN",
        "availability_recheck_at": "2099-01-01T00:00:00Z",
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


def test_archive_job_contract_validates_basis_scope_and_timestamps():
    row = {
        "schema_version": "job_archive_v1",
        "workspace_id": WORKSPACE_ID,
        "canonical_job_id": "job-1",
        "job_version_id": "version-1",
        "title": "Archived data engineer",
        "company": "Example Corp",
        "canonical_url": None,
        "description": None,
        "source": "ATS",
        "location": "Singapore",
        "workplace_type": "REMOTE",
        "processing_state": "MATCHED",
        "recommendation_outcome": "TRACK",
        "archived_at": "2026-10-01T00:00:00Z",
        "archive_reason": "JOB_OLDER_THAN_THREE_CALENDAR_MONTHS",
        "archive_age_basis": "OBSERVED_AGE_PUBLICATION_UNKNOWN",
        "archive_reference_at": "2026-06-01T00:00:00+00:00",
        "application_status": "APPLIED",
        "active_hold_until": None,
    }
    validate_archive_job_row(row, WORKSPACE_ID)
    validate_archive_job_row(
        row
        | {
            "processing_state": "HARD_REJECTED",
            "recommendation_outcome": None,
            "archive_reason": "HARD_REJECTED_PERMANENT",
            "archive_age_basis": "HARD_REJECTED_DECISION",
        },
        WORKSPACE_ID,
    )
    for invalid_row, expected_error in (
        (row | {"archive_age_basis": "UNKNOWN"}, ValueError),
        (row | {"archived_at": "2026-10-01T00:00:00"}, ValueError),
        (row | {"application_status": "INVALID"}, ValueError),
    ):
        try:
            validate_archive_job_row(invalid_row, WORKSPACE_ID)
        except expected_error:
            pass
        else:
            raise AssertionError(
                "Archive job contract accepted invalid lifecycle metadata"
            )


def _document_selection(**overrides):
    row = {
        "workspace_id": WORKSPACE_ID,
        "user_id": "user-1",
        "selection_id": "selection-1",
        "application_record_id": "application-1",
        "approval_id": "approval-1",
        "cv_docx_sha256": "a" * 64,
        "cv_pdf_sha256": "b" * 64,
        "cover_letter_docx_sha256": "c" * 64,
        "cover_letter_pdf_sha256": "d" * 64,
        "pipeline_readiness": "USER_SELECTED",
        "selected_at": "2026-11-05 10:00 UTC",
    }
    return row | overrides


def test_document_selection_rows_are_scoped_hashed_and_flagged():
    validate_document_selection_row(_document_selection(), WORKSPACE_ID, "user-1")
    for row, user_id in (
        (_document_selection(), "user-2"),
        (_document_selection(workspace_id="workspace-2"), "user-1"),
        (_document_selection(cv_pdf_sha256="not-a-hash"), "user-1"),
        (_document_selection(pipeline_readiness="SUBMITTED"), "user-1"),
    ):
        try:
            validate_document_selection_row(row, WORKSPACE_ID, user_id)
        except ValueError:
            continue
        raise AssertionError(f"Document selection contract accepted {row}")
