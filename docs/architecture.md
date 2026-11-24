# Architecture

This document says how Job Decision Engine is structured, which part owns what, and what each part may touch. It has two halves:

- **Target architecture** (sections 2 to 8). Binding for every new file and every file that is moved. Most rules are checked by a test, so breaking one fails the build.
- **As built** (sections 9 to 15). The pipeline, states and entry points as they are, where the code lives today, the known violations, and the order in which they are removed.

The document is kept true by `src/tests/architecture/`. If a lane, pipeline stage, job state, table or rule changes in the code and not here, the test fails. See [Keeping this document true](#16-keeping-this-document-true).

Related documents: [`AGENTS.md`](../AGENTS.md) (operating contract and invariants), [`.agents/DATA-FLOW-CONTRACT.md`](../.agents/DATA-FLOW-CONTRACT.md) (what each boundary must prove), [`docs/data-contracts.md`](data-contracts.md) (runtime schemas and gate codes), [`docs/adr/`](adr/README.md) (decision records), [`docs/delivery-plan.md`](delivery-plan.md) (who is building what now), [`docs/architecture-review-2026-11-19.md`](architecture-review-2026-11-19.md) (the review behind this design).

## 1. What the system does

A posting is discovered, stored as evidence, checked by fixed rules, matched against the owner's profile, and given a decision. A model then adds an advisory evaluation to the short list. The owner reads the result, prepares documents and records the application.

```mermaid
flowchart TD
  S["Sources: email alerts, employer boards,<br/>saved-job imports, manual entry"] --> O["Raw observations"]
  O --> F["Full posting fetched"]
  F --> N["Canonical job and immutable job version"]
  N --> R["Requirements extracted"]
  R --> G{"Hard gates"}
  G -->|"hard reject, or blocked on verification"| D
  G -->|"pass, or only an open workability fact"| E["Embeddings published"]
  E --> L{"Lane routing"}
  L -->|"no lane fits"| X["Unmatched: stops here"]
  L -->|"lane found"| M["Requirements matched to profile evidence"]
  M --> D["Deterministic decision:<br/>PRIORITY, REVIEW, TRACK or SKIP"]
  D -->|"eligible PRIORITY or REVIEW"| Q["AI evaluation (advisory)"]
  D --> K["Ranking: Top 10 Ready"]
  Q --> V["Read models (views)"]
  K --> V
  V --> U["Streamlit workspace and HTTP API"]
  U --> W["Documents and application tracker"]
```

Fixed rules decide. The model never sets a gate, a score or an outcome ([`AGENTS.md`](../AGENTS.md), invariant 11).

## 2. Principles

1. **One job per part.** Finding postings, storing them, extracting requirements, applying policy, matching, deciding, evaluating with a model, writing documents and tracking applications are separate modules.
2. **One owner per fact.** Every table has exactly one owning module. Only the owner writes it.
3. **One door per part.** Other code reaches a module through one public file and nothing else.
4. **Rules are pure.** A gate, a lane rule, a score and a decision are functions of their inputs. They read no database, no clock and no environment, so they run in a unit test with no setup.
5. **Results carry their inputs.** Every stored result names the job version, profile version and policy version it was computed from, so it can be recomputed and compared.
6. **The model is a tool, not an actor.** Model calls go through one gateway that knows nothing about jobs and cannot reach the database. Model output is validated, stored as advice, and never changes a decision.
7. **Failures are not rejections.** A timeout, a parser error or a provider error leaves a job waiting or in support, never rejected.
8. **Posting text is untrusted.** It is cleaned before a model sees it and escaped before a person sees it.

The design is a modular monolith: one program and one database, with firm walls inside. Separate services would add network calls and deployments that a single-owner tool does not need. The decision is recorded in [ADR 0001](adr/0001-modular-monolith-with-enforced-boundaries.md).

## 3. Layers

```mermaid
flowchart TD
  I["Interfaces<br/>scripts/, src/interfaces/, Streamlit, desktop"] --> A["Composition root<br/>src/app/"]
  A --> M["Domain modules<br/>src/modules/&lt;name&gt;/"]
  M --> P["Platform<br/>src/platform/&lt;part&gt;/"]
  P --> C["Contracts<br/>src/contracts/"]
  I --> M
  M --> C
  I -.->|"read-only, views only"| DB[("PostgreSQL")]
  P --> DB
```

| Layer | Folder | Holds | May import |
|---|---|---|---|
| Interfaces | `scripts/`, `src/interfaces/`, `streamlit_*.py`, `desktop/` | Commands, scheduled entry points, HTTP routes, user interface. Parse input, call one module function, present the result. No rules and no SQL. | Composition root, module public files, platform public files, contracts |
| Composition root | `src/app/` | Wiring only: builds the database pool, the model gateway and the repositories, registers each module's task handlers with the queue. | Everything below |
| Domain modules | `src/modules/<name>/` | The rules and use cases of one job. | Earlier modules (public file only), platform public files, own repository, contracts |
| Platform | `src/platform/<part>/` | Technical services with no job rules. | Other platform parts (public file only), contracts |
| Contracts | `src/contracts/` | Shared types and runtime schemas. | Nothing |

Imports point downward only. Nothing imports upward, and nothing imports sideways except through a public file.

The platform cannot import a module, so the queue cannot name a stage. The composition root registers each module's handler against its task type. That keeps the queue generic and the stage logic inside its module.

## 4. Domain modules

Modules are listed in dependency order. A module may import only the modules above it in this table.

| # | Module | Its one job | Owns (main tables) | Code today |
|---|---|---|---|---|
| 1 | `sourcing` | Find postings and fetch their content | `raw_email_alerts`, `raw_job_observations`, `source_*`, `searchapi_*`, `employer_board_resolutions` | `src/ingestion/`, `src/services/gmail.ts`, `src/services/adapters/` |
| 2 | `catalog` | Hold the canonical job, its versions, confirmed facts and archive state | `canonical_jobs`, `job_versions`, `job_confirmed_facts`, `job_archive_*`, `verification_questions` | `src/pipeline/normalize.ts`, `src/services/jobArchive.ts`, `src/services/jobConfirmedFactService.ts` |
| 3 | `requirements` | Extract what a posting asks for, with quotes | `job_requirements`, `requirement_sets`, `requirement_extraction_runs`, `taxonomy_concepts` | `src/pipeline/requirementsExtractor.ts`, `src/requirements/` |
| 4 | `profile` | Hold the owner's facts, evidence, credentials and preferences | `profile_*`, `candidate_profiles`, `evidence_sources`, `workspace_user_preference_*` | `src/profile/` |
| 5 | `policy` | Apply the fixed rules: hard gates and lane routing | `gate_decisions`, `lane_decisions`, `lane_*`, `workspace_policy_snapshots` | `src/pipeline/hardGate.ts`, `src/services/criteria.ts`, `src/pipeline/laneRouter.ts`, `src/lanes/`, `src/policy/` |
| 6 | `matching` | Match requirements to profile evidence | `match_runs`, `requirement_evidence_matches`, `embedding_*`, `semantic_embeddings` | `src/pipeline/deterministicMatcher.ts`, `src/embeddings/` |
| 7 | `decision` | Turn gates, lane and match into an outcome and a rank | `deterministic_decisions`, `job_ranking_snapshots`, `ranking_policies` | `src/pipeline/recommendationDecider.ts`, `src/services/applicationRankingMaterializer.ts` |
| 8 | `evaluation` | Queue and run the advisory model evaluation | `evaluation_queue`, `ai_evaluations`, `evaluation_attempts`, `evaluation_budget_deferrals` | `src/pipeline/explanationQueueEnqueuer.ts`, `scripts/evaluate_queue.ts`, part of `src/services/agent.ts` |
| 9 | `documents` | Generate CVs and cover letters from verified evidence | `document_*`, `manual_application_*`, `manual_evidence_pairings` | `src/documents/`, `src/services/renderers/` |
| 10 | `applications` | Record applications and their status history | `application_records`, `application_events`, `application_document_selections` | `src/api/v2/router.ts`, `src/documents/` |

The full table list is in [`src/architecture/table-ownership.json`](../src/architecture/table-ownership.json).

### Inside a module

```text
src/modules/<name>/
  index.ts     the public file: the only file other code may import
  domain/      pure rules and types: no database, model, clock or environment
  handlers/    use cases: load inputs through the repository, call domain code, save the result

src/platform/persistence/<name>/
  index.ts     the module's repository: every SQL statement that touches the module's tables
```

A handler receives what it needs as arguments: the repository, the model gateway, the clock, the configuration. It does not build them and does not read `process.env`. That is what lets the same handler run in production, in a replay against a database copy, and in a test.

A public file exports functions and types. It does not export the repository, a database client or a SQL string.

## 5. Platform parts

| Part | Folder | Does | Must never |
|---|---|---|---|
| `config` | `src/platform/config/` | One typed loader for settings, model IDs and prices; validates at start | Be bypassed with `process.env` in a module |
| `observability` | `src/platform/observability/` | Structured logs, run reports, counters | Log posting text, profile data or connection strings |
| `security` | `src/platform/security/` | Workspace identity, text cleaning, bounded and public-safe errors | Hold job rules |
| `persistence` | `src/platform/persistence/` | The database pool, transactions, and one repository folder per owner | Export a general query function to modules |
| `llm` | `src/platform/llm/` | The model gateway: typed request in, validated result and usage out; retries, fallback, budgets | Import the database driver, a repository or a module |
| `prompts` | `src/platform/prompts/` | Prompts with an id, a version and an output schema | Be assembled inline in a module |
| `orchestration` | `src/platform/orchestration/` | The task queue: claim, lease, retry, dead-letter | Know what a stage means or read a module's tables |

The owner of platform tables is the part itself: `orchestration` owns `pipeline_*`, `llm` owns `model_route*`, `config` owns `config_*`, `security` owns `workspaces` and the workspace user tables.

## 6. Boundary rules

Each rule has an id. The check reports a violation as `RULE|subject|detail`.

### Rules for the target layout

These apply to every file under `src/modules/`, `src/platform/`, `src/interfaces/` and `src/app/`. There is no baseline for them: a violation always fails.

| Rule | Meaning | Why |
|---|---|---|
| B1 | Imports point downward: interfaces, modules, platform, contracts. | A lower layer that knows an upper one cannot be reused or tested alone. |
| B2 | Another module or platform part is reached only through its `index.ts`. | A part can change inside without breaking its users. |
| B3 | A module imports only modules that come before it in the order of section 4. | No cycles. Evaluation can read a decision; a decision can never depend on an evaluation. |
| B4 | Code in a module's `domain/` folder is pure: it imports no database, model, network or file package, and reads neither `process.env` nor the clock. | Rules can be tested and replayed exactly. |
| B5 | The model gateway never imports the database driver or persistence. | A model call cannot read or change stored data. |
| B6 | Only `src/platform/persistence/` imports the database driver. | There is one place to look for every query. |
| B7 | A repository folder is named after its owner and is imported only by that owner and by the composition root. | A module cannot use another module's queries. |
| B8 | SQL lives in persistence. A repository writes only its owner's tables. A module's repository reads its own tables, platform tables, tables of earlier modules, and views. A platform repository reads platform tables only. Nothing reads legacy tables. | One writer per fact, and data flows in one direction. |

Cross-module joins belong in a database view, not in code. Views named `v_*` are the read models that interfaces use.

### Rules that freeze the legacy layout

The code that exists today breaks these rules in known places. Those places are recorded in [`src/architecture/boundary-baseline.json`](../src/architecture/boundary-baseline.json). Anything not recorded fails the build, so the debt can shrink but cannot grow.

| Rule | Meaning |
|---|---|
| F1 | No new import cycle between files. |
| F2 | No new pair of legacy areas that import each other. |
| F3 | No new database access from `scripts/` or `src/api/`. A new command calls a module function. |
| F4 | No new importer of `src/services/agent.ts` or `src/db/db.ts`. |
| F5 | No new file in `src/services/`. New code goes into a module or a platform part. |
| F6 | No new writer of a job status column on `canonical_jobs` (section 7). |
| F7 | No new legacy area writes a table. An area is `scripts` or one folder under `src/`. |
| F8 | The Streamlit interface reads no new table and writes none. It reads views. |
| F9 | No new upward import. `src/db/` imports no area above it. `src/pipeline/` imports no queue, API, read-model or desktop code. |
| F10 | `src/services/modelCallResilience.ts`, which holds retry, timeout and fallback for model calls, imports no database, workspace, pipeline, queue, read-model or API code. |
| F11 | Code under `src/` never imports a script. |

`src/services/agent.ts` also has a line limit. It may shrink and may not grow.

### How the check works

- There is one check and one baseline. The rules are in [`src/architecture/boundaries.ts`](../src/architecture/boundaries.ts). The test is [`src/tests/architecture/boundaries.test.ts`](../src/tests/architecture/boundaries.test.ts). It runs with `npm test`, so it runs in CI on every pull request.
- A new violation fails with its key. Fix the code. Do not edit the baseline to make the test pass.
- When a recorded violation is fixed, the test asks for the baseline to be pruned: `ARCH_BASELINE=prune npx vitest run src/tests/architecture/boundaries.test.ts`. Pruning only removes entries.
- Adding a baseline entry is a hand edit and an exception. Each added entry and its reason go at the top of the pull request description, so the owner sees it before merging.
- Until the persistence layer exists (phase 5), a new command that must query the database is such an exception. Prefer extending an existing command.

### What the check cannot see

- SQL whose table name is built at run time, or written with lower-case keywords. Every statement in the repository uses upper-case keywords and literal table names; keep it so.
- SQL inside migrations: views, functions and triggers. Migrations are reviewed by the `database-versioning-engineer` and `data-contract-checker` roles.
- Read direction in legacy code. Only writes are frozen there.
- Hidden state inside a pure function, such as a module-level cache. Review covers this.
- Python other than `streamlit_*.py`.

## 7. Data ownership

- Every table has one owner in [`src/architecture/table-ownership.json`](../src/architecture/table-ownership.json). A migration that creates a table must add it there, or the test fails.
- Owners are the ten modules, the platform parts `orchestration`, `llm`, `config` and `security`, and `legacy`.
- `legacy` tables (`jobs`, `raw_jobs`, `raw_companies`, `companies`, `interactions_log` and the unused audit and cutover tables) are scheduled for retirement. New code neither reads nor writes them.
- Only the owner writes a table. Another module that needs a change calls the owner's public function.
- A user interface never writes a table. Streamlit reads views only; every change it makes goes through the HTTP API, which calls a module.

### Job status columns

`canonical_jobs` carries copies of facts that belong to other modules: `processing_state`, `processing_status`, `gate_decision`, `primary_lane`, `routing_disposition`, `profile_match_status`, `recommendation_outcome` and `recommendation_eligibility`. Today several files update each one, which is how a rejected job could keep an old recommendation.

Target:

1. The module that owns the fact saves it in its own table: `policy` in `gate_decisions` and `lane_decisions`, `matching` in `match_runs`, `decision` in `deterministic_decisions`, `evaluation` in `ai_evaluations`.
2. It then calls one `catalog` function that updates the copy. Each column has one update statement, in the `catalog` repository.
3. Later the copies are removed and job status becomes a view over the result tables.

Until then rule F6 lists every file that writes each column, and no file may be added.

### The concept graph

Matching needs a shared vocabulary: a requirement is about a concept, and a profile fact is evidence for a concept. The tables `taxonomy_concepts` and `profile_fact_concepts` exist for this, but no code fills `taxonomy_concepts`, requirements have no concept link, and `evidence_edges` is unused. Matching therefore compares sentences by embedding similarity. Building the concept links is phase 6 of the migration (section 15). It stays inside PostgreSQL; a separate graph database is not planned.

## 8. Model calls

| Rule | Target | Today |
|---|---|---|
| One gateway | Every model call goes through `src/platform/llm/` with a typed request and a typed result | Calls are still made from `src/services/agent.ts`, which also holds prompts, parsing and database writes. Phase 1 has started: `src/platform/llm/` holds error classification, usage and cost accounting, response-schema converters, the resilience layer (retry, deadline, rate-limit), fetch timeouts and the measurement check; the old paths re-export from there |
| No database in the gateway | B5 | The audited call path in `src/services/agent.ts` takes a database client |
| Model IDs in one place | `src/platform/config/` only; checked against the providers with `npm run models:check` | `src/platform/config/` holds the Gemini credential and backend settings. The evaluation default is in `src/services/modelDefaults.ts`. Other model defaults are still spread across `src/services/agent.ts`, `src/services/openAiModelRoles.ts`, scripts and environment variables, and an unset variable falls back to the code default |
| Versioned prompts | Each stored output records prompt id, prompt version and model | Prompts are built inline. Only the quoted-requirement prompt records a hash |
| Advice only | An evaluation is stored in `ai_evaluations` and never changes a gate, a score or an outcome | Holds. The legacy `eval:run` scripts are removed and `runAgent` no longer writes to the database. `runAgent` itself is still in `src/services/agent.ts` and goes with Phase 1 |
| Cleaned input | Posting text is cleaned and delimited before any model sees it | The posting is placed in the same message as the instructions, with no cleaning step |
| Bounded spend | Lane budgets and deferrals are recorded per run | In place: `ai_evaluation_budget_runs`, `evaluation_budget_deferrals` |

## 9. Pipeline stages

A stage is a task in `pipeline_tasks`. The worker is `scripts/process_pipeline_tasks.ts`, which runs `src/tasks/stageTaskWorker.ts`. Task types are defined there as `PIPELINE_STAGE_TASK_TYPES`.

| # | Task type | What it does | Code today | Target module |
|---|---|---|---|---|
| 1 | `FETCH_JOB_CONTENT` | Fetches the full posting for a discovered link | `src/ingestion/jobContentFetcher.ts` | `sourcing` |
| 2 | `NORMALIZE_OBSERVATION` | Creates or updates the canonical job and a new immutable job version | `src/pipeline/normalize.ts` | `catalog` |
| 3 | `EXTRACT_DETERMINISTIC_REQUIREMENTS` | Extracts requirements from the posting text by rule | `src/pipeline/requirementsExtractor.ts` | `requirements` |
| 4 | `APPLY_HARD_GATES` | Checks location, work mode, employment type, pay and title rules | `src/pipeline/hardGate.ts`, `src/services/criteria.ts` | `policy` |
| 5 | `EXTRACT_QUOTED_REQUIREMENTS` | Optional model-assisted extraction with quotes. A failure here never blocks the job | `src/pipeline/requirementsExtractor.ts` | `requirements` |
| 6 | `PUBLISH_EMBEDDING` | Publishes the embeddings that routing and matching compare: job, requirements, profile facts, lane prototypes | `src/embeddings/batchCoordinator.ts` | `matching` |
| 7 | `ROUTE_LANE` | Chooses the lane, or records that none fits | `src/pipeline/laneRouter.ts` | `policy` |
| 8 | `MATCH_PROFILE_EVIDENCE` | Matches each requirement to profile evidence | `src/pipeline/deterministicMatcher.ts` | `matching` |
| 9 | `DECIDE_RECOMMENDATION` | Computes eligibility and the outcome | `src/pipeline/recommendationDecider.ts` | `decision` |
| 10 | `ENQUEUE_EXPLANATION` | Puts an eligible job on the evaluation queue within the lane budget | `src/pipeline/explanationQueueEnqueuer.ts` | `evaluation` |
| 11 | `RECHECK_AVAILABILITY` | Re-reads a posting whose 7-day availability window ran out: open or closed, work mode, hiring territory | `src/tasks/availabilityRecheck.ts` | `catalog` |

Order of work:

- Stages 1 to 4 run in sequence for every job.
- A job that passes the gates continues to 6, 7, 8 and 9. So does a job whose only open items are workability facts that can be checked later, such as an unknown work mode (`src/pipeline/verificationRouting.ts`). It is matched and triaged while the question is open.
- A hard-rejected job, and any other job that needs verification, goes straight to stage 9, so its decision is recorded.
- If lane routing finds no lane, the job becomes `UNMATCHED` and stops. If routing could not run for a technical reason, the job becomes `ROUTING_DEFERRED` and goes to stage 9.
- Stage 10 follows stage 9 only when eligibility is `ELIGIBLE` and the outcome is `PRIORITY` or `REVIEW`.

After the stages:

| Step | Code today | Target module |
|---|---|---|
| Advisory evaluation of queued jobs | `scripts/evaluate_queue.ts` | `evaluation` |
| Ranking of Apply Now jobs into Top 10 Ready | `scripts/materialize_application_rankings.ts`, `src/services/applicationRankingMaterializer.ts` | `decision` |
| Archiving of rejected and aged jobs | `scripts/archive_jobs.ts`, `src/services/jobArchive.ts` | `catalog` |

## 10. Job states, decisions and status

### Job states

Stored in `canonical_jobs.processing_state` (`processing_status` holds the same value). The list is the enum in `src/contracts/index.ts`. There is no database constraint on the column.

| State | Meaning | Set by |
|---|---|---|
| `RAW_STAGED` | Canonical job created, not yet gated | Normalize |
| `PREQUALIFIED` | Passed the hard gates | Hard gates |
| `NEEDS_VERIFICATION` | A workability fact is unknown; the owner is asked | Hard gates |
| `HARD_REJECTED` | Conflicts with a hard rule, with stored reason codes | Hard gates |
| `LANE_ROUTED` | A lane was chosen | Lane routing |
| `ROUTING_DEFERRED` | Routing could not run for a technical reason | Lane routing |
| `UNMATCHED` | No lane fits, or a mandatory qualification is missing | Lane routing, matching |
| `MATCHED` | Requirements matched to profile evidence | Matching |
| `QUEUED_FOR_AI` | On the evaluation queue | Enqueue |
| `AI_EVALUATED` | Advisory evaluation stored | Evaluation worker |
| `NEEDS_MANUAL_REVIEW` | Evaluation retries exhausted | Evaluation worker |
| `PROCESSING_ERROR` | A stage failed and needs support | Stage worker |
| `MANUALLY_REMOVED` | Removed or dismissed by the owner | HTTP API |
| `EVALUATING`, `RETRY_WAIT` | In the enum; in practice these are statuses of a row in `evaluation_queue`, not of the job | Not set on jobs |
| `DEFERRED_BUDGET` | In the enum; since migration 060 a budget deferral is a row in `evaluation_budget_deferrals` and the job keeps its state | Not set |
| `SEMANTIC_SHORTLISTED`, `EVALUATED`, `REJECTED_AFTER_EVALUATION` | Older values kept for historical rows | Not set |

[`AGENTS.md`](../AGENTS.md) describes the flow with conceptual names. They map to stored values as follows: DISCOVERED is a row in `raw_job_observations`; NORMALIZED is `RAW_STAGED`; GATE_PASSED is `PREQUALIFIED`; EVALUATED is `AI_EVALUATED`.

### Decision values

| Fact | Values | Owner |
|---|---|---|
| Gate result | `PASS`, `NEEDS_VERIFICATION`, `HARD_REJECT` | `policy` |
| Eligibility | `ELIGIBLE`, `VERIFY`, `INELIGIBLE` | `decision` |
| Outcome | `PRIORITY`, `REVIEW`, `TRACK`, `SKIP` | `decision` |

### Status buckets

The owner sees one bucket per job. The view `v_job_status_buckets_scoped` computes it; the list is `JobStatusBucketSchema` in `src/contracts/jobStatus.ts`.

`APPLY_NOW`, `REVIEW_AWAITING_AI`, `REVIEW_EVALUATED_NOT_READY`, `TRACK`, `NEEDS_VERIFICATION`, `PROCESSING`, `SKIP`, `TECHNICAL_ERROR`, `REJECTED`, `UNMATCHED`, `REMOVED`.

### Availability

Whether a posting is currently open is decided in one place: `assessAvailability` in `src/decision/availability.ts`. The view `v_job_availability_current` states the same rule in SQL, and a parity test fails if the two differ. Every list reads that view's `availability_current` field. No list or script works it out for itself.

| Moment | What happens |
|---|---|
| Seen in the employer's feed, or its page shows the posting | Open, valid for 7 days. Each sighting extends it |
| Day 7 passes with no sighting | Hidden from every list and counted as "awaiting re-check". A re-check task is queued |
| Re-check finds the posting | Open for 7 more days |
| Re-check gets a clear closure: the page says not found or no longer accepting, or the feed was read successfully and the job is absent twice in a row | Archived the same day as closed |
| Re-check cannot tell: timeout, server error, paywall, login | Retried up to 3 times over 3 days, then archived as not confirmable |

An expired window is "unknown", never "closed". Saved, applied and held jobs are never archived automatically, and an archived job that reappears is restored. The rule and the list filtering are built; the automatic re-check and archive are in progress.

### Unknown facts

A job with an unknown workability fact (work mode, hiring territory, office days, travel) is not stopped and not rejected.

1. The fact is resolved automatically where the data exists: structured feed fields, or the posting text re-read by the availability re-check.
2. If it stays unknown, the job continues to matching and decision with the question left open.
3. A question is raised to the owner only when the job ranks in the top 20.
4. A job that is unresolved for 28 days and never reaches the top 20 is archived as not confirmable. This is reversible and is not a rejection.

### Awaiting content

A live job that is not hard-rejected and whose posting text has not reached the completeness rule (`description_quality_status` is not `COMPLETE`, or the only evidence is a bare Gmail alert) has no gate result, lane or recommendation in any list. It waits as "awaiting content" until its posting is fetched. The view `v_job_content_state` states the rule once; `v_canonical_shortlist_scoped` and everything built on it exclude waiting jobs, and `v_job_awaiting_content_scoped` lists them with the state of their fetch task. Stored decisions are kept, so a job returns to the lists when its content is complete. `scripts/check_integrity.ts` fails when a waiting job still carries a gate decision, lane or recommendation.

### What blocks a job

A mandatory requirement blocks a job only when it is a degree or credential that the matcher compared with the profile and found short, and the posting does not accept an equivalent. A free-text requirement with no supporting evidence does not block: it lowers coverage. Job duties, and skills in a posting with no section headings, are not mandatory unless the item itself says so.

Task status (pending, retrying, failed) and job status (rejected, review, priority) are different things. Task status belongs to `orchestration`. A failed task never changes a job's decision.

## 11. Lanes

Lanes are defined in `config/lanes/registry.yml`, one file per lane in `config/lanes/`.

- `CORE_AI_DATA`
- `LEGAL_REGTECH`
- `HEALTH_BIO_PHARMA`
- `INVESTMENT_MARKETS_FINTECH`
- `SOCIAL_IMPACT_MULTILATERAL`
- `UNIVERSITY_AI_RESEARCH`
- `TECHNICAL_PRODUCT_TRANSFORMATION`
- `INVESTIGATIONS_ENFORCEMENT`

## 12. Identity, versions and sources

Every observation keeps source identity and raw payload evidence. Canonical jobs may have multiple immutable `job_versions`. Gates, queue rows, evaluations, shortlist rows, and documents are pinned to `job_version_id`.

Public connectors are described by versioned source plugin manifests under `config/source-plugins/`. Each raw observation can link to the active immutable source plugin revision, enabling later compliance and audit reporting. See [`docs/source-adapters.md`](source-adapters.md).

## 13. Entry points

### Scheduled workflows

All four stop when the repository variable `WORKFLOW_KILL_SWITCH` is `true`.

| Workflow | When (UTC) | Runs |
|---|---|---|
| `.github/workflows/ingest.yml` | Daily, 02:00 | Email and source ingestion, then the pipeline worker and the evaluation worker |
| `.github/workflows/process_backlog.yml` | Hourly, minute 35 | Reconciliation, the pipeline worker, ranking |
| `.github/workflows/queue_worker.yml` | Hourly, minute 0 | The evaluation worker, ranking |
| `.github/workflows/daily-job-archiving.yml` | Daily, 19:15 | Archiving ([`docs/job-archiving.md`](job-archiving.md)) |

### Interfaces

| Interface | Code today | Reads | Writes |
|---|---|---|---|
| Streamlit workspace | `streamlit_app.py` and `streamlit_*.py` | Views | Nothing; changes go through the HTTP API |
| HTTP API v2 | `src/api/v2/`, started by `npm run workspace` | Through modules (target) | Through modules (target) |
| Commands | `scripts/` | Through modules (target) | Through modules (target) |
| Desktop app | `desktop/`, `src/desktop/` | The HTTP API | The HTTP API |
| MCP server and SDK | `src/mcp/`, `src/sdk/` | The HTTP API | The HTTP API |

## 14. As built

The code predates the target layout. No file lives under `src/modules/`, `src/platform/`, `src/interfaces/` or `src/app/` yet.

| Area today | Holds | Goes to |
|---|---|---|
| `src/services/` | Mixed: model calls, gate rules, ranking, archiving, Gmail, renderers | Split across `llm`, `policy`, `decision`, `catalog`, `sourcing`, `documents` |
| `src/pipeline/` | Stage logic with SQL inline | One module per stage (section 9) |
| `src/tasks/` | The queue and a single worker file that knows every stage | `orchestration`, with handlers in each module |
| `src/ingestion/` | Source adapters, broker, fetcher | `sourcing` |
| `src/policy/`, `src/lanes/` | Lane intent, lane registry, policy snapshots | `policy` |
| `src/eligibility/` | Readiness and hiring-territory checks used by the decision | `policy`, `decision` |
| `src/profile/`, `src/evidence/` | Profile import, facts, evidence strength | `profile` |
| `src/requirements/`, `src/taxonomy/` | Extraction helpers, concept contracts | `requirements` |
| `src/embeddings/`, `src/matching/` | Embedding spaces and batches, match contracts | `matching` |
| `src/decision/`, `src/reporting/` | Decision contracts, ranking measurement, board yield report | `decision`; the board yield report to `sourcing` |
| `src/documents/` | Document generation and provenance | `documents` |
| `src/modelRoutes/` | Model route registry | `llm` |
| `src/config/` | Config registry and loader | `config` |
| `src/security/`, `src/workspace/` | Text cleaning, public errors, workspace context | `security` |
| `src/db/` | Pool settings, migration runner, the legacy `db.ts` | `persistence`; `db.ts` is deleted |
| `src/api/` | HTTP routes with SQL inline | `src/interfaces/`, calling modules |
| `src/desktop/`, `src/mcp/`, `src/sdk/` | Desktop setup, MCP tools, client SDK | `src/interfaces/` |
| `src/contracts/`, `src/readModels/` | Runtime schemas | `src/contracts/` (stays) |
| `scripts/` | Commands, most with their own SQL | Thin commands that call modules |

### Known violations

Counted on 24 November 2026. The first count was on 23 November, when the check was merged. The live list is the baseline file.

| Rule | Count | What it shows |
|---|---|---|
| F1 | 1 | `src/services/agent.ts` and `src/services/llmFallback.ts` import each other |
| F2 | 11 | Pairs of areas that import each other; `src/pipeline` is in six of them |
| F3 | 98 | 92 scripts and 6 API files open their own database connection |
| F4 | 25 | 16 importers of `src/services/agent.ts`, 9 of `src/db/db.ts` |
| F5 | 33 | Files in `src/services/` |
| F6 | 46 | Writers of job status columns: `processing_state` from 14 files, `recommendation_outcome` from 6 |
| F7 | 166 | Table and area pairs; 30 tables are written from more than one area |
| F8 | 5 | Tables that `streamlit_app.py` reads directly |
| F9 | 1 | `src/pipeline/laneRouter.ts` imports the task queue |
| F10, F11 | 0 | Clean today; the rules keep them so |

Two files concentrate the problem. `src/services/agent.ts` (3,094 lines, down from 3,328 as Phase 1 moves code out) holds model configuration, provider calls, cost accounting, prompts, parsing, embeddings and a legacy evaluator. `src/tasks/stageTaskWorker.ts` (4,041 lines) holds the queue and the logic that links every stage.

## 15. Migration order

Each phase is a series of small pull requests merged to `main`. Behaviour does not change unless a phase says so. Who is doing what this week, and which work can run in parallel, is in [`docs/delivery-plan.md`](delivery-plan.md).

| Phase | Goal | Done when |
|---|---|---|
| 0 | Stop new damage. **Done.** | This check runs in CI; `runAgent` no longer writes to the legacy `jobs` table |
| 1 | Model gateway out of `src/services/agent.ts` | The file is deleted; F1 and its F4 entries are gone |
| 2 | Prompt registry and `evaluation` module | Every stored evaluation records a prompt version |
| 3 | One writer per decision | F6 shows one writer per status column |
| 4 | Pure stages and one recompute command | Stage logic sits in module `domain/` folders; the one-off replay scripts are retired |
| 5 | Persistence for what remains | The SQL still in scripts and API routes is in repositories; F3 and F7 are empty |
| 6 | Concept graph | A match is explained as requirement, concept, fact |
| 7 | Retire and shrink | Legacy tables and files removed; the baseline file is empty |

Moving a file into the target layout means it must pass rules B1 to B8 from that moment. A module's repository is therefore created when its first code moves: move the code and its SQL together, or the move fails the check. The first module that must change a job status column also creates the `catalog` function for it (section 7).

## 16. Keeping this document true

`src/tests/architecture/docs.test.ts` fails when:

- a lane in `config/lanes/registry.yml` is missing from section 11, or section 11 lists a lane that does not exist;
- a task type, job state, status bucket, job status column, module, platform part, table owner or boundary rule exists in the code and is not named here;
- a repository path or link written in this document no longer exists.

A structural change needs a decision record first. See [`docs/adr/README.md`](adr/README.md).
