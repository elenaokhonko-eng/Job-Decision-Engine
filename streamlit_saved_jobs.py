"""Streamlit "Saved jobs" tab: LinkedIn and MyCareersFuture saved-jobs exports.

The user exports their own saved jobs in their own signed-in browser with the
repository's console script, uploads the JSON file here, validates it with a
dry run and then imports it. Every write goes through the authenticated v2 API
(``POST /api/v2/imports/linkedin-saved`` and ``/imports/mcf-saved``), which calls
the same canonical importers as ``npm run import:*-saved``. Nothing here reads
or writes the database directly, and no job or file content is rendered as HTML.
"""

import hashlib
import json
import re
from collections.abc import Callable, Mapping, MutableMapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import streamlit as st

REPO_ROOT = Path(__file__).resolve().parent
IMPORT_TIMEOUT_SECONDS = 300
# Mirrors SAVED_IMPORT_MAX_ITEMS in src/api/v2/savedJobsImportRouter.ts.
MAX_ITEMS_PER_UPLOAD = 500

ApiRequest = Callable[..., Mapping[str, object]]


@dataclass(frozen=True)
class SavedJobsSource:
    """Static description of one saved-jobs source shown in the tab."""

    key: str
    label: str
    route: str
    script_path: str
    export_file_name: str
    saved_page_name: str
    saved_page_url: str
    resume_call: str
    cli_command: str


LINKEDIN = SavedJobsSource(
    key="linkedin",
    label="LinkedIn",
    route="/api/v2/imports/linkedin-saved",
    script_path="scripts/linkedin/export_saved_jobs.console.js",
    export_file_name="linkedin_saved_jobs.json",
    saved_page_name="My jobs → Saved",
    saved_page_url="https://www.linkedin.com/jobs-tracker/",
    resume_call="await jdeLinkedInExport.resume()",
    cli_command="npm run import:linkedin-saved",
)

MCF = SavedJobsSource(
    key="mcf",
    label="MyCareersFuture",
    route="/api/v2/imports/mcf-saved",
    script_path="scripts/mcf/export_saved_jobs.console.js",
    export_file_name="mcf_saved_jobs.json",
    saved_page_name="Saved jobs",
    saved_page_url="https://www.mycareersfuture.gov.sg/saved-jobs",
    resume_call="await jdeMcfExport.resume()",
    cli_command="npm run import:mcf-saved",
)

SOURCES = (LINKEDIN, MCF)

# Gmail match outcomes that mean "this import unblocks a parked alert card".
REVIVED_OUTCOMES = ("CONTENT_ATTACH_QUEUED", "WOULD_QUEUE_CONTENT_ATTACH")

_MARKDOWN_SPECIAL = re.compile(r"([\\`*_{}\[\]()#+\-.!|<>~$])")


def escape_markdown(value: object) -> str:
    """Escape Markdown so external text renders literally in st.markdown/st.error.

    Example:
        escape_markdown("[x](javascript:1)") == "\\[x\\]\\(javascript:1\\)"
    """
    return _MARKDOWN_SPECIAL.sub(r"\\\1", str(value))


def read_export_script(source: SavedJobsSource, root: Path = REPO_ROOT) -> str:
    """Return the current console export script from the repository file.

    The tab shows the file itself so the instructions never drift from the
    script the importer was written for. A missing file is an error, not an
    empty script.
    """
    return (root / source.script_path).read_text(encoding="utf-8")


def content_hash(data: bytes) -> str:
    """SHA-256 of the uploaded file bytes; keys "validated" to this exact file."""
    return hashlib.sha256(data).hexdigest()


class ExportFileError(ValueError):
    """The uploaded file is not a usable saved-jobs export."""


