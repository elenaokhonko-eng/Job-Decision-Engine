import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { GATE_VERSION } from "../../contracts/version.js";
import { DECIDER_VERSION, deciderVersionReassessmentReason } from "../../pipeline/deciderVersion.js";
import { findTasksCompletedWithoutResult } from "../../tasks/completedWithoutResult.js";
import { reportedDecisionCounts, staleStageResults } from "../../tasks/integrityZeroChecks.js";
import { applyLiveJobScope } from "../../tasks/seedQueryScope.js";
import { runPipelineStageTaskWorker, seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";

// Live-job scope of the capped seeds, decider-version reassessment of terminal jobs, and the zero checks that
// guard both. Synthetic jobs only, in this test's own schema on local PostgreSQL.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the seed live-filter integration test against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let snapshotId = "";
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };
const ctx = (): WorkspaceContext => { if (!context) throw new Error("not initialised"); return context; };

interface JobOptions {
  state: string;
  gate?: string;
  outcome?: string | null;
  routingDisposition?: string | null;
  /** undefined: no decision row; null: a decision with no decider_version. */
  decider?: string | null;
  ageDays?: number;
  complete?: boolean;
}
interface JobIds { jobId: string; versionId: string }

/** Bulk insert of synthetic jobs (no posting evidence): enough for the seed queries. */
async function bulkJobs(count: number, options: JobOptions): Promise<JobIds[]> {
  const jobIds = Array.from({ length: count }, () => randomUUID());
  const versionIds = Array.from({ length: count }, () => randomUUID());
  const age = `${options.ageDays ?? 30} days`;
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status,
                                 gate_decision, recommendation_eligibility, recommendation_outcome, routing_disposition, updated_at)
     SELECT id, $2, 'Seed Fixture Co', 'fixture role', 'https://example.test/seed/' || id::text, $3, $3, $4, 'INELIGIBLE', $5, $6, NOW() - $7::interval
       FROM unnest($1::uuid[]) AS id`,
    [jobIds, ctx().workspaceId, options.state, options.gate ?? "HARD_REJECT", options.outcome === undefined ? "SKIP" : options.outcome, options.routingDisposition ?? null, age],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at)
     SELECT v.version_id, $3, v.job_id, 'h-' || v.version_id::text, 'Synthetic.', NOW() - $4::interval
       FROM unnest($1::uuid[], $2::uuid[]) AS v(job_id, version_id)`,
    [jobIds, versionIds, ctx().workspaceId, age],
  );
  await db().query(
    `UPDATE canonical_jobs c SET latest_job_version_id = v.version_id
       FROM unnest($1::uuid[], $2::uuid[]) AS v(job_id, version_id) WHERE c.id = v.job_id`,
    [jobIds, versionIds],
  );
  if (options.decider !== undefined) {
    await db().query(
      `INSERT INTO deterministic_decisions (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id, decision_hash, decision_json,
                                            recommendation_eligibility, recommendation_outcome, decider_version)
       SELECT $3, v.job_id, v.version_id, $4, 'stale-' || v.job_id::text, '{}'::jsonb, 'INELIGIBLE', $5, $6
         FROM unnest($1::uuid[], $2::uuid[]) AS v(job_id, version_id)`,
      [jobIds, versionIds, ctx().workspaceId, snapshotId, options.outcome === undefined ? "SKIP" : options.outcome, options.decider],
    );
    await db().query(
      `UPDATE canonical_jobs c SET latest_deterministic_decision_id = d.id
         FROM deterministic_decisions d WHERE d.canonical_job_id = c.id AND c.id = ANY($1::uuid[])`,
      [jobIds],
    );
  }
  return jobIds.map((jobId, index) => ({ jobId, versionId: versionIds[index]! }));
}

