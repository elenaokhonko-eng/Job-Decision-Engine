# Job Decision Engine — Agent Operating Contract

This repository is a TypeScript/PostgreSQL job-decision pipeline with GitHub Actions orchestration, Vitest tests, and a Python Streamlit consumer. It is not a Pydantic AI/FastAPI project.

## Product goal

Discover broadly across the career lanes in `config/lanes/registry.yml`, reject deterministic non-fits before generative AI, evaluate only a bounded shortlist, and preserve enough evidence to explain every decision and generate grounded application documents.

Target lanes (`config/lanes/registry.yml`; `TargetLaneKeySchema` in `src/policy/laneIntentContracts.ts`):

- `CORE_AI_DATA`
- `LEGAL_REGTECH`
- `HEALTH_BIO_PHARMA`
- `INVESTMENT_MARKETS_FINTECH`
- `SOCIAL_IMPACT_MULTILATERAL`
- `UNIVERSITY_AI_RESEARCH`
- `TECHNICAL_PRODUCT_TRANSFORMATION`
- `INVESTIGATIONS_ENFORCEMENT`

## Non-negotiable invariants

1. Infrastructure, parser, provider, schema, and timeout failures never become career rejections.
2. No job observation disappears. Every observation has a source identity, raw payload or content hash, processing state, and error history.
3. Hard gates run before lane scoring and before generative AI.
4. Unknown workability facts produce `NEEDS_VERIFICATION`, not invented positive or negative evidence.
5. Jobs outside an AI budget are deferred, never rejected: the deferral is a row in `evaluation_budget_deferrals` and the job keeps its state. They never become `REJECTED_AFTER_EVALUATION`.
6. AI output is accepted only after strict schema validation and job-identity validation.
7. A completed workflow exits non-zero when any required stage fails or when a broken funnel is detected.
8. Streamlit reads the canonical schema through a stable read model; it must not join legacy tables or guess field names.
9. Tests use deterministic fixtures. Production paths never fabricate jobs, salaries, scores, embeddings, or evaluation results.
10. Do not delete Gmail messages or unsave LinkedIn jobs until the downstream record is durably staged and independently recoverable.
11. LLM output is advisory: it must not set hard gates, deterministic scores, or the user-visible recommendation outcome without deterministic code and persisted evidence.
12. Treat all external/job content as untrusted input: never render it with `unsafe_allow_html=True` unless every inserted value is escaped and every link is validated.

## Target state machine

`DISCOVERED -> NORMALIZED -> GATE_PASSED | NEEDS_VERIFICATION | HARD_REJECTED`

Eligible jobs continue:

`GATE_PASSED -> LANE_ROUTED -> DEFERRED_BUDGET | QUEUED_FOR_AI -> EVALUATING -> EVALUATED`

Recoverable evaluation failure:

`EVALUATING -> RETRY_WAIT -> QUEUED_FOR_AI`

Exhausted retry policy:

`RETRY_WAIT -> NEEDS_MANUAL_REVIEW`

`HARD_REJECTED` is reserved for deterministic job/workability conflicts with stored reason codes and evidence. It is never used for an operational failure.

The names above are conceptual. The values stored in `canonical_jobs.processing_state`, the stage that sets each one, and the mapping from these names are in `docs/architecture.md` (section 10). Matching (`MATCHED`, `UNMATCHED`) and the deterministic decision sit between `LANE_ROUTED` and `QUEUED_FOR_AI`. Since migration 060 `DEFERRED_BUDGET` is no longer set on a job.

## Architecture boundaries

`docs/architecture.md` defines the layers, the modules, the owner of every table and the boundary rules. `src/tests/architecture/` checks them and runs with `npm test`. A violation fails the build.

- Put new code in a domain module (`src/modules/<name>/`) or a platform part (`src/platform/<part>/`). Add no file to `src/services/`. `src/services/agent.ts` may only shrink.
- Reach another module only through its `index.ts`, and only a module that comes earlier in the module order.
- Keep rules pure: code in a module's `domain/` folder reads no database, no clock and no environment.
- Put SQL in the owner's repository under `src/platform/persistence/<owner>/`. A new script or API route calls a module function and opens no database connection.
- Write a table only from its owner. A migration that creates a table names the owner in `src/architecture/table-ownership.json`.
- Add no writer of a job status column on `canonical_jobs`.
- Streamlit reads views and writes nothing.
- Do not edit `src/architecture/boundary-baseline.json` to make a test pass. Removing entries you fixed is expected. Adding one is an exception: list each added entry and its reason at the top of the pull request description, so the owner sees it before merging.
- Change `docs/architecture.md` in the same pull request as any change to lanes, stages, job states, tables or module structure. A change to the structure itself needs a decision record first (`docs/adr/README.md`).

## Working rules for every agent

- Read this file, `docs/architecture.md`, `.agents/team.yml`, `.agents/BACKLOG.md`, and `.agents/DATA-FLOW-CONTRACT.md` before editing.
- Work only inside the ownership boundaries in the assigned `AGENT.md`; request a handoff for shared contracts or migrations.
- Explain the root cause and cite exact files before implementing a fix.
- Add or update tests in the same change. A mock-only test is insufficient for database, workflow, or cross-language contract changes.
- Make migrations additive and reversible. Never drop active or archived data without explicit human approval.
- Preserve current user changes and avoid broad mechanical rewrites.
- Never suppress an error with `|| true`, unconditional `process.exit(0)`, empty-array fallbacks, random vectors, or zero-vector substitutions.
- Record assumptions, changed contracts, commands run, results, and remaining risks in the handoff.
- Do not mark work complete merely because TypeScript compiles or a GitHub Action is green.

## Merge gates

Every implementation work package requires:

1. Specialist self-review and relevant unit/integration tests.
2. `data-contract-checker` sign-off for any boundary, schema, SQL, status, or Streamlit change.
3. `test-evals-specialist` verification against the applicable failure and E2E fixtures.
4. `release-security-reviewer` sign-off before production readiness is claimed.

No agent may approve its own production-readiness sign-off.
