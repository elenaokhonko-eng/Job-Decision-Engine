import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { createTaskIntentV2 } from "../../tasks/taskIntent.js";
import { runPipelineStageTaskWorker, defaultPipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { findTasksCompletedWithoutResult } from "../../tasks/completedWithoutResult.js";
import { openPipelineStack, type PipelineStack, type StackJob } from "../fixtures/pipelineStackFixture.js";

// Real PostgreSQL, real recommendation decider. A DECIDE_RECOMMENDATION task for a job that is already in a
// terminal state (HARD_REJECTED or UNMATCHED) used to complete without running the decider whenever ANY
// outcome was stored, so a recommendation (TRACK) left on a hard-rejected job by a gate that predates the
// clear-on-reject fix (#202) was accepted and no decision was recorded for the job version.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the terminal decide tests against its PostgreSQL service.");
}

let stack: PipelineStack | undefined;
const s = (): PipelineStack => { if (!stack) throw new Error("not initialised"); return stack; };

async function hardRejected(job: StackJob, outcome: string, eligibility: string, state = "HARD_REJECTED"): Promise<void> {
  const { db, ctx } = s();
  await db.query(
    `UPDATE canonical_jobs
        SET processing_state = '${state}', processing_status = '${state}', gate_decision = 'HARD_REJECT',
            rejection_reason = 'HARD_LOCATION_ONSITE', description_quality_status = 'COMPLETE',
            recommendation_outcome = $3, recommendation_eligibility = $4
      WHERE workspace_id = $1 AND id = $2`,
    [ctx.workspaceId, job.canonicalJobId, outcome, eligibility],
  );
  await db.query(
    `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, gate_version, decision) VALUES ($1, $2, $3, 'gate-2026-11.4', 'HARD_REJECT')`,
    [ctx.workspaceId, job.canonicalJobId, job.jobVersionId],
  );
}

async function enqueueDecide(job: StackJob, forced: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  const { db, ctx } = s();
  const payload: Record<string, unknown> = {
    canonical_job_id: job.canonicalJobId,
    job_version_id: job.jobVersionId,
    ...extra,
    ...(forced ? { force_policy_recalculation: true } : {}),
  };
  const taskKey = `DECIDE_RECOMMENDATION:${job.jobVersionId}:terminal-test:${randomUUID()}`;
  await enqueuePipelineTask({
    taskType: "DECIDE_RECOMMENDATION",
    taskKey,
    payload,
    maxAttempts: 2,
    ...(forced ? {
      intent: createTaskIntentV2({
        workspaceId: ctx.workspaceId, taskType: "DECIDE_RECOMMENDATION", stageVersion: "recommendation_decider_v1",
        producer: "terminal-test", requestId: taskKey, mode: "FORCE_RECOMPUTE", payload,
      }),
    } : {}),
  }, db, { context: ctx });
}

async function runDecide(dependencies = defaultPipelineStageWorkerDependencies) {
  return runPipelineStageTaskWorker(s().db, {
    context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false,
    heartbeatSeconds: 0, minTimeToStartTaskMs: 0, maxTasks: 20, taskTypes: ["DECIDE_RECOMMENDATION"],
  }, dependencies);
}

async function reported(): Promise<string[]> {
  return (await findTasksCompletedWithoutResult(s().db, s().ctx.workspaceId, { all: true })).sample.map((row) => row.jobVersionId);
}

