# Job Decision Engine Remediation Plan

Status: Approved for incremental implementation

Decision: the desktop application will use a managed remote API plus an authenticated desktop client. The packaged desktop client will not assume that it owns the database, provider credentials, or a local worker.

## Root cause

The pipeline's main failure is not primarily an overly strict deterministic or semantic threshold. Stage completion is not equivalent to a current, valid artifact. Dependency-blocked work can be marked completed, completed task keys can prevent recreation, historical profile/match/evaluation artifacts are treated as current, and profile/preference changes do not consistently invalidate downstream work.

The audit snapshot contained 1,064 canonical jobs, 192 gate-passed jobs, only one completed match using the active profile, and historical AI evaluations predating the active profile. This explains green workers with no trustworthy current recommendations.

## Initial implementation wave

Completed in the working tree:

- saved this plan as the project remediation record;
- added explicit `BLOCKED_DEPENDENCY` task and attempt states with prerequisite wake-up;
- added task context fingerprints and context-aware task identity migrations;
- tightened requirement extraction currentness so legacy runs without the active requirement set do not satisfy prerequisites;
- persisted matching provenance (active requirement set, job content hash, and context fingerprint) and made PASS decisions reject stale/legacy matches;
- replaced the legacy one-active-evaluation-per-job queue constraint with context-scoped identity and quarantined stale/unprovable active queue rows;
- added a read-only `pipeline:reconcile` inventory with current requirement, match, decision, and evaluation counts plus repair samples;
- bound AI queue/evaluation eligibility to the current profile, match run, deterministic decision, and job content, and removed the fixed in-code profile from the production single-job evaluator path;
- removed the fixed in-code candidate profile entirely, required explicit database-backed context for the legacy agent harness, and retired the legacy `/api/ask` evaluator;
- added workspace-scoped canonical read models with explicit stale/blocked artifact status, and removed Streamlit's direct legacy-table join and localhost API default;
- made client-side currentness defaults fail closed (`CURRENTNESS_UNKNOWN`) when a boundary omits provenance status;
- added resolved workability-policy preview before preference-mode activation;
- normalized the actual Streamlit `hard_constraints` preference payload, including zero and false values;
- changed the packaged desktop architecture to an authenticated main-process bridge for the managed remote API;
- kept the desktop bearer token inside Electron main-process OS storage, exposed only token-configured status to the renderer, and cleared the token from renderer state after save;
- removed the packaged desktop's implicit loopback API fallback; installed clients now require an explicitly configured managed HTTPS endpoint;
- enforced HTTPS for packaged non-loopback API endpoints and relative Vite asset URLs.
- made worker cancellation lease-safe: interrupted tasks return to `RETRY_WAIT` with an attempt record instead of remaining invisibly `RUNNING` until lease expiry;
- closed the post-claim cancellation race so an abort cannot strand a newly claimed task before the release handler runs;
- made the application handoff API enforce the same current-artifact and deterministic-eligibility contract as the desktop UI;
- added before/after read-only reconciliation artifacts to the backlog workflow so a failed or cancelled drain leaves a durable funnel diagnosis;
- validated the complete migration chain and new read-model plans on `pgvector/pgvector:pg16`; plain PostgreSQL images without the `vector` extension are unsupported;

## Follow-up reliability wave

- prevented recovery seeding from completing recommendation/explanation tasks before a current match and deterministic decision exist;
- included the live job content, requirement set, match-run, and deterministic-decision identities in downstream task context fingerprints so stale completed tasks cannot suppress current successors;
- required the deterministic recommender to reject match artifacts with missing canonical identity or missing provenance context;
- serialized ingestion and backlog-drain workflows under one non-canceling GitHub Actions concurrency group, preventing an active leased worker from being terminated by a newer dispatch;
- made the evaluation queue workflow non-canceling as well, allowing its leased rows to finish or be reclaimed deliberately;
- made the evaluation pickup query fail closed unless queue, match, decision, job-version, and context provenance all agree;
- preserved native OS-backed API tokens when saving unrelated desktop settings, while adding an explicit clear-token action;
- reran the full TypeScript suite, desktop packaging checks, production build, workflow lint, and static checks after this wave;

Production recovery, managed API onboarding, cold-install verification, provider calibration, and the required independent reviews remain release-blocking until completed.

## Implementation order

### P0: containment and recovery safety

