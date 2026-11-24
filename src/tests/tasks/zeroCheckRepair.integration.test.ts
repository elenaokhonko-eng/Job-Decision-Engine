import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { createTaskIntentV2 } from "../../tasks/taskIntent.js";
import { runPipelineStageTaskWorker, type PipelineStageTaskType } from "../../tasks/stageTaskWorker.js";
import { runZeroChecks } from "../../tasks/integrityZeroChecks.js";
import { applyZeroCheckRepairs, planZeroCheckRepairs, repairTaskKey } from "../../tasks/zeroCheckRepair.js";
import { openPipelineStack, type PipelineStack, type StackJob } from "../fixtures/pipelineStackFixture.js";

// Real PostgreSQL and the real stages (router, matcher, decider): a seeded violation of each repairable kind
// is planned, enqueued once (a second run enqueues nothing new), carried out by the normal worker, and the
// check then reads zero. Only the embedding provider is a deterministic synthetic function.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the zero-check repair tests against its PostgreSQL service.");
}

let stack: PipelineStack | undefined;
const s = (): PipelineStack => { if (!stack) throw new Error("not initialised"); return stack; };

const ALL_STAGES = ["APPLY_HARD_GATES", "PUBLISH_EMBEDDING", "ROUTE_LANE", "MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION"] as const;

async function runWorker(taskTypes: readonly PipelineStageTaskType[] = ALL_STAGES) {
  return runPipelineStageTaskWorker(s().db, {
    context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false,
    heartbeatSeconds: 0, minTimeToStartTaskMs: 0, maxTasks: 200, taskTypes: [...taskTypes],
  });
}

async function completedTask(taskType: string, job: StackJob): Promise<void> {
  await s().db.query(
    `INSERT INTO pipeline_tasks (id, workspace_id, task_type, task_key, payload, status, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'COMPLETED', NOW())`,
    [randomUUID(), s().ctx.workspaceId, taskType, `${taskType}:${job.jobVersionId}:seed:${randomUUID()}`,
     JSON.stringify({ canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId })],
  );
}

/** Starts a job through the normal pipeline: a forced re-gate, as the strand check does. */
async function startPipeline(job: StackJob, label: string): Promise<void> {
  const payload = { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId, force_policy_recalculation: true, reassessment_reason: `ZERO_REPAIR:${label}` };
  const taskKey = `APPLY_HARD_GATES:${job.jobVersionId}:ZERO_REPAIR:${label}`;
  await enqueuePipelineTask({
    taskType: "APPLY_HARD_GATES", taskKey, payload, maxAttempts: 8,
    intent: createTaskIntentV2({
      workspaceId: s().ctx.workspaceId, taskType: "APPLY_HARD_GATES", stageVersion: "hard_gate_v1",
      producer: "zero-repair-test", requestId: taskKey, mode: "FORCE_RECOMPUTE", payload,
    }),
  }, s().db, { context: s().ctx });
}

async function enqueuePlain(taskType: string, job: StackJob): Promise<void> {
  await enqueuePipelineTask({
    taskType, taskKey: `${taskType}:${job.jobVersionId}:plain`, payload: { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId }, maxAttempts: 8,
  }, s().db, { context: s().ctx });
}

async function markComplete(job: StackJob): Promise<void> {
  await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'COMPLETE' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
}

async function gateRow(job: StackJob, decision: string): Promise<void> {
  await s().db.query(
    `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, gate_version, decision) VALUES ($1, $2, $3, 'gate-2026-11.4', $4)`,
    [s().ctx.workspaceId, job.canonicalJobId, job.jobVersionId, decision],
  );
}

async function totals(): Promise<Record<string, number>> {
  const results = await runZeroChecks(s().db, s().ctx.workspaceId, { phase: "pre" });
  return Object.fromEntries(results.map((check) => [check.name, check.total]));
}