async function jobRow(job: StackJob) {
  const { rows } = await s().db.query<{ outcome: string | null; eligibility: string | null; decisions: number }>(
    `SELECT c.recommendation_outcome AS outcome, c.recommendation_eligibility AS eligibility,
            (SELECT COUNT(*)::int FROM deterministic_decisions d WHERE d.workspace_id = c.workspace_id AND d.job_version_id = c.latest_job_version_id) AS decisions
       FROM canonical_jobs c WHERE c.workspace_id = $1 AND c.id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId],
  );
  return rows[0]!;
}

describe.skipIf(skipReal)("decide task on a terminal job (PostgreSQL)", () => {
  beforeAll(async () => { stack = await openPipelineStack(databaseUrl, "terminal_decide"); }, 180_000);
  afterAll(async () => { await stack?.close(); });

  it("a stale recommendation on a hard-rejected job is cleared by the decider and a decision is recorded", async () => {
    const job = await s().seedRoutableJob("stale-track");
    await hardRejected(job, "TRACK", "VERIFY");
    await enqueueDecide(job, false);
    const summary = await runDecide();
    expect(summary.failed).toBe(0);
    const row = await jobRow(job);
    expect(row.outcome).toBe("SKIP");
    expect(row.eligibility).toBe("INELIGIBLE");
    expect(row.decisions).toBe(1);
  });

  it("a SKIP outcome carried on the canonical job does not stand in for a decision on a new job version: the decider records it", async () => {
    const job = await s().seedRoutableJob("skip-recorded");
    await hardRejected(job, "SKIP", "INELIGIBLE");
    await enqueueDecide(job, false);
    const summary = await runDecide();
    expect(summary.failed).toBe(0);
    expect((await jobRow(job)).decisions).toBe(1);
    expect(await reported()).not.toContain(job.jobVersionId);
  });

  it("a seeded decide task (repair_existing_state) is not a forced recompute: a decided SKIP job does not run the decider again", async () => {
    const job = await s().seedRoutableJob("seeded-decided");
    await hardRejected(job, "SKIP", "INELIGIBLE");
    await enqueueDecide(job, false);
    expect((await runDecide()).failed).toBe(0);
    expect((await jobRow(job)).decisions).toBe(1);
    let calls = 0;
    const counting = {
      ...defaultPipelineStageWorkerDependencies,
      runRecommendationDecider: async (...args: Parameters<typeof defaultPipelineStageWorkerDependencies.runRecommendationDecider>) => {
        calls += 1;
        return defaultPipelineStageWorkerDependencies.runRecommendationDecider(...args);
      },
    } as typeof defaultPipelineStageWorkerDependencies;
    await enqueueDecide(job, false, { repair_existing_state: true });
    const summary = await runDecide(counting);
    expect(summary.failed).toBe(0);
    expect(summary.completed).toBe(1);
    expect(calls).toBe(0);
  });

  it("a terminal job whose version cannot be decided is awaiting content: a seeded decide task completes quietly with a recorded reason, not a failure", async () => {
    const job = await s().seedRoutableJob("seeded-awaiting");
    await hardRejected(job, "TRACK", "VERIFY");
    await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
    await enqueueDecide(job, false, { repair_existing_state: true });
    const summary = await runDecide();
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);
    expect(summary.completed).toBe(1);
    const task = await s().db.query<{ status: string; repair_action: string | null }>(
      `SELECT status, repair_action FROM pipeline_tasks WHERE workspace_id = $1 AND payload->>'job_version_id' = $2 AND task_type = 'DECIDE_RECOMMENDATION'`,
      [s().ctx.workspaceId, job.jobVersionId]);
    expect(task.rows[0]).toEqual({ status: "COMPLETED", repair_action: "AWAITING_CONTENT_NOT_DECIDABLE" });
    expect((await jobRow(job)).outcome).toBe("TRACK");
    expect(await reported()).not.toContain(job.jobVersionId);
  });

  it("a seeded decide task for a decidable job holding a stale recommendation runs the decider", async () => {
    const job = await s().seedRoutableJob("seeded-stale-decidable");
    await hardRejected(job, "TRACK", "VERIFY");
    await enqueueDecide(job, false, { repair_existing_state: true });
    expect((await runDecide()).failed).toBe(0);
    expect((await jobRow(job)).outcome).toBe("SKIP");
  });

  it("a terminal job whose version cannot be decided (incomplete description) completes without a decision and is not reported", async () => {
    const job = await s().seedRoutableJob("skip-undecidable");
    await hardRejected(job, "SKIP", "INELIGIBLE");
    await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
    await enqueueDecide(job, false);
    const summary = await runDecide();
    expect(summary.failed).toBe(0);
    expect(summary.completed).toBe(1);
    expect((await jobRow(job)).decisions).toBe(0);
    expect(await reported()).not.toContain(job.jobVersionId);
  });

  it("a stale recommendation on an undecidable UNMATCHED job is awaiting content, recorded and not failed", async () => {
    const job = await s().seedRoutableJob("unmatched-stale");
    await hardRejected(job, "TRACK", "VERIFY", "UNMATCHED");
    await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
    await enqueueDecide(job, false);
    const summary = await runDecide();
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);
    expect(summary.completed).toBe(1);
    expect((await jobRow(job)).outcome).toBe("TRACK");
    expect(await reported()).not.toContain(job.jobVersionId);
  });

  it("a stale recommendation on a DECIDABLE terminal job that the decider leaves in place fails visibly", async () => {
    const job = await s().seedRoutableJob("decidable-silent");
    await hardRejected(job, "TRACK", "VERIFY", "UNMATCHED");
    await enqueueDecide(job, false);
    const silentDecider = {
      ...defaultPipelineStageWorkerDependencies,
      runRecommendationDecider: async () => ({ updated: 0, decisionsInserted: 0, errors: 0, policySnapshotId: "p", policySnapshotHash: "h" }),
    } as typeof defaultPipelineStageWorkerDependencies;
    const summary = await runDecide(silentDecider);
    expect(summary.completed).toBe(0);
    expect(summary.failed + summary.blocked + summary.deadLettered).toBeGreaterThan(0);
  });

  it("a forced decide on a decidable job fails when the decider wrote no decision", async () => {
    const job = await s().seedRoutableJob("forced-no-write");
    await hardRejected(job, "SKIP", "INELIGIBLE");
    await enqueueDecide(job, true);
    const silentDecider = {
      ...defaultPipelineStageWorkerDependencies,
      runRecommendationDecider: async () => ({ updated: 0, decisionsInserted: 0, errors: 0, policySnapshotId: "p", policySnapshotHash: "h" }),
    } as typeof defaultPipelineStageWorkerDependencies;
    const summary = await runDecide(silentDecider);
    expect(summary.completed).toBe(0);
    expect(summary.failed + summary.blocked + summary.deadLettered).toBeGreaterThan(0);
  });

  it("a forced recompute runs the decider even when the stored outcome is already SKIP", async () => {
    const job = await s().seedRoutableJob("skip-forced");
    await hardRejected(job, "SKIP", "INELIGIBLE");
    await enqueueDecide(job, true);
    const summary = await runDecide();
    expect(summary.failed).toBe(0);
    const row = await jobRow(job);
    expect(row.outcome).toBe("SKIP");
    expect(row.decisions).toBe(1);
  });


});
