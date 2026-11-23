import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import {
  COMPLETED_RESULT_PREDICATES,
  COMPLETED_RESULT_TASK_TYPES,
  completedWithoutResultExitCode,
  findTasksCompletedWithoutResult,
} from "../../tasks/completedWithoutResult.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// "Task completed, no result" is reported as an error. Synthetic jobs and tasks only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };
const ctx = (): WorkspaceContext => { if (!context) throw new Error("not initialised"); return context; };

async function job(): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status)
     VALUES ($1, $2, 'Result Fixture Co', 'fixture role', $3, 'MATCHED', 'MATCHED')`,
    [canonicalJobId, ctx().workspaceId, `https://example.test/r/${canonicalJobId}`],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at)
     VALUES ($1, $2, $3, $4, 'Synthetic.', NOW())`,
    [jobVersionId, ctx().workspaceId, canonicalJobId, `h-${jobVersionId}`],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  return { canonicalJobId, jobVersionId };
}

async function completedTask(taskType: string, jobVersionId: string, repairAction: string | null = null): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO pipeline_tasks (id, workspace_id, task_type, task_key, payload, status, completed_at, repair_action)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'COMPLETED', NOW(), $6)`,
    [id, ctx().workspaceId, taskType, `${taskType}:${jobVersionId}:${id}`, JSON.stringify({ job_version_id: jobVersionId }), repairAction],
  );
  return id;
}