1. Preserve the database and run a read-only inventory before replaying work.
2. Add a resumable reconciliation report that classifies every job version and task as current, runnable, dependency-blocked, stale, awaiting verification/consent, retrying, paused, or manual review.
3. Do not bulk-reset deferred, verification, rejected, or historical evaluation rows.

### P1: artifact currentness contract

Additive schema and runtime contracts must identify the actual context of every artifact: workspace/user, job version and content hash, active requirement set/run, profile version, workability and lane policy versions, embedding space/model, matcher version, decision policy snapshot, and evaluation prompt/schema/route versions.

Outputs and task identities must carry a deterministic context fingerprint. Historical artifacts remain preserved but cannot satisfy a current dependency.

### P1: dependency-safe task lifecycle

Missing prerequisites must produce an explicit dependency-blocked disposition, not `COMPLETED`. The worker must release its lease, enqueue or awaken the prerequisite, and only resume the dependent stage after a valid artifact exists. Valid empty requirement sets must be distinguishable from missing or stale extraction artifacts.

Stale gate tasks may be safely ignored only when a current gate artifact exists. Task completion must verify the stage postcondition.

### P1: profile and preference invalidation

Profile activation, requirement changes, and workability preference changes must preserve historical evidence while invalidating affected current artifacts and seeding new context-specific work.

Normalize the actual preference UI payload, including zero values, `false` values, remote-only modes, travel, office days, on-call, shifts, and employment types. Show the resolved policy before activation.

### P1: grounded AI evaluation

AI evaluation must use an immutable database-backed context containing active verified profile facts, selected lanes, workability rules, requirement evidence, current deterministic match/decision, consent, and all policy/model/schema identifiers. Fixed in-code candidate profile data must not determine production evaluation.

### P2: reconciler and workflow hardening

Workers must consume reconciled work. Add stage-specific preflight, shared effective provider configuration, deadlines distinct from request timeouts, independent lease heartbeats, bounded retries with jitter, circuit breakers, atomic output/successor commits, and workflow summaries based on distinct current jobs rather than handler counts.

### P2: Streamlit and desktop

Streamlit must display the canonical current read model, including stale and blocked reasons. The desktop client must use an authenticated remote API through a secure main-process/IPC bridge or same-origin managed API, with no disabled browser security. Add packaged relative asset loading, pagination, recovery actions, onboarding for API/auth/workspace, and cold Windows installation tests.

### P3: provider and embedding calibration

Do not change embedding providers before pipeline correctness is restored. Benchmark OpenAI, Gemini, and any third-party candidate on a fixed labelled regression set for recall/precision, latency, cost, rate limits, and failure recovery. Every embedding model/space change must invalidate and re-publish dependent artifacts. Random or zero-vector fallbacks remain prohibited.

## Safe recovery sequence

1. Apply additive schema and worker changes.
2. Run reconciliation in dry-run mode.
3. Review the repair report.
4. Repair a small stratified batch, including a known-positive fixture.
5. Reconcile again and verify idempotency.
6. Repair deterministic requirements and current-profile matches for gate-passed jobs.
7. Recompute deterministic recommendations.
8. Evaluate only current eligible jobs with valid consent.
9. Run two no-change reconciliation passes.
10. Generate documents only after current shortlist and evidence validation.

## Required release evidence

- no current eligible job has an unexplained missing dependency;
- no completed task lacks its required current artifact;
- profile and preference changes propagate while history is preserved;
- reruns and interruption/restart are idempotent;
- a known-positive fixture reaches a grounded recommendation;
- Streamlit and desktop display the same canonical current read model;
- disposable-Postgres failure-injection tests pass;
- data-contract, test/evaluation, and independent security reviews are complete.

## Implementation handoff — 2026-09-10

Completed work packages in this working tree:

- P0-04/P0-05 reliability containment: dependency-blocked tasks, cancellation-safe lease release, context-aware task identity, reconciler, and non-canceling workflow serialization;
- P0-06/P0-07 evaluation boundary hardening: database-backed profile context and current queue/match/decision provenance checks;
- P0-09 read-model/desktop consumer boundary: scoped currentness view, fail-closed contracts, Streamlit API/read-only fallback, and managed remote desktop API bridge;
- P1 profile invalidation support: active-profile rematch seeding and stale evaluation queue quarantine;
- P2 desktop security containment: main-process OS token storage, HTTPS enforcement for packaged remote endpoints, and explicit token clearing.

Validation completed:

- `npx vitest run`: 67 files passed, 7 skipped; 255 tests passed, 35 skipped;
- `npm run lint`: passed;
- `npm run build`: passed;
- `npm run desktop:verify`: 54 checks passed;
- Electron `main.cjs` and `preload.cjs` syntax checks: passed;
- `docker run ... rhysd/actionlint:latest -color`: passed;
- `git diff --check`: passed;
- all 51 migrations applied and rerun idempotently on disposable `pgvector/pgvector:pg16`; reconciliation script executed successfully there.

Assumptions and remaining owners:

- No production Neon migration, reconciliation, repair, consent grant, or provider call was performed from this workspace. The database owner must apply migrations 039–044, run `npm run pipeline:reconcile -- --json`, review the report, and execute the staged recovery sequence.
- Python/Streamlit syntax and browser E2E were not executable locally because the available Windows Python command is only the inaccessible Microsoft Store alias. `streamlit_e2e.yml` remains the validation owner for that boundary.
- The `data-contract-checker`, `test-evals-specialist`, and `release-security-reviewer` still owe independent sign-off before a production `GO` is claimed.
- Provider/embedding selection remains a calibration task after currentness recovery; no model switch is justified by the original failure logs alone.

## Historical production execution checkpoint — 2026-09-10 (superseded below)

- Read-only connectivity to the configured Neon database succeeded (`neondb`, `neondb_owner`).
- The pre-migration reconciliation stopped as expected because `match_runs.requirement_set_id` is not yet present.
- The workspace currently has only a pooled connection (`-pooler`) and no `DATABASE_URL_UNPOOLED`.
- The local Neon CLI profile exists but its OAuth session refresh failed. Migrations are therefore intentionally paused until a direct connection string is supplied or Neon CLI authentication is renewed.
- No production write has been performed in this execution pass.

## Production execution checkpoint update — 2026-09-10

- Direct Neon connectivity is now verified through `DATABASE_URL_UNPOOLED`; the database reports `neondb` and user `neondb_owner`.
- Production migrations 039–044 were already present; additive migration 045 was applied successfully to remove the legacy four-column deterministic-decision uniqueness constraint. All 52 migrations also applied twice on disposable `pgvector/pgvector:pg16` (`52`, then `0`).
- The worker now supports `PIPELINE_TASK_WORKER_TASK_TYPES` and `PIPELINE_TASK_WORKER_SEED`, allowing deterministic-only recovery without invoking provider-backed stages.
- Production recovery exposed and fixed two lifecycle defects: dependency blocking no longer violates `pipeline_tasks.available_at NOT NULL`, and decision tasks now fence stale job versions and block when a current match is missing.
- Production reconciliation after recovery: 1,144 canonical jobs; 326 current requirement sets; 16 current matches; 16 current deterministic decisions; 0 current evaluations; 0 active evaluation queue items; 30 dependency-blocked tasks; 7 retry-wait tasks; 2 historical dead-letter tasks.
- Model route preflight passed for evaluation, extraction, document generation, and embedding. No provider-backed production recovery or AI evaluation was run from this workspace.
- Production has no `allow_ai_evaluation` consent row, and the managed API endpoint/token are not configured locally. These are the remaining authorization and deployment gates before the full AI/API/desktop E2E test.
- Latest validation: 67 Vitest files passed (256 tests), TypeScript lint passed, production build passed, desktop packaging verification passed (54 checks), actionlint passed, and `git diff --check` passed.

Next authorized release steps: grant `allow_ai_evaluation` through the authenticated consent path, configure the managed HTTPS API endpoint and token, run the provider-backed embedding/quoted/lane stages in bounded batches, process the current evaluation queue, run two no-change reconciliations, then verify Streamlit and the authenticated desktop client against the same current read model. Do not claim E2E readiness until all of those checks pass and the three independent reviews sign off.

## Deterministic policy and recovery checkpoint — 2026-09-10

The workability policy is now configurable through the YAML default and the active database preference mode. The current production profile resolves to Singapore authorization, accepts hybrid postings without an exact office-day count, accepts remote postings without a stated territory, rejects explicit foreign-only territory requirements, and treats unqualified work-authorization language as non-blocking. Experience, degree, credential, and authorization facts are persisted in the active profile ledger rather than inferred from free-form prose.

