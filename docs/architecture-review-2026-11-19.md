# Job Decision Engine — Architecture Review and Redesign

> **Status: review snapshot, 19 November 2026.** This is a point-in-time review of `main` at commit `299706e`. It is kept as the record of why the restructuring was started. It is not updated as the code changes, so file sizes, counts, pull request numbers and model dates describe that day. Since then the scoring stack has merged, Phase 0 is complete, and the evaluation model question is settled for now. For the current structure see [architecture.md](architecture.md).

## Verdict

The engine's ideas are sound, but the code has no enforced boundaries, so the same fact is computed and written in many places. That is why each fix keeps producing a new fault somewhere else.

I read `main` at commit `299706e` (19 Nov 2026): about 95,000 lines under `src` excluding tests, 63,000 lines of tests, 121 scripts, 113 migrations and 141 database tables.

One item needs a check today and is unrelated to structure. Google's Vertex AI page lists `gemini-3.6-flash`, the production evaluation model, with a retirement date of 19 November 2026. A Google account notice reported on 18 November says projects already using it keep access until 28 January 2027. Confirm with one live call. See the model ID section.

Five changes matter most, in this order:

1. **One owner per decision.** A job's outcome is updated from 6 files and its processing state from 14. Give each stored fact a single writer, and compute a job's status from the latest records.
2. **Split `agent.ts` into a model gateway that knows nothing about jobs or the database.** Delete the legacy agent path, which still writes model output straight into job state.
3. **Make every pipeline stage a pure function with a thin handler.** A decision becomes a function of job version, profile version and policy version. One generic recompute command then replaces the 22 replay, repair, requeue, reconcile and reset scripts.
4. **Build the concept graph the schema was designed for.** The taxonomy tables exist but nothing fills them, and requirements have no link to concepts. Matching therefore compares sentences, not skills.
5. **Shrink the surface and enforce the boundaries.** Two generations of the system run side by side. Retire the old one, freeze what is not needed to produce jobs, and add a lint rule that fails a build on a forbidden import.

This should be done as a gradual move, module by module, behind unchanged behaviour. A rewrite would throw away 271 test files that encode hard-won rules. The scoring work now in review should merge first.

## Today's architecture

The code has three layers on paper and none in practice: every entry point and every code area reaches the database directly, and several of them write the same job state.

*(Diagram omitted in this copy: interfaces and scripts, the code areas, and the database, with every part reaching the database directly.)*

Read it top to bottom. The highlighted box is where the copies of each decision live, and where they fall out of step.

## What works and should be kept

The redesign keeps the engine's rules and replaces only how the code is arranged around them.

- **The 12 invariants in `AGENTS.md`.** A failure never becomes a rejection, an unknown stays unknown, and model output is advisory.
- **Deterministic gates before any model call**, with a per-lane budget and a retry-safe evaluation queue.
- **Immutable job versions.** Gates, decisions, evaluations and documents are pinned to a `job_version_id`, and raw payloads are retained.
- **The model-call resilience layer** (`modelCallResilience.ts`, 714 lines): backoff with jitter, deadlines, Flex handling and an ordered fallback. It is already nearly self-contained.
- **Strict validation of model output**: schema checks, identity echo, and per-sentence citation checks in documents.
- **Contract-first schemas**: 70 JSON schemas with a CI check, and the Streamlit UI reads through database views.
- **The test suite**: 271 test files, 80 of which run against a real Postgres, plus a migration-ordering test, CodeQL and secret scanning in CI.
- **Additive migrations** and the rule that nothing is deleted.

## Flaws in structure and module boundaries

Thirteen structural flaws, all with the same root: folders group files by habit, and nothing stops any file from importing any other.

