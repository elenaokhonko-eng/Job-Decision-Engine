# Assigned remediation backlog

Status values: `READY`, `BLOCKED`, `IN_PROGRESS`, `REVIEW`, `DONE`.

## P0 — trustworthy pipeline

| ID | Owner | Assignment | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| P0-01 | data-contract-checker | Define versioned runtime contracts and current field-lineage baseline | — | Gmail-to-Streamlit contract fixtures and schema-drift test fail on known mismatches | DONE |
| P0-02 | test-evals-specialist | Add PostgreSQL CI service and a reproducible anonymized nine-email fixture | P0-01 | CI applies canonical migrations and reproduces exact stage counts; no DB tests skip | DONE |
| P0-03 | database-versioning-engineer | Establish one additive migration chain and canonical identity/version schema | P0-01 | Fresh and upgrade paths pass; no destructive reset; latest job version is unambiguous | READY |
| P0-04 | pipeline-reliability-engineer | Implement leases, retry/backoff, stale-lease recovery and manual-review terminal state | P0-03 | Crash/timeout tests requeue safely; exhausted retries never become rejection | BLOCKED |
| P0-05 | pipeline-reliability-engineer | Repair script exit codes and GitHub workflow dispatch/concurrency | P0-04 | Required stage failures make Actions fail; manual dispatch runs; one pipeline run cannot overlap itself | BLOCKED |
| P0-06 | ai-evaluation-engineer | Validate AI output, identity and full result before atomic persistence | P0-01, P0-03 | Malformed/empty/mismatched output retries another provider and cannot mark success | BLOCKED |
| P0-07 | ai-evaluation-engineer | Persist provider, model, attempt, fallback, degraded state, cost and full evaluation | P0-03 | A shortlist result is auditable from job version through exact model response | BLOCKED |
| P0-08 | ingestion-source-engineer | Make Gmail ingestion non-destructive and replace evaluator-shaped email parsing | P0-01, P0-03 | Email is moved/deleted only after valid job observations commit; failed parse is recoverable | BLOCKED |
| P0-09 | data-contract-checker | Replace Streamlit legacy/mismatched queries with one canonical shortlist read model | P0-03, P0-07 | Streamlit renders real fields for evaluated, deferred, verification and failed states | BLOCKED |
| P0-10 | test-evals-specialist | Add failure-injection E2E for the complete pipeline | P0-04..P0-09 | Nine-email test proves conservation, idempotency, retry and correct World Bank identity/evidence | BLOCKED |

## P1 — correct selection and broad sourcing

| ID | Owner | Assignment | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| P1-01 | decision-policy-engineer | Implement `PASS / NEEDS_VERIFICATION / HARD_REJECT` with multiple codes, quotes and confidence | P0-03 | On-site and >3-day rules are deterministic; vague language alone cannot hard reject | BLOCKED |
| P1-02 | decision-policy-engineer | Separate personal workability from domain/career value | P1-01 | Hard workability conflicts are non-compensable; unknown evidence remains visible | BLOCKED |
| P1-03 | decision-policy-engineer | Load lane definitions and thresholds from YAML; support secondary/unclassified lanes | P0-03 | Title-only counterfactuals are stable; zero/random embeddings cannot default to core AI | BLOCKED |
| P1-04 | decision-policy-engineer | Replace budget-cap rejection with durable deferral and fair per-lane selection | P0-04, P1-03 | At most three/lane/run, unused weak quotas stay unused, deferred jobs remain eligible | BLOCKED |
| P1-05 | ingestion-source-engineer | Add observable, paginated Greenhouse/Ashby/Lever/Himalayas adapters | P0-03 | Empty source is distinct from failed source; timeouts, rate limits and schema changes are visible | BLOCKED |
| P1-06 | ingestion-source-engineer | Implement four outbound discovery scouts as query/source planners | P1-05 | Scouts only produce queries/watchlists or ingest verified postings; no fabricated jobs | BLOCKED |
| P1-07 | test-evals-specialist | Build real-job calibration and counterfactual suite | P1-01..P1-06 | False-rejection rate, gate precision, per-lane yield and AI-call budget are reported | BLOCKED |

## P2 — grounded applications and production readiness

| ID | Owner | Assignment | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|
| P2-01 | documents-evidence-engineer | Consolidate profile/evidence/title ledgers and both CV paths | P0-07 | One canonical private evidence ledger; every claim has evidence IDs; schema validation is real | BLOCKED |
| P2-02 | documents-evidence-engineer | Finish and wire cover-letter generation | P2-01 | Every substantive paragraph is grounded; deterministic DOCX/PDF; human approval before export | BLOCKED |
| P2-03 | release-security-reviewer | Remove legacy parallel workflows and stale architecture documentation | P0/P1 complete | One supported pipeline; README and `Instructions.yml` match runtime reality | BLOCKED |
| P2-04 | release-security-reviewer | Resolve dependency, TLS, secret and fabricated-fallback risks | P0/P1 complete | No high-severity audit finding without written exception; no `rejectUnauthorized:false`; no fake analytics | BLOCKED |
| P2-05 | release-security-reviewer | Produce production readiness decision | all above | Evidence-based `GO`, `CONDITIONAL GO`, or `NO-GO` report with residual risks | BLOCKED |

## Required handoff format

Each agent returns:

1. Work-package IDs completed.
2. Root cause and affected files.
3. Contract or migration changes.
4. Tests added and exact results.
5. Failure modes exercised.
6. Data migration/recovery implications.
7. Open risks and explicit next owner.
