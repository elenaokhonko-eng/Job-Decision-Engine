import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { AWAITING_REMATCH_LIMIT_DAYS } from "../../modules/decision/index.js";
import { DECIDER_VERSION } from "../../pipeline/deciderVersion.js";
import { runDeterministicMatcher } from "../../pipeline/deterministicMatcher.js";
import { runExplanationQueueEnqueuer } from "../../pipeline/explanationQueueEnqueuer.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { runRecommendationDecider } from "../../pipeline/recommendationDecider.js";
import { saveWorkspacePreferenceRevision } from "../../policy/workspacePreferenceRegistry.js";
import { STAGE3_SCHEMA_VERSION } from "../../policy/stage3Contracts.js";
import {
  AVAILABILITY_RECHECK_ARCHIVE_RULE,
  archiveJobsAsPostingNotConfirmable,
  reactivateGenuineRepost,
  restoreArchivedJob,
  restoreAvailabilityArchivedJob,
  restoreHardRejectedArchiveForOwnerSavedObservation,
} from "../../services/jobArchive.js";
import { jobsAwaitingRematchOverLimit, staleStageResults } from "../../tasks/integrityZeroChecks.js";
import { pipelineTaskStageVersion } from "../../tasks/pipelineTaskCurrentness.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { createTaskIntentV2 } from "../../tasks/taskIntent.js";
import { openAiWorkForSuite, TEST_SCORE_POLICY } from "../fixtures/aiWorkSwitch.js";
import { openPipelineStack, type PipelineStack, type StackJob } from "../fixtures/pipelineStackFixture.js";

// "A re-run never clears a result" (owner decision). Real PostgreSQL, real worker, gate, matcher and decider;
// synthetic jobs only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the re-run result tests against its PostgreSQL service.");
}

// The owner's AI switch is closed by default: it is opened here, and stored results carry a score policy the cut-off
// accepts, so "never sent to AI" is proven by a queue that does accept other jobs.
openAiWorkForSuite();

let stack: PipelineStack | undefined;
const s = (): PipelineStack => { if (!stack) throw new Error("not initialised"); return stack; };

const STAGES = [
  "APPLY_HARD_GATES", "EXTRACT_DETERMINISTIC_REQUIREMENTS", "PUBLISH_EMBEDDING", "ROUTE_LANE",
  "MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "ENQUEUE_EXPLANATION",
] as const;

async function job(key: string): Promise<StackJob> {
  const seeded = await s().seedRoutableJob(key);
  await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'COMPLETE' WHERE id = $1`, [seeded.canonicalJobId]);
  return seeded;
}

/** Gives a job a stored result, as an earlier run with a current match would have left it. */
async function storeResult(target: StackJob, outcome = "PRIORITY", state = "MATCHED"): Promise<void> {
  await s().db.query(
    `UPDATE canonical_jobs
        SET processing_state = $3, processing_status = $3,
            recommendation_eligibility = 'ELIGIBLE', recommendation_outcome = $4,
            recommendation_requirement_score = 0.9, recommendation_coverage_score = 0.8,
            recommendation_evidence_completeness = 1, recommendation_decided_at = NOW(),
            recommendation_score_policy = $5, recommendation_degree_asked_for = 'A synthetic degree is asked for.',
            recommendation_evidence_confidence = 'NORMAL'
      WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, target.canonicalJobId, state, outcome, TEST_SCORE_POLICY],
  );
}

async function waitingJob(key: string, outcome = "PRIORITY", state = "MATCHED"): Promise<StackJob> {
  const target = await job(key);
  await storeResult(target, outcome, state);
  return target;
}

async function stored(target: StackJob) {
  const { rows } = await s().db.query(
    `SELECT recommendation_requirement_score::float AS score, recommendation_coverage_score::float AS coverage,
            recommendation_evidence_completeness::float AS completeness, recommendation_eligibility AS eligibility,
            recommendation_outcome AS outcome, recommendation_score_policy AS policy, recommendation_degree_asked_for AS degree,
            recommendation_evidence_confidence AS confidence, latest_deterministic_decision_id AS decision
       FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, target.canonicalJobId],
  );
  return rows[0]!;
}

/** The latest decision of the job, with what the lists compare it against. */
async function latestDecision(target: StackJob) {
  const { rows } = await s().db.query<{ decider_version: string; outcome: string; eligibility: string; json: any }>(
    `SELECT d.decider_version, d.recommendation_outcome AS outcome, d.recommendation_eligibility AS eligibility, d.decision_json AS json
       FROM canonical_jobs c JOIN deterministic_decisions d ON d.id = c.latest_deterministic_decision_id
      WHERE c.workspace_id = $1 AND c.id = $2`,
    [s().ctx.workspaceId, target.canonicalJobId],
  );
  return rows[0];
}

async function awaiting(target: StackJob): Promise<Date | null> {
  const { rows } = await s().db.query<{ waiting_since: Date }>(
    `SELECT waiting_since FROM v_job_awaiting_rematch WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [s().ctx.workspaceId, target.canonicalJobId],
  );
  return rows[0]?.waiting_since ?? null;
}

async function tasks(target: StackJob) {
  const { rows } = await s().db.query<{ task_type: string; status: string; repair_action: string | null }>(
    `SELECT task_type, status, repair_action FROM pipeline_tasks WHERE workspace_id = $1 AND payload->>'job_version_id' = $2
      ORDER BY created_at, task_key`,
    [s().ctx.workspaceId, target.jobVersionId],
  );
  return rows;
}

