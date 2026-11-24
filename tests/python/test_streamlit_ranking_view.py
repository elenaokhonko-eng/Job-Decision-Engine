import ast
from pathlib import Path

import pytest

from streamlit_job_review import (
    ai_note_lines,
    ai_notes_pending,
    degree_asked_for_label,
    low_confidence_label,
    ranking_sort_key,
    role_signal_labels,
)

APP_PATH = Path(__file__).resolve().parents[2] / "streamlit_app.py"
LIST_QUERIES = (
    "APPLY_NOW_JOBS_QUERY",
    "VERIFY_THEN_APPLY_JOBS_QUERY",
    "REVIEW_JOBS_QUERY",
    "TRACK_JOBS_QUERY",
)
RAW_SCORE_COLUMNS = ("deterministic_match_score", "raw_match_score")


def _module() -> ast.Module:
    return ast.parse(APP_PATH.read_text(encoding="utf-8"))


def read_query_constant(name: str) -> str:
    for node in _module().body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == name
            for target in node.targets
        ):
            value = ast.literal_eval(node.value)
            if isinstance(value, str):
                return value
    raise AssertionError(f"Streamlit query constant {name} was not found.")


def order_by_clause(query: str) -> str:
    index = query.upper().rindex("ORDER BY")
    return query[index:]


EXPECTED_ORDER_BY = {
    "APPLY_NOW_JOBS_QUERY": (
        "ORDER BY overall_rank_score DESC NULLS LAST, "
        "CASE jobs.recommendation_outcome WHEN 'PRIORITY' THEN 0 ELSE 1 END, "
        "r.ranking_score DESC NULLS LAST, observed_at DESC NULLS LAST LIMIT 5000"
    ),
    "VERIFY_THEN_APPLY_JOBS_QUERY": (
        "ORDER BY r.ranking_score DESC NULLS LAST, "
        "jobs.recommendation_coverage_score DESC NULLS LAST, "
        "jobs.lane_confidence DESC NULLS LAST, jobs.observed_at DESC NULLS LAST LIMIT 5000"
    ),
    "REVIEW_JOBS_QUERY": (
        "ORDER BY r.ranking_score DESC NULLS LAST, jobs.observed_at DESC NULLS LAST LIMIT 5000"
    ),
    "TRACK_JOBS_QUERY": (
        "ORDER BY r.ranking_score DESC NULLS LAST, jobs.observed_at DESC NULLS LAST LIMIT 5000"
    ),
}


def test_job_list_queries_read_the_ranking_view_and_have_exactly_the_documented_order():
    assert set(EXPECTED_ORDER_BY) == set(LIST_QUERIES)
    for name in LIST_QUERIES:
        query = read_query_constant(name)
        assert "v_job_ranking_scoped" in query, name
        clause = " ".join(order_by_clause(query).split())
        # The whole clause, so an extra raw-score (or any other) key fails.
        assert clause == EXPECTED_ORDER_BY[name], name


def test_every_query_orders_without_the_raw_score():
    names = [
        node.targets[0].id
        for node in _module().body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id.endswith("_QUERY")
    ]
    assert names
    for name in names:
        query = read_query_constant(name)
        if "ORDER BY" not in query.upper():
            continue
        clause = order_by_clause(query)
        for column in RAW_SCORE_COLUMNS:
            assert column not in clause, f"{name} orders by {column}"


def test_shortlist_query_carries_the_ranking_evidence_columns():
    query = read_query_constant("SHORTLIST_READ_MODEL_QUERY")
    assert "v_job_ranking_scoped" in query
    for column in (
        "ranking_score",
        "raw_match_score",
        "degree_asked_for",
        "role_signals",
        "evidence_confidence",
    ):
        assert column in query


def _normalised(expression: str) -> str:
    return ast.unparse(ast.parse(expression, mode="eval").body)


