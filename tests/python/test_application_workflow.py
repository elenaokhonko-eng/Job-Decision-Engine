from streamlit_application_workflow import is_document_generation_eligible


def current_review_job(**overrides):
    job = {
        "canonical_job_id": "job-id",
        "job_version_id": "version-id",
        "latest_match_run_id": "match-id",
        "gate_status": "PASS",
        "decision_eligibility": "ELIGIBLE",
        "decision_outcome": "REVIEW",
        "processing_state": "MATCHED",
        "current_artifact_status": "EVALUATION_MISSING",
        "version_mismatch": False,
        "eval_provider": None,
    }
    return job | overrides


def test_includes_current_matched_review_without_optional_ai_evaluation():
    assert is_document_generation_eligible(current_review_job())


def test_excludes_stale_or_incomplete_deterministic_context():
    assert not is_document_generation_eligible(
        current_review_job(latest_match_run_id=None)
    )
    assert not is_document_generation_eligible(
        current_review_job(current_artifact_status="MATCH_STALE")
    )
    assert not is_document_generation_eligible(
        current_review_job(current_artifact_status="DECISION_STALE")
    )


def test_allows_current_deterministic_context_with_a_stale_optional_evaluation():
    assert is_document_generation_eligible(
        current_review_job(
            version_mismatch=True, current_artifact_status="EVALUATION_STALE"
        )
    )


def test_excludes_ineligible_or_non_apply_now_jobs_by_default():
    assert not is_document_generation_eligible(
        current_review_job(decision_eligibility="INELIGIBLE")
    )
    assert not is_document_generation_eligible(
        current_review_job(decision_outcome="SKIP")
    )
    assert not is_document_generation_eligible(
        current_review_job(decision_outcome="TRACK")
    )


def test_includes_track_jobs_only_when_explicitly_requested():
    track_job = current_review_job(decision_outcome="TRACK")
    assert not is_document_generation_eligible(track_job)
    assert is_document_generation_eligible(track_job, include_track=True)
