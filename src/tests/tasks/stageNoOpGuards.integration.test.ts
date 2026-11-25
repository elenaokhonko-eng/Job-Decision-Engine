import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { DETERMINISTIC_EXTRACTOR_VERSION } from "../../requirements/deterministicExtractors.js";
import { DECIDER_VERSION, deciderVersionReassessmentReason } from "../../pipeline/deciderVersion.js";
import { findTasksCompletedWithoutResult } from "../../tasks/completedWithoutResult.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import {
  defaultPipelineStageWorkerDependencies,
  runPipelineStageTaskWorker,
  seedRecoverablePipelineTasks,
} from "../../tasks/stageTaskWorker.js";
import { openPipelineStack, type PipelineStack, type StackJob } from "../fixtures/pipelineStackFixture.js";

// Real PostgreSQL and the real worker; synthetic jobs only. A stage task completes successfully only when its result exists or
// when it records a designed no-op in repair_action, and a decider-version reassessment that completed without a decision is
// reopened (not a permanent tombstone) unless it is an outcome conflict closed under the current decider version.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the stage no-op guard tests against its PostgreSQL service.");
}

let stack: PipelineStack | undefined;
const s = (): PipelineStack => { if (!stack) throw new Error("not initialised"); return stack; };

type Deps = typeof defaultPipelineStageWorkerDependencies;
const silentDecider = {
  ...defaultPipelineStageWorkerDependencies,
  runRecommendationDecider: async () => ({ updated: 0, decisionsInserted: 0, errors: 0, policySnapshotId: "p", policySnapshotHash: "h" }),
} as unknown as Deps;

async function terminalJob(key: string, state: string, outcome: string, eligibility: string): Promise<StackJob> {
  const job = await s().seedRoutableJob(key);
  await s().db.query(
    `UPDATE canonical_jobs
        SET processing_state = $3, processing_status = $3, gate_decision = 'HARD_REJECT', rejection_reason = 'HARD_LOCATION_ONSITE',
            description_quality_status = 'COMPLETE', recommendation_outcome = $4, recommendation_eligibility = $5
      WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId, state, outcome, eligibility],
  );
  await s().db.query(
    `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, gate_version, decision) VALUES ($1, $2, $3, 'gate-2026-11.4', 'HARD_REJECT')`,
    [s().ctx.workspaceId, job.canonicalJobId, job.jobVersionId],
  );
  return job;
}

/** A decision an earlier decider version stamped, as the latest decision of the job. */
async function oldDecision(job: StackJob, deciderVersion = "recommendation_decider_v1"): Promise<void> {
  const snapshot = await s().db.query<{ id: string }>(
    `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, resolved_snapshot) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
    [s().ctx.workspaceId, `snap-${randomUUID()}`],
  );
  const decision = await s().db.query<{ id: string }>(
    `INSERT INTO deterministic_decisions (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id, decision_hash, decision_json,
                                          recommendation_eligibility, recommendation_outcome, decider_version)
     SELECT $1, $2, $3, $4, $5, '{}'::jsonb, c.recommendation_eligibility, c.recommendation_outcome, $6
       FROM canonical_jobs c WHERE c.workspace_id = $1 AND c.id = $2 RETURNING id`,
    [s().ctx.workspaceId, job.canonicalJobId, job.jobVersionId, snapshot.rows[0]!.id, `decision-${randomUUID()}`, deciderVersion],
  );
  await s().db.query(`UPDATE canonical_jobs SET latest_deterministic_decision_id = $3 WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId, decision.rows[0]!.id]);
}

const seedDecide = (job: StackJob) => seedRecoverablePipelineTasks(s().db, {
  context: s().ctx, taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: [job.jobVersionId], includeTestFixtures: true,
});
const drain = (taskTypes: string[], dependencies: Deps = defaultPipelineStageWorkerDependencies, jobVersionIds?: string[]) => runPipelineStageTaskWorker(s().db, {
  context: s().ctx, seed: false, ...(jobVersionIds ? { jobVersionIds } : {}), includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
  minTimeToStartTaskMs: 0, maxTasks: 20, taskTypes: taskTypes as never,
}, dependencies);

async function tasks(job: StackJob, taskType: string) {
  const { rows } = await s().db.query<{ status: string; repair_action: string | null; attempt_count: number }>(
    `SELECT status, repair_action, attempt_count FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = $2 AND payload->>'job_version_id' = $3
      ORDER BY created_at`,
    [s().ctx.workspaceId, taskType, job.jobVersionId],
  );
  return rows;
}
async function stamped(job: StackJob): Promise<number> {
  const { rows } = await s().db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM deterministic_decisions WHERE workspace_id = $1 AND job_version_id = $2 AND decider_version = $3`,
    [s().ctx.workspaceId, job.jobVersionId, DECIDER_VERSION],
  );
  return rows[0]!.n;
}
async function reported(): Promise<string[]> {
  return (await findTasksCompletedWithoutResult(s().db, s().ctx.workspaceId, { all: true })).sample.map((row) => row.jobVersionId);
}
/** Simulates the lost no-op: the closed row a handler that returned without writing left behind. */
async function closeAsNoOp(job: StackJob): Promise<void> {
  await s().db.query(
    `UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW(), attempt_count = 3, repair_action = NULL
      WHERE workspace_id = $1 AND task_type = 'DECIDE_RECOMMENDATION' AND payload->>'job_version_id' = $2`,
    [s().ctx.workspaceId, job.jobVersionId],
  );
}

