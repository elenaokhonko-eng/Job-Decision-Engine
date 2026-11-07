"""User-supervised, single-job application preparation UI."""

import base64
import hashlib
import json
import re
import time
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import docx
from docx.opc.exceptions import PackageNotFoundError
from jsonschema import Draft202012Validator, FormatChecker, ValidationError
import streamlit as st


PROJECT_ROOT = Path(__file__).resolve().parent
SCHEMA_DIRECTORY = PROJECT_ROOT / "src" / "contracts" / "json"
_SCHEMA_CACHE = {}
# api_request raises RuntimeError for HTTP errors, OSError for transport failures and
# timeouts, ValueError for bad JSON; contract and integrity checks raise ValueError.
API_CALL_ERRORS = (RuntimeError, ValueError, OSError)
UPLOAD_READ_ERRORS = (ValueError, OSError, BadZipFile, KeyError, PackageNotFoundError)
MANUAL_SCHEMA_VERSION = "manual_application_v1"
# api_error_message formats an API refusal as "HTTP 409 JOB_VERSION_CHANGED: <message>".
_API_ERROR_CODE = re.compile(r"^HTTP \d{3} ([A-Z_]+):")
# Opening a pipeline job: these refusals hold for that posting version, so the button is not offered again.
PIPELINE_FINAL_CODES = {"JOB_VERSION_CHANGED", "DESCRIPTION_INSUFFICIENT"}
# Another request was staging the same comparison; one automatic retry returns its draft.
PIPELINE_RETRYABLE_CODES = {"CONCURRENT_UPDATE"}
PIPELINE_RETRY_DELAY_SECONDS = 3
# Document generation runs as a job on the API: start it, then poll. No single request waits long.
DOCUMENT_JOB_START_TIMEOUT_SECONDS = 30
DOCUMENT_JOB_POLL_TIMEOUT_SECONDS = 15
DOCUMENT_JOB_POLL_SECONDS = 2
# Stop polling after this long; the API marks a job past its own deadline as interrupted.
DOCUMENT_JOB_CLIENT_MAX_SECONDS = 420
DOCUMENT_JOB_STEP_LABELS = {
    "SUMMARY": "AI CV summary",
    "LETTER": "AI cover letter",
    "FILES": "DOCX and PDF files",
}
DOCUMENT_JOB_STEP_STATUS = {
    "PENDING": "waiting",
    "RUNNING": "in progress",
    "COMPLETED": "done",
    "FALLBACK": "AI not used; built from your statements",
    "SKIPPED": "not needed",
    "FAILED": "failed",
}
DOCUMENT_JOB_FAILURE_KINDS = {
    "RATE_LIMITED": "the AI provider was rate limited (429)",
    "TIMEOUT": "the AI call ran out of time",
    "VALIDATION": "the AI draft did not pass the evidence checks",
    "PROVIDER_ERROR": "the AI provider returned an error",
}


def _validate_payload(schema_name, payload):
    schema = _SCHEMA_CACHE.get(schema_name)
    if schema is None:
        schema_path = SCHEMA_DIRECTORY / f"{schema_name}.schema.json"
        with schema_path.open("r", encoding="utf-8") as schema_file:
            schema = json.load(schema_file)
        Draft202012Validator.check_schema(schema)
        _SCHEMA_CACHE[schema_name] = schema
    try:
        Draft202012Validator(schema, format_checker=FormatChecker()).validate(payload)
    except ValidationError as error:
        location = ".".join(str(part) for part in error.absolute_path) or "<root>"
        raise ValueError(
            f"API {schema_name} contract violation at {location}: {error.message}"
        ) from error
    return payload


def _validate_document_pair(artifacts):
    keys = {(item.get("type"), item.get("format")) for item in artifacts}
    expected = {
        ("CV", "DOCX"),
        ("CV", "PDF"),
        ("COVER_LETTER", "DOCX"),
        ("COVER_LETTER", "PDF"),
    }
    if len(artifacts) != 4 or keys != expected:
        raise ValueError(
            "The API did not return one DOCX and one PDF for both documents."
        )


def extract_uploaded_description(uploaded_file):
    if uploaded_file is None:
        return ""
    name = (uploaded_file.name or "").lower()
    data = uploaded_file.getvalue()
    if len(data) > 1_000_000:
        raise ValueError(
            "The uploaded source file is larger than the 1 MB manual import limit."
        )
    if name.endswith(".txt"):
        text = data.decode("utf-8-sig")
        if len(text) > 100_000:
            raise ValueError(
                "The extracted description exceeds the 100,000 character limit."
            )
        return text
    if name.endswith(".docx"):
        with ZipFile(BytesIO(data)) as archive:
            members = archive.infolist()
            if (
                len(members) > 1_000
                or sum(item.file_size for item in members) > 5_000_000
            ):
                raise ValueError(
                    "The uploaded Word file expands beyond the 5 MB import limit."
                )
        document = docx.Document(BytesIO(data))
        blocks = [
            paragraph.text
            for paragraph in document.paragraphs
            if paragraph.text.strip()
        ]
        for table in document.tables:
            blocks.extend(
                "\t".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                for row in table.rows
            )
        text = "\n".join(block for block in blocks if block.strip())
        if len(text) > 100_000:
            raise ValueError(
                "The extracted description exceeds the 100,000 character limit."
            )
        return text
    raise ValueError("Upload a plain text (.txt) or Word (.docx) job description.")


def _download_bytes(api_request, draft_id, artifact):
    return _fetch_artifact(
        api_request,
        f"/api/v2/application-drafts/{draft_id}/documents/{artifact['type'].lower()}/{artifact['format'].lower()}",
        artifact["format"],
    )


