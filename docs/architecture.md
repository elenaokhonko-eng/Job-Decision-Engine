# Architecture

## Pipeline

```text
API / RSS / Gmail
  -> IngestionEnvelope
  -> raw_job_observations
  -> canonical_jobs + job_versions
  -> deterministic hard gates
  -> semantic lane routing
  -> per-lane evaluation budget
  -> evaluation_queue
  -> ai_evaluations
  -> v_canonical_shortlist
  -> Streamlit and document generators
```

## State Conservation

Operational failures never become career rejection states. Recoverable evaluation failures enter `RETRY_WAIT`; exhausted attempts enter `NEEDS_MANUAL_REVIEW`. Jobs outside the per-run evaluation budget enter `DEFERRED_BUDGET`.

## Identity

Every observation keeps source identity and raw payload evidence. Canonical jobs may have multiple immutable `job_versions`. Gates, queue rows, evaluations, shortlist rows, and documents are pinned to `job_version_id`.

## Four Lanes

- `CORE_AI_DATA`
- `LEGAL_REGTECH`
- `HEALTH_BIO_PHARMA`
- `INVESTMENT_MARKETS_FINTECH`