def test_python_side_sort_keys_are_exactly_the_documented_tuples():
    module = _module()
    status_sort_returns = []
    lambda_keys = []
    for node in ast.walk(module):
        if isinstance(node, ast.FunctionDef) and node.name == "status_sort_key":
            status_sort_returns = [
                ast.unparse(child.value)
                for child in ast.walk(node)
                if isinstance(child, ast.Return) and child.value is not None
            ]
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "sorted":
            for keyword in node.keywords:
                if keyword.arg == "key" and isinstance(keyword.value, ast.Lambda):
                    lambda_keys.append(ast.unparse(keyword.value.body))
    assert status_sort_returns == [
        _normalised(
            "(rank_missing, rank_sort, outcome_rank, eligibility_rank, status_rank, "
            "ranking_sort_key(j), priority_sort)"
        )
    ]
    assert lambda_keys == [
        _normalised(
            "(ranking_sort_key(job), "
            "-(as_number(job.get('recommendation_coverage_score')) or 0), "
            "job.get('observed_at') or '')"
        )
    ]
    source = APP_PATH.read_text(encoding="utf-8")
    sort_function = next(
        ast.get_source_segment(source, node)
        for node in ast.walk(module)
        if isinstance(node, ast.FunctionDef) and node.name == "status_sort_key"
    )
    for column in RAW_SCORE_COLUMNS:
        assert column not in sort_function


def test_ranking_sort_key_orders_by_the_stored_score_not_the_raw_score():
    jobs = [
        {"title": "high raw, penalised", "ranking_score": 0.5, "raw_match_score": 80},
        {"title": "low raw, clean", "ranking_score": 0.7, "raw_match_score": 60},
        {"title": "unscored", "ranking_score": None, "raw_match_score": 99},
        {"title": "no field", "raw_match_score": 99},
    ]
    ordered = [job["title"] for job in sorted(jobs, key=ranking_sort_key)]
    assert ordered[:2] == ["low raw, clean", "high raw, penalised"]
    assert set(ordered[2:]) == {"unscored", "no field"}


@pytest.mark.parametrize("value", ["abc", float("nan"), float("inf"), True])
def test_ranking_sort_key_puts_invalid_scores_last(value):
    assert ranking_sort_key({"ranking_score": value}) == (1, 0.0)


def test_degree_label_quotes_the_posting_and_escapes_it():
    assert degree_asked_for_label({"degree_asked_for": None}) is None
    assert degree_asked_for_label({"degree_asked_for": "  "}) is None
    label = degree_asked_for_label(
        {"degree_asked_for": "A [click](https://evil.test) <b>PhD</b>\nrequired"}
    )
    assert label is not None
    assert label.startswith("degree asked for: ")
    assert "](" not in label.replace("\\]\\(", "")
    assert "<b>" not in label
    assert "\n" not in label


def test_degree_label_is_clipped():
    label = degree_asked_for_label({"degree_asked_for": "x" * 5000})
    assert label is not None
    assert len(label) < 400


def test_low_confidence_label_only_for_low():
    assert low_confidence_label({"evidence_confidence": "LOW"})
    assert low_confidence_label({"evidence_confidence": "NORMAL"}) is None
    assert low_confidence_label({"evidence_confidence": None}) is None
    assert low_confidence_label({}) is None


def test_role_signal_labels_are_short_known_or_escaped():
    labels = role_signal_labels(
        {
            "role_signals": [
                {"code": "DEGREE_GAP_FLAGGED", "penalty": 0.06, "quote": "x"},
                {"code": "PEOPLE_MANAGEMENT_CORE", "penalty": 0.08},
                {"code": "<script>alert(1)</script>", "penalty": 0.01},
                {"code": ""},
                "not a mapping",
                {"penalty": 0.1},
            ]
        }
    )
    assert labels[0] == "degree gap"
    assert labels[1] == "people management"
    assert len(labels) == 3
    assert "<script>" not in labels[2]


def test_role_signal_labels_ignore_malformed_values():
    assert role_signal_labels({}) == []
    assert role_signal_labels({"role_signals": None}) == []
    assert role_signal_labels({"role_signals": "[]"}) == []
    assert role_signal_labels({"role_signals": "not json {"}) == []
    assert role_signal_labels({"role_signals": '{"code": "DEGREE_GAP_FLAGGED"}'}) == []
    assert role_signal_labels({"role_signals": {"code": "DEGREE_GAP_FLAGGED"}}) == []
    assert role_signal_labels({"role_signals": "42"}) == []