def _download_selected_bytes(api_request, selection, document_type, format_name):
    """The exact file chosen for an application, checked against the hash pinned at selection."""
    return _fetch_artifact(
        api_request,
        f"/api/v2/application-drafts/selections/{selection['selection_id']}/documents/"
        f"{document_type.lower()}/{format_name.lower()}",
        format_name,
        expected_sha256=selection[
            f"{document_type.lower()}_{format_name.lower()}_sha256"
        ],
    )


def _fetch_artifact(api_request, path, format_name, expected_sha256=None):
    response = api_request("GET", path, timeout=60)
    _validate_payload("ManualDownloadResponse", response)
    if not response.get("ok") or not response.get("content_base64"):
        raise RuntimeError(
            response.get("error") or "The API did not return a document artifact."
        )
    content = base64.b64decode(response["content_base64"], validate=True)
    if hashlib.sha256(content).hexdigest() != response["sha256"]:
        raise ValueError(
            "The downloaded private artifact failed its SHA-256 integrity check."
        )
    if expected_sha256 is not None and response["sha256"] != expected_sha256:
        raise ValueError(
            "The downloaded file is not the version chosen for this application."
        )
    expected_mime = {
        "PDF": ("application/pdf", b"%PDF-"),
        "DOCX": (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            b"PK\x03\x04",
        ),
    }
    mime, signature = expected_mime[format_name]
    if response["mime_type"] != mime or not content.startswith(signature):
        raise ValueError(
            "The downloaded file type does not match its validated artifact metadata."
        )
    filename = response["filename"]
    if not re.fullmatch(r"[A-Za-z0-9_. -]{1,160}", filename):
        raise ValueError("The private document filename is invalid.")
    return content, filename


ROLE_LAYOUT_LABELS = {
    "FULL": "Full entry",
    "ONE_LINE": "One line",
    "SUMMARISED": "In the earlier-roles line",
    "HIDDEN": "Hide",
}


def _render_role_choices(role_plan, fingerprint, locked=False):
    """Lets the candidate choose how each role appears on the CV before generating.

    Returns only the choices that differ from the default, keyed by engagement id.
    """
    if not role_plan:
        return {}
    choices = {}
    with st.expander("Choose which roles appear on the CV", expanded=not locked):
        if locked:
            st.caption(
                "Documents for this approval are generated. To change the roles, compare the posting again."
            )
        for role in role_plan:
            default = role.get("default_layout", "ONE_LINE")
            options = ["FULL", "ONE_LINE", "HIDDEN"]
            if default == "SUMMARISED":
                options = ["SUMMARISED", *options]
            period = f" ({role['period']})" if role.get("period") else ""
            source = (
                " · your profile default"
                if role.get("default_source") == "PROFILE"
                else ""
            )
            chosen = st.selectbox(
                f"{role.get('label', '')}{period}{source}",
                options,
                index=options.index(default),
                format_func=ROLE_LAYOUT_LABELS.get,
                key=f"manual_role_{fingerprint}_{role.get('engagement_id')}",
                disabled=locked,
            )
            if chosen != default:
                choices[role["engagement_id"]] = chosen
    return choices


def _evidence_cell(item):
    """One evidence line for the review table, with the model's confidence and reason when it proposed the pair."""
    statement = item.get("statement", "")
    if item.get("confidence") is None:
        return statement
    reason = f" Why: {item['justification']}" if item.get("justification") else ""
    return f"{statement} (confidence {item['confidence']:.2f}.{reason})"


def _render_fit_check(fit):
    """Shows MUST-requirement coverage before approval. Returns True when fewer than half have evidence."""
    if not fit:
        return False
    if fit.get("verdict") == "FEWER_THAN_HALF_MUSTS_EVIDENCED":
        st.warning(fit.get("message", ""))
        for item in fit.get("uncovered_must") or []:
            st.text(f"No evidence: {item.get('requirement', '')}")
        st.caption(fit.get("advisory", ""))
        return True
    st.info(fit.get("message", ""))
    return False


WRITTEN_SECTION_TEXT = {
    "summary": ("CV summary", "summary", "The summary was built from your statements."),
    "cover_letter": (
        "cover letter",
        "letter",
        "The letter was assembled from your statements.",
    ),
}


FRAMING_LABELS = {
    "OPENING": "Opening",
    "GAP_NOTE": "Gap note",
    "CANDIDATE_GAP_NOTE": "Your gap sentence",
    "CLOSING": "Closing",
}

REVIEW_DECISIONS = {
    "ACCEPTED": "Use the evidence chosen below",
    "PARTIAL": "Partly met: some evidence, plus a gap sentence",
    "GAP": "Not met: no evidence (gap)",
    "NOT_APPLICABLE": "Not applicable: leave it out of the documents",
}
MAX_EVIDENCE_PER_ROW = 3
MAX_CV_PAGES = 2


def _evidence_option_label(item):
    """How one selectable fact reads in the evidence picker: the statement, then its role and dates."""
    where = item.get("role") or (
        "Credential" if item.get("evidence_type") == "CREDENTIAL" else "Profile"
    )
    period = f", {item['period']}" if item.get("period") else ""
    return f"{item.get('statement', '')} [{where}{period}]"


def _row_widget_keys(fingerprint, key):
    return [
        f"manual_review_{part}_{fingerprint}_{key}"
        for part in ("decision", "evidence", "gap")
    ]


def _default_decision(row, proposed):
    """Keep the proposed evidence, or partly met when the comparison found the record falls short."""
    if not proposed:
        return "GAP"
    return "PARTIAL" if row.get("suggested_status") == "PARTIAL" else "ACCEPTED"