def parse_export_bytes(data: bytes) -> list:
    """Parse an uploaded export file into its JSON array.

    Raises:
        ExportFileError: The file is not UTF-8 JSON, or its root is not a non-empty array.
    """
    try:
        document = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ExportFileError(f"The file is not valid UTF-8 JSON: {error}") from error
    if not isinstance(document, list):
        raise ExportFileError("The file must be a JSON array of saved jobs.")
    if not document:
        raise ExportFileError(
            "The file contains no saved jobs; re-run the export in the browser."
        )
    if len(document) > MAX_ITEMS_PER_UPLOAD:
        raise ExportFileError(
            f"The file has {len(document)} jobs; this page accepts at most "
            f"{MAX_ITEMS_PER_UPLOAD}. Use the command line for a larger file."
        )
    return document


def build_import_request(
    source: SavedJobsSource, items: Sequence[object], *, dry_run: bool
) -> tuple[str, str, dict]:
    """Return ``(method, path, body)`` for the v2 saved-jobs import route."""
    return "POST", source.route, {"items": list(items), "dryRun": bool(dry_run)}


def _state_key(source: SavedJobsSource, name: str) -> str:
    return f"saved_jobs_{source.key}_{name}"


def record_dry_run(
    state: MutableMapping[str, object],
    source: SavedJobsSource,
    file_hash: str,
    response: Mapping[str, object],
) -> bool:
    """Store a dry-run result; mark the file validated only when it succeeded.

    A dry run succeeds when the API answered ``ok`` in ``DRY_RUN`` mode for this
    source and at least one item is valid (otherwise there is nothing to import).
    Returns whether the file is now validated.
    """
    state[_state_key(source, "dry_run")] = {"hash": file_hash, "response": response}
    totals = response.get("totals") if isinstance(response, Mapping) else None
    valid = totals.get("valid") if isinstance(totals, Mapping) else 0
    succeeded = (
        response.get("ok") is True
        and response.get("mode") == "DRY_RUN"
        and response.get("source") == source_code(source)
        and isinstance(valid, int)
        and valid > 0
    )
    state[_state_key(source, "validated_hash")] = file_hash if succeeded else None
    return succeeded


def clear_validation(state: MutableMapping[str, object], source: SavedJobsSource):
    """Forget the validated file (after an import or a failed dry run)."""
    state[_state_key(source, "validated_hash")] = None


def import_enabled(
    state: Mapping[str, object], source: SavedJobsSource, file_hash: str | None
) -> bool:
    """Import is allowed only after a successful dry run of this exact file."""
    if not file_hash:
        return False
    return state.get(_state_key(source, "validated_hash")) == file_hash


def source_code(source: SavedJobsSource) -> str:
    """The ``source`` value the API returns for this section."""
    return "LINKEDIN_SAVED" if source.key == "linkedin" else "MCF_SAVED"


# Ordered: the first matching pattern decides the code.
_REASON_RULES: tuple[tuple[str, str, str], ...] = (
    (
        "descriptionStatus=null",
        "DESCRIPTION_NOT_FETCHED",
        (
            "The export stopped before this job's description was read. Run "
            "{resume} in the browser console on the saved-jobs page, then upload "
            "the new file."
        ),
    ),
    (
        "description was not exported",
        "DESCRIPTION_NOT_EXPORTED",
        (
            "The script could not read this job's description (the job may be "
            "closed or the site was slow). Run {resume} later and re-export; if it "
            "stays missing, open the job on the site to check it still exists."
        ),
    ),
    (
        "description is a placeholder",
        "DESCRIPTION_PLACEHOLDER",
        (
            "This file came from an older script that wrote placeholder text. "
            "Re-export with the script shown on this page."
        ),
    ),
    (
        "description is missing",
        "DESCRIPTION_MISSING",
        "Re-export with the script shown on this page (or run {resume}).",
    ),
    (
        "company is missing",
        "COMPANY_MISSING",
        (
            "The employer was hidden or a placeholder such as 'Unknown Company' "
            "was exported. Open the job on the site and re-export; a job whose "
            "employer is hidden cannot be imported."
        ),
    ),
    (
        "unknown field",
        "UNKNOWN_FIELDS",
        (
            "The file was not produced by the current script. Re-export with the "
            "script shown on this page."
        ),
    ),
    (
        "does not match the job id",
        "JOB_ID_MISMATCH",
        (
            "The job id does not match the link. Re-export with the script shown "
            "on this page."
        ),
    ),
    (
        "url",
        "URL_INVALID",
        (
            "The job link is not a job page on this site. Re-export with the "
            "script shown on this page."
        ),
    ),
    (
        "linkedinJobId",
        "JOB_ID_INVALID",
        "The job id is malformed. Re-export with the script shown on this page.",
    ),
    (
        "title must not be empty",
        "TITLE_MISSING",
        "Open the job on the site to check it still exists, then re-export.",
    ),
    (
        "item must be a JSON object",
        "NOT_AN_OBJECT",
        (
            "The file was edited or is not an export. Re-export with the script "
            "shown on this page."
        ),
    ),
)


