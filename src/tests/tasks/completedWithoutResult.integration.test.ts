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

if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the completed-without-result tests against its PostgreSQL service.");
}

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
  }, 60_000);

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
  it("a task the worker closes without a result by design is not reported; the same task on a job that should have one is", async () => {
    const setState = (canonicalJobId: string, state: string) => db().query(
      `UPDATE canonical_jobs SET processing_state = $2, processing_status = $2 WHERE id = $1`, [canonicalJobId, state]);
    const designed: string[] = [];
    for (const state of ["UNMATCHED", "ROUTING_DEFERRED", "NEEDS_VERIFICATION", "HARD_REJECTED"]) {
      const j = await job();
      await setState(j.canonicalJobId, state);
      designed.push(await completedTask("MATCH_PROFILE_EVIDENCE", j.jobVersionId));
    }
    for (const state of ["RAW_STAGED", "PREQUALIFIED"]) {
      const j = await job();
      await setState(j.canonicalJobId, state);
      designed.push(await completedTask("DECIDE_RECOMMENDATION", j.jobVersionId));
    }
    const shouldHaveMatch = await job();
    await setState(shouldHaveMatch.canonicalJobId, "LANE_ROUTED");
    const missingMatch = await completedTask("MATCH_PROFILE_EVIDENCE", shouldHaveMatch.jobVersionId);
    const rejectedNoDecision = await job();
    await setState(rejectedNoDecision.canonicalJobId, "HARD_REJECTED");
    const missingDecision = await completedTask("DECIDE_RECOMMENDATION", rejectedNoDecision.jobVersionId);
    const reported = (await findTasksCompletedWithoutResult(db(), ctx().workspaceId, { sampleLimit: 200 })).sample.map((row) => row.taskId);
    for (const taskId of designed) expect(reported).not.toContain(taskId);
    expect(reported).toContain(missingMatch);
    expect(reported).toContain(missingDecision);
  });

  it("a match task with a match run is not reported; a technically deferred route is not reported", async () => {
    const matched = await job();
    const matchTask = await completedTask("MATCH_PROFILE_EVIDENCE", matched.jobVersionId);
    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, $2, 'Fixture') RETURNING id`,
      [ctx().workspaceId, `fixture-${randomUUID()}`],
    );
    const version = await db().query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'DRAFT', NOW()) RETURNING id`,
      [ctx().workspaceId, profile.rows[0]!.id, `fixture-${randomUUID()}`],
    );
    await db().query(
      `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, status, requirement_count, matched_count, policy_version, job_content_hash, context_fingerprint)
       VALUES ($1, $2, $3, $4, 'COMPLETED', 1, 1, 'fixture', 'h', 'fp')`,
      [ctx().workspaceId, matched.canonicalJobId, matched.jobVersionId, version.rows[0]!.id],
    );
    const deferred = await job();
    const routeTask = await completedTask("ROUTE_LANE", deferred.jobVersionId);
    await db().query(`UPDATE canonical_jobs SET processing_state = 'ROUTING_DEFERRED', processing_status = 'ROUTING_DEFERRED' WHERE id = $1`, [deferred.canonicalJobId]);
    const reported = (await findTasksCompletedWithoutResult(db(), ctx().workspaceId, { sampleLimit: 200 })).sample.map((row) => row.taskId);
    expect(reported).not.toContain(matchTask);
    expect(reported).not.toContain(routeTask);
  });
});

describe("exit code and predicate map", () => {
  it("is non-zero when any task completed without a result, zero otherwise", () => {
    expect(completedWithoutResultExitCode({ total: 0 })).toBe(0);
    expect(completedWithoutResultExitCode({ total: 1 })).toBe(1);
  });

  it("checks exactly the task types it has a result predicate for", () => {
    expect([...COMPLETED_RESULT_TASK_TYPES].sort()).toEqual(Object.keys(COMPLETED_RESULT_PREDICATES).sort());
    // Not circular: each predicate looks in the table that holds that stage's result.
    const table: Record<string, string> = {
      APPLY_HARD_GATES: "gate_decisions", ROUTE_LANE: "lane_decisions",
      MATCH_PROFILE_EVIDENCE: "match_runs", DECIDE_RECOMMENDATION: "deterministic_decisions",
    };
    for (const [type, name] of Object.entries(table)) expect(COMPLETED_RESULT_PREDICATES[type]).toContain(`FROM ${name} result`);
    expect(COMPLETED_RESULT_TASK_TYPES).toEqual(["APPLY_HARD_GATES", "ROUTE_LANE", "MATCH_PROFILE_EVIDENCE", "DECIDE_RECOMMENDATION", "RECHECK_AVAILABILITY"]);
    expect(COMPLETED_RESULT_PREDICATES.RECHECK_AVAILABILITY).toContain("FROM job_availability_recheck_events result");
  });
});