def _render_review_row(row, labels, fingerprint, locked, corrections, problems):
    """Controls for one requirement; appends its correction (if changed) and any problem."""
    key = row.get("requirement_key", "")
    proposed = [item["id"] for item in row.get("evidence") or [] if item.get("id")]
    # The proposed evidence is always offered, even if the picker list lacks it.
    for item in row.get("evidence") or []:
        labels.setdefault(item.get("id"), item.get("statement", ""))
    default_decision = _default_decision(row, proposed)
    decision_key, evidence_key, gap_key = _row_widget_keys(fingerprint, key)
    st.text(f"{row.get('importance', '')} · {row.get('requirement', '')}")
    for item in row.get("attention") or []:
        st.warning(f"Check: {item.get('detail', '')}")
    decision = st.selectbox(
        "Decision",
        list(REVIEW_DECISIONS),
        index=list(REVIEW_DECISIONS).index(default_decision),
        format_func=REVIEW_DECISIONS.get,
        key=decision_key,
        disabled=locked,
    )
    chosen = st.multiselect(
        "Evidence",
        list(labels),
        default=[item for item in proposed if item in labels],
        format_func=lambda item: labels.get(item, item),
        max_selections=MAX_EVIDENCE_PER_ROW,
        key=evidence_key,
        disabled=locked or decision in ("GAP", "NOT_APPLICABLE"),
    )
    gap_sentence = ""
    if decision in ("GAP", "PARTIAL"):
        gap_sentence = st.text_input(
            "Gap sentence for the letter (optional, your own words)",
            key=gap_key,
            disabled=locked,
        ).strip()
    evidence_ids = [] if decision in ("GAP", "NOT_APPLICABLE") else chosen
    if decision == "ACCEPTED" and not evidence_ids:
        problems.append(
            f"Choose evidence for “{row.get('requirement', '')}”, or mark it not met."
        )
    if gap_sentence and len(gap_sentence) < 10:
        problems.append("A gap sentence needs at least 10 characters.")
    unchanged = (
        decision == default_decision and evidence_ids == proposed and not gap_sentence
    )
    if not unchanged:
        correction = {
            "requirement_key": key,
            "status": decision,
            "evidence_ids": evidence_ids,
        }
        if gap_sentence:
            correction["gap_sentence"] = gap_sentence
        corrections.append(correction)
    st.divider()


def _render_review_corrections(rows, selectable, fingerprint, locked=False):
    """Per-requirement controls to correct the proposed matches before approving.

    MUST requirements are shown open; optional ones (mostly the posting's duties) are collapsed,
    with one button to accept every suggestion. Rows the comparison flags (a market or product the
    evidence does not name, a years threshold, a named certification) say why, and start as partly
    met when the record visibly falls short.

    Returns (corrections, problem): only the rows the candidate changed, in the API's shape, and a
    message when a choice cannot be approved as it stands.
    """
    if not rows:
        return [], None
    labels = {item["id"]: _evidence_option_label(item) for item in selectable or []}
    corrections, problems = [], []
    must_rows = [row for row in rows if row.get("importance") == "MUST"]
    optional_rows = [row for row in rows if row.get("importance") != "MUST"]
    flagged = sum(1 for row in rows if row.get("attention"))
    with st.expander(
        f"Check the MUST requirements ({len(must_rows)})", expanded=not locked
    ):
        st.caption(
            "For each requirement: keep or change the evidence (type to search your facts), mark it "
            "partly met or not met with your own gap sentence, or leave it out as not applicable. "
            "Documents use only what you approve here. A high confidence score is not proof: "
            "check every row marked “Check”."
            + (f" {flagged} row(s) need a look." if flagged else "")
        )
        for row in must_rows:
            _render_review_row(row, labels, fingerprint, locked, corrections, problems)
    if optional_rows:
        with st.expander(
            f"Optional requirements ({len(optional_rows)}): suggested matches",
            expanded=False,
        ):
            if not locked and st.button(
                "Accept all suggested",
                key=f"manual_review_accept_optional_{fingerprint}",
            ):
                for row in optional_rows:
                    for widget_key in _row_widget_keys(
                        fingerprint, row.get("requirement_key", "")
                    ):
                        st.session_state.pop(widget_key, None)
                st.rerun()
            for row in optional_rows:
                _render_review_row(
                    row, labels, fingerprint, locked, corrections, problems
                )
    return corrections, (" ".join(problems) or None)


def _render_gap_note_choice(fit, fingerprint, locked=False):
    """Asks whether the AI letter may admit one MUST requirement without evidence.

    Shown only when the fit check found such a requirement. Returns the choice, or None when
    there is nothing to ask.
    """
    if not (fit or {}).get("uncovered_must"):
        return None
    return st.checkbox(
        "Let the AI letter include one candid sentence about a MUST requirement I have no evidence for",
        value=True,
        key=f"manual_gap_note_{fingerprint}",
        disabled=locked,
        help="The sentence says plainly that the requirement is not yet met and claims nothing to offset it. "
        "You will see it in the review either way, marked if it was left out.",
    )