def classify_invalid_reason(reason: object, source: SavedJobsSource) -> tuple[str, str]:
    """Map an importer reason to ``(reason_code, what_to_do)``."""
    text = str(reason)
    for needle, code, advice in _REASON_RULES:
        if needle in text:
            return code, advice.format(resume=source.resume_call)
    return (
        "OTHER",
        (
            "Re-export with the script shown on this page; if it persists, share "
            "the copied results."
        ),
    )


def _totals(response: Mapping[str, object]) -> Mapping[str, object]:
    totals = response.get("totals")
    return totals if isinstance(totals, Mapping) else {}


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _list(value: object) -> list:
    return value if isinstance(value, list) else []


def invalid_reason_rows(
    response: Mapping[str, object], source: SavedJobsSource
) -> list[dict]:
    """Group invalid items by reason code, with item numbers and the fix."""
    grouped: dict[str, dict] = {}
    for entry in _list(response.get("invalid")):
        if not isinstance(entry, Mapping):
            continue
        code, advice = classify_invalid_reason(entry.get("reason"), source)
        row = grouped.setdefault(
            code,
            {
                "Reason code": code,
                "Count": 0,
                "Items (file position)": [],
                "What to do": advice,
            },
        )
        row["Count"] += 1
        row["Items (file position)"].append(_int(entry.get("index")))
    return [
        {
            **row,
            "Items (file position)": ", ".join(
                str(i) for i in row["Items (file position)"]
            ),
        }
        for row in grouped.values()
    ]


def revived_gmail_rows(response: Mapping[str, object]) -> list[dict]:
    """Parked Gmail alert cards this import unblocks (or would unblock)."""
    rows = []
    for item in _list(response.get("items")):
        if not isinstance(item, Mapping):
            continue
        for match in _list(item.get("gmail_matches")):
            if isinstance(match, Mapping) and match.get("outcome") in REVIVED_OUTCOMES:
                rows.append(
                    {
                        "Item": _int(item.get("index")),
                        "Job id": str(item.get("job_id") or ""),
                        "Gmail alert observation": str(
                            match.get("observation_id") or ""
                        ),
                        "Alert status before": str(
                            match.get("processing_status") or ""
                        ),
                        "Outcome": str(match.get("outcome") or ""),
                    }
                )
    return rows


def item_rows(response: Mapping[str, object]) -> list[dict]:
    """Per-item outcomes with ids only (the API returns no titles or text)."""
    rows = []
    for item in _list(response.get("items")):
        if not isinstance(item, Mapping):
            continue
        rows.append(
            {
                "Item": _int(item.get("index")),
                "Job id": str(item.get("job_id") or ""),
                "Outcome": str(item.get("outcome") or ""),
                "Observation id": str(item.get("observation_id") or ""),
                "Description": str(item.get("description_quality") or ""),
                "Error": str(item.get("error") or ""),
            }
        )
    return rows