describe.skipIf(skipReal)("tasks completed without a result (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `completed_no_result_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("reports a completed stage with no result, and nothing else", async () => {
    const missing = await job();
    const missingTask = await completedTask("MATCH_PROFILE_EVIDENCE", missing.jobVersionId);
    const missingDecision = await completedTask("DECIDE_RECOMMENDATION", missing.jobVersionId);

    const closedWithoutRunning = await job();
    await completedTask("DECIDE_RECOMMENDATION", closedWithoutRunning.jobVersionId, "RECONCILED_PROVEN_SATISFIED");

    const archived = await job();
    await db().query(
      `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING')`,
    );
    await completedTask("MATCH_PROFILE_EVIDENCE", archived.jobVersionId);
    const run = await db().query<{ id: string }>(`SELECT id::text FROM job_archive_runs ORDER BY created_at DESC LIMIT 1`);
    await db().query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = 'POSTING_NOT_CONFIRMABLE',
              archive_age_basis = 'POSTING_LINK_UNVERIFIABLE', archive_reference_at = NOW(), archive_run_id = $2 WHERE id = $1`,
      [archived.canonicalJobId, run.rows[0]!.id],
    );

    const superseded = await job();
    await completedTask("DECIDE_RECOMMENDATION", superseded.jobVersionId);
    const newerVersion = randomUUID();
    await db().query(
      `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at)
       VALUES ($1, $2, $3, $4, 'Newer.', NOW())`,
      [newerVersion, ctx().workspaceId, superseded.canonicalJobId, `h-${newerVersion}`],
    );
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [newerVersion, superseded.canonicalJobId]);

    const complete = await job();
    const matchRunId = randomUUID();
    const withResult = await completedTask("DECIDE_RECOMMENDATION", complete.jobVersionId);
    const policy = await db().query<{ id: string }>(
      `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, schema_version, resolved_snapshot) VALUES ($1, $2, '2.2.0', '{}'::jsonb) RETURNING id`,
      [ctx().workspaceId, `snap-${matchRunId}`],
    );
    await db().query(
      `INSERT INTO deterministic_decisions (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id, decision_hash, schema_version, decision_json, recommendation_eligibility, recommendation_outcome, context_fingerprint)
       VALUES ($1, $2, $3, $5, $4, '2.2.0', '{}'::jsonb, 'ELIGIBLE', 'TRACK', $4)`,
      [ctx().workspaceId, complete.canonicalJobId, complete.jobVersionId, matchRunId, policy.rows[0]!.id],
    );

    const report = await findTasksCompletedWithoutResult(db(), ctx().workspaceId);
    const reported = report.sample.map((row) => row.taskId).sort();
    expect(reported).toContain(missingTask);
    expect(reported).toContain(missingDecision);
    expect(reported).not.toContain(withResult);
    for (const row of report.sample) {
      expect([archived.jobVersionId, superseded.jobVersionId, closedWithoutRunning.jobVersionId]).not.toContain(row.jobVersionId);
    }
    expect(report.total).toBe(2);
    expect(report.byTaskType).toEqual({ MATCH_PROFILE_EVIDENCE: 1, DECIDE_RECOMMENDATION: 1 });
  });

  it("gate and lane tasks: missing result is reported, present result is not, and a result for another version of the job does not count", async () => {
    const withResults = await job();
    const gateOk = await completedTask("APPLY_HARD_GATES", withResults.jobVersionId);
    const laneOk = await completedTask("ROUTE_LANE", withResults.jobVersionId);
    await db().query(
      `INSERT INTO gate_decisions (canonical_job_id, job_version_id, decision, workspace_id) VALUES ($1, $2, 'PASS', $3)`,
      [withResults.canonicalJobId, withResults.jobVersionId, ctx().workspaceId],
    );
    await db().query(
      `INSERT INTO lane_decisions (workspace_id, canonical_job_id, job_version_id, decision_hash, model_version, lane_snapshot, decision_json)
       VALUES ($1, $2, $3, $4, 'fixture', '{}'::jsonb, '{}'::jsonb)`,
      [ctx().workspaceId, withResults.canonicalJobId, withResults.jobVersionId, `lane-${withResults.jobVersionId}`],
    );

    const none = await job();
    const gateMissing = await completedTask("APPLY_HARD_GATES", none.jobVersionId);
    const laneMissing = await completedTask("ROUTE_LANE", none.jobVersionId);

    // The old version of this job has both results; the current version has none.
    const moved = await job();
    await db().query(
      `INSERT INTO gate_decisions (canonical_job_id, job_version_id, decision, workspace_id) VALUES ($1, $2, 'PASS', $3)`,
      [moved.canonicalJobId, moved.jobVersionId, ctx().workspaceId],
    );
    await db().query(
      `INSERT INTO lane_decisions (workspace_id, canonical_job_id, job_version_id, decision_hash, model_version, lane_snapshot, decision_json)
       VALUES ($1, $2, $3, $4, 'fixture', '{}'::jsonb, '{}'::jsonb)`,
      [ctx().workspaceId, moved.canonicalJobId, moved.jobVersionId, `lane-${moved.jobVersionId}`],
    );
    const currentVersion = randomUUID();
    await db().query(
      `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Newer.', NOW())`,
      [currentVersion, ctx().workspaceId, moved.canonicalJobId, `h-${currentVersion}`],
    );
    await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [currentVersion, moved.canonicalJobId]);
    const gateOnCurrent = await completedTask("APPLY_HARD_GATES", currentVersion);
    const laneOnCurrent = await completedTask("ROUTE_LANE", currentVersion);

    const reported = (await findTasksCompletedWithoutResult(db(), ctx().workspaceId, { sampleLimit: 200 })).sample.map((row) => row.taskId);
    expect(reported).toEqual(expect.arrayContaining([gateMissing, laneMissing, gateOnCurrent, laneOnCurrent]));
    expect(reported).not.toContain(gateOk);
    expect(reported).not.toContain(laneOk);
  });
});

describe("exit code and predicate map", () => {
  it("is non-zero when any task completed without a result, zero otherwise", () => {
    expect(completedWithoutResultExitCode({ total: 0 })).toBe(0);
    expect(completedWithoutResultExitCode({ total: 1 })).toBe(1);
  });

  it("checks exactly the task types it has a result predicate for", () => {
    expect([...COMPLETED_RESULT_TASK_TYPES].sort()).toEqual(Object.keys(COMPLETED_RESULT_PREDICATES).sort());
    expect(COMPLETED_RESULT_TASK_TYPES).toEqual(["APPLY_HARD_GATES", "ROUTE_LANE", "MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION"]);
  });
});