def _render_written_review(review, section):
    """Shows how a written section was produced and the approved evidence behind each sentence.

    Model text and profile statements are untrusted, so they are shown with st.text, not markdown.
    """
    if not review:
        return
    name, short_name, fallback = WRITTEN_SECTION_TEXT[section]
    if review.get("mode") == "AI_WRITTEN":
        st.info(
            f"The {name} was written by AI from your approved requirement-to-evidence pairs "
            "and the job description. Check each sentence against its source before downloading."
        )
    else:
        st.warning(f"AI {name} not used. {fallback}")
        if review.get("reason"):
            st.text(review["reason"])
    sentences = review.get("sentences") or []
    if not sentences:
        return
    with st.expander(
        f"Sources for each {short_name} sentence",
        expanded=review.get("mode") == "AI_WRITTEN",
    ):
        for index, sentence in enumerate(sentences, start=1):
            st.text(f"{index}. {sentence.get('text', '')}")
            for item in sentence.get("evidence") or []:
                st.text(f"    Source: {item.get('statement', '')}")
        framing = review.get("framing") or []
        if framing:
            st.caption(
                "Opening, closing and gap note: these state no achievement, so they cite no source."
            )
            for item in framing:
                label = FRAMING_LABELS.get(item.get("kind"), "Framing")
                if not item.get("included", True):
                    label += " (left out)"
                st.text(f"{label}: {item.get('text', '')}")


def _document_job_step_lines(job):
    lines = []
    for step in job.get("steps") or []:
        label = DOCUMENT_JOB_STEP_LABELS.get(step.get("step"), step.get("step"))
        status = DOCUMENT_JOB_STEP_STATUS.get(step.get("status"), step.get("status"))
        line = f"{label}: {status}"
        kind = DOCUMENT_JOB_FAILURE_KINDS.get(step.get("failure_kind"))
        if kind:
            line += f" ({kind})"
        if step.get("elapsed_ms") is not None and step.get("status") != "RUNNING":
            line += f" in {step['elapsed_ms'] / 1000:.0f} s"
        lines.append(line)
    return lines


def _start_document_job(api_request, draft_id, body, on_success=None):
    """Starts (or rejoins) the API's document job for one approval; polling continues on rerun."""
    response = api_request(
        "POST",
        f"/api/v2/application-drafts/{draft_id}/documents",
        body=body,
        timeout=DOCUMENT_JOB_START_TIMEOUT_SECONDS,
    )
    _validate_payload("ManualDocumentJobResponse", response)
    job = response["job"]
    st.session_state["manual_document_job"] = {
        "job_id": job["job_id"],
        "draft_id": draft_id,
        "started_at": time.time(),
        "on_success": on_success or {},
    }
    if not _finish_document_job(job):
        st.rerun()


def _finish_document_job(job):
    """Applies a finished job (documents or the API's error); False while it is still running."""
    status = job.get("status")
    if status not in ("SUCCEEDED", "FAILED"):
        return False
    state = st.session_state.pop("manual_document_job", None) or {}
    if status == "FAILED":
        error = job.get("error") or {}
        code = error.get("code") or "GENERATION_FAILED"
        message = error.get("message") or "Document generation failed."
        st.session_state["manual_document_job_error"] = f"{code}: {message}"
        return True
    result = job.get("result") or {}
    _validate_payload("ManualDocumentsResponse", result)
    _validate_document_pair(result.get("artifacts") or [])
    on_success = state.get("on_success") or {}
    if on_success.get("approval"):
        st.session_state["manual_approval"] = on_success["approval"]
    st.session_state["manual_generated_documents"] = result
    st.session_state["manual_document_job_steps"] = _document_job_step_lines(job)
    if (
        on_success.get("retry_summary")
        and (result.get("summary") or {}).get("mode") == "AI_WRITTEN"
    ):
        st.session_state["manual_document_job_notice"] = (
            "The AI summary is in place; the cover letter is unchanged."
        )
    return True


def _poll_document_job(api_request):
    """One status check per run while a document job is running; shows progress, then reruns."""
    state = st.session_state.get("manual_document_job")
    if not state:
        return
    try:
        response = api_request(
            "GET",
            f"/api/v2/application-drafts/{state['draft_id']}/document-jobs/{state['job_id']}",
            timeout=DOCUMENT_JOB_POLL_TIMEOUT_SECONDS,
        )
        _validate_payload("ManualDocumentJobResponse", response)
    except API_CALL_ERRORS as error:
        st.session_state.pop("manual_document_job", None)
        st.session_state["manual_document_job_error"] = (
            f"Could not check document generation: {error}"
        )
        return
    job = response["job"]
    if _finish_document_job(job):
        return
    st.info(
        "Generating your CV and cover letter. This page updates by itself.\n\n"
        + "\n".join(f"- {line}" for line in _document_job_step_lines(job))
    )
    if (
        time.time() - state.get("started_at", time.time())
        > DOCUMENT_JOB_CLIENT_MAX_SECONDS
    ):
        st.session_state.pop("manual_document_job", None)
        st.session_state["manual_document_job_error"] = (
            "Document generation is taking longer than expected. Press Generate again in a moment: "
            "the API returns the finished documents, or reports why it stopped."
        )
        return
    time.sleep(DOCUMENT_JOB_POLL_SECONDS)
    st.rerun()


def _show_document_job_messages():
    error = st.session_state.pop("manual_document_job_error", None)
    if error:
        st.error(f"Could not generate the document pair: {error}")
    notice = st.session_state.pop("manual_document_job_notice", None)
    if notice:
        st.success(notice)


def _retry_summary(api_request, draft_id, fingerprint, approval, generated):
    """Approves the same review again as a new revision and regenerates, keeping an AI-written letter.

    Only the summary call runs again when the letter was AI-written; the earlier revision's
    documents stay downloadable.
    """
    try:
        body = {
            "approved": True,
            "comparison_fingerprint": fingerprint,
            "new_revision": True,
        }
        corrections = st.session_state.get("manual_approved_corrections") or []
        if corrections:
            body["corrections"] = corrections
        revision = api_request(
            "POST",
            f"/api/v2/application-drafts/{draft_id}/approve",
            body=body,
            timeout=60,
        )
        _validate_payload("ManualApprovalResponse", revision)
        generate = {
            "approval_id": revision.get("approval_id"),
            **(st.session_state.get("manual_generate_options") or {}),
        }
        if (generated.get("cover_letter") or {}).get("mode") == "AI_WRITTEN":
            generate["reuse_cover_letter_from"] = approval.get("approval_id")
        _start_document_job(
            api_request,
            draft_id,
            generate,
            on_success={"approval": revision, "retry_summary": True},
        )
    except API_CALL_ERRORS as error:
        st.error(f"Could not retry the AI summary: {error}")