async function queued(target: StackJob): Promise<number> {
  const { rows } = await s().db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM evaluation_queue WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [s().ctx.workspaceId, target.canonicalJobId],
  );
  return rows[0]!.n;
}

async function listedAsWaiting(target: StackJob): Promise<boolean> {
  const { rows } = await s().db.query(
    `SELECT 1 FROM v_job_awaiting_rematch WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [s().ctx.workspaceId, target.canonicalJobId],
  );
  return rows.length > 0;
}

/** A worker pass with nothing to claim for the job: it only keeps the waits. */
async function drainNothing(target: StackJob): Promise<void> {
  await runPipelineStageTaskWorker(s().db, {
    context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
    minTimeToStartTaskMs: 0, maxTasks: 1, taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: [randomUUID()],
  });
  void target;
}

const decide = (target: StackJob, options: { preserveStoredOutcome?: boolean } = {}) =>
  runRecommendationDecider(s().db, { context: s().ctx, canonicalJobIds: [target.canonicalJobId], ...options });

/** A new, empty requirement set: the next match completes and compares nothing. */
async function emptyRequirements(target: StackJob): Promise<void> {
  const set = await s().db.query<{ id: string }>(
    `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
     SELECT workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number + 1, 'EXTRACTED'
       FROM requirement_sets WHERE id = $1 RETURNING id`,
    [target.requirementSetId],
  );
  await s().db.query(`UPDATE job_versions SET active_requirement_set_id = $2 WHERE id = $1`, [target.jobVersionId, set.rows[0]!.id]);
  await s().db.query(
    `INSERT INTO requirement_extraction_runs (workspace_id, canonical_job_id, job_version_id, requirement_set_id, run_type, status, requirements_extracted, completed_at)
     VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', 0, NOW())`,
    [s().ctx.workspaceId, target.canonicalJobId, target.jobVersionId, set.rows[0]!.id],
  );
}

const WITHOUT_EXTRACTION = STAGES.filter((stage) => stage !== "EXTRACT_DETERMINISTIC_REQUIREMENTS");

async function drain(target: StackJob, passes = 5, taskTypes: readonly string[] = WITHOUT_EXTRACTION): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await runPipelineStageTaskWorker(s().db, {
      context: s().ctx, seed: true, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
      minTimeToStartTaskMs: 0, maxTasks: 30, taskTypes: [...taskTypes] as never, jobVersionIds: [target.jobVersionId],
    });
    await s().publishEmbeddings();
  }
}

async function enqueueRerun(target: StackJob, taskType: "APPLY_HARD_GATES" | "EXTRACT_DETERMINISTIC_REQUIREMENTS", flags: Record<string, unknown>) {
  const payload = { canonical_job_id: target.canonicalJobId, job_version_id: target.jobVersionId, ...flags };
  const taskKey = `${taskType}:${target.jobVersionId}:rerun:${randomUUID()}`;
  const intent = createTaskIntentV2({
    workspaceId: s().ctx.workspaceId, taskType, stageVersion: pipelineTaskStageVersion(taskType)!,
    producer: "rerunKeepsResultsTest", requestId: taskKey, mode: "FORCE_RECOMPUTE", payload,
  });
  await enqueuePipelineTask({ taskType, taskKey, payload, maxAttempts: 8, intent }, s().db, { context: s().ctx });
}

const noFailures = async (target: StackJob) =>
  expect((await tasks(target)).filter((task) => !["COMPLETED", "PENDING", "BLOCKED_DEPENDENCY"].includes(task.status))).toEqual([]);

