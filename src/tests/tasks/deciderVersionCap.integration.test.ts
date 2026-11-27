import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { DECIDER_VERSION, deciderVersionReassessmentReason } from "../../pipeline/deciderVersion.js";
import { seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from "../fixtures/completePostingEvidence.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// The decider-version seed under a per-run cap. The readiness-refresh arm of the same seed query is switched off by dropping
// the readiness view in this test's own schema, so only the decider-version arm can select a job and the cap is decisive:
// archived and fixture jobs (oldest) must not take the single slot ahead of the live job.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the decider-version cap integration test against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const db = (): pg.PoolClient => {
  if (!client) throw new Error("The test database is not initialized.");
  return client;
};
const ctx = (): WorkspaceContext => {
  if (!context) throw new Error("The test workspace is not initialized.");
  return context;
};

async function decidedJob(deciderVersion: string | null): Promise<{ jobId: string; versionId: string }> {
  const jobId = randomUUID();
  const versionId = randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status,
                                 gate_decision, recommendation_eligibility, recommendation_outcome)
     VALUES ($1, $2, 'Cap Fixture', 'Fixture Role', $3, 'NEEDS_VERIFICATION', 'NEEDS_VERIFICATION', 'PASS', 'ELIGIBLE', 'REVIEW')`,
    [jobId, ctx().workspaceId, `https://example.test/cap/${jobId}`],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'cap fixture', NOW())`,
    [versionId, ctx().workspaceId, jobId, `hash-${versionId}`],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [jobId, versionId]);
  // The DECIDE seed selects only what the decider can process: a complete posting with source content.
  await db().query(`UPDATE job_versions SET description_text = $2 WHERE id = $1`, [versionId, COMPLETE_TEST_POSTING_DESCRIPTION]);
  await insertCompletePostingEvidence(db(), {
    workspaceId: ctx().workspaceId, jobVersionId: versionId, companyName: "Cap Fixture", title: "Fixture Role",
    sourceUrl: `https://example.test/cap/${jobId}`, description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });
  const snapshot = await db().query<{ id: string }>(
    `INSERT INTO workspace_policy_snapshots (workspace_id, snapshot_hash, resolved_snapshot) VALUES ($1, $2, '{}'::jsonb) RETURNING id`,
    [ctx().workspaceId, `snap-${jobId}`],
  );
  const decision = await db().query<{ id: string }>(
    `INSERT INTO deterministic_decisions (workspace_id, canonical_job_id, job_version_id, policy_snapshot_id, decision_hash, decision_json,
                                          recommendation_eligibility, recommendation_outcome, decider_version)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'ELIGIBLE', 'REVIEW', $6) RETURNING id`,
    [ctx().workspaceId, jobId, versionId, snapshot.rows[0]!.id, `decision-${jobId}`, deciderVersion],
  );
  await db().query(`UPDATE canonical_jobs SET latest_deterministic_decision_id = $2 WHERE id = $1`, [jobId, decision.rows[0]!.id]);
  return { jobId, versionId };
}

async function deciderVersionTasks(jobIds: string[]): Promise<number> {
  const rows = await db().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pipeline_tasks
      WHERE workspace_id = $1 AND task_type = 'DECIDE_RECOMMENDATION' AND payload->>'canonical_job_id' = ANY($2::text[])
        AND payload->>'reassessment_reason' = $3`,
    [ctx().workspaceId, jobIds, deciderVersionReassessmentReason()],
  );
  return rows.rows[0]?.n ?? 0;
}

describe.skipIf(skipReal)("decider-version seed cap (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `decider_cap_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    // Switch off the readiness-refresh arm of the seed query (it would otherwise also select these fixtures).
    await client.query("DROP VIEW IF EXISTS v_application_readiness_current CASCADE");
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("with a cap of 1, archived and fixture jobs (the oldest) never take the slot: the live job is seeded", async () => {
    const archived = await decidedJob("recommendation_decider_v0");
    const fixture = await decidedJob("recommendation_decider_v0");
    const live = await decidedJob("recommendation_decider_v0");
    const archiveRun = randomUUID();
    await db().query(
      `INSERT INTO job_archive_runs (id, run_started_at, cutoff_at, mode, status) VALUES ($1, NOW(), NOW() - INTERVAL '1 day', 'DRY_RUN', 'SUCCEEDED')`,
      [archiveRun],
    );
    await db().query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_run_id = $2, archive_reason = 'fixture archive',
              archive_age_basis = 'HARD_REJECTED_DECISION', archive_reference_at = NOW() WHERE id = $1`,
      [archived.jobId, archiveRun],
    );
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1`, [fixture.jobId]);
    await db().query(`UPDATE canonical_jobs SET updated_at = NOW() - INTERVAL '2 days' WHERE id = ANY($1::uuid[])`, [[archived.jobId, fixture.jobId]]);

    await seedRecoverablePipelineTasks(db(), {
      context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"],
      jobVersionIds: [archived.versionId, fixture.versionId, live.versionId], maxSeedPerType: 1,
    });
    expect(await deciderVersionTasks([archived.jobId, fixture.jobId])).toBe(0);
    expect(await deciderVersionTasks([live.jobId])).toBe(1);
  }, 60_000);

  it("a job decided under an earlier decider version is re-seeded for DECIDE; one at the current version is not", async () => {
    expect(DECIDER_VERSION).toBe("recommendation_decider_v4");
    const old = await decidedJob("recommendation_decider_v3");
    const current = await decidedJob(DECIDER_VERSION);
    await seedRecoverablePipelineTasks(db(), {
      context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: [old.versionId, current.versionId], maxSeedPerType: 10,
    });
    expect(await deciderVersionTasks([old.jobId])).toBe(1);
    expect(await deciderVersionTasks([current.jobId])).toBe(0);
  }, 60_000);

  it("a current-version job is never seeded", async () => {
    const current = await decidedJob(DECIDER_VERSION);
    await seedRecoverablePipelineTasks(db(), { context: ctx(), taskTypes: ["DECIDE_RECOMMENDATION"], jobVersionIds: [current.versionId], maxSeedPerType: 10 });
    expect(await deciderVersionTasks([current.jobId])).toBe(0);
  }, 60_000);
});