describe.skipIf(skipReal)("stage no-op guards and the decide reopen rule (PostgreSQL)", () => {
  beforeAll(async () => { stack = await openPipelineStack(databaseUrl, "noop_guards"); }, 180_000);
  afterAll(async () => { await stack?.close(); });

  it("a COMPLETED no-op reassessment with no decision under the current decider version is reopened by the seed and stamped on drain", async () => {
    const job = await terminalJob("reopen", "HARD_REJECTED", "SKIP", "INELIGIBLE");
    await oldDecision(job);
    expect((await seedDecide(job)).byType.DECIDE_RECOMMENDATION?.inserted).toBe(1);
    const [seeded] = await tasks(job, "DECIDE_RECOMMENDATION");
    expect(seeded?.status).toBe("PENDING");
    await closeAsNoOp(job);
    expect(await stamped(job)).toBe(0);

    await seedDecide(job);
    expect(await tasks(job, "DECIDE_RECOMMENDATION")).toEqual([{ status: "PENDING", repair_action: null, attempt_count: 0 }]);
    // Idempotent: a second seed leaves the reopened row alone.
    await seedDecide(job);
    expect(await tasks(job, "DECIDE_RECOMMENDATION")).toEqual([{ status: "PENDING", repair_action: null, attempt_count: 0 }]);

    const summary = await drain(["DECIDE_RECOMMENDATION"]);
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);
    expect(await stamped(job)).toBe(1);
    // A decision exists now, so nothing reopens it again.
    await seedDecide(job);
    expect((await tasks(job, "DECIDE_RECOMMENDATION"))[0]?.status).toBe("COMPLETED");
  });

  it("an outcome conflict closed under the current decider version stays closed", async () => {
    // A stored recommendation on a hard-rejected job: the reassessment would clear it, so it is a conflict, not a stamp.
    const job = await terminalJob("conflict", "HARD_REJECTED", "TRACK", "VERIFY");
    await oldDecision(job);
    await seedDecide(job);
    await drain(["DECIDE_RECOMMENDATION"]);
    expect(await tasks(job, "DECIDE_RECOMMENDATION")).toEqual([
      { status: "COMPLETED", repair_action: "OUTCOME_CONFLICT_ON_TERMINAL_JOB", attempt_count: 1 },
    ]);
    await seedDecide(job);
    await seedDecide(job);
    expect(await tasks(job, "DECIDE_RECOMMENDATION")).toEqual([
      { status: "COMPLETED", repair_action: "OUTCOME_CONFLICT_ON_TERMINAL_JOB", attempt_count: 1 },
    ]);
    expect(await stamped(job)).toBe(0);
  });

  it("a decider run that writes nothing for a decidable job is not a completed task", async () => {
    const job = await terminalJob("silent", "HARD_REJECTED", "SKIP", "INELIGIBLE");
    await oldDecision(job);
    await seedDecide(job);
    const summary = await drain(["DECIDE_RECOMMENDATION"], silentDecider);
    expect(summary.completed).toBe(0);
    expect(summary.failed + summary.blocked + summary.deadLettered).toBeGreaterThan(0);
    const [task] = await tasks(job, "DECIDE_RECOMMENDATION");
    expect(task?.status).not.toBe("COMPLETED");
  });

  it("a designed no-op records its reason in repair_action and is not reported as a lost result", async () => {
    // UNMATCHED without a match run: the decider cannot select it.
    const unmatched = await terminalJob("no-match-run", "UNMATCHED", "SKIP", "INELIGIBLE");
    await s().db.query(`UPDATE canonical_jobs SET gate_decision = 'PASS', routing_disposition = 'POLICY_NO_MATCH' WHERE workspace_id = $1 AND id = $2`,
      [s().ctx.workspaceId, unmatched.canonicalJobId]);
    await oldDecision(unmatched);
    // A terminal job whose version already has a decision, asked to decide without being a reassessment.
    const decided = await terminalJob("has-decision", "HARD_REJECTED", "SKIP", "INELIGIBLE");
    await oldDecision(decided);
    // A terminal job awaiting content.
    const awaiting = await terminalJob("awaiting", "HARD_REJECTED", "TRACK", "VERIFY");
    await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE workspace_id = $1 AND id = $2`,
      [s().ctx.workspaceId, awaiting.canonicalJobId]);
    // A job still before lane routing.
    const early = await s().seedRoutableJob("pre-routing");

    const enqueue = async (job: StackJob, extra: Record<string, unknown>) => {
      const payload = { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId, ...extra };
      await enqueuePipelineTask({
        taskType: "DECIDE_RECOMMENDATION", taskKey: `DECIDE_RECOMMENDATION:${job.jobVersionId}:guard:${randomUUID()}`, payload, maxAttempts: 2,
      }, s().db, { context: s().ctx });
    };
    await enqueue(unmatched, { reprocess_existing_state: true, reassessment_reason: deciderVersionReassessmentReason() });
    await enqueue(decided, {});
    await enqueue(awaiting, { repair_existing_state: true });
    await enqueue(early, {});
    // The decider selects nothing for the UNMATCHED job (no match run to decide from); the others never reach it.
    const summary = await drain(["DECIDE_RECOMMENDATION"], silentDecider);
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);

    expect((await tasks(unmatched, "DECIDE_RECOMMENDATION"))[0]).toMatchObject({ status: "COMPLETED", repair_action: "DECISION_NOT_STAMPABLE:NO_CURRENT_MATCH_RUN" });
    expect((await tasks(decided, "DECIDE_RECOMMENDATION"))[0]).toMatchObject({ status: "COMPLETED", repair_action: "DECISION_NOT_STAMPABLE:TERMINAL_HAS_DECISION" });
    expect((await tasks(awaiting, "DECIDE_RECOMMENDATION"))[0]).toMatchObject({ status: "COMPLETED", repair_action: "DECISION_NOT_STAMPABLE:AWAITING_CONTENT_NOT_DECIDABLE" });
    expect((await tasks(early, "DECIDE_RECOMMENDATION"))[0]).toMatchObject({ status: "COMPLETED", repair_action: "DECISION_NOT_STAMPABLE:PRE_ROUTING_STATE" });
    const lost = await reported();
    for (const job of [unmatched, decided, awaiting, early]) expect(lost).not.toContain(job.jobVersionId);
    // A decidable job whose DECIDE task completed with no recorded reason and no decision IS reported.
    const lostJob = await terminalJob("lost", "HARD_REJECTED", "SKIP", "INELIGIBLE");
    await enqueue(lostJob, {});
    await closeAsNoOp(lostJob);
    expect(await reported()).toContain(lostJob.jobVersionId);
  });

  it("an extraction task completes only when the CURRENT extractor version made the active requirement set", async () => {
    const job = await s().seedRoutableJob("stale-extractor");
    const payload = { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId };
    await enqueuePipelineTask({
      taskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS", taskKey: `EXTRACT_DETERMINISTIC_REQUIREMENTS:${job.jobVersionId}:guard`, payload, maxAttempts: 2,
    }, s().db, { context: s().ctx });
    // An extractor that reports success but leaves the fixture's older-version requirement set in place.
    const noWrite = {
      ...defaultPipelineStageWorkerDependencies,
      runRequirementsExtraction: async () => ({ errors: 0 }),
    } as unknown as Deps;
    const summary = await drain(["EXTRACT_DETERMINISTIC_REQUIREMENTS"], noWrite);
    expect(summary.completed).toBe(0);
    expect((await tasks(job, "EXTRACT_DETERMINISTIC_REQUIREMENTS"))[0]?.status).not.toBe("COMPLETED");
  });

  it("a job removed by the user while its decide task is pending closes as a recorded no-op, with no dead letter and the job untouched", async () => {
    const job = await terminalJob("removed", "MANUALLY_REMOVED", "SKIP", "INELIGIBLE");
    await oldDecision(job);
    await seedRecoverablePipelineTasks(s().db, { context: s().ctx, taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: [job.jobVersionId], includeTestFixtures: true });
    await s().db.query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, max_attempts)
       VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'PENDING', 2)`,
      [s().ctx.workspaceId, `DECIDE_RECOMMENDATION:${job.jobVersionId}:removed:${randomUUID()}`,
       JSON.stringify({ canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId, reprocess_existing_state: true, reassessment_reason: deciderVersionReassessmentReason() })],
    );
    const summary = await drain(["DECIDE_RECOMMENDATION"]);
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);
    const closed = (await tasks(job, "DECIDE_RECOMMENDATION")).filter((task) => task.repair_action !== null);
    expect(closed[0]).toMatchObject({ status: "COMPLETED", repair_action: "DECISION_NOT_STAMPABLE:JOB_REMOVED" });
    const row = await s().db.query<{ state: string; outcome: string }>(
      `SELECT processing_state AS state, recommendation_outcome AS outcome FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
    expect(row.rows[0]).toEqual({ state: "MANUALLY_REMOVED", outcome: "SKIP" });
    expect(await reported()).not.toContain(job.jobVersionId);
  });

  it("a job archived between the claim and the decider run closes as a recorded no-op, not a failure", async () => {
    const job = await terminalJob("archived-race", "HARD_REJECTED", "SKIP", "INELIGIBLE");
    await oldDecision(job);
    await seedDecide(job);
    const archivingDecider = {
      ...defaultPipelineStageWorkerDependencies,
      runRecommendationDecider: async () => {
        const run = await s().db.query<{ id: string }>(
          `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`);
        await s().db.query(
          `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = 'JOB_OLDER_THAN_THREE_CALENDAR_MONTHS',
                  archive_age_basis = 'AUTHORITATIVE_PUBLICATION_DATE', archive_reference_at = NOW(), archive_run_id = $3
            WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId, run.rows[0]!.id]);
        return { updated: 0, decisionsInserted: 0, errors: 0, policySnapshotId: "p", policySnapshotHash: "h" };
      },
    } as unknown as Deps;
    const summary = await drain(["DECIDE_RECOMMENDATION"], archivingDecider, [job.jobVersionId]);
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);
    expect((await tasks(job, "DECIDE_RECOMMENDATION"))[0]).toMatchObject({ status: "COMPLETED", repair_action: "DECISION_NOT_STAMPABLE:JOB_ARCHIVED" });
  });

  it("an UNMATCHED job without a current match run, closed with no recorded reason by an older worker, is not reported", async () => {
    const job = await terminalJob("legacy-unmatched", "UNMATCHED", "SKIP", "INELIGIBLE");
    await s().db.query(`UPDATE canonical_jobs SET gate_decision = 'PASS', routing_disposition = 'POLICY_NO_MATCH' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
    await s().db.query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, completed_at)
       VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'COMPLETED', NOW())`,
      [s().ctx.workspaceId, `DECIDE_RECOMMENDATION:${job.jobVersionId}:legacy`, JSON.stringify({ job_version_id: job.jobVersionId })],
    );
    expect(await reported()).not.toContain(job.jobVersionId);
  });

  it("a plain extraction task asks the extractor to reprocess a version-stale active set", async () => {
    const job = await s().seedRoutableJob("stale-reprocess-flag");
    await s().db.query(`UPDATE canonical_jobs SET processing_state = 'NEEDS_VERIFICATION', processing_status = 'NEEDS_VERIFICATION' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
    await enqueuePipelineTask({
      taskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS", taskKey: `EXTRACT_DETERMINISTIC_REQUIREMENTS:${job.jobVersionId}:flag`,
      payload: { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId }, maxAttempts: 2,
    }, s().db, { context: s().ctx });
    const seen: unknown[] = [];
    const spy = {
      ...defaultPipelineStageWorkerDependencies,
      runRequirementsExtraction: async (_client: unknown, options: { reprocess?: boolean }) => { seen.push(options.reprocess); return { errors: 0 }; },
    } as unknown as Deps;
    await drain(["EXTRACT_DETERMINISTIC_REQUIREMENTS"], spy, [job.jobVersionId]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((flag) => flag === true)).toBe(true);
  });

  it("a plain extraction task on a version-stale requirement set re-extracts for a NEEDS_VERIFICATION job and completes at the current version", async () => {
    const job = await s().seedRoutableJob("stale-plain");
    await s().db.query(`UPDATE canonical_jobs SET processing_state = 'NEEDS_VERIFICATION', processing_status = 'NEEDS_VERIFICATION' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, job.canonicalJobId]);
    await enqueuePipelineTask({
      taskType: "EXTRACT_DETERMINISTIC_REQUIREMENTS", taskKey: `EXTRACT_DETERMINISTIC_REQUIREMENTS:${job.jobVersionId}:plain`,
      payload: { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId }, maxAttempts: 2,
    }, s().db, { context: s().ctx });
    const summary = await drain(["EXTRACT_DETERMINISTIC_REQUIREMENTS"]);
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);
    expect((await tasks(job, "EXTRACT_DETERMINISTIC_REQUIREMENTS"))[0]?.status).toBe("COMPLETED");
    const version = await s().db.query<{ v: string }>(
      `SELECT ri.deterministic_extractor_version AS v FROM job_versions jv
         JOIN requirement_sets rs ON rs.id = jv.active_requirement_set_id
         JOIN requirement_set_identities ri ON ri.id = rs.requirement_identity_id WHERE jv.id = $1`, [job.jobVersionId]);
    expect(version.rows[0]?.v).toBe(DETERMINISTIC_EXTRACTOR_VERSION);
  });
});