def test_role_signal_labels_parse_a_json_string_array():
    text = '[{"code": "DEGREE_GAP_FLAGGED", "penalty": 0.06}, {"code": "CONTRACT_EMPLOYMENT"}, 7]'
    assert role_signal_labels({"role_signals": text}) == ["degree gap", "contract role"]
    assert role_signal_labels({"role_signals": []}) == []


# --- AI notes (migration 122): display-only labels that never enter the rank ---

AI_COLUMNS = (
    "ai_notes_pending",
    "ai_label_autonomy_score",
    "ai_label_politics_risk_score",
    "ai_label_sensory_workload_risk_score",
    "ai_label_focus_protection_score",
    "ai_label_culture_priority_score",
    "ai_label_evidence",
)


def test_top_ten_and_apply_now_queries_select_the_ai_note_columns():
    for name in ("TOP_TEN_READY_QUERY", "APPLY_NOW_JOBS_QUERY"):
        query = read_query_constant(name)
        for column in AI_COLUMNS:
            assert column in query, f"{name} does not select {column}"


def test_overall_rank_note_is_the_agreed_wording():
    module = _module()
    values = [
        ast.literal_eval(node.value)
        for node in module.body
        if isinstance(node, ast.Assign)
        and isinstance(node.targets[0], ast.Name)
        and node.targets[0].id == "OVERALL_RANK_NOTE"
    ]
    assert values == [
        (
            "Overall rank is requirement fit (about half), requirement coverage, "
            "evidence completeness and lane confidence. AI notes on autonomy, politics "
            "and sensory load are shown as labels and do not change the rank."
        )
    ]


def test_pending_row_is_flagged_and_has_no_numbers_to_show():
    pending = {
        "ai_notes_pending": True,
        "ai_label_autonomy_score": None,
        "ai_label_politics_risk_score": None,
        "ai_label_sensory_workload_risk_score": None,
        "ai_label_focus_protection_score": None,
        "ai_label_culture_priority_score": None,
        "ai_label_evidence": [],
    }
    assert ai_notes_pending(pending) is True
    assert all("UNKNOWN" in line for line in ai_note_lines(pending))
    assert ai_notes_pending({"ai_notes_pending": False}) is False
    assert ai_notes_pending({}) is False
    assert ai_notes_pending({"ai_notes_pending": "true"}) is False


def test_labelled_row_shows_scores_and_the_escaped_clipped_quote():
    row = {
        "ai_notes_pending": False,
        "ai_label_autonomy_score": 72.5,
        "ai_label_politics_risk_score": None,
        "ai_label_sensory_workload_risk_score": 30,
        "ai_label_focus_protection_score": 55,
        "ai_label_culture_priority_score": 60,
        "ai_label_evidence": [
            {
                "signal": "AUTONOMY",
                "quote": "You own it [click](https://evil.test) <b>x</b>\n" + "y" * 500,
                "source": "JOB_DESCRIPTION",
                "score": 72.5,
            },
            {"signal": "AUTONOMY", "quote": "second quote is ignored"},
            {"signal": "POLITICS_RISK", "quote": None},
            "not a mapping",
        ],
    }
    lines = ai_note_lines(row)
    assert lines[0].startswith("Autonomy: 72.5%")
    assert "AI quote" in lines[0]
    assert "second quote" not in " ".join(lines)
    assert "<b>" not in lines[0]
    assert "\n" not in lines[0]
    assert "](" not in lines[0].replace(r"\]\(", "")
    assert len(lines[0]) < 400
    assert lines[1] == "Politics risk: UNKNOWN"
    assert [line.split(":")[0] for line in lines] == [
        "Autonomy",
        "Politics risk",
        "Sensory/workload risk",
        "Focus protection",
        "Culture priority",
    ]


def test_ai_notes_accept_json_text_and_ignore_malformed_evidence():
    text = '[{"signal": "FOCUS_PROTECTION", "quote": "Quiet focus time."}]'
    lines = ai_note_lines(
        {"ai_label_focus_protection_score": 80, "ai_label_evidence": text}
    )
    assert lines == [r'Focus protection: 80.0% - AI quote: "Quiet focus time\."']
    assert ai_note_lines({"ai_label_evidence": "not json"}) == []
    assert ai_note_lines({}) == []