async function copy(job: StackJob) {
  const { rows } = await s().db.query<{ state: string; outcome: string | null; eligibility: string | null; match: string | null; decision: string | null }>(
    `SELECT COALESCE(processing_state, processing_status) AS state, recommendation_outcome AS outcome, recommendation_eligibility AS eligibility,
            latest_match_run_id::text AS match, latest_deterministic_decision_id::text AS decision
       FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId],
  );
  return rows[0]!;
}

describe.skipIf(skipReal)("zero-check repair (PostgreSQL)", () => {
  beforeAll(async () => { stack = await openPipelineStack(databaseUrl, "zero_repair"); }, 180_000);
  afterAll(async () => { await stack?.close(); });

  it("a clean workspace plans nothing", async () => {
    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.items).toEqual([]);
    expect(plan.unrepairable).toEqual([]);
  });

  it("repairs a hard-rejected job that still recommends: the decider clears it, the check reads zero, a second run enqueues nothing", async () => {
    const job = await s().seedRoutableJob("rejected");
    await markComplete(job);
    await s().db.query(
      `UPDATE canonical_jobs SET processing_state = 'HARD_REJECTED', processing_status = 'HARD_REJECTED', gate_decision = 'HARD_REJECT',
              rejection_reason = 'HARD_LOCATION_ONSITE', recommendation_outcome = 'TRACK', recommendation_eligibility = 'VERIFY'
        WHERE workspace_id = $1 AND id = $2`,
      [s().ctx.workspaceId, job.canonicalJobId],
    );
    await gateRow(job, "HARD_REJECT");
    expect((await totals()).rejected_job_with_recommendation).toBe(1);

    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.items.map((item) => [item.kind, item.entry, item.canonicalJobId])).toEqual([
      ["rejected_job_with_recommendation", "DECIDE_RECOMMENDATION", job.canonicalJobId],
    ]);
    const first = await applyZeroCheckRepairs(s().db, s().ctx, plan);
    expect(first).toEqual({ inserted: 1, existing: 0, skipped: 0 });
    const second = await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId));
    expect(second.inserted).toBe(0);

    const summary = await runWorker();
    expect(summary.failed).toBe(0);
    const row = await copy(job);
    expect(row.outcome).toBe("SKIP");
    expect(row.eligibility).toBe("INELIGIBLE");
    expect((await totals()).rejected_job_with_recommendation).toBe(0);
    // Once the work has completed the same violation does not enqueue again.
    expect((await planZeroCheckRepairs(s().db, s().ctx.workspaceId)).items).toEqual([]);
  });

  it("repairs a completed decide task without a decision on a hard-rejected job (forced decide runs although the outcome is SKIP)", async () => {
    const job = await s().seedRoutableJob("decide-no-result");
    await markComplete(job);
    await s().db.query(
      `UPDATE canonical_jobs SET processing_state = 'HARD_REJECTED', processing_status = 'HARD_REJECTED', gate_decision = 'HARD_REJECT',
              rejection_reason = 'HARD_LOCATION_ONSITE', recommendation_outcome = 'SKIP', recommendation_eligibility = 'INELIGIBLE'
        WHERE workspace_id = $1 AND id = $2`,
      [s().ctx.workspaceId, job.canonicalJobId],
    );
    await gateRow(job, "HARD_REJECT");
    await completedTask("DECIDE_RECOMMENDATION", job);
    expect((await totals()).task_completed_without_result).toBe(1);

    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.items.map((item) => [item.kind, item.entry])).toEqual([["task_completed_without_result", "DECIDE_RECOMMENDATION"]]);
    expect((await applyZeroCheckRepairs(s().db, s().ctx, plan)).inserted).toBe(1);
    expect((await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId))).inserted).toBe(0);
    expect((await runWorker()).failed).toBe(0);
    expect((await totals()).task_completed_without_result).toBe(0);
  });

  it("repairs a completed match task without a match run: a forced re-match and its decision follow", async () => {
    const job = await s().seedRoutableJob("match-no-result");
    await markComplete(job);
    await s().publishEmbeddings();
    // Carry the job to a routed state only; the match is then reported as completed without a run.
    await s().db.query(`UPDATE canonical_jobs SET gate_decision = 'PASS' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
    await gateRow(job, "PASS");
    await enqueuePlain("ROUTE_LANE", job);
    expect((await runWorker(["ROUTE_LANE"])).failed).toBe(0);
    expect((await copy(job)).state).toBe("LANE_ROUTED");
    await completedTask("MATCH_PROFILE_EVIDENCE", job);
    expect((await totals()).task_completed_without_result).toBe(1);

    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.items.map((item) => [item.kind, item.entry])).toEqual([["task_completed_without_result", "MATCH_PROFILE_EVIDENCE"]]);
    expect((await applyZeroCheckRepairs(s().db, s().ctx, plan)).inserted).toBe(1);
    expect((await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId))).inserted).toBe(0);
    expect((await runWorker()).failed).toBe(0);
    const row = await copy(job);
    expect(row.match).not.toBeNull();
    expect(row.decision).not.toBeNull();
    expect((await totals()).task_completed_without_result).toBe(0);
  });

  it("repairs a stranded routable verification job: it is re-routed, matched and decided", async () => {
    const job = await s().seedRoutableJob("stranded", { workplaceType: "UNKNOWN", location: "Singapore" });
    await markComplete(job);
    await s().publishEmbeddings();
    await s().db.query(
      `UPDATE canonical_jobs SET processing_state = 'NEEDS_VERIFICATION', processing_status = 'NEEDS_VERIFICATION', gate_decision = 'NEEDS_VERIFICATION',
              rejection_reason = 'GATE_UNKNOWN_WORK_MODE, NEEDS_VERIFICATION' WHERE workspace_id = $1 AND id = $2`,
      [s().ctx.workspaceId, job.canonicalJobId],
    );
    await gateRow(job, "NEEDS_VERIFICATION");
    expect((await totals()).routable_verification_job_stranded).toBe(1);

    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.items.map((item) => [item.kind, item.entry])).toEqual([["routable_verification_job_stranded", "ROUTE_LANE"]]);
    expect((await applyZeroCheckRepairs(s().db, s().ctx, plan)).inserted).toBe(1);
    expect((await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId))).inserted).toBe(0);
    expect((await runWorker()).failed).toBe(0);
    const row = await copy(job);
    expect(row.match).not.toBeNull();
    expect(row.decision).not.toBeNull();
    expect((await totals()).routable_verification_job_stranded).toBe(0);
  });

  it("repairs drifted copy columns: a job whose stage tasks all completed but whose canonical columns were reset", async () => {
    const lane = await s().seedRoutableJob("drift-lane");
    const pre = await s().seedRoutableJob("drift-pre");
    for (const job of [lane, pre]) await markComplete(job);
    await s().publishEmbeddings();
    for (const job of [lane, pre]) await startPipeline(job, "drift");
    expect((await runWorker()).failed).toBe(0);
    for (const job of [lane, pre]) {
      const row = await copy(job);
      expect(row.decision, "the job completed its stages").not.toBeNull();
    }
    // A re-gate that resets the copy columns while the version-keyed stage tasks stay COMPLETED.
    await s().db.query(
      `UPDATE canonical_jobs SET processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED', latest_match_run_id = NULL, latest_deterministic_decision_id = NULL,
              recommendation_outcome = NULL, recommendation_eligibility = NULL, recommendation_decided_at = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [s().ctx.workspaceId, lane.canonicalJobId],
    );
    await s().db.query(
      `UPDATE canonical_jobs SET processing_state = 'PREQUALIFIED', processing_status = 'PREQUALIFIED', latest_match_run_id = NULL, latest_deterministic_decision_id = NULL,
              latest_lane_decision_id = NULL, recommendation_outcome = NULL, recommendation_eligibility = NULL, recommendation_decided_at = NULL,
              primary_lane = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [s().ctx.workspaceId, pre.canonicalJobId],
    );
    // The explanation-enqueue tasks are outside this worker's task list; they read done, as in the drifted production jobs.
    await s().db.query(
      `UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE workspace_id = $1 AND status <> 'COMPLETED'`, [s().ctx.workspaceId]);
    expect((await totals()).canonical_copy_columns_drift).toBe(2);

    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.items.map((item) => [item.canonicalJobId, item.entry]).sort()).toEqual([
      [lane.canonicalJobId, "MATCH_PROFILE_EVIDENCE"], [pre.canonicalJobId, "PUBLISH_EMBEDDING"],
    ].sort());
    expect((await applyZeroCheckRepairs(s().db, s().ctx, plan)).inserted).toBe(2);
    expect((await applyZeroCheckRepairs(s().db, s().ctx, await planZeroCheckRepairs(s().db, s().ctx.workspaceId))).inserted).toBe(0);
    expect((await runWorker()).failed).toBe(0);
    for (const job of [lane, pre]) {
      const row = await copy(job);
      expect(row.outcome, JSON.stringify(row)).not.toBeNull();
      expect(row.match).not.toBeNull();
    }
    expect((await totals()).canonical_copy_columns_drift).toBe(0);
  });

  it("one entry task per job even when a job violates two checks, and the key is per job, kind and rule version", async () => {
    const job = await s().seedRoutableJob("two-kinds");
    await markComplete(job);
    await s().db.query(
      `UPDATE canonical_jobs SET processing_state = 'HARD_REJECTED', processing_status = 'HARD_REJECTED', gate_decision = 'HARD_REJECT',
              recommendation_outcome = 'REVIEW', recommendation_eligibility = 'ELIGIBLE' WHERE workspace_id = $1 AND id = $2`,
      [s().ctx.workspaceId, job.canonicalJobId],
    );
    await gateRow(job, "HARD_REJECT");
    await completedTask("DECIDE_RECOMMENDATION", job);
    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.items).toHaveLength(1);
    expect(repairTaskKey(plan.items[0]!)).toBe(
      `DECIDE_RECOMMENDATION:${job.jobVersionId}:recommendation_decider_v1:zero-check-repair:rejected_job_with_recommendation:zero-check-repair-v1`,
    );
  });

  it("reports what it does not repair, with counts", async () => {
    const job = await s().seedRoutableJob("gate-no-result");
    await completedTask("APPLY_HARD_GATES", job);
    const plan = await planZeroCheckRepairs(s().db, s().ctx.workspaceId);
    expect(plan.unrepairable).toEqual([{ check: "task_completed_without_result", reason: "APPLY_HARD_GATES is not repaired here", count: 1 }]);
    expect(plan.items.filter((item) => item.canonicalJobId === job.canonicalJobId)).toEqual([]);
  });
});