def results_checklist(
    response: Mapping[str, object], source: SavedJobsSource, saved_count: int | None
) -> list[tuple[bool | None, str]]:
    """Plain-language checks for a dry-run or import result.

    Each entry is ``(passed, text)``; ``passed`` is ``None`` for information.
    """
    totals = _totals(response)
    collected = _int(totals.get("items"))
    invalid = _int(totals.get("invalid"))
    already = _int(totals.get("alreadyImported"))
    revived = _int(totals.get("contentAttachQueued"))
    checks: list[tuple[bool | None, str]] = []
    if saved_count:
        checks.append(
            (
                collected == saved_count,
                f"Collected {collected} of the {saved_count} jobs you saved."
                + (
                    ""
                    if collected == saved_count
                    else " Compare with the 'expected vs collected' line the "
                    f"script printed in the browser console; run {source.resume_call} "
                    "or paste the script again to collect the rest."
                ),
            )
        )
    else:
        checks.append(
            (
                None,
                (
                    f"Collected {collected} jobs. Compare this with the 'expected vs "
                    "collected' line the script printed in the browser console and "
                    "with the number of jobs you saved."
                ),
            )
        )
    checks.append(
        (
            invalid == 0,
            "Invalid is 0."
            if invalid == 0
            else f"{invalid} invalid job(s); each reason and what to do is listed "
            "below. The valid jobs can still be imported.",
        )
    )
    checks.append(
        (
            None,
            (
                f"Already imported: {already}. Expected when you upload a file again; "
                "those jobs are not staged twice."
            ),
        )
    )
    checks.append(
        (
            None,
            f"Gmail alerts revived: {revived}. Parked alert jobs that this import "
            + (
                "will unblock (listed below)."
                if revived
                else "will unblock; none matched this file."
            ),
        )
    )
    if response.get("normalize_seed_error"):
        checks.append(
            (
                False,
                (
                    "Queuing the imported jobs for processing failed; the pipeline "
                    "will still pick them up on its next run."
                ),
            )
        )
    return checks


def results_text(
    response: Mapping[str, object], source: SavedJobsSource, file_hash: str
) -> str:
    """Counts and reason codes only, for pasting into a test report."""
    totals = _totals(response)
    mode = str(response.get("mode") or "UNKNOWN")
    lines = [
        f"source: {source_code(source)}",
        f"mode: {mode}",
        f"complete: {str(bool(response.get('complete'))).lower()}",
        f"file_sha256_prefix: {file_hash[:12]}",
    ]
    for key in (
        "items",
        "valid",
        "invalid",
        "duplicatesInFile",
        "staged",
        "alreadyImported",
        "failed",
        "gmailMatches",
        "contentAttachQueued",
        "gmailAlreadyComplete",
        "gmailUnusable",
        "existingCanonicalJobs",
    ):
        lines.append(f"{key}: {_int(totals.get(key))}")
    if mode == "APPLIED":
        for key in (
            "fetchTasksReactivated",
            "fetchTasksEnqueued",
            "normalizeTasksSeeded",
            "normalizeTasksAlreadyQueued",
            "normalizeSeedDeferred",
        ):
            lines.append(f"{key}: {_int(totals.get(key))}")
        lines.append(
            f"normalize_seed_error: {'yes' if response.get('normalize_seed_error') else 'no'}"
        )
    for row in invalid_reason_rows(response, source):
        lines.append(f"invalid_reason {row['Reason code']}: {row['Count']}")
    outcomes: dict[str, int] = {}
    for item in _list(response.get("items")):
        if isinstance(item, Mapping):
            outcome = str(item.get("outcome") or "UNKNOWN")
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
    for outcome in sorted(outcomes):
        lines.append(f"outcome {outcome}: {outcomes[outcome]}")
    return "\n".join(lines)


def _call_import(
    api_request: ApiRequest, source: SavedJobsSource, items: list, *, dry_run: bool
) -> Mapping[str, object]:
    method, path, body = build_import_request(source, items, dry_run=dry_run)
    return api_request(method, path, body=body, timeout=IMPORT_TIMEOUT_SECONDS)


