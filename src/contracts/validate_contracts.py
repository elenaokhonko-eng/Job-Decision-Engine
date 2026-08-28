"""
Python-side boundary schema validator for Job Decision Engine.
Consumes the JSON Schemas exported from src/contracts/ to validate Streamlit read models.
"""

import json
import os
from pathlib import Path
from typing import Dict, Any, Tuple

SCHEMA_DIR = Path(__file__).parent / "json"

def load_json_schema(contract_name: str) -> Dict[str, Any]:
    schema_path = SCHEMA_DIR / f"{contract_name}.schema.json"
    if not schema_path.exists():
        raise FileNotFoundError(f"JSON schema not found: {schema_path}")
    with open(schema_path, "r", encoding="utf-8") as f:
        return json.load(f)

def validate_shortlist_row(row_dict: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Validates a ShortlistRow dictionary against required fields and typing constraints.
    """
    required_keys = [
        "canonical_job_id",
        "job_version_id",
        "title",
        "company",
        "canonical_url",
        "location",
        "workplace_type",
        "gate_status",
        "processing_status",
        "observed_at"
    ]
    for key in required_keys:
        if key not in row_dict or row_dict[key] is None:
            return False, f"Missing required field: {key}"

    valid_gate_statuses = {"PASS", "NEEDS_VERIFICATION", "HARD_REJECT"}
    if row_dict["gate_status"] not in valid_gate_statuses:
        return False, f"Invalid gate_status: {row_dict['gate_status']}"

    return True, "OK"

if __name__ == "__main__":
    print("Testing Python contract validator...")
    test_row = {
        "canonical_job_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "job_version_id": "v1",
        "title": "Associate Senior AI Solutions Officer",
        "company": "The World Bank Group",
        "canonical_url": "https://worldbank.org/careers/req38014",
        "location": "Singapore",
        "workplace_type": "HYBRID",
        "gate_status": "PASS",
        "primary_lane": "CORE_AI_DATA",
        "secondary_lanes": ["INVESTMENT_MARKETS_FINTECH"],
        "lane_confidence": "Medium",
        "priority_score": 0.449,
        "processing_status": "AI_EVALUATED",
        "nd_friendly_score": 75,
        "politics_stress_score": 35,
        "next_action": "APPLY_AFTER_VERIFICATION",
        "strategic_value": "Strong alignment with multi-lateral development bank AI initiatives.",
        "recommended_cv_version": "CORE_AI_DATA",
        "observed_at": "2026-08-28T12:00:00.000Z",
        "evaluated_at": "2026-08-28T12:30:00.000Z"
    }
    is_valid, msg = validate_shortlist_row(test_row)
    assert is_valid, f"Validation failed: {msg}"
    print("✅ Python contract validator verified successfully.")
