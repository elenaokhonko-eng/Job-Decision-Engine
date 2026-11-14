"""Pure helpers for reviewing any job in the selected command-centre category.

Nothing here reads the database or calls Streamlit, so the category, review
and verification rules can be tested without a running app.
"""

from collections.abc import Iterable, Mapping, Sequence

from streamlit_application_workflow import (
    CURRENT_DETERMINISTIC_CONTEXTS,
    has_current_ready_assessment,
)

VERIFY_THEN_APPLY_CATEGORY = "Verify, then apply"
REVIEW_CATEGORY = "Review"
CATEGORY_OPTIONS = (
    "Top 10",
    "Apply Now",
    VERIFY_THEN_APPLY_CATEGORY,
    REVIEW_CATEGORY,
    "Track",
    "Processing",
    "Applied",
    "Skip",
    "Rejected",
    "Unmatched",
    "Removed",
    "Archive",
    "All",
)
DEFAULT_CATEGORY_INDEX = CATEGORY_OPTIONS.index("Apply Now")
# Closed-out categories and their v_job_status_buckets_scoped bucket (migration 112).
CLOSED_OUT_CATEGORY_BUCKETS = {
    "Rejected": "REJECTED",
    "Unmatched": "UNMATCHED",
    "Removed": "REMOVED",
}
# Categories whose rows come from their own scoped read model rather than the
# shortlist page, so the sidebar filters are applied to them directly.
SELF_SOURCED_CATEGORIES = frozenset({VERIFY_THEN_APPLY_CATEGORY, REVIEW_CATEGORY})
# Categories the read model pages on the server (LIMIT/OFFSET); every other
# category is loaded whole and paged in the listing.
SERVER_PAGED_CATEGORIES = frozenset({"Archive", *CLOSED_OUT_CATEGORY_BUCKETS})
# Categories whose VERIFY-eligibility rows get the same verification action as
# "Verify, then apply".
VERIFICATION_ACTION_CATEGORIES = frozenset({"Track", REVIEW_CATEGORY})
PAGE_SIZE = 25

_MARKDOWN_SPECIAL = frozenset("\\`*_{}[]()<>#+-.!|~$")

_WORKABILITY_QUESTIONS = (
    ("GATE_UNKNOWN_WORK_MODE", "Ask whether the role is remote, hybrid, or on-site."),
    (
        "NEEDS_VERIFICATION_LOCATION_DETAIL",
        "Confirm the work location and any residency requirement.",
    ),
    (
        "NEEDS_VERIFICATION_HIRING_TERRITORY",
        "Ask whether this role can hire someone based in Singapore.",
    ),
    (
        "NEEDS_VERIFICATION_OFFICE_DAYS",
        "Confirm how many days per week are required in the office.",
    ),
    (
        "NEEDS_VERIFICATION_TRAVEL",
        "Confirm the expected travel percentage and frequency.",
    ),
)

_ARTIFACT_EXPLANATIONS = {
    "MATCH_STALE": "its profile match is out of date and waits for the pipeline to re-match it",
    "DECISION_STALE": "its deterministic decision is out of date and waits for the pipeline to decide again",
    "BLOCKED_DEPENDENCY": "a pipeline task for it is blocked on a dependency",
}


def escape_markdown(value: object) -> str:
    """Return job text that Streamlit markdown shows literally, on one line.

    Links, emphasis, headings, LaTeX and raw HTML in job content are escaped.
    """
    text = "" if value is None else str(value)
    text = " ".join(text.splitlines())
    return "".join("\\" + char if char in _MARKDOWN_SPECIAL else char for char in text)


def string_list(value: object) -> list[str]:
    """Return a read-model array as strings; anything else becomes empty."""
    if isinstance(value, str) or not isinstance(value, Iterable):
        return []
    return [str(item) for item in value if item is not None and str(item).strip()]


