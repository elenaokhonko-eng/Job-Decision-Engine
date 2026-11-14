"""Record what the employer confirmed about a job's workability facts.

Jobs held at VERIFY eligibility or NEEDS_VERIFICATION readiness are missing a
posting fact (work mode, office days, travel, on-call, employment type or
location). The user asks the employer and records the answer here; the API
stores it for the job's current version and queues the pipeline to re-check
the job. This module never writes to the database and never renders job text
as Markdown or HTML: job-derived values are shown with ``st.text``.
"""

from collections.abc import Callable, Mapping
from urllib.parse import urlsplit

import streamlit as st

FACT_TYPES = (
    ("WORK_MODE", "Work mode"),
    ("OFFICE_DAYS", "Office days per week"),
    ("TRAVEL_PCT", "Travel (maximum %)"),
    ("ON_CALL", "On-call"),
    ("EMPLOYMENT_TYPE", "Employment type"),
    ("LOCATION", "Location / territory"),
)
FACT_TYPE_LABELS = dict(FACT_TYPES)
SOURCE_TYPES = (
    ("RECRUITER_EMAIL", "Recruiter email"),
    ("RECRUITER_CALL", "Recruiter call"),
    ("EMPLOYER_CAREERS_PAGE", "Employer careers page"),
    ("HIRING_MANAGER", "Hiring manager"),
    ("OTHER", "Other"),
)
SOURCE_TYPE_LABELS = dict(SOURCE_TYPES)
WORK_MODES = (("HYBRID", "Hybrid"), ("REMOTE", "Remote"), ("ONSITE", "On-site"))
EMPLOYMENT_TYPES = (("PERMANENT", "Permanent"), ("CONTRACT", "Contract"))
MAX_NOTE_LENGTH = 500
MAX_LOCATION_LENGTH = 200
MAX_URL_LENGTH = 2048

ApiRequest = Callable[..., Mapping[str, object]]


def job_eligibility(job: Mapping[str, object]) -> object:
    return job.get("decision_eligibility") or job.get("recommendation_eligibility")


def needs_employer_confirmation(job: Mapping[str, object]) -> bool:
    """Whether the job card offers the employer-confirmation form."""
    if not job.get("canonical_job_id") or not job.get("job_version_id"):
        return False
    return (
        job_eligibility(job) == "VERIFY"
        or job.get("readiness_status") == "NEEDS_VERIFICATION"
    )


def confirmed_facts_path(canonical_job_id: object) -> str:
    return f"/api/v2/jobs/{canonical_job_id}/confirmed-facts"


def is_safe_source_url(value: str) -> bool:
    """An absolute http(s) URL without credentials or whitespace."""
    if len(value) > MAX_URL_LENGTH or any(char.isspace() for char in value):
        return False
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return (
        parts.scheme in ("http", "https")
        and bool(parts.hostname)
        and parts.username is None
        and parts.password is None
    )


def _has_control_characters(value: str) -> bool:
    return any(ord(char) < 32 or ord(char) == 127 for char in value)


def build_confirmed_fact_request(
    job_version_id: object,
    fact_type: str,
    inputs: Mapping[str, object],
    source_type: str,
    source_note: object = "",
    source_url: object = "",
) -> tuple[dict | None, str | None]:
    """Return ``(body, None)`` for a valid request, or ``(None, error)``.

    The API validates the same rules; checking here gives the user the
    message before a round trip.
    """
    if not job_version_id:
        return None, "This job has no current version to confirm."
    if fact_type not in FACT_TYPE_LABELS:
        return None, "Choose which fact the employer confirmed."
    if source_type not in SOURCE_TYPE_LABELS:
        return None, "Choose where the confirmation came from."

    if fact_type == "WORK_MODE":
        mode = inputs.get("work_mode")
        if mode not in dict(WORK_MODES):
            return None, "Choose hybrid, remote or on-site."
        value: dict = {"work_mode": mode}
    elif fact_type == "OFFICE_DAYS":
        low, high = inputs.get("office_days_min"), inputs.get("office_days_max")
        if not isinstance(low, int) or not isinstance(high, int):
            return None, "Office days must be whole numbers."
        if not (0 <= low <= 7 and 0 <= high <= 7):
            return None, "Office days must be between 0 and 7."
        if low > high:
            return None, "The minimum office days cannot exceed the maximum."
        value = {"office_days_min": low, "office_days_max": high}
    elif fact_type == "TRAVEL_PCT":
        travel = inputs.get("travel_pct_max")
        if (
            isinstance(travel, bool)
            or not isinstance(travel, (int, float))
            or not 0 <= travel <= 100
        ):
            return None, "Travel must be a percentage between 0 and 100."
        value = {"travel_pct_max": travel}
    elif fact_type == "ON_CALL":
        required = inputs.get("on_call_required")
        if not isinstance(required, bool):
            return None, "Say whether regular on-call is required."
        value = {"on_call_required": required}
    elif fact_type == "EMPLOYMENT_TYPE":
        employment = inputs.get("employment_type")
        if employment not in dict(EMPLOYMENT_TYPES):
            return None, "Choose permanent or contract."
        value = {"employment_type": employment}
    else:
        location = str(inputs.get("location") or "").strip()
        if not location:
            return None, "Enter the confirmed location."
        if len(location) > MAX_LOCATION_LENGTH or _has_control_characters(location):
            return (
                None,
                f"The location must be plain text of at most {MAX_LOCATION_LENGTH} characters.",
            )
        value = {"location": location}

    note = str(source_note or "").strip()
    if len(note) > MAX_NOTE_LENGTH or _has_control_characters(note):
        return (
            None,
            f"The note must be plain text of at most {MAX_NOTE_LENGTH} characters.",
        )
    url = str(source_url or "").strip()
    if url and not is_safe_source_url(url):
        return (
            None,
            "The source link must be an http(s) URL without a username or password.",
        )

    return {
        "job_version_id": str(job_version_id),
        "fact_type": fact_type,
        "value": value,
        "source_type": source_type,
        "source_note": note or None,
        "source_url": url or None,
    }, None