describe.skipIf(skipReal)("a re-run never clears a result (PostgreSQL)", { timeout: 120_000 }, () => {
  beforeAll(async () => { stack = await openPipelineStack(databaseUrl, "rerun_keeps"); await s().publishEmbeddings(); }, 180_000);
  afterAll(async () => { await stack?.close(); });

  it("a waiting job keeps its stored score and outcome, gets a current decision, is marked, and a second run changes nothing", async () => {
    const target = await waitingJob("unchanged");
    const before = await stored(target);

    expect(await decide(target)).toMatchObject({ errors: 0, decisionsInserted: 1 });
    const after = await stored(target);
    expect(after).toEqual({ ...before, completeness: after.completeness, decision: after.decision });
    expect(after.completeness).not.toBeNull();
    const decision = (await latestDecision(target))!;
    expect(decision).toMatchObject({ decider_version: DECIDER_VERSION, outcome: "PRIORITY", eligibility: "ELIGIBLE" });
    expect(decision.json.inputs).toMatchObject({ requirement_score: null, coverage_score: null });
    expect(decision.json.outputs).toMatchObject({ recommendation_requirement_score: 0.9, recommendation_coverage_score: 0.8 });
    expect(decision.json.trace.notes).toEqual(expect.arrayContaining(["awaiting_rematch", "stored_score_carried", "kept_outcome:PRIORITY"]));
    expect(await awaiting(target)).not.toBeNull();

    expect(await decide(target)).toMatchObject({ errors: 0, decisionsInserted: 0 });
    expect(await stored(target)).toEqual(after);
  });

  it.each([
    ["a closed posting", `UPDATE job_versions SET availability_status = 'CLOSED' WHERE canonical_job_id = $1`, "INELIGIBLE", "SKIP"],
    ["a fact needing verification", `UPDATE canonical_jobs SET gate_decision = 'NEEDS_VERIFICATION' WHERE id = $1`, "VERIFY", "REVIEW"],
    ["no matching lane", `UPDATE canonical_jobs SET routing_disposition = 'POLICY_NO_MATCH' WHERE id = $1`, "ELIGIBLE", "SKIP"],
  ])("%s is still written to a waiting job, and the score stays", async (label, change, eligibility, outcome) => {
    const target = await waitingJob(`override-${label.replaceAll(" ", "-")}`);
    await s().db.query(change, [target.canonicalJobId]);
    expect((await decide(target)).errors).toBe(0);
    expect(await stored(target)).toMatchObject({ score: 0.9, coverage: 0.8, eligibility, outcome });
    expect(await latestDecision(target)).toMatchObject({ decider_version: DECIDER_VERSION, eligibility, outcome });
  });

  it("a real hard reject by the gate clears the stored score and ends at Skip", async () => {
    const target = await waitingJob("hard-reject");
    await s().db.query(`UPDATE canonical_jobs SET workplace_type = 'ONSITE', location = 'London', location_summary = 'London' WHERE id = $1`,
      [target.canonicalJobId]);
    expect(await runHardGates(s().db, { context: s().ctx, canonicalJobIds: [target.canonicalJobId], reprocess: true }))
      .toMatchObject({ errors: 0, hardRejected: 1 });
    expect(await stored(target)).toMatchObject({ score: null, coverage: null, completeness: null, outcome: null, eligibility: null });
    expect((await decide(target)).errors).toBe(0);
    expect(await stored(target)).toMatchObject({ score: null, coverage: null, eligibility: "INELIGIBLE", outcome: "SKIP" });
  });

  it("an old match score is never used for a new decision, whatever the gate says", async () => {
    const target = await job("old-score");
    await s().db.query(
      `UPDATE canonical_jobs SET gate_decision = 'NEEDS_VERIFICATION', deterministic_match_score = 95, deterministic_match_coverage = 90 WHERE id = $1`,
      [target.canonicalJobId],
    );
    expect((await decide(target)).errors).toBe(0);
    expect(await stored(target)).toMatchObject({ score: null, coverage: null });
    expect((await latestDecision(target))!.json.inputs).toMatchObject({ requirement_score: null, coverage_score: null });
    expect(await awaiting(target)).toBeNull();
  });

  it("a kept outcome is never queued for AI, also when the queue's own match test would accept the match", async () => {
    const target = await job("no-ai");
    await drain(target);
    // Whatever the pipeline decided, leave an AI-eligible stored result behind.
    await storeResult(target, "PRIORITY");
    await s().db.query(`DELETE FROM evaluation_queue WHERE canonical_job_id = $1`, [target.canonicalJobId]);
    // The decider treats a match without a context fingerprint as not current; the queue's query alone does not.
    await s().db.query(`UPDATE match_runs SET context_fingerprint = NULL WHERE canonical_job_id = $1`, [target.canonicalJobId]);
    expect((await decide(target)).errors).toBe(0);
    expect((await latestDecision(target))!.json.trace.notes).toContain("awaiting_rematch");
    expect(await stored(target)).toMatchObject({ eligibility: "ELIGIBLE", outcome: "PRIORITY" });
    await runExplanationQueueEnqueuer(s().db, { context: s().ctx, jobVersionIds: [target.jobVersionId] });
    expect(await queued(target)).toBe(0);

    // Positive control: with a current match, the same job in the same setup is queued.
    await s().db.query(`UPDATE match_runs SET context_fingerprint = 'current-again' WHERE canonical_job_id = $1`, [target.canonicalJobId]);
    await s().db.query(`UPDATE canonical_jobs SET deterministic_match_score = 95, deterministic_match_coverage = 100, profile_match_status = 'POSITIVE_MATCH' WHERE id = $1`,
      [target.canonicalJobId]);
    expect((await decide(target)).errors).toBe(0);
    expect((await latestDecision(target))!.json.trace.notes).not.toContain("stored_score_carried");
    expect(await stored(target)).toMatchObject({ eligibility: "ELIGIBLE", policy: TEST_SCORE_POLICY });
    expect(["PRIORITY", "REVIEW"]).toContain((await stored(target)).outcome);
    await runExplanationQueueEnqueuer(s().db, { context: s().ctx, jobVersionIds: [target.jobVersionId] });
    expect(await queued(target)).toBe(1);
  });

  it("the career-track cap applies to a kept outcome", async () => {
    const target = await waitingJob("track-cap");
    // A title that matches no career track cannot be a priority match.
    await s().db.query(`UPDATE canonical_jobs SET normalized_title = 'synthetic zebra keeper' WHERE id = $1`, [target.canonicalJobId]);
    expect((await decide(target)).errors).toBe(0);
    expect(await stored(target)).toMatchObject({ score: 0.9, eligibility: "ELIGIBLE", outcome: "REVIEW" });
    expect((await latestDecision(target))!.json.trace.notes).toContain("kept_outcome_override:career_track_cap");
  });

  it("a result changed by another stage gets its own decision: the pointer never names a decision with another outcome", async () => {
    const target = await waitingJob("carried-identity");
    expect(await decide(target)).toMatchObject({ errors: 0, decisionsInserted: 1 });
    // As the lane router or the matcher would, with every other input of the decision unchanged.
    await s().db.query(`UPDATE canonical_jobs SET recommendation_outcome = 'TRACK' WHERE id = $1`, [target.canonicalJobId]);
    expect(await decide(target)).toMatchObject({ errors: 0, decisionsInserted: 1 });
    expect(await stored(target)).toMatchObject({ outcome: "TRACK" });
    expect(await latestDecision(target)).toMatchObject({ outcome: "TRACK" });
  });

  it("a terminal job that waits is stamped without any result column changing", async () => {
    const target = await waitingJob("terminal", "SKIP", "UNMATCHED");
    const before = await stored(target);
    expect(await decide(target, { preserveStoredOutcome: true })).toMatchObject({ errors: 0, outcomeConflicts: 0, decisionsInserted: 1 });
    const after = await stored(target);
    expect(after).toEqual({ ...before, decision: after.decision });
    expect(after.decision).not.toBeNull();
  });

  const flagged = async (target: StackJob) =>
    (await jobsAwaitingRematchOverLimit(s().db, s().ctx.workspaceId)).sample.includes(target.canonicalJobId);
  const waitedDays = (target: StackJob, days: number) => s().db.query(
    `UPDATE job_rematch_waits SET waiting_since = NOW() - make_interval(days => $3) WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [s().ctx.workspaceId, target.canonicalJobId, days],
  );

  it("the clock starts when the job begins to wait: a match that is weeks old does not count", async () => {
    const target = await waitingJob("clock-start");
    await s().db.query(
      `UPDATE canonical_jobs SET created_at = NOW() - INTERVAL '60 days', recommendation_decided_at = NOW() - INTERVAL '45 days' WHERE id = $1`,
      [target.canonicalJobId],
    );
    await s().db.query(
      `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id, job_content_hash,
                               context_fingerprint, status, requirement_count, matched_count, coverage_score, overall_match_score, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'an-earlier-content', 'weeks-old', 'COMPLETED', 1, 1, 100, 90, NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days')`,
      [s().ctx.workspaceId, target.canonicalJobId, target.jobVersionId, s().profileVersionId, target.requirementSetId],
    );
    await s().db.query(
      `UPDATE canonical_jobs SET latest_match_run_id = (SELECT id FROM match_runs WHERE canonical_job_id = $1) WHERE id = $1`,
      [target.canonicalJobId],
    );
    // Waiting, but no start recorded yet: listed, not flagged.
    expect(await listedAsWaiting(target)).toBe(true);
    expect(await awaiting(target)).toBeNull();
    expect(await flagged(target)).toBe(false);

    const before = Date.now();
    expect((await decide(target)).errors).toBe(0);
    const since = (await awaiting(target))!;
    expect(since.getTime()).toBeGreaterThan(before - 60_000);
    expect(await flagged(target)).toBe(false);
  });

  it("the limit is seven days: a wait of six days is not flagged, a wait of seven is", async () => {
    expect(AWAITING_REMATCH_LIMIT_DAYS).toBe(7);
    const target = await waitingJob("clock-limit");
    expect((await decide(target)).errors).toBe(0);
    await waitedDays(target, 6);
    expect(await flagged(target)).toBe(false);
    await waitedDays(target, 7);
    expect(await flagged(target)).toBe(true);
  });

  it("a job that has waited past the limit is flagged; later passes never move its start, and leaving clears it", async () => {
    const target = await waitingJob("clock-over");
    await drainNothing(target);
    expect(await awaiting(target)).not.toBeNull();
    await waitedDays(target, 8);
    const since = (await awaiting(target))!;
    expect(await flagged(target)).toBe(true);

    expect((await decide(target)).errors).toBe(0);
    await drainNothing(target);
    expect((await awaiting(target))!.getTime()).toBe(since.getTime());
    expect(await flagged(target)).toBe(true);

    // It leaves (here: no matching lane settles it), and a later wait starts a new clock.
    await s().db.query(`UPDATE canonical_jobs SET routing_disposition = 'POLICY_NO_MATCH' WHERE id = $1`, [target.canonicalJobId]);
    await drainNothing(target);
    const rows = await s().db.query(`SELECT 1 FROM job_rematch_waits WHERE canonical_job_id = $1`, [target.canonicalJobId]);
    expect(rows.rows).toEqual([]);
    await s().db.query(`UPDATE canonical_jobs SET routing_disposition = NULL WHERE id = $1`, [target.canonicalJobId]);
    await drainNothing(target);
    expect((await awaiting(target))!.getTime()).toBeGreaterThan(since.getTime());
    expect(await flagged(target)).toBe(false);
  });

  // The four faults the reviewers found in "write nothing", each as a worker chain.
  it("fault 1: a match that compared nothing becomes Track, keeps the score and never dead-letters an AI task", async () => {
    const target = await job("nothing-compared");
    await storeResult(target, "PRIORITY", "PREQUALIFIED");
    await emptyRequirements(target);
    await drain(target);
    expect(await stored(target)).toMatchObject({ score: 0.9, coverage: 0.8, eligibility: "ELIGIBLE", outcome: "TRACK" });
    expect(await latestDecision(target)).toMatchObject({ decider_version: DECIDER_VERSION, outcome: "TRACK" });
    expect((await latestDecision(target))!.json.trace.notes).not.toContain("awaiting_rematch");
    expect((await tasks(target)).filter((task) => task.task_type === "ENQUEUE_EXPLANATION")).toEqual([]);
    await noFailures(target);
    expect(await queued(target)).toBe(0);
    expect(await awaiting(target)).toBeNull();
  }, 120_000);

  it("fault 2: a waiting job is decided once under the current decider version, not reopened every run", async () => {
    const target = await waitingJob("routing-deferred", "REVIEW", "ROUTING_DEFERRED");
    await s().db.query(`UPDATE canonical_jobs SET routing_disposition = 'TECHNICAL_DEFERRED' WHERE id = $1`, [target.canonicalJobId]);
    expect((await decide(target)).errors).toBe(0);
    // As if an earlier decider version had stamped it.
    await s().db.query(`ALTER TABLE deterministic_decisions DISABLE TRIGGER USER`);
    await s().db.query(`UPDATE deterministic_decisions SET decider_version = 'recommendation_decider_v1', context_fingerprint = $2 WHERE canonical_job_id = $1`,
      [target.canonicalJobId, `old-${randomUUID()}`]);
    await s().db.query(`ALTER TABLE deterministic_decisions ENABLE TRIGGER USER`);

    const work = async () => {
      await seedRecoverablePipelineTasks(s().db, {
        context: s().ctx, taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: [target.jobVersionId], includeTestFixtures: true,
      });
      await runPipelineStageTaskWorker(s().db, {
        context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
        minTimeToStartTaskMs: 0, maxTasks: 5, taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: [target.jobVersionId],
      });
    };
    await work();
    const first = await tasks(target);
    expect(first).toEqual([{ task_type: "DECIDE_RECOMMENDATION", status: "COMPLETED", repair_action: null }]);
    expect(await latestDecision(target)).toMatchObject({ decider_version: DECIDER_VERSION, outcome: "REVIEW" });
    await work();
    expect(await tasks(target)).toEqual(first);
    expect((await staleStageResults(s().db, s().ctx.workspaceId)).sample).not.toContain(target.canonicalJobId);
    expect(await stored(target)).toMatchObject({ score: 0.9, outcome: "REVIEW" });
  });

  it("fault 3: a job restored from the archive gets an outcome again", async () => {
    const target = await job("restored");
    await drain(target);
    const first = await stored(target);
    expect(first.score).not.toBeNull();
    // The recompute after the restore has no score: nothing is left to compare.
    await emptyRequirements(target);
    await archiveJobsAsPostingNotConfirmable(s().db, {
      workspaceId: s().ctx.workspaceId, canonicalJobIds: [target.canonicalJobId], actor: "test", details: { rule: AVAILABILITY_RECHECK_ARCHIVE_RULE },
    });
    expect(await restoreAvailabilityArchivedJob(s().db, {
      workspaceId: s().ctx.workspaceId, canonicalJobId: target.canonicalJobId, context: s().ctx,
    })).toMatchObject({ restored: true });
    expect(await stored(target)).toMatchObject({ outcome: first.outcome, eligibility: first.eligibility, score: first.score });
    await drain(target);
    const after = await stored(target);
    expect(after.outcome).not.toBeNull();
    expect(after.decision).not.toBeNull();
    expect(after).toMatchObject({ score: first.score, coverage: first.coverage });
    // The stages after the restore re-gate ran under their own identities, not suppressed by the first run's tasks.
    const successors = await s().db.query<{ task_type: string }>(
      `SELECT DISTINCT task_type FROM pipeline_tasks
        WHERE workspace_id = $1 AND payload->>'job_version_id' = $2 AND payload->>'repair_generation' LIKE 'ARCHIVE_RESTORE:%'
          AND status = 'COMPLETED'`,
      [s().ctx.workspaceId, target.jobVersionId],
    );
    expect(successors.rows.map((row) => row.task_type)).toEqual(expect.arrayContaining(["ROUTE_LANE", "MATCH_PROFILE_EVIDENCE"]));
    const end = await s().db.query<{ matched: boolean }>(`SELECT latest_match_run_id IS NOT NULL AS matched FROM canonical_jobs WHERE id = $1`, [target.canonicalJobId]);
    expect(end.rows[0]!.matched).toBe(true);
    await noFailures(target);
  }, 120_000);

  it("fault 4: a fact that now needs verification is written by the re-gate chain, not left as the old priority", async () => {
    const target = await waitingJob("needs-verification");
    await s().db.query(`UPDATE canonical_jobs SET workplace_type = 'UNKNOWN', location = 'Singapore', location_summary = 'Singapore' WHERE id = $1`,
      [target.canonicalJobId]);
    await enqueueRerun(target, "APPLY_HARD_GATES", { force_policy_recalculation: true, reassessment_reason: "AVAILABILITY_RECHECK:1" });
    await runPipelineStageTaskWorker(s().db, {
      context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
      minTimeToStartTaskMs: 0, maxTasks: 1, taskTypes: ["APPLY_HARD_GATES"], jobVersionIds: [target.jobVersionId],
    });
    expect(await stored(target)).toMatchObject({ score: 0.9, coverage: 0.8 });
    expect((await decide(target)).errors).toBe(0);
    expect(await stored(target)).toMatchObject({ score: 0.9, coverage: 0.8, eligibility: "VERIFY", outcome: "REVIEW" });
  });

  it.each([
    ["the forced re-gate an availability re-check queues", "forced-regate"],
    ["a re-extraction the seed forces because the extractor version is stale", "stale-extractor"],
  ])("%s never leaves the job without its score and outcome on its way through the worker", async (_label, key) => {
    const target = await job(`chain-${key}`);
    await drain(target);
    const first = await stored(target);
    expect(first.score).not.toBeNull();

    if (key === "forced-regate") {
      await enqueueRerun(target, "APPLY_HARD_GATES", { force_policy_recalculation: true, reassessment_reason: "AVAILABILITY_RECHECK:1" });
    } else {
      // The fixture's requirement set was made by an old extractor version: the real seed adds `reprocess`. A job past
      // routing that cannot be re-matched directly goes back through the gate with that flag.
      await s().db.query(`UPDATE canonical_jobs SET processing_state = 'ROUTING_DEFERRED', processing_status = 'ROUTING_DEFERRED' WHERE id = $1`, [target.canonicalJobId]);
      await seedRecoverablePipelineTasks(s().db, {
        context: s().ctx, taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS"], jobVersionIds: [target.jobVersionId], includeTestFixtures: true,
      });
    }
    let gateReset = false;
    const seen: unknown[] = [];
    for (let step = 0; step < 12; step += 1) {
      await runPipelineStageTaskWorker(s().db, {
        context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
        minTimeToStartTaskMs: 0, maxTasks: 1, taskTypes: [...STAGES], jobVersionIds: [target.jobVersionId],
      });
      await s().publishEmbeddings();
      const now = await stored(target);
      const pointers = await s().db.query<{ reset: boolean }>(`SELECT latest_match_run_id IS NULL AS reset FROM canonical_jobs WHERE id = $1`, [target.canonicalJobId]);
      gateReset ||= pointers.rows[0]!.reset;
      seen.push({ score: now.score !== null, coverage: now.coverage !== null, outcome: now.outcome !== null });
    }
    expect(seen).toEqual(seen.map(() => ({ score: true, coverage: true, outcome: true })));
    // The gate that ran was the forced one: it removed the match pointer.
    const gate = await s().db.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM pipeline_tasks WHERE task_type = 'APPLY_HARD_GATES' AND payload->>'job_version_id' = $1`, [target.jobVersionId]);
    expect(gate.rows.some((row) => row.payload.reprocess === true || row.payload.force_policy_recalculation === true)).toBe(true);
    expect(gateReset).toBe(true);
    await drain(target, 2);
    expect((await stored(target)).score).not.toBeNull();
    await noFailures(target);
  }, 120_000);

  async function archive(target: StackJob, reason: string, basis: string): Promise<void> {
    const run = await s().db.query<{ id: string }>(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`,
    );
    await s().db.query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = $2, archive_age_basis = $3,
              archive_reference_at = NOW() - INTERVAL '200 days', archive_run_id = $4 WHERE id = $1`,
      [target.canonicalJobId, reason, basis, run.rows[0]!.id],
    );
  }

  const RESTORE_PATHS: Array<[string, (target: StackJob) => Promise<void>]> = [
    ["the owner's manual restore", async (target) => {
      await archive(target, "JOB_OLDER_THAN_THREE_CALENDAR_MONTHS", "AUTHORITATIVE_PUBLICATION_DATE");
      await restoreArchivedJob(s().db, { workspaceId: s().ctx.workspaceId, canonicalJobId: target.canonicalJobId, actor: "user:test", reason: "synthetic restore", context: s().ctx });
    }],
    ["the availability re-check seeing the posting open again", async (target) => {
      await archiveJobsAsPostingNotConfirmable(s().db, {
        workspaceId: s().ctx.workspaceId, canonicalJobIds: [target.canonicalJobId], actor: "test", details: { rule: AVAILABILITY_RECHECK_ARCHIVE_RULE },
      });
      await restoreAvailabilityArchivedJob(s().db, { workspaceId: s().ctx.workspaceId, canonicalJobId: target.canonicalJobId, context: s().ctx });
    }],
    ["the owner saving a hard-rejected job again", async (target) => {
      await archive(target, "HARD_REJECTED_PERMANENT", "HARD_REJECTED_DECISION");
      await restoreHardRejectedArchiveForOwnerSavedObservation(s().db, {
        workspaceId: s().ctx.workspaceId, canonicalJobId: target.canonicalJobId, observationId: null, sourceName: "LINKEDIN_SAVED", context: s().ctx,
      });
    }],
    ["a genuine repost", async (target) => {
      await archive(target, "JOB_OLDER_THAN_THREE_CALENDAR_MONTHS", "AUTHORITATIVE_PUBLICATION_DATE");
      await reactivateGenuineRepost(s().db, {
        workspaceId: s().ctx.workspaceId, canonicalJobId: target.canonicalJobId, actor: "test", repostedAt: new Date(),
        repostEvidenceHash: "synthetic-repost", evidenceType: "GENUINE_REPOST_DATE", context: s().ctx,
      });
    }],
  ];

  /** One worker pass that claims only the decision: nothing else has to run first. */
  const decidePass = (target: StackJob) => runPipelineStageTaskWorker(s().db, {
    context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
    minTimeToStartTaskMs: 0, maxTasks: 5, taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: [target.jobVersionId],
  });

  it.each(RESTORE_PATHS.flatMap(([label, restore]) => [
    [label, "with a current match", restore] as const,
    [label, "with no current match", restore] as const,
  ]))("a job restored by %s, %s, gets its old result back and is decided on the next worker pass", async (label, match, restore) => {
    const target = await job(`restore-${randomUUID().slice(0, 8)}`);
    await drain(target);
    if (match === "with no current match") {
      await s().db.query(`UPDATE canonical_jobs SET latest_match_run_id = NULL WHERE id = $1`, [target.canonicalJobId]);
    }
    const first = await stored(target);
    await restore(target);
    expect(await stored(target), label).toMatchObject({ outcome: first.outcome, eligibility: first.eligibility, score: first.score, decision: first.decision });

    expect(await decidePass(target)).toMatchObject({ completed: 1, failed: 0, blocked: 0 });
    const after = await stored(target);
    expect(after).toMatchObject({ outcome: first.outcome, eligibility: first.eligibility, score: first.score, coverage: first.coverage });
    const decision = (await latestDecision(target))!;
    expect(decision).toMatchObject({ decider_version: DECIDER_VERSION, outcome: after.outcome });
    expect(decision.json.inputs).toMatchObject({ requirement_score: null });
    expect(decision.json.trace.notes).toEqual(expect.arrayContaining(["awaiting_rematch", "restored_from_archive"]));
  });

  it.each(RESTORE_PATHS.flatMap(([label, restore]) => [
    [label, "with a score", restore] as const,
    [label, "with no score", restore] as const,
  ]))("a skipped, ineligible job restored by %s, %s, does not come back as Track before it is re-matched", async (_label, score, restore) => {
    const target = await job(`restore-skip-${randomUUID().slice(0, 8)}`);
    await drain(target);
    await storeResult(target, "SKIP");
    await s().db.query(`UPDATE canonical_jobs SET recommendation_eligibility = 'INELIGIBLE' WHERE id = $1`, [target.canonicalJobId]);
    if (score === "with no score") {
      await s().db.query(
        `UPDATE canonical_jobs SET recommendation_requirement_score = NULL, recommendation_coverage_score = NULL, recommendation_score_policy = NULL WHERE id = $1`,
        [target.canonicalJobId]);
    }
    await restore(target);
    expect(await decidePass(target)).toMatchObject({ completed: 1, failed: 0 });
    expect(await stored(target)).toMatchObject({ eligibility: "INELIGIBLE", outcome: "SKIP" });
    // The stages after the restore, short of the re-match, and every decision on the way leave it as it was.
    await drain(target, 3, ["APPLY_HARD_GATES", "PUBLISH_EMBEDDING", "ROUTE_LANE", "DECIDE_RECOMMENDATION"]);
    expect((await decide(target)).errors).toBe(0);
    expect(await stored(target)).toMatchObject({ eligibility: "INELIGIBLE", outcome: "SKIP" });
  });

  it("the re-match after a restore gives a fresh result", async () => {
    const target = await job("restore-rematch");
    await drain(target);
    await storeResult(target, "SKIP");
    await s().db.query(`UPDATE canonical_jobs SET recommendation_eligibility = 'INELIGIBLE' WHERE id = $1`, [target.canonicalJobId]);
    await RESTORE_PATHS[0]![1](target);
    await drain(target);
    expect(await stored(target)).toMatchObject({ eligibility: "ELIGIBLE" });
    expect((await latestDecision(target))!.json.trace.notes).not.toContain("restored_from_archive");
    await noFailures(target);
  });

  it("a restored job is not sent to AI on its old result, before or after its decision", async () => {
    const target = await job("restore-no-ai");
    await drain(target);
    await storeResult(target, "PRIORITY");
    const offer = async () => {
      await s().db.query(`DELETE FROM evaluation_queue WHERE canonical_job_id = $1`, [target.canonicalJobId]);
      await runExplanationQueueEnqueuer(s().db, { context: s().ctx, jobVersionIds: [target.jobVersionId] });
      return queued(target);
    };
    // Positive control: as it stands, with its match current, the job is queued.
    expect(await offer()).toBe(1);

    await RESTORE_PATHS[0]![1](target);
    expect(await stored(target)).toMatchObject({ eligibility: "ELIGIBLE", outcome: "PRIORITY" });
    expect(await offer()).toBe(0);
    expect(await decidePass(target)).toMatchObject({ completed: 1, failed: 0 });
    expect(await stored(target)).toMatchObject({ eligibility: "ELIGIBLE", outcome: "PRIORITY" });
    expect(await offer()).toBe(0);
  });

  it("a restored job that cannot be decided yet keeps its result and queues no AI step", async () => {
    const target = await waitingJob("restore-undecidable", "REVIEW");
    await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE id = $1`, [target.canonicalJobId]);
    await RESTORE_PATHS[0]![1](target);
    expect((await stored(target)).outcome).toBe("REVIEW");
    expect(await decidePass(target)).toMatchObject({ completed: 1, failed: 0 });
    expect((await stored(target)).outcome).toBe("REVIEW");
    expect((await tasks(target)).filter((task) => task.task_type === "ENQUEUE_EXPLANATION")).toEqual([]);
  });

  it.each([
    ["the direct matcher and decider calls of the re-route script", "direct"],
    ["the worker's match task", "worker"],
  ])("after a profile import, a match with a missing profile embedding keeps the stored result: %s", async (_label, path) => {
    const target = await job(`import-${path}`);
    await drain(target);
    await storeResult(target, "PRIORITY", "LANE_ROUTED");
    const before = await stored(target);
    // A newly imported profile whose facts have no embedding yet.
    const profile = await s().db.query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       SELECT workspace_id, candidate_profile_id, version_number + 10 + (SELECT COUNT(*) FROM profile_versions), schema_version, $1, 'DRAFT', NOW()
         FROM profile_versions WHERE status = 'ACTIVE' LIMIT 1 RETURNING id`,
      [`synthetic-import-${path}`],
    );
    await s().db.query(`UPDATE profile_versions SET status = 'RETIRED' WHERE status = 'ACTIVE'`);
    await s().db.query(`UPDATE profile_versions SET status = 'ACTIVE' WHERE id = $1`, [profile.rows[0]!.id]);
    await s().db.query(
      `INSERT INTO profile_facts (workspace_id, profile_version_id, fact_key, fact_type, statement, structured_value, evidence_tier, verification_status)
       VALUES ($1, $2, $3, 'SKILL', 'Synthetic unembedded skill for the import case', '{}'::jsonb, 'PROFESSIONAL_PRODUCTION', 'VERIFIED')`,
      [s().ctx.workspaceId, profile.rows[0]!.id, `unembedded-${path}`],
    );

    if (path === "direct") {
      const summary = await runDeterministicMatcher(s().db, { context: s().ctx, canonicalJobIds: [target.canonicalJobId] });
      expect(summary).toMatchObject({ errors: 0, matchedJobs: 0, skippedJobs: 1 });
      expect((await decide(target)).errors).toBe(0);
    } else {
      await seedRecoverablePipelineTasks(s().db, {
        context: s().ctx, taskTypes: ["MATCH_PROFILE_EVIDENCE"], jobVersionIds: [target.jobVersionId], includeTestFixtures: true,
      });
      await runPipelineStageTaskWorker(s().db, {
        context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
        minTimeToStartTaskMs: 0, maxTasks: 1, taskTypes: ["MATCH_PROFILE_EVIDENCE"], jobVersionIds: [target.jobVersionId],
      });
    }
    const run = await s().db.query<{ status: string; error_message: string }>(
      `SELECT mr.status, mr.error_message FROM canonical_jobs c JOIN match_runs mr ON mr.id = c.latest_match_run_id WHERE c.id = $1`,
      [target.canonicalJobId],
    );
    expect(run.rows[0]).toMatchObject({ status: "FAILED", error_message: "EMBEDDING_DEPENDENCY_INCOMPLETE" });
    expect(await stored(target)).toMatchObject({ score: before.score, coverage: before.coverage, outcome: "PRIORITY", eligibility: "ELIGIBLE" });
  }, 120_000);
});

// Its own schema: an active pay floor would change what the cases above decide.
describe.skipIf(skipReal)("a kept outcome and the owner's pay floor (PostgreSQL)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    stack = await openPipelineStack(databaseUrl, "rerun_pay");
    await saveWorkspacePreferenceRevision(s().db, s().ctx, {
      preferenceDomain: "stage3",
      schemaVersion: STAGE3_SCHEMA_VERSION,
      preferenceValue: { compensation: { target_salary_basis: "GROSS", commercial_min_annual_sgd: 240000, university_research_min_annual_sgd: 240000, disposition_below_floor: "PREVENT_APPLY_NOW" } },
      activate: true,
    });
  }, 180_000);
  afterAll(async () => { await stack?.close(); });

  it("pay below the floor ends at Skip, whatever the disposition, and keeps the score", async () => {
    const target = await waitingJob("pay-below");
    // An employer whose category is known, so the floor can be confirmed as missed.
    await s().db.query(`UPDATE canonical_jobs SET company_name = 'Synthetic Zebra University' WHERE id = $1`, [target.canonicalJobId]);
    await s().db.query(
      `UPDATE raw_job_observations SET compensation_raw = 'SGD 5,000 - 6,000 per month gross base salary' WHERE job_version_id = $1`,
      [target.jobVersionId],
    );
    expect((await decide(target)).errors).toBe(0);
    expect(await stored(target)).toMatchObject({ score: 0.9, eligibility: "INELIGIBLE", outcome: "SKIP" });
  });

  it("pay that cannot be confirmed lowers a kept top priority to review", async () => {
    const target = await waitingJob("pay-unverified");
    // A synthetic range that straddles the floor: neither below it nor confirmed above it.
    await s().db.query(
      `UPDATE raw_job_observations SET compensation_raw = 'SGD 18,000 - 24,000 per month gross base salary' WHERE job_version_id = $1`,
      [target.jobVersionId],
    );
    expect((await decide(target)).errors).toBe(0);
    expect((await latestDecision(target))!.json.trace.notes).toContain("kept_outcome_override:pay_needs_verification");
    expect(await stored(target)).toMatchObject({ score: 0.9, eligibility: "ELIGIBLE", outcome: "REVIEW" });
  });
});
