import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { runLaneRouter } from "../../pipeline/laneRouter.js";
import { DETERMINISTIC_MATCHER_POLICY_VERSION, currentMatcherPolicyVersion } from "../../pipeline/profileMatchCurrency.js";
import { staleStageResults } from "../../tasks/integrityZeroChecks.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker, seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { openPipelineStack, type PipelineStack, type StackJob } from "../fixtures/pipelineStackFixture.js";

// Real PostgreSQL, real lane router, matcher and decider; synthetic jobs only. A job the matcher parked UNMATCHED under an older
// matcher policy version (a rule that no longer fails the job) is re-matched once under the current rules; a job parked by the
// CURRENT policy, and a job lane routing left UNMATCHED (POLICY_NO_MATCH), are left alone.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the UNMATCHED re-match tests against its PostgreSQL service.");
}

let stack: PipelineStack | undefined;
const s = (): PipelineStack => { if (!stack) throw new Error("not initialised"); return stack; };
const jobs: Record<"parked" | "current" | "policyNoMatch" | "incomplete", StackJob> = {} as never;
const parkedRunIds: Record<string, string> = {};

async function matchRun(job: StackJob, policyVersion: string): Promise<string> {
  const space = await s().db.query<{ id: string }>(
    `SELECT id::text AS id FROM embedding_spaces WHERE workspace_id = $1 AND active = TRUE AND is_fallback_space = FALSE ORDER BY created_at LIMIT 1`,
    [s().ctx.workspaceId],
  );
  const run = await s().db.query<{ id: string }>(
    `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id, status,
                             requirement_count, matched_count, coverage_score, overall_match_score, policy_version, job_content_hash,
                             context_fingerprint, embedding_space_id, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'COMPLETED', 1, 0, 0, 0, $6, $7, $8, $9, NOW()) RETURNING id`,
    [s().ctx.workspaceId, job.canonicalJobId, job.jobVersionId, s().profileVersionId, job.requirementSetId, policyVersion,
     job.contentHash, `parked-${job.canonicalJobId}-${policyVersion}`, space.rows[0]?.id ?? null],
  );
  return run.rows[0]!.id;
}

/** The state an earlier matcher run left: UNMATCHED, routed, a failed mandatory qualification, SKIP / INELIGIBLE. */
async function park(job: StackJob, policyVersion: string | null, disposition: "ROUTED" | "POLICY_NO_MATCH"): Promise<string | null> {
  const runId = policyVersion ? await matchRun(job, policyVersion) : null;
  await s().db.query(
    `UPDATE canonical_jobs
        SET processing_state = 'UNMATCHED', processing_status = 'UNMATCHED', routing_disposition = $3,
            latest_match_run_id = $4, profile_match_status = 'NO_PROFILE_MATCH',
            rejection_reason = 'MANDATORY_QUALIFICATION_FAILED: DEGREE',
            recommendation_eligibility = 'INELIGIBLE', recommendation_outcome = 'SKIP'
      WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId, disposition, runId],
  );
  return runId;
}

async function row(job: StackJob) {
  const { rows } = await s().db.query<{
    state: string; gate: string | null; lane: string | null; lane_decision: string | null; reason: string | null; run_policy: string | null; run_id: string | null;
  }>(
    `SELECT c.processing_state AS state, c.gate_decision AS gate, c.primary_lane AS lane, c.latest_lane_decision_id::text AS lane_decision,
            c.rejection_reason AS reason, mr.policy_version AS run_policy, c.latest_match_run_id::text AS run_id
       FROM canonical_jobs c LEFT JOIN match_runs mr ON mr.id = c.latest_match_run_id
      WHERE c.workspace_id = $1 AND c.id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId],
  );
  return rows[0]!;
}

async function matcherStale(): Promise<string[]> {
  const check = await staleStageResults(s().db, s().ctx.workspaceId);
  return check.sample.filter((id) => id.startsWith("matcher:"));
}

const seedMatch = () => seedRecoverablePipelineTasks(s().db, {
  context: s().ctx, taskTypes: ["MATCH_PROFILE_EVIDENCE"], includeTestFixtures: true,
});
const drain = () => runPipelineStageTaskWorker(s().db, {
  context: s().ctx, seed: false, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
  minTimeToStartTaskMs: 0, maxTasks: 20, taskTypes: ["MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION"],
});