def _render_metrics(response: Mapping[str, object]) -> None:
    totals = _totals(response)
    dry_run = response.get("mode") == "DRY_RUN"
    columns = st.columns(6)
    metrics = (
        ("Collected", totals.get("items")),
        ("Valid", totals.get("valid")),
        ("Invalid", totals.get("invalid")),
        ("Would be new" if dry_run else "New", totals.get("staged")),
        ("Already imported", totals.get("alreadyImported")),
        ("Gmail alerts revived", totals.get("contentAttachQueued")),
    )
    for column, (label, value) in zip(columns, metrics, strict=True):
        column.metric(label, _int(value))
    if _int(totals.get("duplicatesInFile")):
        st.caption(
            f"{_int(totals.get('duplicatesInFile'))} job(s) appear twice in the file "
            "and are staged once."
        )
    if _int(totals.get("failed")):
        st.error(
            f"{_int(totals.get('failed'))} job(s) failed to stage because of an "
            "operational error (see the Error column). Import again later; this "
            "is not a judgement on the job."
        )


def _render_result(
    response: Mapping[str, object],
    source: SavedJobsSource,
    file_hash: str,
    saved_count: int | None,
) -> None:
    _render_metrics(response)
    st.markdown("**Checklist**")
    for passed, text in results_checklist(response, source, saved_count):
        marker = "✅" if passed is True else "⚠️" if passed is False else "ℹ️"
        st.markdown(f"{marker} {escape_markdown(text)}")
    reasons = invalid_reason_rows(response, source)
    if reasons:
        st.markdown("**Invalid jobs by reason**")
        st.dataframe(reasons, hide_index=True, width="stretch")
    revived = revived_gmail_rows(response)
    if revived:
        st.markdown("**Parked Gmail alerts this import unblocks**")
        st.dataframe(revived, hide_index=True, width="stretch")
    rows = item_rows(response)
    if rows:
        with st.expander(f"Per-job outcomes ({len(rows)})"):
            st.dataframe(rows, hide_index=True, width="stretch")
    st.markdown("**Copy results** (counts and reason codes only)")
    st.code(results_text(response, source, file_hash), language="text")