def job_eligibility(job: Mapping[str, object]) -> object:
    return job.get("decision_eligibility") or job.get("recommendation_eligibility")


def job_outcome(job: Mapping[str, object]) -> object:
    return job.get("decision_outcome") or job.get("recommendation_outcome")


def verification_question_for_job(job: Mapping[str, object]) -> str:
    """The question to settle with the employer for the job's open gate codes.

    A gate-passed job held at VERIFY has no open gate code; its question then
    names the readiness reason codes that still need verification.
    """
    codes = set(string_list(job.get("rejection_codes")))
    questions = [question for code, question in _WORKABILITY_QUESTIONS if code in codes]
    if questions:
        return " ".join(questions)
    if job.get("gate_status") == "PASS":
        readiness_codes = string_list(job.get("readiness_reason_codes"))
        if readiness_codes:
            return f"Confirm the open readiness items: {', '.join(readiness_codes)}."
    return "Confirm the unresolved workability detail shown in the gate evidence."


def unresolved_readiness_checks(job: Mapping[str, object]) -> list[str]:
    """Readiness checks that still need verification, as 'KEY: REASON' lines."""
    readiness = job.get("application_readiness")
    checks = readiness.get("checks") if isinstance(readiness, Mapping) else None
    if not isinstance(checks, list):
        return []
    lines = []
    for check in checks:
        if (
            not isinstance(check, Mapping)
            or check.get("status") != "NEEDS_VERIFICATION"
        ):
            continue
        key = check.get("key") or "CHECK"
        reason = check.get("reason_code") or "UNSPECIFIED"
        lines.append(f"{key}: {reason}")
    return lines


def verification_action_applies(job: Mapping[str, object], category: str) -> bool:
    """Whether the job card offers the verify-then-apply action.

    Every "Verify, then apply" row does; Track and Review rows do when their
    deterministic eligibility is VERIFY. The action needs a job identity.
    """
    if not job.get("canonical_job_id") or not job.get("job_version_id"):
        return False
    if category == VERIFY_THEN_APPLY_CATEGORY:
        return True
    return (
        category in VERIFICATION_ACTION_CATEGORIES and job_eligibility(job) == "VERIFY"
    )


def apply_now_exclusion_reasons(job: Mapping[str, object]) -> list[str]:
    """Plain-language explanation of the conditions a REVIEW job does not meet.

    This only explains; it never decides membership. Whether a job is in Apply
    Now comes from the read model's ``in_apply_now`` flag (an EXISTS against
    ``v_apply_now_jobs_stage3_scoped``), see ``apply_now_exclusion_summary``.
    """
    reasons = []
    gate = job.get("gate_status")
    if gate != "PASS":
        if gate == "NEEDS_VERIFICATION":
            reasons.append(
                "Gate is NEEDS_VERIFICATION: a workability fact is still unknown "
                f"({', '.join(string_list(job.get('rejection_codes'))) or 'no code stored'})."
            )
        else:
            reasons.append(f"Gate is {gate or 'not recorded'}, not PASS.")
    eligibility = job_eligibility(job)
    if eligibility != "ELIGIBLE":
        reasons.append(
            f"Eligibility is {eligibility or 'not recorded'}; Apply Now needs ELIGIBLE."
        )
    outcome = job_outcome(job)
    if outcome not in {"PRIORITY", "REVIEW"}:
        reasons.append(
            f"Decision is {outcome or 'not recorded'}, not PRIORITY or REVIEW."
        )
    artifact = job.get("current_artifact_status")
    if artifact not in CURRENT_DETERMINISTIC_CONTEXTS:
        explanation = _ARTIFACT_EXPLANATIONS.get(
            str(artifact), "its pipeline artifacts are not current"
        )
        detail = job.get("current_artifact_reason")
        reasons.append(
            f"Pipeline status is {artifact or 'unknown'}: {explanation}"
            + (f" ({detail})." if detail else ".")
        )
    if not has_current_ready_assessment(job):
        status = job.get("readiness_status") or "not assessed"
        codes = ", ".join(string_list(job.get("readiness_reason_codes")))
        reasons.append(f"Readiness is {status}" + (f" ({codes})." if codes else "."))
    return reasons