/** A live job whose posting is complete, so the real decider processes it. */
async function decidableJob(options: JobOptions): Promise<JobIds> {
  const [created] = await bulkJobs(1, options);
  await insertCompletePostingEvidence(db(), {
    workspaceId: ctx().workspaceId,
    jobVersionId: created!.versionId,
    companyName: "Seed Fixture Co",
    title: "fixture role",
    sourceUrl: `https://example.test/seed/${created!.jobId}`,
    description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });
  await db().query(`UPDATE job_versions SET description_text = $2 WHERE id = $1`, [created!.versionId, COMPLETE_TEST_POSTING_DESCRIPTION]);
  return created!;
}

async function archiveJobs(jobIds: string[]): Promise<void> {
  const run = await db().query<{ id: string }>(
    `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 day', 'DRY_RUN', 'SUCCEEDED') RETURNING id::text`,
  );
  await db().query(
    `UPDATE canonical_jobs SET archived_at = NOW(), archive_run_id = $2, archive_reason = 'fixture archive',
            archive_age_basis = 'HARD_REJECTED_DECISION', archive_reference_at = NOW() WHERE id = ANY($1::uuid[])`,
    [jobIds, run.rows[0]!.id],
  );
}

async function tasksFor(taskType: string, jobIds: string[]): Promise<number> {
  const rows = await db().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = $2 AND payload->>'canonical_job_id' = ANY($3::text[])`,
    [ctx().workspaceId, taskType, jobIds],
  );
  return rows.rows[0]?.n ?? 0;
}

describe("applyLiveJobScope", () => {
  it("adds the live-job terms right after the workspace filter, with the fixture term only when fixtures are excluded", () => {
    const sql = "SELECT c.id FROM canonical_jobs c WHERE c.workspace_id = $1 AND c.x = 1 ORDER BY c.id LIMIT $2";
    expect(applyLiveJobScope(sql, [1, 2], { includeTestFixtures: false }).sql).toBe(
      "SELECT c.id FROM canonical_jobs c WHERE c.workspace_id = $1 AND c.archived_at IS NULL AND c.is_test_fixture IS NOT TRUE AND c.x = 1 ORDER BY c.id LIMIT $2",
    );
    expect(applyLiveJobScope(sql, [1, 2], { includeTestFixtures: true }).sql).toContain("AND c.archived_at IS NULL AND c.x = 1");
    expect(applyLiveJobScope(sql, [1, 2], { includeTestFixtures: true }).sql).not.toContain("is_test_fixture");
  });

  it("refuses a seed query that has no canonical job anchor, so a new seed cannot skip the scope silently", () => {
    expect(() => applyLiveJobScope("SELECT 1 FROM raw_job_observations obs WHERE obs.workspace_id = $1 LIMIT $2", [1, 2], { includeTestFixtures: false }))
      .toThrow(/live-job scope/);
  });
});

const deciderTask = (job: JobIds, extra: Record<string, unknown> = {}) => db().query(
  `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status)
   VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'PENDING')`,
  [ctx().workspaceId, `DECIDE_RECOMMENDATION:${job.versionId}:t-${randomUUID()}`, JSON.stringify({ canonical_job_id: job.jobId, job_version_id: job.versionId, ...extra })],
);
const reassess = { repair_existing_state: true, reprocess_existing_state: true, reassessment_reason: deciderVersionReassessmentReason() };
const drain = (versionIds: string[], seed = true) => runPipelineStageTaskWorker(db(), {
  context: ctx(), seed, jobVersionIds: versionIds, taskTypes: ["DECIDE_RECOMMENDATION"],
  reconcileStalePending: false, maxTasks: 30, heartbeatSeconds: 0, seedTimeBudgetMs: 60_000,
});
const outcomeColumns = async (jobId: string) => (await db().query(
  `SELECT recommendation_outcome, recommendation_eligibility, recommendation_requirement_score, recommendation_coverage_score,
          recommendation_evidence_completeness, recommendation_decided_at, COALESCE(processing_state, processing_status) AS state
     FROM canonical_jobs WHERE id = $1`, [jobId])).rows[0];
const decisionCount = async (versionId: string) =>
  (await db().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM deterministic_decisions WHERE job_version_id = $1`, [versionId])).rows[0]!.n;