def render_saved_jobs_section(
    source: SavedJobsSource,
    api_request: ApiRequest,
    *,
    api_configured: bool,
    root: Path = REPO_ROOT,
    file_uploader: Callable[..., object] | None = None,
) -> None:
    """Render the export steps, upload, dry run and import for one source.

    ``file_uploader`` defaults to ``st.file_uploader``; tests inject a fake
    because AppTest cannot drive the uploader widget.
    """
    state = st.session_state
    upload_widget = file_uploader or st.file_uploader
    st.subheader(f"{source.label} saved jobs")
    st.info(
        "**First time? Do a test run.** Save 3–5 jobs, export them, upload the "
        "file and click **Validate (dry run)**. Check the counts and the "
        "checklist before importing anything."
    )
    st.markdown(
        "\n".join(
            [
                "1. Save the jobs you want on the site.",
                (
                    f"2. Open **{source.saved_page_name}** ({source.saved_page_url}), "
                    "page 1, while signed in."
                ),
                (
                    "3. Open the browser console (F12), paste the script below and "
                    f"press Enter. It downloads `{source.export_file_name}`. If it "
                    f"stops early, run `{source.resume_call}` later."
                ),
                "4. Upload the file here and click **Validate (dry run)**.",
                "5. If the counts look right, click **Import**.",
                "6. The pipeline picks the jobs up on its next run.",
            ]
        )
    )
    with st.expander(f"Export script ({source.script_path})"):
        try:
            st.code(read_export_script(source, root), language="javascript")
        except OSError as error:
            st.error(
                f"The export script could not be read from the repository: "
                f"{escape_markdown(error)}"
            )

    if not api_configured:
        st.warning(
            "The managed API is not configured (set JDEC_API_BASE_URL), so "
            "validation and import are unavailable here. Use the command line "
            "below."
        )

    uploaded = upload_widget(
        f"Upload {source.export_file_name}",
        type=["json"],
        key=_state_key(source, "file"),
    )
    saved_count = st.number_input(
        "How many jobs did you save? (optional, for the checklist)",
        min_value=0,
        max_value=10_000,
        value=0,
        step=1,
        key=_state_key(source, "saved_count"),
    )

    items: list | None = None
    file_hash: str | None = None
    if uploaded is not None:
        data = uploaded.getvalue()
        file_hash = content_hash(data)
        try:
            items = parse_export_bytes(data)
            st.caption(f"{len(items)} job(s) in the file.")
        except ValueError as error:
            st.error(escape_markdown(error))

    validate_col, import_col = st.columns(2)
    validate_clicked = validate_col.button(
        "Validate (dry run)",
        key=_state_key(source, "validate"),
        disabled=not (api_configured and items is not None),
    )
    if validate_clicked and items is not None and file_hash:
        try:
            with st.spinner("Validating…"):
                response = _call_import(api_request, source, items, dry_run=True)
            if not record_dry_run(state, source, file_hash, response):
                st.warning(
                    "The dry run found nothing to import. Fix the file using the "
                    "reasons below and validate again."
                )
        except Exception as error:  # noqa: BLE001 - shown to the user, never swallowed
            clear_validation(state, source)
            state[_state_key(source, "dry_run")] = None
            st.error(f"Validation failed: {escape_markdown(error)}")

    can_import = api_configured and import_enabled(state, source, file_hash)
    import_clicked = import_col.button(
        "Import",
        key=_state_key(source, "import"),
        type="primary",
        disabled=not can_import,
        help=None if can_import else "Validate this exact file first.",
    )
    if import_clicked and can_import and items is not None and file_hash:
        try:
            with st.spinner("Importing…"):
                response = _call_import(api_request, source, items, dry_run=False)
            state[_state_key(source, "import_result")] = {
                "hash": file_hash,
                "response": response,
            }
            clear_validation(state, source)
        except Exception as error:  # noqa: BLE001 - shown to the user, never swallowed
            st.error(f"Import failed: {escape_markdown(error)}")
        else:
            # Re-render so the Import button reflects the consumed validation.
            st.rerun()

    dry_run = state.get(_state_key(source, "dry_run"))
    if (
        isinstance(dry_run, Mapping)
        and dry_run.get("hash") == file_hash
        and isinstance(dry_run.get("response"), Mapping)
    ):
        st.markdown("#### Dry-run result (nothing written)")
        _render_result(dry_run["response"], source, file_hash, saved_count or None)

    imported = state.get(_state_key(source, "import_result"))
    if (
        isinstance(imported, Mapping)
        and imported.get("hash") == file_hash
        and isinstance(imported.get("response"), Mapping)
    ):
        response = imported["response"]
        st.markdown("#### Import result")
        staged = _int(_totals(response).get("staged"))
        st.success(
            f"Staged {staged} new job(s). The pipeline picks these up on its next "
            "run (hourly)."
        )
        _render_result(response, source, file_hash, saved_count or None)

    with st.expander("Command-line equivalent"):
        st.code(
            "\n".join(
                [
                    f"{source.cli_command} -- path/to/{source.export_file_name} --dry-run",
                    f"{source.cli_command} -- path/to/{source.export_file_name}",
                ]
            ),
            language="bash",
        )


def render_saved_jobs_tab(
    api_request: ApiRequest,
    *,
    api_configured: bool,
    root: Path = REPO_ROOT,
    file_uploader: Callable[..., object] | None = None,
) -> None:
    """Render the "Saved jobs" tab with LinkedIn and MyCareersFuture sections."""
    st.caption(
        "The export script runs in your own signed-in browser, at a human pace, "
        "and reads only the jobs you saved. Nothing here signs in to LinkedIn or "
        "MyCareersFuture, and nothing is unsaved. MyCareersFuture's terms restrict "
        "storing site content without SWDA permission; importing MCF jobs is "
        "recorded as your accepted personal-use risk."
    )
    for index, source in enumerate(SOURCES):
        if index:
            st.divider()
        render_saved_jobs_section(
            source,
            api_request,
            api_configured=api_configured,
            root=root,
            file_uploader=file_uploader,
        )
