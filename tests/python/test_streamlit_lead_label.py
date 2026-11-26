"""The application tracker marks saved jobs that are leads (v_job_lead_state, migration 123)."""

from streamlit_job_review import lead_job_ids


def fake_read_model(available: bool, leads: list[str]):
    queries: list[str] = []

    def read_query(query, params):
        queries.append(query)
        if "to_regclass" in query:
            return [{"available": available}]
        return [{"canonical_job_id": job_id} for job_id in leads]

    return read_query, queries


def test_returns_the_leads_among_the_tracked_jobs():
    read_query, queries = fake_read_model(True, ["job-a"])
    assert lead_job_ids(read_query, "workspace", ["job-a", "job-b"]) == {"job-a"}
    assert "v_job_lead_state" in queries[-1] and "is_lead" in queries[-1]


def test_without_the_migration_nothing_is_labelled_and_the_view_is_not_read():
    read_query, queries = fake_read_model(False, ["job-a"])
    assert lead_job_ids(read_query, "workspace", ["job-a"]) == set()
    assert len(queries) == 1


def test_no_tracked_jobs_reads_nothing():
    read_query, queries = fake_read_model(True, ["job-a"])
    assert lead_job_ids(read_query, "workspace", []) == set()
    assert queries == []