| ID | Flaw | Evidence in the code | Consequence |
| --- | --- | --- | --- |
| S1 | `agent.ts` does eight jobs | 3,364 lines, 83 functions: model registry, provider clients, retries, cost accounting, schema conversion, embeddings, preflight checks, two evaluation prompts, output parsing, a legacy agent loop and database writes | Any model change risks evaluation; 17 non-test files depend on it |
| S2 | `stageTaskWorker.ts` is a second oversized file | 4,012 lines importing 35 internal modules: scheduling, seeding, currentness, Gmail outcome marking | The queueing fixes in #144, #148 and #191 all had to change this file |
| S3 | `services/` has no theme | Model gateway, gate rules (`criteria.ts`, 1,704 lines), archiving (1,689), Gmail, renderers and a second set of source adapters | No one can say what belongs there |
| S4 | No dependency direction | 11 pairs of areas import each other, for example `pipeline` and `services` (11 and 17 files), `ingestion` and `pipeline` (22 and 5) | A change cannot be reasoned about locally |
| S5 | Two generations run side by side | Legacy `jobs` and `raw_jobs` tables, `db.ts`, `runAgent`, legacy routes in `server.ts` and `services/adapters`, next to the canonical pipeline | Double the code to keep correct; `npm run eval:run` still starts the old evaluator |
| S6 | The legacy agent writes model output into job state | `agent.ts` line 2813 onward sets `processing_status` to `EVALUATED` and the lanes from the model's answer | Breaks invariant 11 on that path |
| S7 | Production workers live in `scripts/` | `evaluate_queue.ts` (594 lines, 26 queries), `run_adapters.ts` (1,059), `process_pipeline_tasks.ts` (921); 129 script files, 28,000 lines | Core logic sits outside the tested module tree |
| S8 | SQL is everywhere | About 1,150 query calls in 134 files; 86 scripts open their own connection; API routers hold 111 | A schema change touches dozens of files |
| S9 | Gate and lane rules are regular expressions in six modules | `criteria.ts`, `hardGate.ts`, `workabilityPolicy.ts`, `stage3PolicyEngine.ts`, `laneRouter.ts` (2,808 lines) and `eligibility/`; two gate engines | A preference change is a code change in several files plus a replay script |
| S10 | Four interfaces in two languages | Streamlit (8,074 lines of Python), a React page, an Electron desktop app with 21,700 lines of built output committed, and an HTTP API | Every data change must be made four times |
| S11 | Dead and orphan code | `src/matching`, `src/taxonomy` and `src/mcp` are imported by nothing; `agent.ts` imports Gmail and never uses it | Misleads every new reader, human or agent |
| S12 | Configuration in four places | 124 environment variables (37 about models, with alias chains), 35 config files, database revision tables and GitHub repo variables | The running configuration is hard to know; the model registry is fixed at import time |
| S13 | Weak tooling | `lint` is only `tsc`; no ESLint or import-boundary rule; 410 uses of `any`; no logger (166 `console` calls) | Nothing prevents the next mixed module |

## Flaws in the pipeline, job state and orchestration

The pipeline stores derived state in many places and then works hard to keep the copies in step. Most of the faults of the last three weeks are copies that disagreed.

| ID | Flaw | Evidence in the code | Consequence |
| --- | --- | --- | --- |
| P1 | One fact, many writers | `canonical_jobs.recommendation_outcome` is updated by the matcher, the hard gate, the lane router, the decider, the archive service and a script. `processing_state` is updated from 14 files in 25 statements | A gate can reject a job while its stored decision still says Review. PR #202 patches that one case |
| P2 | Ten status-like columns on one table | `canonical_jobs` grew from 14 to 47 columns, including `processing_state`, `processing_status`, `gate_decision`, `recommendation_outcome`, `recommendation_eligibility`, `routing_disposition`, `profile_match_status` | No single answer to "where is this job now?" |
| P3 | Operational state and career state share a column | `processing_state` holds both PROCESSING\_ERROR and HARD\_REJECTED | Invariant 1 has to be defended by hand everywhere |
| P4 | A hand-built workflow engine | `pipelineTaskCurrentness.ts` (1,444 lines) classifies each task as current, superseded, satisfied or archived; plus a reconciler, stage versions and context fingerprints | The hardest code in the repo exists to work out what needs recomputing |
| P5 | Recomputing means writing a new script | 10 `replay_*`, 4 `repair_*`, 3 `requeue_*`, 3 `reset_*` and 2 `reconcile_*` scripts | Each policy change costs a bespoke script and a production run |
| P6 | Stages are not pure | Each stage reads tables, applies rules and writes several tables and summary columns in one function | Rules cannot be tested or replayed without a database |
| P7 | Stage order is encoded in more than one place | The task-type list in `pipelineStageScheduler.ts`, enqueue logic in `stageTaskWorker.ts`, and the state machine in two documents | The documented state machine and the code have drifted |
| P8 | AI evaluation runs before liveness is confirmed | Found in the saved-jobs review: 20 jobs evaluated with open facts | Money spent on closed jobs |
| P9 | Scheduling depends on GitHub Actions cron | Four scheduled workflows run in the United States against a Singapore database; time budgets, seed budgets and claim limits are tuned by repo variables | Throughput is governed by settings no test covers |
| P10 | No staging environment | Replay databases are created by hand as Neon branches when needed | Every change is first proven on production data, or not proven |

