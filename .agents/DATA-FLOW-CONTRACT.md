# Data-flow handshake

The `data-contract-checker` owns this contract. Feature agents propose changes; the checker updates and verifies the shared contract in the same pull request.

## Boundary map

| Boundary | Producer | Consumer | Required proof |
|---|---|---|---|
| Gmail message -> extraction input | `scripts/ingest_gmail.ts`, `src/services/gmail.ts` | `scripts/parse_emails.ts` | Fixture preserves message identity, source, subject/body, received time and raw hash |
| Extracted job JSON -> observation | email extractor and source adapters | `src/ingestion/sourceBroker.ts` | Strict runtime schema; invalid records are quarantined with errors, not silently dropped |
| Observation -> canonical job/version | source broker | `src/pipeline/normalize.ts` | Idempotent identity test; reposts create versions without duplicating the canonical job |
| Job version -> gate decision | normalizer | `src/pipeline/hardGate.ts` | Structured workplace fields and description evidence agree; tri-state status is stored |
| Gate decision -> lane decision | hard gate | `src/pipeline/laneRouter.ts` | Only eligible records route; primary/secondary lane, confidence, evidence and model version persist |
| Lane decision -> evaluation queue | lane router | `src/pipeline/evaluationBudgeter.ts` | Per-lane quota; overflow is `DEFERRED_BUDGET`; one queue item per job version |
| Queue item -> AI evaluation | evaluation worker | evaluation store | Lease, attempts, provider/model, fallback/degraded state, full validated result and matching job identity persist atomically |
| Canonical data -> shortlist read model | database view/query | `streamlit_app.py` | One row per current job version; no legacy joins; every displayed field has a real source |
| Evaluation -> documents | evaluation/profile ledgers | CV and cover-letter generators | Every substantive claim resolves to verified evidence IDs |

## Contract implementation target

Create runtime schemas under `src/contracts/` and use them at every boundary. Zod or another single TypeScript runtime validator is preferred. Export JSON Schema for the Python consumer where practical; otherwise add a Python-side validator generated from the same versioned schema.

Required contracts:

- `IngestionEnvelope`
- `ExtractedJob`
- `JobObservation`
- `CanonicalJobVersion`
- `GateDecision`
- `LaneDecision`
- `EvaluationQueueItem`
- `EvaluationResult`
- `ShortlistRow`

Every persisted contract includes `schema_version`. Every processing decision includes `pipeline_run_id`, `job_version_id`, `created_at`, and relevant rule/model version.

## Failure semantics

| Failure | Persisted outcome | Retry? | Career decision? |
|---|---|---:|---:|
| Gmail/API fetch failure | `FETCH_FAILED` plus source run error | Yes | No |
| Invalid extraction JSON | `PARSE_FAILED` plus raw input/error | Yes or manual review | No |
| Missing essential description | `DESCRIPTION_INCOMPLETE` | Enrichment/manual | No |
| Deterministic gate conflict | `HARD_REJECTED` plus codes/evidence | Only after rule change | Yes |
| Work pattern unknown | `NEEDS_VERIFICATION` plus questions | Enrichment/manual | No |
| Lane embedding/provider failure | `ROUTING_DEFERRED` | Yes | No |
| AI budget exhausted | `DEFERRED_BUDGET` | Next run | No |
| Evaluation provider/schema failure | `RETRY_WAIT` | Backoff | No |
| Evaluation retries exhausted | `NEEDS_MANUAL_REVIEW` | Manual | No |

## Checker commands and artifacts

The checker must add:

- Contract fixtures covering Gmail, one ATS source, one duplicate/repost, one hard reject, one needs-verification job, one deferred-budget job, one failed-then-retried evaluation and one evaluated shortlist row.
- A schema-drift test that inspects PostgreSQL columns and fails when runtime schemas or Streamlit queries reference missing fields.
- A field-lineage report generated during CI, mapping each `ShortlistRow` field back to its table/column and producer.
- A state-conservation assertion: input count equals terminal plus retry/deferred counts; no record disappears between stages.