def describe_fact_value(fact_type: object, value: object) -> str:
    """Plain-text statement of a confirmed value."""
    value = value if isinstance(value, Mapping) else {}
    if fact_type == "WORK_MODE":
        return dict(WORK_MODES).get(str(value.get("work_mode")), "Unknown")
    if fact_type == "OFFICE_DAYS":
        low, high = value.get("office_days_min"), value.get("office_days_max")
        return f"{high} days" if low == high else f"{low}-{high} days"
    if fact_type == "TRAVEL_PCT":
        return f"up to {value.get('travel_pct_max')}%"
    if fact_type == "ON_CALL":
        return "required" if value.get("on_call_required") is True else "not required"
    if fact_type == "EMPLOYMENT_TYPE":
        return dict(EMPLOYMENT_TYPES).get(str(value.get("employment_type")), "Unknown")
    if fact_type == "LOCATION":
        return " ".join(str(value.get("location") or "").split())
    return "Unknown"


def confirmed_fact_line(fact: Mapping[str, object]) -> str:
    """One plain-text line per confirmed fact, with its source."""
    fact_type = fact.get("fact_type")
    label = FACT_TYPE_LABELS.get(str(fact_type), str(fact_type))
    source = SOURCE_TYPE_LABELS.get(str(fact.get("source_type")), "Other")
    recorded = str(fact.get("recorded_at") or "")[:10]
    line = f"{label}: {describe_fact_value(fact_type, fact.get('fact_value'))} (source: {source}"
    line += f", recorded {recorded})" if recorded else ")"
    note = " ".join(str(fact.get("source_note") or "").split())
    if note:
        line += f" - {note}"
    assessment = ASSESSMENT_LABELS.get(str(fact.get("posting_assessment")))
    if assessment:
        line += f" [{assessment}]"
    return line


ASSESSMENT_LABELS = {
    "FILLS_UNKNOWN": "fills a fact the posting does not state",
    "MATCHES_POSTING": "agrees with the posting",
    "CONFLICTS_WITH_POSTING": "conflicts with the posting, not applied",
}
POSTING_SOURCE_LABELS = {
    "STRUCTURED_FIELD": "structured field",
    "EXTRACTED_REQUIREMENT": "extracted requirement",
    "DESCRIPTION": "description",
    "SOURCE_EVIDENCE": "source evidence",
}


def conflict_line(conflict: Mapping[str, object]) -> str:
    """Both sides of a confirmation that contradicts the posting, as plain text."""
    fact_type = conflict.get("fact_type")
    label = FACT_TYPE_LABELS.get(str(fact_type), str(fact_type))
    source = SOURCE_TYPE_LABELS.get(str(conflict.get("confirmed_source_type")), "Other")
    posting = conflict.get("posting_evidence")
    posting = posting if isinstance(posting, Mapping) else {}
    posting_source = POSTING_SOURCE_LABELS.get(str(posting.get("source")), "posting")
    line = (
        f"Conflict - {label}: you recorded "
        f"{describe_fact_value(fact_type, conflict.get('confirmed_value'))} (source: {source}); "
        f"the posting states {' '.join(str(posting.get('summary') or 'something else').split())} "
        f"(posting {posting_source})"
    )
    evidence = " ".join(str(posting.get("evidence") or "").split())
    if evidence:
        line += f': "{evidence[:200]}"'
    return line + ". The posting wins; the confirmation is not applied."