The pre-AI recovery was executed against production after importing the active profile. It repaired the prior provider-failure, gate-null, legacy budget-cap, raw-staged hard-reject, and stale-task cases; replayed current review candidates; republished embeddings; rerouted deferred jobs; rematched current-profile lane results; and repaired missing deterministic outcomes. The final read-only reconciliation reported:

- 1,333 canonical jobs: 745 `HARD_REJECTED`, 52 `MATCHED`, 103 `ROUTING_DEFERRED`, and 433 `NEEDS_VERIFICATION`.
- Every hard rejection has a persisted reason and `SKIP` outcome; every verification and routing-deferred job has a persisted deterministic outcome.
- 155 gate-passed jobs have current deterministic requirements and downstream deterministic outcomes: 52 current profile matches plus 103 intentional semantic routing deferrals.
- No raw-staged jobs, canonical manual-review states, budget-cap remnants, missing hard-reject reasons, blocked tasks, retrying tasks, or dead-letter tasks remain.
- 421 verification records are genuinely missing workplace/office-day evidence (`workplace_type=UNKNOWN` and no reliable work-mode text); they are not failed hybrid-without-day-count decisions. Nine are experience evidence mismatches, one is a credential mismatch, one is a degree mismatch, and one combines degree and experience mismatches.
- 138 pending and one expired-running `EXTRACT_QUOTED_REQUIREMENTS` tasks remain as optional enrichment debt. They do not gate deterministic embeddings, routing, matching, decisions, or AI eligibility and were intentionally excluded from the final provider-backed E2E.
- No provider-backed AI evaluation was enabled or run. The single historical evaluation-queue quarantine row remains inactive and has no current profile/match/decision context.

Validation for this checkpoint: `npx tsc --noEmit`; `npx vitest run` (67 files passed, 7 skipped; 263 tests passed, 36 skipped); `git diff --check`; and production `scripts/reconcile_pipeline.ts --json` all passed. The local Python command remains unavailable because Windows exposes only an inaccessible Microsoft Store alias, so Streamlit browser/runtime validation remains a deployment workflow responsibility.

Next owner: deploy the code and Streamlit changes, obtain the independent data-contract/evaluation/security reviews, configure the managed HTTPS API and authenticated desktop token path, grant `allow_ai_evaluation`, then run the provider-backed E2E. Until those steps are complete, the safe re-test is deterministic/pre-AI only; do not expect generated documents or provider-backed recommendations.

## Current production remediation checkpoint — 2026-09-11

The additive migration set is applied in production through migration 045 and remains idempotent. The corrected deterministic policy was replayed against 405 verification jobs (v4 replay), and the currentness-aware matcher recovery repaired 11 stale requirement-set matches. Read-only reconciliation now reports:

- 1,333 canonical jobs: 772 `HARD_REJECTED`, 52 `MATCHED`, 404 `NEEDS_VERIFICATION`, 103 `ROUTING_DEFERRED`, and 2 `PREQUALIFIED`.
- 157 jobs passed deterministic gates. Of those, 52 have current active-profile matches and current deterministic decisions; 103 are intentional routing deferrals; 2 are waiting for provider-backed lane routing.
- Current requirements: 722; current matches: 52; current deterministic decisions: 52; current evaluations: 0.
- No stale/unprovable matches, blocked tasks, retrying tasks, or dead-letter tasks remain. 114 pending tasks are optional `EXTRACT_QUOTED_REQUIREMENTS` enrichment; they do not gate deterministic matching or evaluation eligibility.

The 103 routing deferrals are not 103 semantic failures. All 103 have lane scores, but every job is blocked in at least one lane by function alignment and domain alignment: 401 function-blocked lane rows, 329 domain-blocked rows, and 55 semantic-threshold-blocked rows across 412 lane diagnostics. Only 24 jobs have a semantic blocker in any lane. The dominant combinations are domain+function (267 lane rows), function-only (79), and semantic+domain+function (51). The evidence is persisted in `canonical_jobs.lane_evidence`; it is recoverable by rerunning provider-backed embeddings/routing after the provider authorization gate is satisfied.

The embedding audit found no job-vector outage: all 103 deferred jobs have a persisted Gemini `gemini-embedding-001` vector, and 12 also have an OpenAI `text-embedding-3-small` fallback vector. The missing artifact is the four Gemini lane-prototype vectors; all four OpenAI lane prototypes are present. Consequently, the configured Gemini-first router would call an external provider to rebuild prototypes before it can safely reroute. This is why the recovery is paused at the explicit provider-data authorization boundary.