def _api_error_code(error):
    match = _API_ERROR_CODE.match(str(error))
    return match.group(1) if match else None


def open_pipeline_job_for_review(api_request, job):
    """Makes a pipeline job version the comparison under review in the Add job tab.

    Returns None when the review is open, or (final, message) when it could not be opened.
    """
    body = {
        "schema_version": MANUAL_SCHEMA_VERSION,
        "canonical_job_id": str(job["canonical_job_id"]),
        "job_version_id": str(job["job_version_id"]),
    }
    candidate_profile_id = st.session_state.get("manual_candidate_profile")
    if candidate_profile_id:
        body["candidate_profile_id"] = candidate_profile_id
    for attempt in range(2):
        try:
            comparison = api_request(
                "POST",
                "/api/v2/application-drafts/compare-existing",
                body=body,
                timeout=120,
            )
            _validate_payload("ManualCompareResponse", comparison)
            break
        except API_CALL_ERRORS as error:
            code = _api_error_code(error)
            if code in PIPELINE_RETRYABLE_CODES and attempt == 0:
                time.sleep(PIPELINE_RETRY_DELAY_SECONDS)
                continue
            return code in PIPELINE_FINAL_CODES, _API_ERROR_CODE.sub(
                "", str(error)
            ).strip()
    st.session_state["manual_comparison"] = comparison
    st.session_state.pop("manual_approval", None)
    st.session_state.pop("manual_generated_documents", None)
    return None


def render_pipeline_review_action(api_request, job, key_prefix):
    """Offers the manual review, approve and generate screens for a job the pipeline holds."""
    version = str(job["job_version_id"])
    refused = st.session_state.setdefault("manual_pipeline_final_refusals", {})
    if version in refused:
        st.warning(
            f"Documents can't be prepared for this posting version: {refused[version]}"
        )
        return
    current = (st.session_state.get("manual_comparison") or {}).get(
        "selected_job"
    ) or {}
    if current.get("jobVersionId") == version:
        st.success(
            "This job is open in the Add job tab: review the matches, approve, then generate."
        )
        return
    if not st.button(
        "Prepare application documents", key=f"{key_prefix}_prepare_documents"
    ):
        return
    with st.spinner("Comparing this posting with your profile..."):
        outcome = open_pipeline_job_for_review(api_request, job)
    if outcome is None:
        st.success(
            "Opened in the Add job tab: review the matches, approve, then generate."
        )
        return
    final, message = outcome
    if final:
        refused[version] = message
        st.warning(f"Documents can't be prepared for this posting version: {message}")
    else:
        st.error(f"Could not open this job for review: {message} Try again.")


def render_selected_documents(api_request, selection):
    """The CV and cover letter chosen for an application, exactly as they were chosen."""
    if not selection:
        st.caption(
            "No documents chosen yet. Prepare them from a job card, then choose "
            "“Use these documents for my application”."
        )
        return
    st.caption(f"Documents chosen for this application on {selection['selected_at']}.")
    if selection["pipeline_readiness"] == "USER_SELECTED":
        st.info(
            "Added by you: the job was not a current Apply Now decision when you chose these documents."
        )
    for document_type, document_name in (
        ("CV", "CV"),
        ("COVER_LETTER", "Cover letter"),
    ):
        for format_name in ("DOCX", "PDF"):
            try:
                content, filename = _download_selected_bytes(
                    api_request, selection, document_type, format_name
                )
            except API_CALL_ERRORS as error:
                st.error(f"{document_name} ({format_name}) is unavailable: {error}")
                continue
            st.download_button(
                f"Download {document_name} ({format_name})",
                content,
                file_name=filename,
                key=f"tracker_download_{selection['selection_id']}_{document_type}_{format_name}",
            )