def open_check_labels(checks: Mapping[str, object] | None) -> list[str]:
    if not isinstance(checks, Mapping):
        return []
    open_checks = checks.get("open_checks")
    if not isinstance(open_checks, list):
        return []
    return [FACT_TYPE_LABELS.get(str(code), str(code)) for code in open_checks]


def checks_from_response(response: Mapping[str, object]) -> Mapping[str, object] | None:
    """The read-model row from ``GET .../confirmed-facts``; an unexpected shape is an error."""
    if not isinstance(response, Mapping) or response.get("ok") is not True:
        raise ValueError(
            "The confirmed-facts response is not a successful API response."
        )
    checks = response.get("checks")
    if checks is None:
        return None
    if not isinstance(checks, Mapping):
        raise TypeError(
            "The confirmed-facts response has no verification checks object."
        )
    for field in ("open_checks", "confirmed_facts", "conflicts"):
        if not isinstance(checks.get(field), list):
            raise TypeError(f"The verification checks are missing '{field}'.")
    return checks


def _state_key(key_prefix: str, name: str) -> str:
    return f"{key_prefix}_{name}"


def _load_checks(api_request: ApiRequest, job: Mapping[str, object], key_prefix: str):
    cache_key = _state_key(key_prefix, "checks")
    if cache_key not in st.session_state:
        response = api_request("GET", confirmed_facts_path(job.get("canonical_job_id")))
        st.session_state[cache_key] = checks_from_response(response)
    return st.session_state[cache_key]


def _value_inputs(fact_type: str, key_prefix: str) -> dict:
    if fact_type == "WORK_MODE":
        mode = st.selectbox(
            "Confirmed work mode",
            [code for code, _ in WORK_MODES],
            format_func=lambda code: dict(WORK_MODES)[code],
            key=_state_key(key_prefix, "work_mode"),
        )
        return {"work_mode": mode}
    if fact_type == "OFFICE_DAYS":
        low = st.number_input(
            "Minimum office days per week",
            0,
            7,
            2,
            step=1,
            key=_state_key(key_prefix, "office_min"),
        )
        high = st.number_input(
            "Maximum office days per week",
            0,
            7,
            3,
            step=1,
            key=_state_key(key_prefix, "office_max"),
        )
        return {"office_days_min": int(low), "office_days_max": int(high)}
    if fact_type == "TRAVEL_PCT":
        travel = st.number_input(
            "Maximum travel (%)",
            0,
            100,
            10,
            step=5,
            key=_state_key(key_prefix, "travel"),
        )
        return {"travel_pct_max": int(travel)}
    if fact_type == "ON_CALL":
        required = st.radio(
            "Regular on-call",
            ["Not required", "Required"],
            horizontal=True,
            key=_state_key(key_prefix, "on_call"),
        )
        return {"on_call_required": required == "Required"}
    if fact_type == "EMPLOYMENT_TYPE":
        employment = st.selectbox(
            "Confirmed employment type",
            [code for code, _ in EMPLOYMENT_TYPES],
            format_func=lambda code: dict(EMPLOYMENT_TYPES)[code],
            key=_state_key(key_prefix, "employment"),
        )
        return {"employment_type": employment}
    location = st.text_input(
        "Confirmed location or territory",
        max_chars=MAX_LOCATION_LENGTH,
        key=_state_key(key_prefix, "location"),
    )
    return {"location": location}


