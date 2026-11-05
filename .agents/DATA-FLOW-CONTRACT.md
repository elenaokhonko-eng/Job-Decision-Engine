# Data-flow handshake

The `data-contract-checker` owns this contract. Feature agents propose changes; the checker updates and verifies the shared contract in the same pull request.

## Boundary map

| Boundary | Producer | Consumer | Required proof |
|---|---|---|---|
| Gmail message -> extraction input | `scripts/ingest_gmail.ts`, `src/services/gmail.ts` | `scripts/parse_emails.ts` | Fixture preserves message identity, source, subject/body, received time and raw hash |
| Gmail alert -> fetched posting observation | `src/tasks/stageTaskWorker.ts` and `src/ingestion/jobContentFetcher.ts` | `src/ingestion/sourceBroker.ts` | Persist a complete posting and schema-valid HTTP fetch receipt; `discovery_observation_id` must match the exact `GMAIL_ALERT` parent referenced by `derived_from_observation_id`, `requested_url` and receipt `requestedUrl` must equal that parent's URL, root `canonical_url` and `posting.canonicalUrl` must equal the fetched posting observation URL, and receipt posting `companyName`, `title`, and `description` must equal the persisted observation fields; receipt `resolvedUrl` is the final credential-free HTTP(S) transport endpoint and may differ from the employer posting URL when an ATS API supplies the content |
| Extracted job JSON -> observation | email extractor and source adapters | `src/ingestion/sourceBroker.ts` | Strict runtime schema; invalid records are quarantined with errors, not silently dropped |
| Versioned source-plugin manifest -> availability evidence | `config/source-plugins/*.yml`, `src/ingestion/sourcePluginRegistry.ts` | `src/ingestion/jobSourceEvidence.ts` | Only exact, credential-free HTTP(S) source hostnames from the pinned plugin revision may establish `VERIFIED_POSTING_RETRIEVAL`; wildcards and subdomain suffix matching are forbidden, and the posting must be complete |
| Manual posting submission -> availability evidence | `src/api/v2/manualApplicationRouter.ts` | `src/ingestion/jobSourceEvidence.ts` | Submission provenance records how content was supplied, but manual submission or a successful content fetch alone does not establish that the job is open; pasted/uploaded postings remain `UNKNOWN` absent independent existing availability evidence |
| Observation -> canonical job/version | source broker | `src/pipeline/normalize.ts` | Idempotent identity test; reposts create versions without duplicating the canonical job |
| Job version -> gate decision | normalizer | `src/pipeline/hardGate.ts` | Structured workplace fields and description evidence agree; tri-state status and the effective `workability_policy_hash` are stored; new rows require a 64-character SHA-256 hash while legacy rows may be null |
| Gate decision -> lane decision | hard gate | `src/pipeline/laneRouter.ts` | `PASS` records route; `NEEDS_VERIFICATION` records route only when every stored gate code is an unresolved workability fact (work mode, location detail, office days, or travel). The gate remains `NEEDS_VERIFICATION`, matching and decision evidence persist, and readiness stays blocked until the fact is resolved. Other verification codes and hard rejects do not route. Primary/secondary lane, confidence, evidence and model version persist |
| Lane decision -> deterministic matching | lane router | `src/pipeline/deterministicMatcher.ts` | Only `LANE_ROUTED` records match; match runs are version-pinned and recoverable failures never become rejections |
| Stage task -> profile matching dependency | `src/tasks/stageTaskWorker.ts` | `pipeline_tasks` and `src/embeddings/profileEmbeddingRepair.ts` | If a profile-match task cannot be enqueued because there is not exactly one active profile, retain the parent stage task as `BLOCKED_DEPENDENCY` with `blocked_on=PROFILE_VERSION_ACTIVE` and `repair_action=IMPORT_OR_ACTIVATE_PROFILE_AND_REPAIR_EMBEDDINGS`; do not turn this operational prerequisite into a job decision or processing error |
| Deterministic decision -> evaluation queue | `src/pipeline/recommendationDecider.ts` | `src/pipeline/explanationQueueEnqueuer.ts` | Eligible jobs are selected by the workspace lane registry snapshot used by routing; by default one worker invocation shares a budget run across its explanation tasks and a later invocation starts a new run; explicit run-ID reuse is allowed only when the pinned snapshot matches; source, aggregate revision, hash, and per-lane caps are immutable; stale or missing route snapshots fail and roll back; overflow is recorded as `DEFERRED_BUDGET`, never rejected; one queue item per job version |
| Queue item -> AI evaluation | evaluation worker | evaluation store | Lease, attempts, provider/model, fallback/degraded state, full validated result and matching job identity persist atomically |
| Canonical data -> shortlist read model | database view/query | `streamlit_app.py` | One row per current job version; no legacy joins; every displayed field has a real source; UI sanitizes untrusted content + validates links; missing scores remain null/N/A (never coerced to 0) |
| Evaluation -> documents | evaluation/profile ledgers | CV and cover-letter generators | Every substantive claim resolves to verified evidence IDs |
| Pipeline job version -> manual review draft | `streamlit_app.py` job cards (Apply Now, Verify, then apply) via `POST /api/v2/application-drafts/compare-existing` | `prepareComparisonForExistingJobVersion` in `src/api/v2/manualApplicationRouter.ts` | Cites the version's first observation and stages no new posting content; response source is `source_kind=PIPELINE`, `source_content_status=PIPELINE_OBSERVED` with the observation's `source_name`; same membership, currentness and description-quality checks as `/compare`; one draft per comparison fingerprint; `409 CONCURRENT_UPDATE` (with `retry_after`) is retryable, `409 JOB_VERSION_CHANGED` and `422 DESCRIPTION_INSUFFICIENT` are final for that version; requirement extraction runs deterministic-only, so the version keeps the requirement set its match and Apply Now currentness are tied to; it never writes a gate, match, recommendation or quoted requirement run (quoted enrichment stays with the pipeline's `EXTRACT_QUOTED_REQUIREMENTS` task, which re-matches afterwards) |

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
| Workplace model remains unknown after available evidence is examined | `NEEDS_VERIFICATION` with `GATE_UNKNOWN_WORK_MODE` and the unresolved evidence; it may continue through matching and deterministic triage | Recheck after new source evidence or an owner answer | No hard rejection; `VERIFY`/`REVIEW` is allowed, and readiness remains blocked |
| Other material workability fact remains unknown | `NEEDS_VERIFICATION` plus questions; work mode, location detail, office days, and travel may continue through matching when they are the only open facts | Enrichment/manual | No hard rejection; `VERIFY`/`REVIEW` is allowed, and readiness remains blocked |
| Lane embedding/provider failure | `ROUTING_DEFERRED` | Yes | No |
| Profile-match successor cannot be enqueued because there is no unique active profile version | `pipeline_tasks.status=BLOCKED_DEPENDENCY`, `blocked_on=PROFILE_VERSION_ACTIVE`, `blocked_reason` records the missing/ambiguous prerequisite, and `repair_action=IMPORT_OR_ACTIVATE_PROFILE_AND_REPAIR_EMBEDDINGS`; the job remains at its existing processing state (normally `LANE_ROUTED`) | No timer retry; profile import/activation plus successful primary-space profile-fact embedding repair reactivates matching blocked tasks as `PENDING` | No |
| Full-posting host is not an exact pinned-manifest match, or description is incomplete | `availability.status=UNKNOWN`, `verification_method=NONE`, `reason_code=AVAILABILITY_NOT_VERIFIED` | Source evidence refresh | No |
| Gmail fetch receipt is malformed or its parent/URL lineage does not match | `availability.status=UNKNOWN`; retain the observation, raw payload, and error history | Fetch retry or manual review under the fetch task policy | No |
| Manual posting has no independent existing availability evidence | `availability.status=UNKNOWN`, including pasted/uploaded `MANUAL_STREAMLIT` content | Existing source verification may refresh the status | No |
| AI evaluation capacity not drained | `QUEUED_FOR_AI` / queue remains `PENDING` | Next run | No |
| Evaluation provider/schema failure | `RETRY_WAIT` | Backoff | No |
| Evaluation retries exhausted | `NEEDS_MANUAL_REVIEW` | Manual | No |

The profile prerequisite is checked when the worker creates `MATCH_PROFILE_EVIDENCE` task identity. A blocked task preserves its task/attempt history and is recoverable only after the repair path confirms exactly one active profile and verifies that every eligible current profile fact has a published embedding in the configured primary space. The repair path clears the dependency metadata and requeues only tasks with the matching `blocked_on` and `repair_action` values. It does not write a gate, lane, match, or recommendation outcome. These values use the existing `pipeline_tasks` dependency fields and `BLOCKED_DEPENDENCY` status; they do not change the task-intent payload contract or the database shape.

Availability policy details:

- Any retrieved posting with `description.completeness_status=COMPLETE` has a seven-day `OPEN` availability window, regardless of source. Greenhouse, Lever, and Ashby use their official adapter source identity to establish retrieval; Gmail-derived postings still require the complete, lineage-bound fetch receipt, and non-ATS boards still require an exact pinned-manifest host. Incomplete ATS listings may remain `OPEN` from the ATS listing status but keep the one-day window; alert-only and unverified listings remain `UNKNOWN`.
- Source-plugin schema `2.3.0` accepts up to 20 exact DNS hostnames per manifest. Host comparison is case-insensitive and may normalize one trailing dot; it must not accept wildcard entries or an unlisted subdomain. The source URL must be credential-free HTTP(S). The configured hosts are `himalayas.app` and `www.himalayas.app`, `jobicy.com` and `www.jobicy.com`, and `weworkremotely.com` and `www.weworkremotely.com`.
- A Gmail-derived posting may become `OPEN` only when its complete posting carries a schema-valid receipt (`requestedUrl`, `resolvedUrl`, `redirectHistory`, `retrievedAt`, `httpStatus`, `contentType`, and `responseHash`), `derived_from_observation_id` identifies a `GMAIL_ALERT` observation, and the payload `discovery_observation_id` equals that exact parent ID. Root `requested_url`, receipt `requestedUrl`, and the parent's discovered URL must match exactly. `resolvedUrl` records the final transport endpoint and is independently validated as a credential-free HTTP(S) URL; ATS APIs may serve a posting through a different endpoint from its employer-facing canonical URL. Root `canonical_url` and `posting.canonicalUrl` must match the fetched posting observation URL exactly. Receipt posting `companyName`, `title`, and `description` must match the persisted child observation fields exactly. A valid-looking receipt on its own is not lineage proof.
- Manual source provenance records the origin and editing history of the submitted content. It does not infer `OPEN`: a fetch receipt establishes content retrieval and identity, not current availability; pasted/uploaded `MANUAL_STREAMLIT` postings remain `UNKNOWN` unless an existing independent availability source (such as an explicit source status or employer ATS listing) verifies them. User confirmation and content completeness alone are not availability evidence.
- Evidence refresh uses the observation's pinned plugin revision and exact job-version lineage, preserves a baseline before replacing observation evidence, and recomputes readiness after persistence. A refreshed `OPEN` or `CLOSED` value updates the version projection; an `UNKNOWN` refresh does not overwrite the previous projected status, but the latest normalized evidence takes precedence for readiness, and any `OPEN` result is usable only through its expiry time.
- Emit `job_source_evidence_v2` when `verification_method=VERIFIED_POSTING_RETRIEVAL`, while keeping v1 records readable. Runtime readers, PostgreSQL version constraints, and SQL readiness/read-model consumers must accept both versions; update database constraints additively in the same change as a new emitted version, and regenerate the exported schemas for both versions and their parent contracts.

## Checker commands and artifacts

The checker must add:

- Contract fixtures covering Gmail, one ATS source, one duplicate/repost, one hard reject, one needs-verification job, one queued-for-AI job, one failed-then-retried evaluation and one evaluated shortlist row.
- A schema-drift test that inspects PostgreSQL columns and fails when runtime schemas or Streamlit queries reference missing fields.
- A field-lineage report generated during CI, mapping each `ShortlistRow` field back to its table/column and producer.
- A state-conservation assertion: input count equals terminal plus retry/queued counts; no record disappears between stages.
