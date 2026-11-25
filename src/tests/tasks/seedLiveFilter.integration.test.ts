import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { DECIDER_VERSION, deciderVersionReassessmentReason } from "../../pipeline/deciderVersion.js";
import { findTasksCompletedWithoutResult } from "../../tasks/completedWithoutResult.js";
import { staleStageResults } from "../../tasks/integrityZeroChecks.js";
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

describe.skipIf(skipReal)("seed live filter, decider reassessment and stale-stage zero checks (PostgreSQL)", () => {
  beforeAll(async () => {
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

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("(a) more archived older stale jobs than the cap never starve the live stale job: one pass seeds its EXTRACT and DECIDE tasks", async () => {
    const cap = 5;
    const stale = { state: "ROUTING_DEFERRED", gate: "PASS", outcome: "REVIEW", decider: "recommendation_decider_v0" };
    const archived = await bulkJobs(205, { ...stale, ageDays: 40 });
    const fixtures = await bulkJobs(10, { ...stale, ageDays: 41 });
    await archiveJobs(archived.map((job) => job.jobId));
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = ANY($1::uuid[])`, [fixtures.map((job) => job.jobId)]);
    const [live] = await bulkJobs(1, { ...stale, ageDays: 1 });

    const summary = await seedRecoverablePipelineTasks(db(), {
      context: ctx(),
      taskTypes: ["EXTRACT_DETERMINISTIC_REQUIREMENTS", "DECIDE_RECOMMENDATION"],
      maxSeedPerType: cap,
      timeBudgetMs: 60_000,
    });

    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", [live!.jobId])).toBe(1);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [live!.jobId])).toBe(1);
    expect(await tasksFor("EXTRACT_DETERMINISTIC_REQUIREMENTS", [...archived, ...fixtures].map((job) => job.jobId))).toBe(0);
    expect(await tasksFor("DECIDE_RECOMMENDATION", [...archived, ...fixtures].map((job) => job.jobId))).toBe(0);
    // Archived jobs never reach the enqueue, so nothing hides behind the "existing" counter.
    expect(summary.skippedArchived).toBe(0);
    expect(summary.existing).toBe(0);
  }, 120_000);

  it("(b)+(c) HARD_REJECTED and UNMATCHED live jobs with an old or NULL decider version end with a stamped decision after the queue drains, outcome and state unchanged", async () => {
    const rejectedOld = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: "recommendation_decider_v1" });
    const rejectedNull = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: null });
    const unmatchedOld = await decidableJob({ state: "UNMATCHED", gate: "PASS", outcome: "SKIP", routingDisposition: "POLICY_NO_MATCH", decider: "recommendation_decider_v1" });
    const unmatchedNull = await decidableJob({ state: "UNMATCHED", gate: "PASS", outcome: "SKIP", routingDisposition: "POLICY_NO_MATCH", decider: null });
    const jobs = [rejectedOld, rejectedNull, unmatchedOld, unmatchedNull];
    const ids = jobs.map((job) => job.jobId);
    const versionIds = jobs.map((job) => job.versionId);

    // (c) before the drain: the zero check reports each live decided job whose decision is stale.
    const before = await staleStageResults(db(), ctx().workspaceId);
    expect(before.detail?.decider).toBeGreaterThanOrEqual(4);

    // The DECIDE seed reaches a job outside HARD_REJECTED/NEEDS_VERIFICATION/ROUTING_DEFERRED only through a current match run
    // (an UNMATCHED job has one in production; this fixture has none), so those two get the task the seed would build.
    for (const job of [unmatchedOld, unmatchedNull]) {
      await db().query(
        `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status)
         VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'PENDING')`,
        [ctx().workspaceId, `DECIDE_RECOMMENDATION:${job.versionId}:reassess`, JSON.stringify({
          canonical_job_id: job.jobId, job_version_id: job.versionId, repair_existing_state: true, reprocess_existing_state: true,
          reassessment_reason: deciderVersionReassessmentReason(),
        })],
      );
    }
    const run = await runPipelineStageTaskWorker(db(), {
      context: ctx(), seed: true, jobVersionIds: versionIds, taskTypes: ["DECIDE_RECOMMENDATION"],
      reconcileStalePending: false, maxTasks: 20, heartbeatSeconds: 0, seedTimeBudgetMs: 60_000,
    });
    expect(run.failed).toBe(0);

    const after = await db().query<{ id: string; processing_state: string; recommendation_outcome: string; decider_version: string | null; latest_ok: boolean }>(
      `SELECT c.id::text, COALESCE(c.processing_state, c.processing_status) AS processing_state, c.recommendation_outcome,
              d.decider_version, (c.latest_deterministic_decision_id = d.id) AS latest_ok
         FROM canonical_jobs c
         JOIN deterministic_decisions d ON d.id = c.latest_deterministic_decision_id
        WHERE c.id = ANY($1::uuid[])`,
      [ids],
    );
    expect(after.rows).toHaveLength(4);
    for (const row of after.rows) {
      expect(row.decider_version).toBe(DECIDER_VERSION);
      expect(row.recommendation_outcome).toBe("SKIP");
    }
    const states = Object.fromEntries(after.rows.map((row) => [row.id, row.processing_state]));
    expect(states[rejectedOld.jobId]).toBe("HARD_REJECTED");
    expect(states[rejectedNull.jobId]).toBe("HARD_REJECTED");
    expect(states[unmatchedOld.jobId]).toBe("UNMATCHED");
    expect(states[unmatchedNull.jobId]).toBe("UNMATCHED");

    const stale = await staleStageResults(db(), ctx().workspaceId);
    const staleDeciderIds = stale.sample.filter((entry) => entry.startsWith("decider:"));
    for (const id of ids) expect(staleDeciderIds).not.toContain(`decider:${id}`);
    expect(stale.detail?.decider).toBe(0);

    // The drained DECIDE tasks have their result row: nothing completed without a result.
    const missing = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    expect(missing.byTaskType.DECIDE_RECOMMENDATION ?? 0).toBe(0);
  }, 180_000);

  it("(c) the gate stage of the stale-stage check reports a live job gated under an older gate version", async () => {
    const job = await decidableJob({ state: "NEEDS_VERIFICATION", gate: "NEEDS_VERIFICATION", outcome: "TRACK", decider: DECIDER_VERSION });
    await db().query(
      `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, gate_version, decision) VALUES ($1, $2, $3, 'gate-2020-01.1', 'NEEDS_VERIFICATION')`,
      [ctx().workspaceId, job.jobId, job.versionId],
    );
    const stale = await staleStageResults(db(), ctx().workspaceId);
    expect(stale.detail?.gate).toBeGreaterThanOrEqual(1);
    expect(stale.detail?.decider).toBe(0);
  }, 60_000);

  it("(d) a terminal job that already has a decision completes its DECIDE task as a legitimate no-op and is not flagged; one without a decision runs the decider and is not flagged either", async () => {
    const decided = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP", decider: DECIDER_VERSION });
    const undecided = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP" });
    const versionIds = [decided.versionId, undecided.versionId];
    for (const job of [decided, undecided]) {
      await db().query(
        `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status)
         VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'PENDING')`,
        [ctx().workspaceId, `DECIDE_RECOMMENDATION:${job.versionId}:manual`, JSON.stringify({ canonical_job_id: job.jobId, job_version_id: job.versionId })],
      );
    }
    const decisionsBefore = await db().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM deterministic_decisions WHERE job_version_id = $1`, [decided.versionId]);

    const run = await runPipelineStageTaskWorker(db(), {
      context: ctx(), seed: false, jobVersionIds: versionIds, taskTypes: ["DECIDE_RECOMMENDATION"],
      reconcileStalePending: false, maxTasks: 10, heartbeatSeconds: 0,
    });
    expect(run.failed).toBe(0);

    const decisionsAfter = await db().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM deterministic_decisions WHERE job_version_id = $1`, [decided.versionId]);
    expect(decisionsAfter.rows[0]!.n).toBe(decisionsBefore.rows[0]!.n); // the no-op wrote nothing
    const undecidedRows = await db().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM deterministic_decisions WHERE job_version_id = $1`, [undecided.versionId]);
    expect(undecidedRows.rows[0]!.n).toBeGreaterThanOrEqual(1);

    const report = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    expect(report.sample.map((row) => row.jobVersionId)).not.toContain(decided.versionId);
    expect(report.sample.map((row) => row.jobVersionId)).not.toContain(undecided.versionId);
  }, 120_000);

  it("(d) a real missing result is still flagged", async () => {
    const job = await decidableJob({ state: "HARD_REJECTED", gate: "HARD_REJECT", outcome: "SKIP" });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, completed_at)
       VALUES ($1, 'DECIDE_RECOMMENDATION', $2, $3::jsonb, 'COMPLETED', NOW())`,
      [ctx().workspaceId, `DECIDE_RECOMMENDATION:${job.versionId}:orphan`, JSON.stringify({ canonical_job_id: job.jobId, job_version_id: job.versionId })],
    );
    const report = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    expect(report.sample.map((row) => row.jobVersionId)).toContain(job.versionId);
  }, 60_000);
});