def apply_now_exclusion_summary(job: Mapping[str, object]) -> str:
    """Say whether a REVIEW job is in Apply Now and, if not, why.

    Membership is read only from ``in_apply_now`` (the Apply Now read model).
    A missing flag is never treated as membership.
    """
    if job.get("in_apply_now") is True:
        return "Listed in Apply Now."
    reasons = apply_now_exclusion_reasons(job)
    if job.get("in_apply_now") is not False:
        prefix = "Apply Now membership is unknown for this row."
        return prefix + (" Open conditions: " + " ".join(reasons) if reasons else "")
    if not reasons:
        reasons = [
            (
                "It has no current Apply Now ranking yet (for example, its ranking "
                "snapshot is missing or needs a policy recheck)."
            )
        ]
    return "Not in Apply Now: " + " ".join(reasons)


def filter_by_sidebar(
    rows: Sequence[Mapping[str, object]],
    *,
    lane_filter: str | None,
    status_filter: str | None,
    board_filter: str | None,
    track_filter: str | None,
    search_query: str = "",
) -> list[Mapping[str, object]]:
    """Apply the sidebar filters to rows read from a category's own read model."""
    needle = (search_query or "").strip().lower()
    kept = []
    for job in rows:
        lane = job.get("primary_lane")
        if lane_filter not in (None, "All Lanes") and lane != lane_filter:
            continue
        if (
            status_filter not in (None, "All Statuses")
            and job.get("processing_state") != status_filter
        ):
            continue
        if (
            board_filter not in (None, "All Sources")
            and (job.get("source") or "UNKNOWN") != board_filter
        ):
            continue
        if track_filter not in (None, "All Tracks"):
            if track_filter == "Unassigned":
                if lane and lane != "UNASSIGNED":
                    continue
            elif lane != track_filter:
                continue
        if needle and not any(
            needle in str(job.get(field) or "").lower()
            for field in ("title", "company", "description")
        ):
            continue
        kept.append(job)
    return kept


def review_option_label(job: Mapping[str, object]) -> str:
    """The selector label for one job: company, title, decision and state."""
    outcome = job_outcome(job) or "NO_DECISION"
    eligibility = job_eligibility(job) or "UNKNOWN"
    state = job.get("processing_state") or job.get("application_status") or "UNKNOWN"
    stale = " - stale evaluation" if job.get("version_mismatch") else ""
    suffix = str(job.get("job_version_id") or "")[:8]
    return (
        f"{job.get('company') or 'Unknown company'} — {job.get('title') or 'Untitled role'} "
        f"[{outcome}/{eligibility}, {state}]{stale} ({suffix})"
    )


def review_selector_options(
    jobs: Sequence[Mapping[str, object]],
) -> dict[str, Mapping[str, object]]:
    """Every job in the category, keyed by a stable job/version identity.

    The key keeps the selection on the same job when filters change the list.
    Rows without an identity (or repeated ones) fall back to their position.
    """
    options: dict[str, Mapping[str, object]] = {}
    for index, job in enumerate(jobs):
        canonical_job_id = job.get("canonical_job_id")
        job_version_id = job.get("job_version_id") or job.get("application_record_id")
        key = (
            f"{canonical_job_id}:{job_version_id}"
            if canonical_job_id
            else f"row:{index}"
        )
        if key in options:
            key = f"{key}:{index}"
        options[key] = job
    return options


def page_count(total: object, page_size: int = PAGE_SIZE) -> int:
    """Pages needed for ``total`` rows; an unknown total is one page."""
    try:
        count = int(total)
    except (TypeError, ValueError):
        return 1
    return max(1, (count + page_size - 1) // page_size)
