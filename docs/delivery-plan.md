# Delivery plan

This plan says what is being built now, by which workstream, and in what order it reaches `main`. It changes often. The structure it builds towards is in [architecture.md](architecture.md) and does not change without a decision record.

Last updated: 23 November 2026.

## Goal for this round

The owner can test the engine end to end: fresh postings come in, closed postings drop out, the right jobs reach Review and Apply Now, and a blind review of 30 jobs passes. Processing is then restarted.

The restructuring phases in [architecture.md](architecture.md), section 15, continue in parallel only where they do not touch the same files.

## What can run in parallel

Six workstreams can run at the same time, because each owns different files. Four phases cannot start yet, because they rewrite the files the workstreams are changing.

| Stream | Purpose | Can start | Blocks the blind review |
|---|---|---|---|
| W1 Availability | Postings that close drop out; unknown facts resolve or expire | Now | Yes |
| W2 Lanes | Jobs that fit a lane get one | Now | Yes |
| W3 Scoring and calibration | Downranks, cut-offs, rehearsal tooling, the review sheet | Now; its last steps wait for W1 and W2 | Yes |
| W4 Sourcing | Alerts, snippets, aggregators, more employer boards | Now | No, but it decides volume |
| W5 Model gateway (Phase 1) | Model code out of `src/services/agent.ts` | Now | No |
| W6 Evaluation quality (part of Phase 2) | Posting cleaning, benchmark in CI, prompt inventory | Now | No |

Not started this round:

| Phase | Why it waits |
|---|---|
| Rest of Phase 2 (prompt registry, `evaluation` module) | Needs the gateway from W5 |
| Phase 3 (one writer per decision) | Rewrites the gate, router, matcher and decider, which W1 to W3 are changing. Includes one read model that assigns each job to exactly one list with the reason, so no screen applies its own filter. Availability, list ordering and staleness of kept results were all the same gap (each list had its own filter). Do not build it before the restart |
| Phase 4 (pure stages, one recompute command) | Follows Phase 3 |
| Phase 5 (persistence), Phase 6 (concept graph), Phase 7 (retire and shrink) | Follow Phase 4 |

## Rules for working in parallel

1. **One owner per hot file.** These files cause most merge conflicts. During this round only the named stream edits each one. Another stream that needs a change asks the owner stream to make it.

   | File | Owner stream |
   |---|---|
   | `src/tasks/stageTaskWorker.ts`, `src/tasks/pipelineTasks.ts` | W1 |
   | `src/pipeline/laneRouter.ts`, `config/lanes/` | W2 |
   | `src/pipeline/recommendationDecider.ts`, `src/pipeline/deterministicMatcher.ts` | W3 |
   | `src/ingestion/`, `scripts/run_adapters.ts`, `scripts/parse_emails.ts` | W4 |
   | `src/services/agent.ts`, `src/services/llmFallback.ts`, `src/services/modelCallResilience.ts` | W5 |
   | `src/security/`, `src/reporting/` | W6 |
   | `scripts/reconcile_pipeline.ts`, `scripts/check_integrity.ts`, `src/tasks/completedWithoutResult.ts`, and the zero-check modules once merged (the integrity zero-check and repair modules in `src/tasks/`) | W10 (the zero-check stream; it took these over from W1 and W7) |
| `src/tasks/availabilityRecheck.ts`, `src/tasks/pipelineTaskCurrentness.ts`, `src/services/jobArchive.ts` | W1 stream (carried by W10 while W1 has no budget) |
| `src/architecture/boundary-baseline.json`, `docs/architecture.md` | W5 |
| `.agents/DATA-FLOW-CONTRACT.md` | Append-only for every stream: add your own row, never edit another stream's row; on a conflict keep both sides |
| `package.json`, `package-lock.json`, `.github/workflows/` | Orchestrator only |