## Flaws in the data model and the graph

The schema is far larger than the problem, yet the one structure that matching needs, a shared set of concepts, was designed and never filled.

| ID | Flaw | Evidence | Consequence |
| --- | --- | --- | --- |
| D1 | Schema out of proportion to a single-user tool | 141 tables, 38 views with 83 definitions over time, 43 functions, 40 triggers, 296 indexes and 141 JSONB columns across 113 migrations | Every change needs a migration, and few people or agents can hold the model in mind |
| D2 | Governance tables repeated per domain | 27 revision, activation and approval tables for config, lanes, model routes, plugins, profile facts, requirement sets and preferences | A budget change created a new lane revision and stranded 356 jobs (#144) |
| D3 | Multi-tenant design for one user | 17 `workspace_*` tables; `workspace/context.ts` is imported by 117 files | Every query and test carries a scope it never varies |
| D4 | Legacy tables still written | `jobs` and `raw_jobs` are updated by `db.ts` and at least six scripts | Two sources of truth |
| D5 | Derived and vestigial columns on base tables | The 10 status-like columns on `canonical_jobs`; `location_summary` reads "Unknown" on every production job while the gates read `location` | A review sheet read the wrong column and misdiagnosed the gates |
| D6 | The concept layer is empty | `taxonomy_concepts` is read by three profile modules, but no code or migration inserts into it; `job_requirements` has no concept column | A requirement and a profile fact can never meet on a shared concept, so matching falls back to sentence similarity |
| D7 | An unused generic edge table | `evidence_edges` stores entity type and id pairs without foreign keys; no code references it | A graph was sketched in the least safe relational form, then abandoned |
| D8 | Embeddings stored twice and compared in application code | `embedding_values DOUBLE PRECISION[]` plus an untyped `embedding_vector vector`; no vector index | Works at 183 facts; cannot support retrieval at scale |
| D9 | Requirement types favour logistics | On `main` the types cover office days, travel, work authorisation and similar; capability falls into `DOMAIN`, `FUNCTION` or `CUSTOM` | The template-sentence fault. PR #193 addresses the text, not the model |
| D10 | The schema is the interface | Streamlit reads 19 views directly; API routers and scripts embed SQL | A column rename is a cross-language change |

### The graph view

The domain is a graph, and the redesign should model it as one, inside Postgres.

- **Entities**: employer, job, job version, requirement, concept, profile fact, engagement, credential, lane, application, document.
- **Relationships that carry the logic**: a requirement is *about* a concept; a fact is *evidence for* a concept; a lane *covers* concepts; a document sentence *cites* a fact.
- **What that buys**: a match becomes a path, requirement to concept to fact. It is exact, explainable in one line, and stable when wording changes. "Kubernetes" and "K8s" resolve to one node.

Five principles the current model breaks, and the fix for each:

| Principle | Today | Fix |
| --- | --- | --- |
| Relationships are first-class and typed | One generic edge table with no foreign keys, unused | One table per relationship with foreign keys: `requirement_concepts`, `fact_concepts`, `lane_concepts` |
| Resolve entities before linking | No concept normalisation on the job side | A concept-linking step after extraction: exact and alias match first, embedding search for candidates, a model only to choose among candidates |
| Store a fact once; derive the rest | Outcomes copied onto `canonical_jobs` | Decision tables are the record; status is a view |
| Every edge carries its evidence | Requirements keep quotes; facts keep sources | Keep this, and add the quote to each requirement-to-concept link |
| Embeddings find candidates; they do not decide | Cosine similarity is the score | Concept overlap decides first; embeddings rank what the graph cannot link |

I would not add a separate graph database. At a few thousand jobs and a few hundred concepts, Postgres handles these joins in milliseconds. A second database would double the operations work for one user and split transactions that today are atomic.

## Flaws in the AI and agentic design

The production path is correctly a workflow of bounded model calls, not an autonomous agent. The flaws are in how those calls are defined, configured and checked.

| ID | Flaw | Evidence | Consequence |
| --- | --- | --- | --- |
| A1 | One prompt does everything | The evaluation call returns a lane, about 15 scores, culture quotes, policy conflicts and a next action (`agent.ts` lines 3222 to 3300) | Unfocused output; the evaluator separated saved jobs from non-fits at only 0.65 in the benchmark |
| A2 | Prompts are inline strings | Six files hold prompts as template literals. Only the quoted-requirement prompt records a hash; evaluation and document prompts carry no version | A stored evaluation cannot be traced to the prompt that produced it; a prompt edit is untestable |
| A3 | Example values in the output template | The JSON shape shown to the model contains sample numbers such as 78, 80 and 82 | Models anchor on examples; scores cluster near them |
| A4 | Untrusted posting text sits beside instructions | The description is concatenated into the same message as the profile and the rules, with no cleaning step | A posting can carry hidden text or instructions; the owner's profile is in the same context |
| A5 | A legacy agent loop can write state | `runAgent` gives the model a database query tool, then writes its answer to job rows (S6) | The one place where the model does set state |
| A6 | Three sources of model configuration | Environment variables with alias chains, database model routes with revisions, and GitHub repo variables; the registry is read at import time | Nobody can state the running model with confidence. A benchmark silently measured the fallback |
| A7 | Inconsistent provider defaults | Extraction defaults to OpenAI when unset; evaluation and documents default to Gemini | Surprising cost and behaviour on a fresh setup |
| A8 | No evaluation set guards changes | `golden_questions.yaml` (96 lines) tests only the legacy agent; the ranking measurement tool is in unmerged PR #192 | Model, prompt and scoring changes ship without a quality number |
| A9 | The gateway knows about the database and workspaces | `generateContentAudited` is about 500 lines and takes a Postgres client, a workspace context and route keys | The model layer cannot be tested or reused without a database |
| A10 | Similarity is used as the score | Raw embedding cosine is the match credit | Covered in the change plan; the graph section gives the lasting fix |
| A11 | Cost is only known if a variable is set | Prices come from `MODEL_PRICING_JSON`; without it cost is null | Run costs were reported as estimates |
| A12 | Model IDs are repeated in ten files | `agent.ts`, `modelIdPreflight.ts`, `SetupWizard.tsx`, `.env.example`, `streamlit_app.py`, the OpenAI roles file and four scripts | A retirement means a hunt. PR #197 starts to fix this |

The principles I measured against, and where the engine stands:

| Principle | Status |
| --- | --- |
| Prefer a fixed workflow to an autonomous agent when the steps are known | Met in production; the legacy loop should go |
| One purpose per model call, with typed input and output | Not met for evaluation (A1) |
| The model proposes; code decides and writes | Met, except A5 |
| Treat external text as data, isolated from instructions | Not met (A4) |
| Version every prompt and record it with each output | Partly met (A2) |
| Trace every call: model, prompt version, tokens, cost, path served | Partly met: path and model are recorded, prompt and cost are not reliable |
| Fail loudly when a fallback is used in a measurement | Not met (A6) |
| Gate changes on an evaluation set | Not met (A8) |
| Keep a person in the loop for irreversible actions | Met: the owner submits applications personally |

## Flaws in the delivery process

The process has many checks and a very high change rate, yet the most important fix is not on `main` and nothing measures whether the product does its job.

| ID | Flaw | Evidence | Consequence |
| --- | --- | --- | --- |
| L1 | The core fix is not on `main` | Measurement, real extraction, replay tooling and top-K scoring sit in a four-deep stack of draft PRs: #192, #193, #194, #196 | `main` still ships the template-sentence extractor; every other PR is built on the old behaviour |
| L2 | High throughput with long-lived leftovers | 102 PRs merged and 124 opened since 1 November; 26 open, some from 2 to 7 November; 156 remote branches | Review attention is spread thin; stale branches drift |
| L3 | Heavy review roles, no boundary check | 10 agent role definitions, 25 skill files and three sign-offs per change; no automated rule on imports or state writers | Recent defects were caught by manual challenge, not by the gates |
| L4 | No quality gate for the product's purpose | 271 test files; none reports ranking quality | A change can pass CI and make the ranking worse |
| L5 | No staging environment | Production variables were changed during investigations and later reverted | Experiments and production share settings |
| L6 | Documentation has drifted | `docs/architecture.md` is 52 lines and names four lanes; the code has eight, and the documented state machine omits matching and decision | New agents start from a wrong map |
| L7 | Build output is committed | 21,700 lines of bundled desktop backend, including a bundled copy of the agent code | Stale copies of logic; noisy diffs |
| L8 | Scope ran ahead of the core | Desktop installer and signing policy, multi-workspace, plugin revisions, an SDK and an unused MCP module exist; ranking does not yet work | Each adds surface that every change must respect |
| L9 | Tests depend on the clock | About 33 test files read the real date; 6 use fake timers | Risk of failures that appear with time, not with a change |
| L10 | Dependency hygiene | Both Playwright and Puppeteer are runtime dependencies; 11 Dependabot PRs are open, the oldest from 14 October | Extra install weight and unpatched libraries |
| L11 | No structured logging | 166 `console` calls; provider mix and costs were added to reports case by case | Diagnosis depends on reading workflow logs |

## Default model IDs against the providers' lists

The production Gemini defaults all exist today, but the evaluation model is in its wind-down period. Five other IDs still in the code are retired or scheduled for shutdown: `gemini-1.5-flash`, `gemini-2.5-flash`, `o3-mini`, `gpt-4o-mini` and `gpt-4o`. Checked on 19 November 2026.

| Model ID | Where it is a default | Provider status | Action |
| --- | --- | --- | --- |
| `gemini-3.6-flash` | Evaluation primary: `agent.ts`, `.env.example`, setup wizard, the repo variable | Vertex lists retirement on 19 Nov 2026, replacement `gemini-3.8-flash`. A Google account notice dated 18 Nov reportedly keeps already-active projects running until 28 Jan 2027 | Confirm with a live Vertex call today. Plan the move now; do not wait for January |
| `gemini-3.8-flash` | Documents | Released 2 Sep 2026; retirement "September 2, 2027 or later" | Keep. It is the natural evaluation replacement: same price tier, already in use |
| `gemini-4-hydrogen` | Proposed in PR #197 | Generally available since 12 Nov 2026; no retirement date. A third-party listing gives $1.50 input and $7.50 output per million tokens | Candidate only after the cost and quality comparison |
| `gemini-3.1-flash-lite` | Requirement extraction; document secondary | Retirement "May 7, 2027 or later"; successor `gemini-3.5-flash-lite` | Keep; schedule a measured comparison with the successor |
| `gemini-embedding-001` | Embeddings | Retirement "no sooner than May 20, 2028"; successor `gemini-embedding-2` | Keep. Changing it means re-embedding everything |
| `gemini-1.5-flash` | `scripts/evaluate_jobs.ts`; column default on `ai_evaluations.model` | Retired in 2025 | Remove with the legacy path |
| `gemini-2.5-flash` | `scripts/compare_evaluation_models.ts` | Vertex retirement 20 Oct 2026 | Remove from the comparison script |
| `gpt-4o-mini` | `DEFAULT_OPENAI_FALLBACK_MODEL` in `openAiModelRoles.ts`, `.env.example`, setup wizard | Deprecated on 14 Oct 2026; shutdown 14 Jan 2027; replacement `gpt-6-luna` | Change the code default. Production overrides it with `OPENAI_MODEL`, a fresh install does not |
| `gpt-5.6-luna` | Extraction on OpenAI | Not deprecated | Keep |
| `text-embedding-3-small` | Embedding fallback | Not on OpenAI's deprecation page | Keep, but never mix its vectors with Gemini's in one comparison |
| `gpt-4o`, `o3-mini` | Model list in `streamlit_app.py` | `gpt-4o` shuts down 14 Jan 2027; `o3-mini` shut down 23 Oct 2026 | Prune the list |

Two cautions on the evidence. The agent's `models:check` today ran with the evaluation model overridden to hydrogen, so it may not have tested `gemini-3.6-flash` on Vertex. The 28 January date comes from a third party quoting Google's notice; Google's public page still shows 19 November.

Sources: [Vertex AI model versions and lifecycle](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions?hl=en) · [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations.md) · [Gemini deprecations, third-party summary](https://www.developersdigest.tech/deprecations/gemini) · [report of Google's 18 Nov notice](https://github.com/theopenco/llmgateway/pull/5149) · [Gemini 4 Hydrogen on Vertex, third-party pricing](https://www.llmreference.com/model/gemini-4-hydrogen/gcp-vertex-ai)

## Target architecture

One codebase in three layers, where each module does one job, owns its own tables, and can be tested without the others.

*(Diagram omitted in this copy: three layers. Interfaces on top; the domain modules sourcing, catalog, requirements, profile, policy, matching, decision, evaluation, documents and applications in the middle; the platform parts config, observability, security, persistence, model gateway, prompts and orchestration below.)*

A job passes through the domain modules in reading order: sourcing, catalog, requirements, policy, matching, decision, then evaluation. Configuration and logging also sit in the platform layer.

Seven rules make the picture true. Each is checkable by a tool, not by review.

| Rule | What it means | How it is enforced |
| --- | --- | --- |
| R1. Imports point downward | Interfaces import modules; modules import the platform; nothing imports upward or sideways except through a module's public file | Import-boundary lint in CI |
| R2. One writer per fact | Each table has one owning module. Only `decision` writes an outcome | A CI query counts update sites per column |
| R3. Rules are pure | A gate, a lane rule, a score and a decision are functions of their inputs. They read no database, no clock and no environment | Unit tests run with no database |
| R4. Results carry their inputs | Every result is stored with job version, profile version and policy version | Schema constraint; the recompute command relies on it |
| R5. The model gateway knows nothing about jobs | It takes a typed request and returns a typed result with usage. It never imports Postgres | Import-boundary lint |
| R6. Prompts are versioned | Each stored model output records prompt id, prompt version and model | Not-null columns |
| R7. External text is cleaned first | No posting reaches a model before the cleaning step | The gateway accepts only a cleaned-text type |

The design is a modular monolith: one deployable program with firm internal walls. Separate services would add network calls, deployments and failure modes that a single-user tool does not need.

## Where each part of `agent.ts` goes

Every block of `agent.ts` has one destination: the model gateway, the prompt registry, the evaluation module, or deletion. Line numbers are from `main` at `299706e`.

| Lines | What it is | Destination | Note |
| --- | --- | --- | --- |
| 68 to 82 | Lane lists for prompts | `prompts/evaluation` | Belongs with the prompt it feeds |
| 88 to 160 | Model registry, provider order, timeouts, retries | `platform/config/models.ts` | One typed loader, read at call time; the only file with model IDs |
| 162 to 255 | Provider error classification | `platform/llm/errors.ts` | Pure functions |
| 257 to 395 | Token usage and cost accounting | `platform/llm/usage.ts` | Prices move to the models config |
| 424 to 455, 2288 to 2514 | Registry and route preflight | `platform/llm/preflight.ts` | Used by `models:check` |
| 456 to 546 | Gemini client, credential scope, Flex headers | `platform/llm/providers/gemini.ts` |  |
| 552 to 760 | Database query tool and `runAgentWithFallback` | Delete | Only a test calls it |
| 765 to 825 | Schema converters for Gemini and OpenAI | `platform/llm/schema.ts` | Pure functions |
| 826 to 1120 | Provider call functions | `platform/llm/providers/` | Replace `options: any` with one typed request |
| 1121 to 1234 | `callLLM`, `generateContent` | Delete after moving three callers | Two scripts and `llmFallback.ts` |
| 1235 to 1918 | `generateContentAudited` | `platform/llm/gateway.ts` plus an `AuditSink` interface | The gateway stops importing Postgres; the sink is implemented in persistence |
| 1919 to 2287 | Embedding calls | `platform/llm/embeddings.ts` | Batching stays in `embeddings/` |
| 2515 to 2866 | Legacy agent: `runAgent` and its parser | Delete | Remove `eval:run`, `run_evals.ts` and `test_agent.ts` with it |
| 2867 to 3197 | Evaluation types, bounds, strict parsing | `evaluation/contracts.ts`, `evaluation/parse.ts` | Pure functions, easy to test |
| 3198 to 3364 | `evaluateSingleCanonicalJob` | Prompt to `prompts/evaluation/v1.ts`; flow to `evaluation/evaluateJob.ts` | The worker logic in `scripts/evaluate_queue.ts` moves to `evaluation/worker.ts` |

During the move, `agent.ts` stays as a short file that re-exports from the new locations, so its 17 importers keep working. It is deleted once they point at the new modules.

## Migration plan

Eight phases, each a series of small pull requests that leave behaviour unchanged unless stated. Phase 0 and Phase 1 can start now, because they do not touch the files in the scoring pull requests.

| Phase | Goal | Done when |
| --- | --- | --- |
| 0 | Stop new damage | Boundary rule in CI; legacy evaluator cannot run; scoring stack merged |
| 1 | Model gateway out of `agent.ts` | `agent.ts` deleted; nothing in `platform/llm` imports Postgres, workspace or pipeline code |
| 2 | Prompt registry and evaluation module | Every stored evaluation records a prompt version; the ranking benchmark runs in CI |
| 3 | One writer per decision | One update site per status column; no rejected job can appear in Review or Apply Now |
| 4 | Pure stages and generic recompute | The 22 replay-style scripts are retired; a preference change is a config change plus a dry run |
| 5 | Persistence layer | No SQL outside `persistence/` in `src` |
| 6 | Concept graph | Matching explains each match as a path and beats the top-K score on the benchmark |
| 7 | Retire and shrink | Legacy tables, files and build output removed; architecture document matches the code |

### Phase 0. Stop new damage

1. Confirm `gemini-3.6-flash` with a live Vertex call. If it fails, set the evaluation model to `gemini-3.8-flash`.
2. Change the code default for the OpenAI fallback away from `gpt-4o-mini`.
3. Remove the `eval:run` script, and make `runAgent` refuse to write to job rows.
4. Add an import-boundary check (for example `dependency-cruiser`) with today's violations recorded as a baseline. CI fails on any new violation.
5. Add three lines to `AGENTS.md`: no new code in `agent.ts`, nothing new in `services/`, no SQL in new scripts.
6. Merge the scoring stack (#192, #193, #194, #196) once the blind review passes. Do this before any file moves, to avoid conflicts.

### Phase 1. Model gateway out of `agent.ts`

1. Create `platform/llm` and move code as the move map shows. These are moves, not rewrites.
2. Define one typed request and one typed result for every provider call.
3. Replace the database parameter with an `AuditSink` interface. The gateway calls it; persistence implements it.
4. Put every model ID and price in one config file, read at call time.
5. Make a measurement run fail when the primary model was not the one that answered.
6. Point the 17 importers at the new modules, then delete `agent.ts` and the `llmFallback.ts` cycle.

### Phase 2. Prompt registry and evaluation module

1. Give each prompt an id, a version, a template function and an output schema, in `prompts/`.
2. Record prompt id and version on evaluations and document runs. This needs one additive migration.
3. Move the worker logic from `scripts/evaluate_queue.ts` into `evaluation/`. The script becomes a short command.
4. Narrow the evaluation prompt to the outputs something reads. Remove the example numbers from the output template.
5. Clean every posting before any model sees it, and wrap it in clear delimiters. The posting guard from ai-job-search fits here.
6. Add the saved-jobs benchmark as a command and report it in CI, first as information, later as a threshold.

### Phase 3. One writer per decision

1. Gates, lane routing and matching each write only to their own result table.
2. The decision module becomes the only writer of the outcome.
3. A job's status becomes a view over the latest gate, lane, match, decision and evaluation records.
4. Keep the old columns for now, filled by one projector, until nothing reads them.
5. Split task status (pending, retrying, failed) from job status (rejected, review, priority).
6. Add the check to CI and to the measuring tool: a rejected job in Review, Priority or Apply Now fails the run.

### Phase 4. Pure stages and generic recompute

1. Rewrite each stage as a pure function plus a thin handler: load inputs, call the function, save the result with its input versions.
2. Key every result by job version, profile version and policy version.
3. Add one command: recompute a named stage for a chosen set of jobs, dry run by default, with a before-and-after report.
4. Merge the two gate engines into one.
5. Move title lists, sector lists and thresholds from regular expressions in code to validated config files.

### Phase 5. Persistence layer

1. Create one repository per module under `persistence/`.
2. Move SQL out of API routers and production scripts into those repositories.
3. Forbid importing `pg` anywhere else in `src`, by lint rule.

### Phase 6. Concept graph

1. Seed concepts from the owner's profile facts and from extracted requirements. A model proposes; the owner approves in batches.
2. Add `requirement_concepts`, `fact_concepts` and `lane_concepts` with foreign keys.
3. Add a concept-linking stage after extraction.
4. Score by concept overlap first, with embeddings for requirements the graph cannot link.
5. Compare against the top-K score on the benchmark before switching.

### Phase 7. Retire and shrink

1. Export and archive the legacy `jobs` and `raw_jobs` tables, with the owner's approval, then stop writing to them.
2. Delete `db.ts`, the legacy routes in `server.ts`, `services/adapters`, the orphan modules and the committed build output.
3. Close or merge the stale pull requests and delete merged branches.
4. Rewrite `docs/architecture.md` from the code, and record each structural decision in a short decision record.

## Decisions for the owner

Seven decisions shape the work. My recommendation follows each.

- [ ] **Direction.** One TypeScript codebase on Postgres, split into modules with enforced boundaries, moved gradually. Recommended: yes.
- [ ] **Evaluation model.** Move to `gemini-3.8-flash` now, or wait for the hydrogen comparison. Recommended: move to 3.8 now if today's live check fails or the comparison is more than a week away.
- [ ] **Legacy path.** Delete `runAgent`, `eval:run` and writes to `jobs` and `raw_jobs`. Recommended: yes, after confirming they are no longer run by hand.
- [ ] **Interfaces.** Keep Streamlit and the HTTP API; freeze the desktop app and the React page until jobs flow. Recommended: yes.
- [ ] **Single user.** Stop adding multi-workspace and approval machinery; keep the columns. Recommended: yes. People who fork the repo each run one workspace.
- [ ] **Rules as data.** Move title, sector and threshold lists into config files the owner can edit without a code change. Recommended: yes, in Phase 4.
- [ ] **Way of working.** One agent owns the restructuring as a single stream of small pull requests merged daily, with no stack deeper than two. Recommended: yes. Parallel agents are what produced the long-lived stacks.

One limit of this review: I read the code and its history, not the production database. Row counts and production figures quoted here come from the agent's reports.
