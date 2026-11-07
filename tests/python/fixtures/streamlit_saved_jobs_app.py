"""AppTest fixture for the Saved jobs tab with a fake API and a fake upload.

AppTest cannot drive ``st.file_uploader``, so the uploader is replaced by one
that returns the bytes stored in ``st.session_state["fake_upload"]``.
"""

import json

import streamlit as st

import streamlit_saved_jobs


class FakeUpload:
    """Minimal stand-in for Streamlit's UploadedFile."""

    def __init__(self, data):
        self._data = data

    def getvalue(self):
        return self._data


def fake_file_uploader(label, type=None, key=None):
    data = st.session_state.get("fake_upload", {}).get(key)
    return FakeUpload(data) if data is not None else None


def fake_api_request(method, path, params=None, body=None, timeout=30):
    """Record the call and answer like the v2 import route."""
    calls = st.session_state.setdefault("api_calls", [])
    calls.append({"method": method, "path": path, "body": body, "timeout": timeout})
    dry_run = body["dryRun"]
    source = "LINKEDIN_SAVED" if path.endswith("linkedin-saved") else "MCF_SAVED"
    return {
        "ok": True,
        "schema_version": "saved_jobs_import_v1",
        "source": source,
        "mode": "DRY_RUN" if dry_run else "APPLIED",
        "complete": False,
        "source_run_id": None,
        "totals": {
            "items": 2,
            "valid": 1,
            "invalid": 1,
            "duplicatesInFile": 0,
            "staged": 1,
            "alreadyImported": 0,
            "failed": 0,
            "gmailMatches": 1,
            "contentAttachQueued": 1,
        },
        "normalize_seed_error": None,
        "invalid": [
            {
                "index": 1,
                "reason": "description was not fetched yet (descriptionStatus=null)",
            }
        ],
        "duplicates_in_file": [],
        "items": [
            {
                "index": 0,
                "job_id": "4300000001",
                "outcome": "WOULD_STAGE" if dry_run else "NEW",
                "observation_id": None,
                "description_quality": "COMPLETE",
                "existing_canonical_jobs": 0,
                "gmail_matches": [
                    {
                        "observation_id": "obs-gmail-1",
                        "processing_status": "FETCH_BLOCKED",
                        "outcome": "WOULD_QUEUE_CONTENT_ATTACH"
                        if dry_run
                        else "CONTENT_ATTACH_QUEUED",
                    }
                ],
                "error": None,
            }
        ],
    }


if "fake_upload" not in st.session_state:
    st.session_state["fake_upload"] = {
        "saved_jobs_linkedin_file": json.dumps(
            [{"title": "Synthetic"}, {"title": "Synthetic two"}]
        ).encode("utf-8")
    }
streamlit_saved_jobs.render_saved_jobs_tab(
    fake_api_request,
    api_configured=st.session_state.get("api_configured", True),
    file_uploader=fake_file_uploader,
)