2. **Reserved migration numbers.** The latest migration on `main` is 120 (118 prompt identity columns, 119 availability re-check state, 120 awaiting-content read model). 115 to 117 are unused and stay unused (see `migrations/README.md`). The next free number is 121, reserved for W3's adjusted-score read model. A stream that needs a number asks the orchestrator; CI rejects any pending number at or below the highest applied one.
3. **One database copy per stream.** Each stream rehearses on its own Neon branch, named `replay-<stream>`. Two streams never write to the same copy. No stream reads or writes production.
4. **Small pull requests to `main`.** No stack deeper than two. Rebase on `main` every day. Each report names the CI status of every pull request it mentions.
5. **A builder never signs off its own work.** Sign-off comes from the reviewer roles in `.agents/team.yml`: `data-contract-checker`, `test-evals-specialist`, `database-versioning-engineer`, `release-security-reviewer`.
6. **The boundary check applies to everyone.** New code follows [architecture.md](architecture.md), section 6. An exception is listed with its reason at the top of the pull request description.
7. **A stage's version changes when its output changes.** Any change to what a stage produces (gate, extractor, matcher, lane router, decider, role-shape rules) changes that stage's version, so the version-reopen mechanism re-runs the affected jobs. `data-contract-checker` does not sign off a pull request that changes behaviour without a version change. Two faults of this kind reached `main` (the extractor input in #244, the degree rule in #247).
8. **Merge lists carry evidence.** Every line the orchestrator sends the owner for merging states that CI is green and which reviewer roles signed off. A pull request without both is not on the list.
9. **Standing limits.** Processing stays paused. No production write without the owner's go-ahead and the exact command. No secrets, connection strings or profile data in output, fixtures, logs or pull requests. Job titles and employers from the owner's saved list stay out of the repository.

## The orchestrator

One agent, the `delivery-orchestrator` role, does no feature work. It:

- keeps this file current and hands out migration numbers;
- owns `package.json`, the lock file and the workflows;
- watches for two streams touching the same file and stops the second;
- sends the owner one combined report a day: what merged, what is waiting on the owner, CI status;
- closes stale pull requests and merged branches.

## W1 Availability

**Outcome:** a closed posting leaves every list within 10 days without anyone acting, and no job waits on the owner unless it is worth applying to.

Deliver, as small pull requests:

1. A `RECHECK_AVAILABILITY` task type that runs through the normal queue when a job's 7-day window expires.
2. One posting read per re-check that re-evaluates three facts: open or closed, work mode, hiring territory.
3. Closure on evidence only: the page says not found or no longer accepting, or the feed was read successfully and the job is absent on two readings in a row. The absence count is stored (migration 119). A failed read is "cannot tell".
4. "Cannot tell" is retried up to 3 times over 3 days, then the job is archived as not confirmable. Paywall and login pages count as "cannot tell". Page checks are rate-limited per site.
5. The Track list reads `availability_current`, like Review.
6. Unknown facts: routable unknowns always continue to matching; a question reaches the owner only for a job in the top 20; a job unresolved for 28 days and never in the top 20 is archived as not confirmable.
7. The reconciler reports "task completed, no result" as an error.

Prove before merge, on `replay-w1`:

- After a re-gate, the normal worker (`scripts/process_pipeline_tasks.ts`) carries every routed, routable job to a match run and a decision. None is stranded.
- Counts before and after: hidden at day 7, re-checks queued, archived, restored.

Done when: the lists on a refreshed copy contain no job whose posting is closed, and the hidden count plus the visible count equals the total.

## W2 Lanes

**Outcome:** a job that fits a lane by meaning is not refused a lane because a title word is missing.

Deliver:

1. Re-route the jobs that an older router version left with only a no-match marker, and say how production re-routes them at restart.
2. Measure two options on the owner's saved jobs and on known non-fits, offline, using the pure routing function. Report for each how many saved jobs gain a lane and how many non-fits gain one.
   - Option A: when the semantic score is clearly above the bar, a zero title or domain score lowers confidence and does not veto.
   - Option B: keep the veto and widen the title allow-list.
3. Build the option the owner chooses, with fixtures written for the purpose. Do not copy titles from the owner's saved list.

Done when: the owner has chosen from the numbers, the change is merged, and the saved jobs with no lane are explained one by one.

## W3 Scoring and calibration

**Outcome:** the ordering is right, the cut-offs are set from the owner's labels, and a blind review passes.

Deliver:

1. Rehearsal tooling: reconnect on a dropped connection, exit non-zero on any failure, resume where it stopped. First, as its own pull request.
2. The numbers for the extractor change: mandatory requirements per job, score and coverage distributions, where each rated row lands, postings with no mandatory requirement, the degree-gap quotes.
3. Downranks, never rejections: customer-facing delivery, people management as the core of the role, contract employment, infrastructure by description.
4. Thin postings: few extracted requirements lower confidence, not the score.
5. Cut-offs for Priority and Review, proposed from re-run scores and the owner's labels. Not applied until the owner approves.
6. The fresh sheet of 30: drawn after W1 has refreshed availability and W2's change is merged, each link re-opened on the day, one job per line with a fixed answer column.
7. The model comparison on the labelled rows, under the agreed spend cap.

Done when: at least 9 of the top 15 are marked yes and clearly more than in the middle 15.

## W4 Sourcing

**Outcome:** every job in the live set has a full description and a confirmable employer posting, and volume comes from employer boards.

Deliver:

1. A job without a complete description gets no gate result, lane or recommendation. It waits as "awaiting content". The change to the stage worker is made by W1 on W4's request.
2. Every alert job gets a fetch task at ingest. Reconciliation fails loudly when a live job has neither a complete description nor a fetch task.
3. A snippet-only job whose fetch has not succeeded is archived automatically: 7 days after it was last seen, and in any case 21 days after it was first seen.
4. Gmail alerts are ingested only for company alerts with a full posting link.
5. Aggregators stay as leads. A lead becomes a rankable job only when the employer's own posting is resolved and verified open. Report how many current leads resolve.
6. More employer boards: propose additional Workday, Ashby and Greenhouse employers in the eight lanes, with the expected number of postings each adds.

Done when: no live job has a description shorter than the completeness rule, and the report shows the weekly number of new verifiable postings by source.

## W5 Model gateway (Phase 1)

**Outcome:** `src/services/agent.ts` is gone, and the model code cannot reach the database.

Deliver, as moves with behaviour unchanged:

1. Create `src/platform/llm/` and `src/platform/config/` and move code as the move map in [architecture-review-2026-11-19.md](architecture-review-2026-11-19.md) shows. `src/services/agent.ts` re-exports from the new places while its importers still point at it.
2. One typed request and one typed result for every provider call.
3. Replace the database parameter with an audit interface that the caller supplies.
4. One file holds every model ID and price, read at call time.
5. A measurement run fails when the primary model did not answer.
6. Repoint the importers, then delete `src/services/agent.ts` and the import cycle. Prune the baseline.

Rules: no prompt text changes, no model changes, no change to what is stored. Everything under `src/platform/` must pass rules B1 to B8. Send the ordered list of moves to the owner before the first pull request.

Done when: rule F1 and the F4 entries for `src/services/agent.ts` are gone from the baseline, and the full test suite passes unchanged.

## W6 Evaluation quality (part of Phase 2)

**Outcome:** model input is cleaned, and a change that makes ranking worse is visible in CI.

Deliver:

1. A cleaning step for posting text before any model sees it, with clear delimiters between instructions and posting.
2. The ranking benchmark as a command, reported in CI as information. Fixtures are synthetic.
3. An inventory of the evaluation prompt: what the roughly 30,000 input tokens per job contain, which outputs anything reads, and what can be cut. A report, not a change.
4. Nullable columns for prompt id and prompt version on evaluations and document runs (migration 118), so the registry can fill them once W5 is done.

Done when: the benchmark figure appears on every pull request, and the inventory is with the owner.

## Order towards the test

1. W1, W2, W3 step 1, W4, W5 and W6 start together.
2. The owner chooses the lane option from W2's numbers.
3. W1's refresh runs on a copy, then W3 proposes cut-offs.
4. W3 draws the fresh 30. The owner labels them.
5. If the review passes: the owner approves the cut-offs, the production commands are sent with counts, and processing restarts.
6. Phase 3 starts once W1 to W3 are merged.

## Waiting on the owner

- Production dry run, then apply, for the snippet-only archive.
- The contract question: whether "a company that fits a lane" means the job or the type of employer.
- Track years in the private profile.
- Whether a Priority job should reach the Top 10 without waiting for the AI evaluation.