def render_manual_application_flow(api_request):
    st.subheader("Prepare documents for one manually selected role")
    st.caption(
        "Enter the posting URL even if you paste the description. This flow stages and compares only that role; it does not drain the ingestion or evaluation backlog."
    )

    candidate_profile_id = None
    try:
        candidate_response = api_request(
            "GET", "/api/v2/application-drafts/candidate-profiles", timeout=30
        )
        _validate_payload("ManualCandidateProfilesResponse", candidate_response)
        profiles = candidate_response.get("profiles") or []
        if profiles:
            profile_by_id = {
                profile["candidate_profile_id"]: profile for profile in profiles
            }
            candidate_profile_id = st.selectbox(
                "Candidate profile",
                list(profile_by_id),
                format_func=lambda profile_id: (
                    f"{profile_by_id[profile_id]['display_name']} · {profile_id[:8]}"
                ),
                key="manual_candidate_profile",
            )
        else:
            st.error(
                "No active candidate profile is available in this workspace. Activate a profile before comparing a role."
            )
    except API_CALL_ERRORS as error:
        st.error(f"Candidate profiles are unavailable: {error}")

    pending_url = st.session_state.pop("manual_pending_job_url", None)
    if pending_url:
        st.session_state["manual_job_url"] = pending_url
    job_url = st.text_input(
        "Job URL",
        key="manual_job_url",
        placeholder="https://company.example/careers/role",
    )
    title = st.text_input("Confirm job title", key="manual_job_title")
    company = st.text_input("Confirm company", key="manual_job_company")
    requisition_id = st.text_input(
        "Requisition ID (optional)", key="manual_job_requisition_id"
    )
    fetch_col, fetch_help_col = st.columns([1, 3])
    with fetch_col:
        fetch_clicked = st.button("Fetch description", key="manual_fetch_description")
    with fetch_help_col:
        st.caption(
            "If fetching is blocked by the posting site, paste the description or upload a .txt/.docx file below."
        )
    fetch_completed = False
    if fetch_clicked:
        if not job_url.strip() or not title.strip() or not company.strip():
            st.error(
                "Enter the URL and the title and company you expect the posting to contain."
            )
        else:
            try:
                fetched = api_request(
                    "POST",
                    "/api/v2/application-drafts/fetch-description",
                    body={
                        "url": job_url.strip(),
                        "title": title.strip(),
                        "company": company.strip(),
                        "requisition_id": requisition_id.strip() or None,
                    },
                    timeout=35,
                )
                _validate_payload("ManualFetchDescriptionResponse", fetched)
                if not fetched.get("ok") or not fetched.get("description"):
                    raise RuntimeError(
                        fetched.get("error") or "No description was returned."
                    )
                st.session_state["manual_job_description"] = fetched["description"]
                st.session_state["manual_pending_job_url"] = (
                    fetched.get("final_url") or job_url.strip()
                )
                st.session_state["manual_job_description_source_hash"] = hashlib.sha256(
                    fetched["description"].strip().encode("utf-8")
                ).hexdigest()
                st.session_state["manual_job_source_kind"] = "FETCHED"
                st.session_state["manual_fetch_receipt_id"] = fetched[
                    "fetch_receipt_id"
                ]
                source_evidence = fetched["source_evidence"]
                st.session_state["manual_fetch_identity"] = {
                    "urls": {
                        source_evidence["requestedUrl"],
                        source_evidence["resolvedUrl"],
                        fetched["final_url"],
                    },
                    "title": title.strip(),
                    "company": company.strip(),
                    "requisition_id": requisition_id.strip() or None,
                }
                st.session_state["manual_fetch_error"] = None
                fetch_completed = True
            except API_CALL_ERRORS as error:
                st.session_state["manual_fetch_error"] = str(error)
    if fetch_completed:
        st.rerun()
    if st.session_state.get("manual_fetch_error"):
        st.warning(
            f"Description fetch failed: {st.session_state['manual_fetch_error']} Paste or upload the description to continue."
        )

    uploaded_file = st.file_uploader(
        "Upload description (.txt or .docx)",
        type=["txt", "docx"],
        key="manual_job_upload",
    )
    if uploaded_file is not None:
        upload_marker = (
            uploaded_file.name,
            hashlib.sha256(uploaded_file.getvalue()).hexdigest(),
        )
        if st.session_state.get("manual_job_upload_marker") != upload_marker:
            try:
                st.session_state["manual_job_description"] = (
                    extract_uploaded_description(uploaded_file)
                )
                st.session_state["manual_job_upload_marker"] = upload_marker
                st.session_state["manual_job_source_kind"] = "UPLOAD"
                st.session_state.pop("manual_fetch_receipt_id", None)
                st.session_state.pop("manual_fetch_identity", None)
            except UPLOAD_READ_ERRORS as error:
                st.error(f"Could not read uploaded description: {error}")
    description = st.text_area(
        "Confirm or edit the imported job description",
        key="manual_job_description",
        height=260,
        help="Check that the title, company and text belong to the exact posting you want to prepare for.",
    )

    input_signature = (
        job_url.strip(),
        title.strip(),
        company.strip(),
        description.strip(),
        candidate_profile_id,
    )
    previous_signature = st.session_state.get("manual_preparation_input_signature")
    if previous_signature is not None and previous_signature != input_signature:
        st.session_state.pop("manual_comparison", None)
        st.session_state.pop("manual_approval", None)
        st.session_state.pop("manual_generated_documents", None)
        fetch_identity = st.session_state.get("manual_fetch_identity")
        if fetch_identity and (
            job_url.strip() not in fetch_identity["urls"]
            or title.strip().casefold() != fetch_identity["title"].casefold()
            or company.strip().casefold() != fetch_identity["company"].casefold()
            or (requisition_id.strip() or None) != fetch_identity["requisition_id"]
        ):
            st.session_state.pop("manual_fetch_receipt_id", None)
            st.session_state.pop("manual_fetch_identity", None)
            if st.session_state.get("manual_job_source_kind") == "FETCHED":
                st.session_state["manual_job_source_kind"] = "PASTED"
    st.session_state["manual_preparation_input_signature"] = input_signature

    compare_clicked = st.button(
        "Compare with my profile", type="primary", key="manual_compare"
    )
    comparison_completed = False
    if compare_clicked:
        if not candidate_profile_id:
            st.error("Select an active candidate profile before comparing this role.")
        elif (
            not job_url.strip()
            or not title.strip()
            or not company.strip()
            or len(description.strip()) < 100
        ):
            st.error(
                "Provide the posting URL, confirm the title and company, and enter at least 100 characters of job description."
            )
        elif len(description) > 100_000:
            st.error(
                "The confirmed job description exceeds the 100,000 character limit."
            )
        else:
            try:
                source_kind = st.session_state.get("manual_job_source_kind")
                if source_kind not in {"UPLOAD", "FETCHED"}:
                    source_kind = "PASTED"
                compare_body = {
                    "schema_version": "manual_application_v1",
                    "candidate_profile_id": candidate_profile_id,
                    "source_kind": source_kind,
                    "title": title.strip(),
                    "company": company.strip(),
                    "url": job_url.strip(),
                    "requisition_id": requisition_id.strip() or None,
                    "description": description.strip(),
                    "location": "Unknown",
                }
                if source_kind == "FETCHED":
                    receipt_id = st.session_state.get("manual_fetch_receipt_id")
                    if not receipt_id:
                        raise ValueError(
                            "The verified fetch receipt is no longer available. Fetch the posting again or paste/upload its description."
                        )
                    compare_body["fetch_receipt_id"] = receipt_id
                comparison = api_request(
                    "POST",
                    "/api/v2/application-drafts/compare",
                    body=compare_body,
                    timeout=120,
                )
                _validate_payload("ManualCompareResponse", comparison)
                if not comparison.get("ok"):
                    raise RuntimeError(comparison.get("error") or "Comparison failed.")
                st.session_state["manual_comparison"] = comparison
                st.session_state.pop("manual_approval", None)
                st.session_state.pop("manual_generated_documents", None)
                comparison_completed = True
            except API_CALL_ERRORS as error:
                st.error(f"Could not compare this role: {error}")
    if comparison_completed:
        st.rerun()

    comparison = st.session_state.get("manual_comparison")
    if not comparison:
        return
    st.markdown("### Selected posting")
    selected = comparison.get("selected_job") or {}
    st.text(f"{selected.get('title') or title} at {selected.get('company') or company}")
    if selected.get("url"):
        st.caption("Version-pinned posting URL")
        st.code(selected["url"], language=None)
    source = selected.get("source") or {}
    if source.get("source_kind") == "FETCHED":
        evidence = source.get("source_evidence") or {}
        st.caption(
            f"Verified source: {source.get('provider')} · retrieved {evidence.get('retrievedAt')} · "
            f"HTTP {evidence.get('httpStatus')} · response SHA-256 {str(evidence.get('responseHash', ''))[:12]}…"
        )
        if source.get("source_content_status") == "USER_EDITED":
            st.warning(
                "You edited the fetched description. Its retrieval evidence is retained, but the staged text is marked user-edited and is not attested by that fetch."
            )
        else:
            st.info(
                "The staged description matches the verified fetched content. The retrieval evidence is pinned to this posting observation."
            )
    elif source.get("source_kind") == "PIPELINE":
        st.caption(
            f"Source: a job the pipeline found ({source.get('source_name')}); its stored posting version is cited as it is."
        )
    else:
        st.caption(
            "Source: user-pasted or uploaded description; no public retrieval receipt is attached."
        )

    payload = comparison.get("comparison") or {}
    for warning in payload.get("suitability_warnings", []):
        st.warning(warning)
    st.info(
        payload.get("evidence_notice")
        or "Review every potential evidence match and gap yourself."
    )
    rows = []
    for row in payload.get("rows", []):
        evidence = row.get("evidence") or []
        rows.append(
            {
                "Requirement": row.get("requirement", ""),
                "Importance": row.get("importance", ""),
                "Potential profile evidence": "\n\n".join(
                    _evidence_cell(item) for item in evidence
                )
                or "No direct evidence",
                "Gap / review": row.get("gap")
                or "Review whether the potential evidence actually meets this requirement.",
                "Needs a look": " ".join(
                    item.get("detail", "") for item in row.get("attention") or []
                ),
            }
        )
    st.markdown("### Requirement, evidence and gap review")
    if rows:
        st.dataframe(rows, width="stretch", hide_index=True)
    else:
        st.warning(
            "No deterministic requirements were extracted. Review the description and confirm the gap manually before approval."
        )

    if comparison.get("document_contact_ready") is False:
        missing = (
            ", ".join(comparison.get("missing_contact_fields", [])) or "required fields"
        )
        st.error(
            f"The active private profile contact graph is missing: {missing}. Update those private profile contact facts before document preparation."
        )
        return

    draft_id = comparison.get("draft_id")
    fingerprint = comparison.get("comparison_fingerprint")
    corrections, correction_problem = _render_review_corrections(
        payload.get("rows", []),
        comparison.get("selectable_evidence") or [],
        fingerprint,
        locked=bool(st.session_state.get("manual_generated_documents")),
    )
    poor_fit = _render_fit_check(payload.get("fit"))
    approval_key = f"manual_approval_checked_{fingerprint}"
    poor_fit_key = f"manual_poor_fit_acknowledged_{fingerprint}"
    st.checkbox("I screened this role and want to prepare documents", key=approval_key)
    if poor_fit:
        st.checkbox(
            "I understand most MUST requirements have no evidence and still want documents",
            key=poor_fit_key,
        )
    if st.button("Approve document preparation", key="manual_approve"):
        if not st.session_state.get(approval_key):
            st.error(
                "Check the explicit approval box after reviewing the job and evidence table."
            )
        elif poor_fit and not st.session_state.get(poor_fit_key):
            st.error(
                "Fewer than half of the MUST requirements have evidence. Confirm you still want documents for this role."
            )
        elif correction_problem:
            st.error(correction_problem)
        else:
            try:
                body = {"approved": True, "comparison_fingerprint": fingerprint}
                if corrections:
                    body["corrections"] = corrections
                result = api_request(
                    "POST",
                    f"/api/v2/application-drafts/{draft_id}/approve",
                    body=body,
                    timeout=60,
                )
                _validate_payload("ManualApprovalResponse", result)
                if not result.get("ok"):
                    raise RuntimeError(
                        result.get("error") or "Approval was not recorded."
                    )
                st.session_state["manual_approval"] = result
                st.session_state["manual_approved_corrections"] = corrections
                st.session_state.pop("manual_generated_documents", None)
                st.success(
                    "Your approval is recorded for this exact job version, profile version, requirement set, comparison"
                    + (
                        f" and your {len(corrections)} correction(s)."
                        if corrections
                        else "."
                    )
                )
            except API_CALL_ERRORS as error:
                st.error(f"Could not record approval: {error}")

    approval = st.session_state.get("manual_approval")
    if not approval or not draft_id:
        return
    locked = bool(st.session_state.get("manual_generated_documents"))
    if not locked and corrections != st.session_state.get(
        "manual_approved_corrections", []
    ):
        st.warning(
            "You changed the corrections after approving. Approve again to use them."
        )
        return
    role_layout = _render_role_choices(
        comparison.get("role_plan") or [], fingerprint, locked=locked
    )
    include_gap_note = _render_gap_note_choice(
        payload.get("fit"), fingerprint, locked=locked
    )
    include_match_section = st.checkbox(
        "Add a “How my experience matches this role” section to the CV",
        value=False,
        key=f"manual_match_section_{fingerprint}",
        disabled=locked,
        help="Off by default: the cover letter already maps your record to the requirements, "
        "and the section repeats your Experience bullets.",
    )
    # Check a running generation job first, so its outcome decides what the buttons offer.
    _poll_document_job(api_request)
    _show_document_job_messages()
    job_running = bool(st.session_state.get("manual_document_job"))
    if st.button(
        "Generate customised CV and cover letter",
        type="primary",
        key="manual_generate",
        disabled=job_running,
    ):
        try:
            body = {"approval_id": approval.get("approval_id")}
            if role_layout:
                body["role_layout"] = role_layout
            if include_gap_note is not None:
                body["include_gap_note"] = include_gap_note
            if include_match_section:
                body["include_match_section"] = True
            st.session_state["manual_generate_options"] = {
                key: value for key, value in body.items() if key != "approval_id"
            }
            _start_document_job(api_request, draft_id, body)
        except API_CALL_ERRORS as error:
            st.error(f"Could not generate the document pair: {error}")

    generated = st.session_state.get("manual_generated_documents")
    if not generated:
        return
    steps = st.session_state.get("manual_document_job_steps")
    if steps:
        st.caption("Generation steps: " + "; ".join(steps) + ".")
    if (generated.get("summary") or {}).get("mode") == "DETERMINISTIC" and st.button(
        "Retry AI summary", key="manual_retry_summary", disabled=job_running
    ):
        _retry_summary(api_request, draft_id, fingerprint, approval, generated)
        generated = st.session_state.get("manual_generated_documents")
    st.markdown("### Review before downloading")
    cv_pages = generated.get("cv_pages")
    if cv_pages and cv_pages > MAX_CV_PAGES:
        st.warning(
            f"The CV runs to {cv_pages} pages. For a VP role aim for {MAX_CV_PAGES}: set older roles "
            "to one line or hide them in “Choose which roles appear on the CV”, then compare again."
        )
    elif cv_pages:
        st.caption(f"CV length: {cv_pages} page(s).")
    preview_col, letter_col = st.columns(2)
    with preview_col:
        st.text_area(
            "Customised CV preview",
            value=(generated.get("preview") or {}).get("cv", ""),
            height=400,
            disabled=True,
            key="manual_cv_preview",
        )
    with letter_col:
        st.text_area(
            "Cover letter preview",
            value=(generated.get("preview") or {}).get("cover_letter", ""),
            height=400,
            disabled=True,
            key="manual_cover_letter_preview",
        )
    _render_written_review(generated.get("summary"), "summary")
    _render_written_review(generated.get("cover_letter"), "cover_letter")
    st.caption(
        "Review both previews and download only the private artifacts you intend to use. No application status is recorded."
    )
    for artifact in generated.get("artifacts", []):
        document_name = "CV" if artifact.get("type") == "CV" else "Cover Letter"
        label = f"Download {document_name} ({artifact.get('format', '')})"
        try:
            content, filename = _download_bytes(api_request, draft_id, artifact)
            st.download_button(
                label,
                content,
                file_name=filename,
                mime=artifact.get("mime_type", "application/octet-stream"),
                key=f"manual_download_{artifact.get('type')}_{artifact.get('format')}_{fingerprint}",
            )
        except API_CALL_ERRORS as error:
            st.error(f"Private download is unavailable: {error}")
    _render_use_for_application(api_request, draft_id, generated)


def _render_use_for_application(api_request, draft_id, generated):
    """Links this exact document pair to the application tracker, only when the user asks."""
    approval_id = generated.get("approval_id")
    linked = st.session_state.setdefault("manual_linked_selections", {})
    if approval_id not in linked and st.button(
        "Use these documents for my application", key=f"manual_use_{approval_id}"
    ):
        try:
            response = api_request(
                "POST",
                f"/api/v2/application-drafts/{draft_id}/use-for-application",
                body={
                    "schema_version": MANUAL_SCHEMA_VERSION,
                    "approval_id": approval_id,
                },
                timeout=30,
            )
            _validate_payload("ManualUseForApplicationResponse", response)
            linked[approval_id] = response
        except API_CALL_ERRORS as error:
            st.error(f"Could not link these documents to your application: {error}")
    response = linked.get(approval_id)
    if not response:
        st.caption(
            "Nothing is recorded until you choose these documents for your application."
        )
        return
    st.success(
        "These exact files are linked to your application in the tracker. "
        f"Its status stays {response['application_status']}: nothing was submitted or sent."
    )
    if response["selection"]["pipeline_readiness"] == "USER_SELECTED":
        st.info(
            "Added by you: this job is not a current Apply Now decision in the pipeline."
        )
