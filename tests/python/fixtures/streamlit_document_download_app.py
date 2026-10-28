"""Minimal Streamlit app for document artifact download integration tests."""

import json
import os
from pathlib import Path

import streamlit as st

from streamlit_application_workflow import render_document_run_downloads

manifests = json.loads(os.environ["JDEC_TEST_DOCUMENT_MANIFESTS"])
export_root = Path(os.environ["JDEC_TEST_EXPORT_ROOT"])
for document_type, manifest in manifests.items():
    render_document_run_downloads(st, manifest, f"test_{document_type}", export_root)