describe.skipIf(skipReal)("UNMATCHED job parked by an older matcher policy (PostgreSQL)", () => {
  beforeAll(async () => {
    stack = await openPipelineStack(databaseUrl, "unmatched_rematch");
    for (const key of ["parked", "current", "policyNoMatch", "incomplete"] as const) jobs[key] = await s().seedRoutableJob(key);
    // Route every job with the real lane router, then put each into the state an earlier run left.
    await s().publishEmbeddings();
    await runLaneRouter(s().db, { context: s().ctx, jobVersionIds: Object.values(jobs).map((job) => job.jobVersionId) });
    parkedRunIds.parked = (await park(jobs.parked, "deterministic_v1", "ROUTED"))!;
    parkedRunIds.current = (await park(jobs.current, DETERMINISTIC_MATCHER_POLICY_VERSION, "ROUTED"))!;
    await park(jobs.policyNoMatch, null, "POLICY_NO_MATCH");
    parkedRunIds.incomplete = (await park(jobs.incomplete, "deterministic_v1", "ROUTED"))!;
    await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'INCOMPLETE' WHERE workspace_id = $1 AND id = $2`, [s().ctx.workspaceId, jobs.incomplete.canonicalJobId]);
  }, 180_000);
  afterAll(async () => { await stack?.close(); });

  it("the seed and the matcher stale-stage check select only the job parked by an older policy that the matcher can select", async () => {
    const stale = await matcherStale();
    expect(stale).toEqual([`matcher:${jobs.parked.canonicalJobId}`]);
    const summary = await seedMatch();
    expect(summary.supersededProfileMatch).toBe(1);
    const tasks = await s().db.query<{ key: string; superseded: string | null }>(
      `SELECT task_key AS key, payload->>'superseded_match_run_id' AS superseded FROM pipeline_tasks
        WHERE workspace_id = $1 AND task_type = 'MATCH_PROFILE_EVIDENCE' AND payload->>'job_version_id' = ANY($2::text[])`,
      [s().ctx.workspaceId, Object.values(jobs).map((job) => job.jobVersionId)],
    );
    expect(tasks.rows.map((task) => task.superseded)).toEqual([parkedRunIds.parked]);
  });

  it("re-matches the parked job under the current matcher: not UNMATCHED any more, a new current-policy run, gate and lane untouched", async () => {
    const before = await row(jobs.parked);
    expect(before.state).toBe("UNMATCHED");
    const summary = await drain();
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);
    const after = await row(jobs.parked);
    expect(after.state).toBe("MATCHED");
    expect(after.run_id).not.toBe(parkedRunIds.parked);
    expect(after.run_policy).toBe(currentMatcherPolicyVersion());
    expect(after.reason).toBeNull();
    expect({ gate: after.gate, lane: after.lane, lane_decision: after.lane_decision })
      .toEqual({ gate: before.gate, lane: before.lane, lane_decision: before.lane_decision });
    const decisions = await s().db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM deterministic_decisions WHERE workspace_id = $1 AND job_version_id = $2 AND match_run_id = $3`,
      [s().ctx.workspaceId, jobs.parked.jobVersionId, after.run_id],
    );
    expect(decisions.rows[0]?.n).toBe(1);
    // Settled: nothing is stale any more.
    expect(await matcherStale()).toEqual([]);
  }, 120_000);

  it("leaves the job parked by the CURRENT policy, the POLICY_NO_MATCH job and the job the matcher cannot select untouched", async () => {
    for (const key of ["current", "policyNoMatch", "incomplete"] as const) {
      expect((await row(jobs[key])).state).toBe("UNMATCHED");
    }
    expect((await row(jobs.current)).run_id).toBe(parkedRunIds.current);
    expect((await row(jobs.incomplete)).run_id).toBe(parkedRunIds.incomplete);
    expect((await row(jobs.policyNoMatch)).run_id).toBeNull();
  });

  it("a re-match task for a job parked by the current policy completes as a recorded no-op without a new match run", async () => {
    const payload = {
      canonical_job_id: jobs.current.canonicalJobId, job_version_id: jobs.current.jobVersionId,
      superseded_match_run_id: parkedRunIds.current,
    };
    await enqueuePipelineTask({
      taskType: "MATCH_PROFILE_EVIDENCE", taskKey: `MATCH_PROFILE_EVIDENCE:${jobs.current.jobVersionId}:control:${parkedRunIds.current}`,
      payload, maxAttempts: 2,
    }, s().db, { context: s().ctx });
    const summary = await drain();
    expect(summary.failed + summary.blocked + summary.deadLettered).toBe(0);
    const after = await row(jobs.current);
    expect(after.state).toBe("UNMATCHED");
    expect(after.run_id).toBe(parkedRunIds.current);
    const task = await s().db.query<{ status: string; repair_action: string | null }>(
      `SELECT status, repair_action FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'MATCH_PROFILE_EVIDENCE'
          AND payload->>'job_version_id' = $2`,
      [s().ctx.workspaceId, jobs.current.jobVersionId],
    );
    expect(task.rows).toEqual([{ status: "COMPLETED", repair_action: "MATCH_NOT_APPLICABLE:UNMATCHED" }]);
  });
});