const staleIds = async (stage: string) => {
  const stale = await staleStageResults(db(), ctx().workspaceId);
  return { count: stale.detail?.[stage] ?? 0, sample: stale.sample.filter((entry) => entry.startsWith(`${stage}:`)) };
};

describe.skipIf(skipReal)("seed live filter, decider reassessment and stale-stage zero checks (PostgreSQL)", () => {
  // Every test gets its own schema, so no test depends on rows another one left behind.
  beforeEach(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `seed_live_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    const snapshot = await client.query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, resolved_snapshot) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
      [context.workspaceId, `snap-${randomUUID()}`],
    );
    snapshotId = snapshot.rows[0]!.id;
  }, 120_000);

  afterEach(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("(a) more archived older stale jobs than the cap never starve the live stale job: one pass seeds its EXTRACT and DECIDE tasks", async () => {
    const stale = { state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" };
    const archived = await bulkJobs(205, { ...stale, ageDays: 40 });
    const fixtures = await bulkJobs(10, { ...stale, ageDays: 41 });
    await archiveJobs(archived.map((job) => job.jobId));
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = ANY($1::uuid[])`, [fixtures.map((job) => job.jobId)]);
    const live = await decidableJob({ ...stale, ageDays: 1 });

    const summary = await seedRecoverablePipelineTasks(db(), {
      context: ctx(), taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS", "DECIDE_RECOMMENDATION"], maxSeedPerType: 5, timeBudgetMs: 60_000,
    });
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", [live.jobId])).toBe(1);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [live.jobId])).toBe(1);
    const others = [...archived, ...fixtures].map((job) => job.jobId);
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", others)).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", others)).toBe(0);
    expect(summary.skippedArchived).toBe(0);
    expect(summary.existing).toBe(0);
  }, 120_000);

  it("B3: live stale jobs the decider skips (incomplete posting), older than the cap, do not starve a decidable job: it is seeded in one pass", async () => {
    const stale = { state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" };
    const incomplete = await bulkJobs(8, { ...stale, ageDays: 40 });
    const live = await decidableJob({ ...stale, ageDays: 1 });
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], maxSeedPerType: 5, timeBudgetMs: 60_000 });
    expect(await tasksFor("DECIDE_RECOMMENDATION", incomplete.map((job) => job.jobId))).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [live.jobId])).toBe(1);
  }, 120_000);

  it("a seed row the enqueue refuses as archived is counted as skippedArchived, never as existing", async () => {
    // A live job whose latest version belongs to an archived job: the seed selects it, the enqueue guard refuses it.
    const [archivedOwner] = await bulkJobs(1, { state: "LANE_ROUTED", gate: "PASS", outcome: null, ageDays: 40 });
    await archiveJobs([archivedOwner!.jobId]);
    const [liveJob] = await bulkJobs(1, { state: "LANE_ROUTED", gate: "PASS", outcome: null, ageDays: 40 });
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [liveJob!.jobId, archivedOwner!.versionId]);
    const summary = await seedRecoverablePipelineTasks(db(), {
      context: ctx(), taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS"], maxSeedPerType: 5, timeBudgetMs: 60_000,
    });
    expect(summary.skippedArchived).toBeGreaterThanOrEqual(1);
    expect(summary.existing).toBe(0);
    expect(summary.inserted).toBe(0);
  }, 60_000);

  it("includeTestFixtures=true reaches a stale fixture job through the seed; false does not", async () => {
    const fixture = await decidableJob({ state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" });
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1`, [fixture.jobId]);
    const types = ["EXTRACT_DETERMINISTIC_REQUIREMENTS", "DECIDE_RECOMMENDATION"] as const;
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: [...types], timeBudgetMs: 60_000 });
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", [fixture.jobId])).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [fixture.jobId])).toBe(0);
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: [...types], includeTestFixtures: true, timeBudgetMs: 60_000 });
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", [fixture.jobId])).toBe(1);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [fixture.jobId])).toBe(1);
  }, 60_000);

  it("a live job whose only task is BLOCKED_DEPENDENCY stays in scope and does not starve the live job behind it", async () => {
    const stale = { state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" };
    const archived = await bulkJobs(20, { ...stale, ageDays: 40 });
    await archiveJobs(archived.map((job) => job.jobId));
    const blocked = await decidableJob({ ...stale, ageDays: 5 });
    const behind = await decidableJob({ ...stale, ageDays: 1 });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, blocked_on)
       VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'BLOCKED_DEPENDENCY', 'MATCH_PROFILE_EVIDENCE')`,
      [ctx().workspaceId, `DECIDE_RECOMMENDATION:${blocked.versionId}:blocked`, JSON.stringify({ canonical_job_id: blocked.jobId, job_version_id: blocked.versionId })],
    );
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], maxSeedPerType: 3, timeBudgetMs: 60_000 });
    expect(await tasksFor("DECIDE_RECOMMENDATION", [blocked.jobId])).toBeGreaterThanOrEqual(1);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [behind.jobId])).toBe(1);
  }, 120_000);

  it("every capped seed query carries the live-job scope before its LIMIT (all selectAndEnqueue seeds)", async () => {
    const recorded: string[] = [];
    const proxy = new Proxy(db(), {
      get(target, prop) {
        if (prop === "query") {
          return (...args: unknown[]) => {
            const text = typeof args[0] === "string" ? args[0] : "";
            if (/LIMIT\s+\$\d+\s*$/.test(text) && /FROM canonical_jobs c\b/.test(text)) recorded.push(text);
            return (target.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as pg.PoolClient;
    await seedRecoverablePipelineTasks(proxy, { context: ctx(), timeBudgetMs: 60_000 });
    // All selectAndEnqueue seeds except NORMALIZE_OBSERVATION select canonical jobs; the re-route seed needs a registry routing version.
    expect(recorded.length).toBeGreaterThanOrEqual(12);
    for (const text of recorded) {
      expect(text).toMatch(/WHERE c\.workspace_id = \$1 AND c\.archived_at IS NULL AND c\.is_test_fixture IS NOT TRUE/);
    }
  }, 120_000);

  it("B1: stale decisions the DECIDE seed cannot reach (UNMATCHED without a match run, LANE_ROUTED, PREQUALIFIED) are reported, never failed; the reachable HARD_REJECTED job drains to zero", async () => {
    const stale = { outcome: "SKIP", decider: "recommendation_decider_v1" };
    const unmatched = await decidableJob({ ...stale, state: "UNMATCHED", gate: "PASS", routingDisposition: "POLICY_NO_MATCH" });
    const laneRouted = await decidableJob({ ...stale, state: "LANE_ROUTED", gate: "PASS" });
    const prequalified = await decidableJob({ ...stale, state: "PREQUALIFIED", gate: "PASS" });
    const rejected = await decidableJob({ ...stale, state: "HARD_REJECTED", gate: "HARD_REJECT" });
    const noDecision = await decidableJob({ state: "UNMATCHED", gate: "PASS", outcome: "SKIP", routingDisposition: "POLICY_NO_MATCH" });
    const all = [unmatched, laneRouted, prequalified, rejected, noDecision];

    const before = await staleIds("decider");
    expect(before.sample).toEqual([`decider:${rejected.jobId}`]);
    const run = await drain(all.map((job) => job.versionId));
    expect(run.failed).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [unmatched, laneRouted, prequalified, noDecision].map((job) => job.jobId))).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [rejected.jobId])).toBe(1);

    expect((await staleIds("decider")).count).toBe(0);
    const reported = await reportedDecisionCounts(db(), ctx().workspaceId);
    expect(reported.unseeded_stale_decisions).toMatchObject({ UNMATCHED: 1, LANE_ROUTED: 1, PREQUALIFIED: 1 });
    expect(reported.outcome_without_latest_decision.UNMATCHED).toBe(1);
  }, 180_000);

  it("(b) a reachable HARD_REJECTED job with an old or NULL decider version ends with a stamped decision; its outcome columns are identical and a second run does not re-run it", async () => {
    const old = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: "recommendation_decider_v1" });
    const nul = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: null });
    const ids = [old, nul];
    const beforeColumns = await Promise.all(ids.map((job) => outcomeColumns(job.jobId)));
    expect((await staleIds("decider")).count).toBe(2);

    expect((await drain(ids.map((job) => job.versionId))).failed).toBe(0);
    for (const [index, job] of ids.entries()) {
      const row = await db().query<{ decider_version: string | null }>(
        `SELECT d.decider_version FROM canonical_jobs c JOIN deterministic_decisions d ON d.id = c.latest_deterministic_decision_id WHERE c.id = $1`, [job.jobId]);
      expect(row.rows[0]!.decider_version).toBe(DECIDER_VERSION);
      expect(await outcomeColumns(job.jobId)).toEqual(beforeColumns[index]);
    }
    expect((await staleIds("decider")).count).toBe(0);
    const missing = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    expect(missing.byTaskType.DECIDE_RECOMMENDATION ?? 0).toBe(0);

    // Repeat: the version-scoped task key holds, so nothing is queued or decided again.
    const decisionsAfterFirst = await Promise.all(ids.map((job) => decisionCount(job.versionId)));
    const seeded = await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: ids.map((job) => job.versionId), timeBudgetMs: 60_000 });
    expect(seeded.inserted).toBe(0);
    await drain(ids.map((job) => job.versionId));
    expect(await Promise.all(ids.map((job) => decisionCount(job.versionId)))).toEqual(decisionsAfterFirst);
  }, 180_000);

  it("B2: a terminal job whose stored outcome the decider would change is left untouched: no decision, no column change, a visible failure", async () => {
    // Stored REVIEW on a HARD_REJECTED job (an illegal state): the decider recomputes SKIP.
    const reviewOnRejected = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "REVIEW", decider: "recommendation_decider_v1" });
    const staleGate = await decidableJob({ state: "HARD_REJECTED", gate: "PASS", outcome: "SKIP", decider: "recommendation_decider_v1" });
    await db().query(`UPDATE canonical_jobs SET gate_decision = NULL WHERE id = $1`, [staleGate.jobId]);
    const unmatchedNullDisposition = await decidableJob({ state: "UNMATCHED", gate: "PASS", outcome: "SKIP", routingDisposition: null, decider: "recommendation_decider_v1" });
    const jobs = [reviewOnRejected, staleGate, unmatchedNullDisposition];
    const before = await Promise.all(jobs.map((job) => outcomeColumns(job.jobId)));
    const decisionsBefore = await Promise.all(jobs.map((job) => decisionCount(job.versionId)));
    for (const job of jobs) await deciderTask(job, reassess);

    await drain(jobs.map((job) => job.versionId), false);

    for (const [index, job] of jobs.entries()) {
      expect(await outcomeColumns(job.jobId)).toEqual(before[index]);
    }
    // The conflicting job gets no decision row and its task did not complete.
    expect(await decisionCount(reviewOnRejected.versionId)).toBe(decisionsBefore[0]);
    const task = await db().query<{ status: string }>(`SELECT status FROM pipeline_tasks WHERE payload->>'job_version_id' = $1`, [reviewOnRejected.versionId]);
    expect(task.rows[0]!.status).not.toBe("COMPLETED");
    // A decision for the other two is written only if it agrees with the stored outcome: the columns above are identical either way.
    for (const [index, job] of [staleGate, unmatchedNullDisposition].entries()) {
      const written = (await decisionCount(job.versionId)) - decisionsBefore[index + 1]!;
      const row = await db().query<{ status: string }>(`SELECT status FROM pipeline_tasks WHERE payload->>'job_version_id' = $1`, [job.versionId]);
      expect(row.rows[0]!.status === "COMPLETED" ? written : -written).toBeGreaterThanOrEqual(row.rows[0]!.status === "COMPLETED" ? 1 : 0);
    }
    // Still flagged by the zero check, so the conflict cannot go unnoticed.
    expect((await staleIds("decider")).sample).toContain(`decider:${reviewOnRejected.jobId}`);
  }, 180_000);

  it("a terminal job with a decision is not re-run by a task that is only reprocess_existing_state (a rematch successor)", async () => {
    const job = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: DECIDER_VERSION });
    const before = await decisionCount(job.versionId);
    await deciderTask(job, { reprocess_existing_state: true, repair_existing_state: true });
    const run = await drain([job.versionId], false);
    expect(run.failed).toBe(0);
    expect(await decisionCount(job.versionId)).toBe(before);
  }, 120_000);

  it("(d) a terminal job with a decision completes as a legitimate no-op and is not flagged; one without a decision runs the decider; a real missing result is flagged", async () => {
    const decided = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: DECIDER_VERSION });
    const undecided = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP" });
    for (const job of [decided, undecided]) await deciderTask(job);
    const decidedBefore = await decisionCount(decided.versionId);
    expect((await drain([decided.versionId, undecided.versionId], false)).failed).toBe(0);
    expect(await decisionCount(decided.versionId)).toBe(decidedBefore);
    expect(await decisionCount(undecided.versionId)).toBeGreaterThanOrEqual(1);
    const report = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    expect(report.sample.map((row) => row.jobVersionId)).not.toContain(decided.versionId);
    expect(report.sample.map((row) => row.jobVersionId)).not.toContain(undecided.versionId);

    const orphan = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP" });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, completed_at) VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'COMPLETED', NOW())`,
      [ctx().workspaceId, `DECIDE_RECOMMENDATION:${orphan.versionId}:orphan`, JSON.stringify({ canonical_job_id: orphan.jobId, job_version_id: orphan.versionId })],
    );
    expect((await findTasksCompletedWithoutResult(db(), ctx().workspaceId)).sample.map((row) => row.jobVersionId)).toContain(orphan.versionId);
  }, 120_000);

  it("gate stage: reported for an older gate version; not reported at the running version, or with a gate task in flight", async () => {
    const job = await decidableJob({ state: "NEEDS_VERIFICATION", gate: "NEEDS_VERIFICATION", outcome: "TRACK", decider: DECIDER_VERSION });
    await db().query(
      `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, gate_version, decision) VALUES ($1, $2, $3, 'gate-2020-01.1', 'NEEDS_VERIFICATION')`,
      [ctx().workspaceId, job.jobId, job.versionId],
    );
    expect((await staleIds("gate")).sample).toEqual([`gate:${job.jobId}`]);
    expect((await staleIds("decider")).count).toBe(0);

    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status) VALUES ($1, 'APPLY_HARD_GATES', $2, $3::jsonb, 'PENDING')`,
      [ctx().workspaceId, `APPLY_HARD_GATES:${job.versionId}:inflight`, JSON.stringify({ canonical_job_id: job.jobId, job_version_id: job.versionId })],
    );
    expect((await staleIds("gate")).count).toBe(0);
    await db().query(`DELETE FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'APPLY_HARD_GATES'`, [ctx().workspaceId]);
    expect((await staleIds("gate")).count).toBe(1);
    await db().query(`UPDATE gate_decisions SET gate_version = $2 WHERE job_version_id = $1`, [job.versionId, GATE_VERSION]);
    expect((await staleIds("gate")).count).toBe(0);
  }, 120_000);
});