The 404 verification cases are likewise not all workplace cases. Current reason counts are: 397 missing authoritative work-mode/office-day evidence, 6 experience-year comparisons needing verification, and 1 degree comparison needing verification. Of the 397 workability cases, 149 also lack a structured location and 310 have descriptions shorter than 300 characters. The 12 remote and 1 hybrid textual mentions are mostly jobs whose remaining blocker is experience; the four onsite mentions are retained as evidence for inspection. The parser now accepts hybrid without an exact office-day count, recognizes explicit remote/onsite headings, and recognizes dotted territory labels such as `U.S.`. A job is not rejected merely because work mode is unknown; that remains `NEEDS_VERIFICATION` under the evidence-preservation invariant.

The seeder now accepts stage-scoped recovery. A deterministic-only worker no longer creates unrelated provider tasks, and matching recovery checks the complete currentness tuple: canonical job, job version, active requirement set, content hash, active profile, completed status, and context fingerprint.

The managed retest gate is available as `npm run e2e:retest-gate` and as the manual `Managed API Desktop E2E Retest Gate` workflow. It is read-only and fail-closed. It requires a public HTTPS `JDEC_API_BASE_URL`, `JDEC_API_TOKEN`, `WORKSPACE_KEY`, `WORKSPACE_USER_KEY`, authenticated API health, granted `allow_ai_evaluation`, no mandatory task backlog, no prequalified jobs, and no unexplained currentness gaps. It does not start AI evaluation or provider calls. At this checkpoint it is correctly red because the managed API credentials and consent are not configured and two jobs still await provider-backed routing.

Remaining authorized production steps: explicitly authorize the bounded transfer of production job-description embedding inputs to the configured primary/fallback embedding providers; run `PUBLISH_EMBEDDING` and `ROUTE_LANE` for the two prequalified jobs and the approved routing-deferred recovery batch; reconcile twice; configure the managed API deployment secrets; grant consent through the authenticated consent endpoint; run the managed gate; then run provider-backed evaluation and document generation only after the independent data-contract, evaluation, and security reviews sign off.

## Provider recovery and consumer verification checkpoint — 2026-09-11

- The two prequalified jobs were processed through Gemini-backed lane routing. Both produced durable `ROUTING_DEFERRED` / `ROUTING_POLICY_NO_MATCH` outcomes with no worker failures.
- All 105 routing-deferred jobs (the original 103 plus the two newly routed jobs) were replayed through fresh, versioned `ROUTE_LANE` task identities. The three bounded worker runs completed 105/105 tasks with zero failures, dependency blocks, retries, or dead letters.
- The worker now supports explicit `PIPELINE_TASK_WORKER_INCLUDE_ROUTING_DEFERRED=true` recovery and `PIPELINE_TASK_WORKER_ROUTING_DEFERRED_REPLAY_VERSION` task identity versioning. Normal scheduled drains remain conservative and do not replay deferred jobs unless explicitly enabled.
- Two consecutive read-only reconciliations were stable: 1,333 canonical jobs; 772 hard rejected; 404 needing verification; 105 routing deferred; 52 current matches and decisions; 0 current evaluations; 0 blocked/retrying/dead tasks; and no current-match gaps.
- The 14 mandatory deterministic decision tasks were drained successfully. The remaining 112 pending tasks are optional quoted-requirement enrichment.
- The Streamlit browser smoke path reached the production-backed canonical read model using the project virtualenv and produced an accessibility snapshot. The E2E launcher now loads dotenv configuration, prefers `PYTHON_BIN`/`.venv`, and handles Windows `.cmd` process launch correctly. Desktop packaging verification passed 54/54 checks.
- The managed retest gate now has only the external deployment/authorization blockers: managed HTTPS API base URL/token/workspace credentials and authenticated `allow_ai_evaluation` consent. Provider-backed evaluation and document generation remain intentionally disabled until those gates and independent reviews are complete.

## Workflow failure audit and database preflight checkpoint — 2026-09-11

The post-release GitHub notifications were reviewed against the public Actions run history. The latest commit (`286e195`) is green for Job Decision Engine CI, CodeQL, and full-history secret scanning. The failures on the preceding release commit (`a43a486`) had two separate causes:

- `Job Decision Engine CI` failed in the real-PostgreSQL queue reliability and nine-email E2E assertions. Those failures were corrected in `a43a486` and the following `286e195` CI run passed.
- `Job Discovery Ingestion`, `Process Discovery Backlog`, and `Evaluation Queue Worker` all failed at their first database-migration step. Their ingestion, backlog, and evaluation work therefore never started. The common failure is the production migration connection contract: migrations require a direct Neon URL, while the application `DATABASE_URL` may be pooled. `queue_worker.yml` and the ingestion process job also failed to pass `DATABASE_URL_UNPOOLED` at all.

The permanent code fix adds `scripts/preflight_database.ts`, which validates the direct/unpooled URL, rejects a pooler URL with an actionable message, and performs a TLS-verified `SELECT` identity check before migrations. All production migration steps now pass both database secrets and run this preflight. The preflight, workflow contract, TypeScript, full Vitest suite, build, contract export, and actionlint checks pass. The configured production connection currently passes the preflight and reports zero unapplied migrations.

The remaining operational action is repository configuration, not a code workaround: configure GitHub Actions secret `DATABASE_URL` for the runtime pooler URL and `DATABASE_URL_UNPOOLED` for the direct Neon URL. Do not put Gemini/OpenAI keys in either field. Once those two secrets are present, rerun ingestion/backlog/evaluation workflows; the new preflight will identify any remaining endpoint or TLS issue before work is claimed.

## Source-quality and routing semantics remediation checkpoint — 2026-09-11

Migration `046_quality_routing_and_match_dispositions.sql` is applied to production. It adds additive, auditable fields for description quality, routing disposition, and grounded profile-match status. A description shorter than the configurable 1,000-character completeness floor is now recorded as `INCOMPLETE` with a reason; it is source/enrichment debt, never an automatic career rejection.

The bounded production source-enrichment pass examined the incomplete verification backlog. It staged 10 enriched observations and created deterministic extraction work for them. Five newly enriched versions reached deterministic gating: four were hard-rejected with persisted gate codes and one remains `NEEDS_VERIFICATION` for office-day evidence. No source fetch failed. The remaining 300 incomplete verification records were not silently rejected: most require an authenticated LinkedIn/Gmail source fetch or returned content below the completeness floor. Local Gmail re-ingestion is currently blocked by missing `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, and `GMAIL_OAUTH_REFRESH_TOKEN`; the read-only command now reports that exact cause and made no mailbox changes.

Routing semantics are now explicit. All 105 current routing holds have `routing_disposition = POLICY_NO_MATCH`, meaning the four-lane policy was evaluated successfully and no lane qualified; they are not embedding/provider failures and normal routing replay excludes them. Technical/provider failures use `TECHNICAL_DEFERRED`. The lifecycle value `ROUTING_DEFERRED` remains for compatibility, while the disposition is the authoritative explanation until a future state-contract migration introduces a separate terminal lifecycle state.

Zero-evidence completed match runs are no longer counted as current matches, deterministic decisions, or AI-ready inputs. Production reconciliation now reports 0 current positive matches and 0 current AI decisions; the former 52 completed runs have `matched_count = 0` and `profile_match_status = NO_PROFILE_MATCH`. This is fail-closed and prevents document generation from treating an empty evidence comparison as a recommendation.

Quoted-requirement extraction remains optional enrichment. Normal deterministic gate, embedding, routing, matching, and decision task paths no longer enqueue it implicitly. It can be drained later with an explicit quoted-requirements worker after higher-priority work is complete.

Post-remediation production reconciliation: 1,333 canonical jobs; 780 `HARD_REJECTED`, 396 `NEEDS_VERIFICATION`, 105 `ROUTING_DEFERRED` with policy-no-match disposition, and 52 legacy `MATCHED` rows whose runs are now correctly classified as zero-evidence. There are 729 current requirement artifacts, 0 current positive matches, 0 current deterministic decisions, 0 current evaluations, no stale positive matches, no blocked/retrying/dead tasks, and one `RUNNING` task subject to the normal lease-recovery mechanism. The managed retest gate now has zero mandatory pending tasks; 107 pending tasks are quoted-requirement enrichment only. TypeScript lint passed, the full Vitest suite passed (72 files, 282 tests; 7 files skipped for unavailable integration infrastructure), and the focused remediation suite passed (55 tests).

This checkpoint does not claim managed E2E readiness. Provider-backed rerouting/evaluation, authenticated consent, managed HTTPS API credentials, Streamlit production verification, desktop verification, and independent data-contract/evaluation/security reviews remain release gates.
