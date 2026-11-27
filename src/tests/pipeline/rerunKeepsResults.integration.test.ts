import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isLocalPostgresConnectionString } from "../../db/pgSsl.js";
import { runHardGates } from "../../pipeline/hardGate.js";
import { runRecommendationDecider } from "../../pipeline/recommendationDecider.js";
import { pipelineTaskStageVersion } from "../../tasks/pipelineTaskCurrentness.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { runPipelineStageTaskWorker } from "../../tasks/stageTaskWorker.js";
import { createTaskIntentV2 } from "../../tasks/taskIntent.js";
import { openPipelineStack, type PipelineStack, type StackJob } from "../fixtures/pipelineStackFixture.js";

// "A re-run never clears a result." Real PostgreSQL, real worker, gate and decider; synthetic jobs only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the re-run result tests against its PostgreSQL service.");
}

let stack: PipelineStack | undefined;
const s = (): PipelineStack => { if (!stack) throw new Error("not initialised"); return stack; };

/** A gate-PASS job with a stored result and no profile match that is current. */
async function scoredJobWithoutCurrentMatch(key: string): Promise<StackJob> {
  const job = await s().seedRoutableJob(key);
  await s().db.query(
    `UPDATE canonical_jobs
        SET description_quality_status = 'COMPLETE', processing_state = 'MATCHED', processing_status = 'MATCHED',
            deterministic_match_score = 75, deterministic_match_coverage = 60,
            recommendation_eligibility = 'ELIGIBLE', recommendation_outcome = 'REVIEW',
            recommendation_requirement_score = 0.75, recommendation_coverage_score = 0.6,
            recommendation_evidence_completeness = 0.5, recommendation_decided_at = '2026-01-01T00:00:00Z',
            recommendation_score_policy = 'synthetic_policy|role_shape', recommendation_degree_asked_for = 'A synthetic degree is asked for.',
            recommendation_evidence_confidence = 'LOW'
      WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId],
  );
  return job;
}

async function makeMatchCurrent(job: StackJob, score: number, coverage: number): Promise<void> {
  const run = await s().db.query<{ id: string }>(
    `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, requirement_set_id, job_content_hash,
                             context_fingerprint, status, requirement_count, matched_count, coverage_score, overall_match_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', 5, 4, $8, $9) RETURNING id`,
    [s().ctx.workspaceId, job.canonicalJobId, job.jobVersionId, s().profileVersionId, job.requirementSetId, job.contentHash,
      `rerun-context-${randomUUID()}`, coverage, score],
  );
  await s().db.query(
    `UPDATE canonical_jobs SET latest_match_run_id = $3, deterministic_match_score = $4, deterministic_match_coverage = $5,
            profile_match_status = 'POSITIVE_MATCH' WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId, run.rows[0]!.id, score, coverage],
  );
}

async function stored(job: StackJob) {
  const { rows } = await s().db.query(
    `SELECT recommendation_requirement_score::float AS score, recommendation_coverage_score::float AS coverage,
            recommendation_evidence_completeness::float AS completeness, recommendation_eligibility AS eligibility,
            recommendation_outcome AS outcome, recommendation_score_policy AS policy, recommendation_degree_asked_for AS degree,
            recommendation_evidence_confidence AS confidence, recommendation_decided_at AS decided_at,
            latest_deterministic_decision_id AS decision, deterministic_match_score::float AS match_score,
            deterministic_match_coverage::float AS match_coverage
       FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId],
  );
  return rows[0]!;
}

async function decisions(job: StackJob): Promise<number> {
  const { rows } = await s().db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM deterministic_decisions WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [s().ctx.workspaceId, job.canonicalJobId],
  );
  return rows[0]!.n;
}

const decide = (job: StackJob) => runRecommendationDecider(s().db, { context: s().ctx, canonicalJobIds: [job.canonicalJobId] });

