"""Tests for the Saved jobs tab helpers and its validate-then-import gating."""

import json
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from streamlit_saved_jobs import (
    LINKEDIN,
    MAX_ITEMS_PER_UPLOAD,
    MCF,
    build_import_request,
    classify_invalid_reason,
    content_hash,
    escape_markdown,
    import_enabled,
    invalid_reason_rows,
    parse_export_bytes,
    read_export_script,
    record_dry_run,
    results_checklist,
    results_text,
    revived_gmail_rows,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_APP = Path(__file__).parent / "fixtures" / "streamlit_saved_jobs_app.py"


def _dry_run_response(source="LINKEDIN_SAVED", valid=1, mode="DRY_RUN"):
    return {
        "ok": True,
        "source": source,
        "mode": mode,
        "complete": False,
        "totals": {
            "items": 3,
            "valid": valid,
            "invalid": 2,
            "staged": valid,
            "alreadyImported": 0,
            "contentAttachQueued": 1,
        },
        "invalid": [
            {
                "index": 1,
                "reason": "company is missing (a placeholder such as 'Unknown Company')",
            },
            {
                "index": 2,
                "reason": "description was not fetched yet (descriptionStatus=null)",
            },
        ],
        "items": [
            {
                "index": 0,
                "job_id": "4300000001",
                "outcome": "WOULD_STAGE",
                "gmail_matches": [
                    {
                        "observation_id": "obs-1",
                        "processing_status": "FETCH_BLOCKED",
                        "outcome": "WOULD_QUEUE_CONTENT_ATTACH",
                    },
                    {
                        "observation_id": "obs-2",
                        "processing_status": "FETCH_COMPLETE",
                        "outcome": "ALREADY_HAS_CONTENT",
                    },
                ],
            }
        ],
    }


def test_export_scripts_are_read_from_the_repository_files():
    for source in (LINKEDIN, MCF):
        expected = (PROJECT_ROOT / source.script_path).read_text(encoding="utf-8")
        assert read_export_script(source) == expected
        assert expected.strip()
    assert "jdeLinkedInExport" in read_export_script(LINKEDIN)
    assert "jdeMcfExport" in read_export_script(MCF)


def test_missing_export_script_is_an_error_not_an_empty_script(tmp_path):
    with pytest.raises(OSError):
        read_export_script(LINKEDIN, tmp_path)


def test_build_import_request_targets_the_v2_routes():
    items = [{"title": "Synthetic"}]
    assert build_import_request(LINKEDIN, items, dry_run=True) == (
        "POST",
        "/api/v2/imports/linkedin-saved",
        {"items": items, "dryRun": True},
    )
    assert build_import_request(MCF, items, dry_run=False) == (
        "POST",
        "/api/v2/imports/mcf-saved",
        {"items": items, "dryRun": False},
    )


def test_parse_export_bytes_accepts_arrays_and_rejects_other_files():
    assert parse_export_bytes(b'[{"a": 1}]') == [{"a": 1}]
    assert parse_export_bytes(b"\xef\xbb\xbf[1]") == [1]
    for bad in (b"{}", b"[]", b"not json", b"\xff\xfe"):
        with pytest.raises(ValueError):
            parse_export_bytes(bad)
    with pytest.raises(ValueError, match="at most"):
        parse_export_bytes(json.dumps([{}] * (MAX_ITEMS_PER_UPLOAD + 1)).encode())


def test_import_is_enabled_only_after_a_successful_dry_run_of_the_same_file():
    state = {}
    first = content_hash(b"[1]")
    second = content_hash(b"[2]")
    assert not import_enabled(state, LINKEDIN, first)

    assert record_dry_run(state, LINKEDIN, first, _dry_run_response())
    assert import_enabled(state, LINKEDIN, first)
    assert not import_enabled(state, LINKEDIN, second)
    assert not import_enabled(state, LINKEDIN, None)
    assert not import_enabled(state, MCF, first)

    # A dry run with nothing valid, an applied result or another source's
    # response does not validate the file.
    assert not record_dry_run(state, LINKEDIN, first, _dry_run_response(valid=0))
    assert not import_enabled(state, LINKEDIN, first)
    assert not record_dry_run(state, LINKEDIN, first, _dry_run_response(mode="APPLIED"))
    assert not record_dry_run(
        state, LINKEDIN, first, _dry_run_response(source="MCF_SAVED")
    )
    assert not record_dry_run(state, LINKEDIN, first, {"ok": False, "error": "x"})
    assert not import_enabled(state, LINKEDIN, first)


def test_invalid_reasons_map_to_codes_and_fixes():
    code, advice = classify_invalid_reason(
        "description was not fetched yet (descriptionStatus=null); run resume()", MCF
    )
    assert code == "DESCRIPTION_NOT_FETCHED"
    assert "await jdeMcfExport.resume()" in advice
    assert (
        classify_invalid_reason("company is missing (x)", LINKEDIN)[0]
        == "COMPANY_MISSING"
    )
    assert (
        classify_invalid_reason("unknown field(s): email", MCF)[0] == "UNKNOWN_FIELDS"
    )
    assert classify_invalid_reason("something new", MCF)[0] == "OTHER"

    rows = invalid_reason_rows(_dry_run_response(), LINKEDIN)
    assert [
        (row["Reason code"], row["Count"], row["Items (file position)"]) for row in rows
    ] == [
        ("COMPANY_MISSING", 1, "1"),
        ("DESCRIPTION_NOT_FETCHED", 1, "2"),
    ]


def test_checklist_and_revived_alerts():
    response = _dry_run_response()
    checks = results_checklist(response, LINKEDIN, 3)
    assert checks[0] == (True, "Collected 3 of the 3 jobs you saved.")
    assert checks[1][0] is False
    assert "Already imported: 0" in checks[2][1]
    assert "Gmail alerts revived: 1" in checks[3][1]
    assert results_checklist(response, LINKEDIN, 5)[0][0] is False
    assert results_checklist(response, LINKEDIN, None)[0][0] is None

    assert revived_gmail_rows(response) == [
        {
            "Item": 0,
            "Job id": "4300000001",
            "Gmail alert observation": "obs-1",
            "Alert status before": "FETCH_BLOCKED",
            "Outcome": "WOULD_QUEUE_CONTENT_ATTACH",
        }
    ]


def test_copy_results_contains_counts_and_codes_only():
    response = _dry_run_response()
    response["invalid"][0]["reason"] = "company is missing for Secret Employer Ltd"
    text = results_text(response, LINKEDIN, "a" * 64)
    assert "source: LINKEDIN_SAVED" in text
    assert "invalid: 2" in text
    assert "invalid_reason COMPANY_MISSING: 1" in text
    assert "outcome WOULD_STAGE: 1" in text
    assert "file_sha256_prefix: aaaaaaaaaaaa" in text
    assert "Secret Employer" not in text
    assert "4300000001" not in text


def test_escape_markdown_neutralises_links_and_html():
    escaped = escape_markdown("[x](javascript:alert(1)) <b>*y*</b>")
    assert "[" not in escaped.replace("\\[", "")
    assert "<" not in escaped.replace("\\<", "")
    assert "*" not in escaped.replace("\\*", "")


def test_saved_jobs_tab_gates_import_on_a_dry_run(monkeypatch):
    monkeypatch.syspath_prepend(str(PROJECT_ROOT))
    app = AppTest.from_file(str(FIXTURE_APP)).run(timeout=20)
    assert not app.exception, [(e.type, e.message) for e in app.exception]

    assert {"LinkedIn saved jobs", "MyCareersFuture saved jobs"} <= {
        header.value for header in app.subheader
    }
    # st.code drops the file's trailing newline.
    codes = [block.value.strip() for block in app.code]
    assert read_export_script(LINKEDIN).strip() in codes
    assert read_export_script(MCF).strip() in codes

    validate = app.button(key="saved_jobs_linkedin_validate")
    import_button = app.button(key="saved_jobs_linkedin_import")
    assert not validate.disabled
    assert import_button.disabled
    # No file was uploaded for MCF, so neither button is usable there.
    assert app.button(key="saved_jobs_mcf_validate").disabled
    assert app.button(key="saved_jobs_mcf_import").disabled

    validate.click().run(timeout=20)
    assert not app.exception
    assert app.session_state["api_calls"] == [
        {
            "method": "POST",
            "path": "/api/v2/imports/linkedin-saved",
            "body": {
                "items": [{"title": "Synthetic"}, {"title": "Synthetic two"}],
                "dryRun": True,
            },
            "timeout": 300,
        }
    ]
    assert not app.button(key="saved_jobs_linkedin_import").disabled
    assert any("DESCRIPTION_NOT_FETCHED" in block.value for block in app.code)

    # A different file (new hash) needs its own dry run.
    app.session_state["fake_upload"] = {
        "saved_jobs_linkedin_file": json.dumps([{"title": "Other"}]).encode()
    }
    app.run(timeout=20)
    assert app.button(key="saved_jobs_linkedin_import").disabled

    app.session_state["fake_upload"] = {
        "saved_jobs_linkedin_file": json.dumps(
            [{"title": "Synthetic"}, {"title": "Synthetic two"}]
        ).encode()
    }
    app.run(timeout=20)
    app.button(key="saved_jobs_linkedin_import").click().run(timeout=20)
    assert not app.exception
    assert [call["body"]["dryRun"] for call in app.session_state["api_calls"]] == [
        True,
        False,
    ]
    assert any("next run (hourly)" in message.value for message in app.success)
    # Import consumed the validation; another import needs another dry run.
    assert app.button(key="saved_jobs_linkedin_import").disabled


def test_saved_jobs_tab_disables_actions_without_an_api(monkeypatch):
    monkeypatch.syspath_prepend(str(PROJECT_ROOT))
    app = AppTest.from_file(str(FIXTURE_APP))
    app.session_state["api_configured"] = False
    app.run(timeout=20)
    assert not app.exception
    assert app.button(key="saved_jobs_linkedin_validate").disabled
    assert app.button(key="saved_jobs_linkedin_import").disabled
