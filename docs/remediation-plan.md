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