describe.skipIf(skipReal)("a re-run never clears a result (PostgreSQL)", () => {
  beforeAll(async () => { stack = await openPipelineStack(databaseUrl, "rerun_keeps"); }, 180_000);
  afterAll(async () => { await stack?.close(); });

  it("the decider writes nothing over a stored result when the match is not current, and writes the changed result once it is", async () => {
    const job = await scoredJobWithoutCurrentMatch("stale-match");
    const before = await stored(job);

    const stale = await decide(job);
    expect(stale).toMatchObject({ errors: 0, updated: 0, decisionsInserted: 0, scoresKept: 1 });
    expect(await stored(job)).toEqual(before);
    expect(await decisions(job)).toBe(0);

    await makeMatchCurrent(job, 40, 20);
    const current = await decide(job);
    expect(current).toMatchObject({ errors: 0, updated: 1, decisionsInserted: 1, scoresKept: 0 });
    const after = await stored(job);
    expect(after).toMatchObject({ score: 0.4, coverage: 0.2 });
    expect(after.decision).not.toBeNull();
  });

  it("a stored coverage alone is also kept", async () => {
    const job = await scoredJobWithoutCurrentMatch("coverage-only");
    await s().db.query(`UPDATE canonical_jobs SET recommendation_requirement_score = NULL WHERE id = $1`, [job.canonicalJobId]);
    expect(await decide(job)).toMatchObject({ errors: 0, scoresKept: 1 });
    expect((await stored(job)).coverage).toBe(0.6);
  });

  it("a job that never had a score is decided and stays without one", async () => {
    const job = await s().seedRoutableJob("never-scored");
    await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'COMPLETE' WHERE id = $1`, [job.canonicalJobId]);
    expect(await decide(job)).toMatchObject({ errors: 0, decisionsInserted: 1, scoresKept: 0 });
    const after = await stored(job);
    expect(after).toMatchObject({ score: null, coverage: null });
    expect(after.outcome).not.toBeNull();
  });

  it.each([
    ["a plain forced reprocess (availability re-check, confirmed fact, restore)", false],
    ["a version refresh", true],
  ])("a re-gate keeps the stored result through %s", async (_label, versionRefresh) => {
    const job = await scoredJobWithoutCurrentMatch(`regate-${String(versionRefresh)}`);
    await makeMatchCurrent(job, 75, 60);
    await s().db.query(`UPDATE canonical_jobs SET gate_decision = 'NEEDS_VERIFICATION', processing_state = 'MATCHED' WHERE id = $1`, [job.canonicalJobId]);
    const before = await stored(job);

    const summary = await runHardGates(s().db, { context: s().ctx, canonicalJobIds: [job.canonicalJobId], reprocess: true, versionRefresh });
    expect(summary.errors).toBe(0);
    expect(await stored(job)).toEqual(before);

    // The recompute that follows has no current match after a forced reprocess: it must still leave a score in place.
    expect((await decide(job)).errors).toBe(0);
    expect(await stored(job)).toMatchObject({ score: expect.any(Number), coverage: expect.any(Number), match_score: 75, match_coverage: 60 });
  });

  it("the forced re-gate an availability re-check queues never leaves the job without a score on its way through the worker", async () => {
    const job = await s().seedRoutableJob("worker-chain");
    await s().db.query(`UPDATE canonical_jobs SET description_quality_status = 'COMPLETE' WHERE id = $1`, [job.canonicalJobId]);
    await s().publishEmbeddings();
    const taskTypes = ["APPLY_HARD_GATES", "PUBLISH_EMBEDDING", "ROUTE_LANE", "MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION"] as never;
    const work = (seed: boolean, maxTasks: number) => runPipelineStageTaskWorker(s().db, {
      context: s().ctx, seed, includeTestFixtures: true, reconcileStalePending: false, heartbeatSeconds: 0,
      minTimeToStartTaskMs: 0, maxTasks, taskTypes, jobVersionIds: [job.jobVersionId],
    });
    for (let pass = 0; pass < 4; pass += 1) await work(true, 30);
    const first = await stored(job);
    expect(first.score).not.toBeNull();
    expect(first.decision).not.toBeNull();

    const taskType = "APPLY_HARD_GATES" as const;
    const payload = {
      canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId,
      force_policy_recalculation: true, reassessment_reason: "AVAILABILITY_RECHECK:1",
    };
    const taskKey = `${taskType}:${job.jobVersionId}:AVAILABILITY_RECHECK:1`;
    const intent = createTaskIntentV2({
      workspaceId: s().ctx.workspaceId, taskType, stageVersion: pipelineTaskStageVersion(taskType)!,
      producer: "availabilityRecheck", requestId: taskKey, mode: "FORCE_RECOMPUTE", payload,
    });
    await enqueuePipelineTask({ taskType, taskKey, payload, maxAttempts: 8, intent }, s().db, { context: s().ctx });
    expect((await work(false, 1)).completed).toBe(1);
    // Routing and matching have not run yet: the earlier result is still all there.
    expect(await stored(job)).toEqual(first);

    for (let pass = 0; pass < 4; pass += 1) await work(true, 30);
    const after = await stored(job);
    expect(after).toMatchObject({ score: first.score, coverage: first.coverage, outcome: first.outcome });
    expect(after.decision).not.toBeNull();
  }, 120_000);
});