def render_employer_confirmation(
    job: Mapping[str, object],
    api_request: ApiRequest,
    key_prefix: str,
    api_configured: bool = True,
) -> None:
    """The "Record employer confirmation" section of a VERIFY / NEEDS_VERIFICATION job card."""
    if not needs_employer_confirmation(job):
        return
    show = st.checkbox(
        "Record employer confirmation", key=_state_key(key_prefix, "open")
    )
    if not show:
        return
    if not api_configured:
        st.info(
            "Recording a confirmation needs the app's local API. Start the app with "
            "`npm run workspace`, which starts the API and the dashboard together."
        )
        return

    try:
        checks = _load_checks(api_request, job, key_prefix)
    except (RuntimeError, TypeError, ValueError) as error:
        st.error("Could not load this job's verification checks.")
        st.text(str(error))
        return

    if checks is None:
        st.info("This job has no current version to confirm.")
        return
    if str(checks.get("job_version_id")) != str(job.get("job_version_id")):
        st.warning(
            "This job has a newer version than the one shown. Reload the page before recording a confirmation."
        )
        return

    labels = open_check_labels(checks)
    st.text(
        f"Open checks: {', '.join(labels)}"
        if labels
        else "Open checks: none without a confirmation"
    )
    facts = [
        fact for fact in checks.get("confirmed_facts", []) if isinstance(fact, Mapping)
    ]
    if facts:
        st.text("Employer-confirmed facts:")
        for fact in facts:
            st.text(f"- {confirmed_fact_line(fact)}")
    conflicts = [c for c in checks.get("conflicts", []) or [] if isinstance(c, Mapping)]
    for conflict in conflicts:
        st.text(conflict_line(conflict))
    if checks.get("rerun_pending"):
        st.caption("A confirmation is waiting for the pipeline to re-check this job.")

    default_type = next(
        (code for code in checks.get("open_checks", []) if code in FACT_TYPE_LABELS),
        "WORK_MODE",
    )
    fact_codes = [code for code, _ in FACT_TYPES]
    fact_type = st.selectbox(
        "Fact the employer confirmed",
        fact_codes,
        index=fact_codes.index(default_type),
        format_func=lambda code: FACT_TYPE_LABELS[code],
        key=_state_key(key_prefix, "fact_type"),
    )
    with st.form(key=_state_key(key_prefix, "form"), clear_on_submit=False):
        inputs = _value_inputs(fact_type, key_prefix)
        source_type = st.selectbox(
            "Where the confirmation came from",
            [code for code, _ in SOURCE_TYPES],
            format_func=lambda code: SOURCE_TYPE_LABELS[code],
            key=_state_key(key_prefix, "source_type"),
        )
        source_note = st.text_input(
            "Note (optional)",
            max_chars=MAX_NOTE_LENGTH,
            key=_state_key(key_prefix, "note"),
        )
        source_url = st.text_input(
            "Source link (optional)",
            max_chars=MAX_URL_LENGTH,
            key=_state_key(key_prefix, "url"),
        )
        submitted = st.form_submit_button("Save confirmation")

    if facts:
        _render_withdrawal(job, api_request, key_prefix, facts)

    if not submitted:
        return
    body, error = build_confirmed_fact_request(
        job.get("job_version_id"),
        fact_type,
        inputs,
        source_type,
        source_note,
        source_url,
    )
    if error:
        st.error(error)
        return
    try:
        response = api_request(
            "POST", confirmed_facts_path(job.get("canonical_job_id")), body=body
        )
    except RuntimeError as failure:
        st.error("The confirmation was not saved.")
        st.text(str(failure))
        return
    st.session_state.pop(_state_key(key_prefix, "checks"), None)
    superseded = isinstance(response, Mapping) and response.get("superseded_fact_id")
    fact = response.get("fact") if isinstance(response, Mapping) else None
    assessment = fact.get("posting_assessment") if isinstance(fact, Mapping) else None
    if assessment == "CONFLICTS_WITH_POSTING":
        st.warning(
            "Saved, but the posting states a different value, so the pipeline keeps the "
            "posting's value. The conflict is listed above after a reload."
        )
        return
    st.success(
        "Confirmation saved"
        + (" (it replaces the earlier one)" if superseded else "")
        + ". The pipeline will re-check this job on its next run."
    )


def withdraw_path(canonical_job_id: object, confirmed_fact_id: object) -> str:
    return f"{confirmed_facts_path(canonical_job_id)}/{confirmed_fact_id}/withdraw"


def _render_withdrawal(job, api_request, key_prefix, facts) -> None:
    """Withdraw a recorded confirmation; the fact returns to "no confirmation"."""
    options = [
        str(fact.get("confirmed_fact_id"))
        for fact in facts
        if fact.get("confirmed_fact_id")
    ]
    if not options:
        return
    labels = {
        str(fact.get("confirmed_fact_id")): confirmed_fact_line(fact) for fact in facts
    }
    with st.form(key=_state_key(key_prefix, "withdraw_form"), clear_on_submit=False):
        chosen = st.selectbox(
            "Withdraw a confirmation",
            options,
            format_func=lambda fact_id: labels.get(fact_id, fact_id)[:120],
            key=_state_key(key_prefix, "withdraw_choice"),
        )
        reason = st.text_input(
            "Reason (optional)",
            max_chars=MAX_NOTE_LENGTH,
            key=_state_key(key_prefix, "withdraw_reason"),
        )
        withdraw = st.form_submit_button("Withdraw confirmation")
    if not withdraw:
        return
    reason = str(reason or "").strip()
    if len(reason) > MAX_NOTE_LENGTH or _has_control_characters(reason):
        st.error(
            f"The reason must be plain text of at most {MAX_NOTE_LENGTH} characters."
        )
        return
    try:
        api_request(
            "POST",
            withdraw_path(job.get("canonical_job_id"), chosen),
            body={
                "job_version_id": str(job.get("job_version_id")),
                "reason": reason or None,
            },
        )
    except RuntimeError as failure:
        st.error("The confirmation was not withdrawn.")
        st.text(str(failure))
        return
    st.session_state.pop(_state_key(key_prefix, "checks"), None)
    st.success(
        "Confirmation withdrawn. The pipeline will re-check this job on its next run."
    )
