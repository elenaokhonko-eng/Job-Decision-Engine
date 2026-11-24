import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { loadBlindReviewPool } from "../../reporting/blindReviewPool.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// The blind review pool: only jobs the Review list could show are drawn. Synthetic jobs only. The availability read model is
// replaced in the schema of this test by a table-backed view so each job can be set open or closed directly.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the blind review pool integration test against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
let profileVersionId = "";
const db = (): pg.PoolClient => {
  if (!client) throw new Error("The test database is not initialized.");
  return client;
};
const ctx = (): WorkspaceContext => {
  if (!context) throw new Error("The test workspace is not initialized.");
  return context;
};

interface JobOptions {
  quality?: "COMPLETE" | "INCOMPLETE";
  open?: boolean;
  gate?: string;
  state?: string;
  outcome?: string | null;
  fixture?: boolean;
  archived?: boolean;
}

async function seedScoredJob(options: JobOptions = {}): Promise<string> {
  const jobId = randomUUID();
  const versionId = randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status,
                                 gate_decision, description_quality_status, recommendation_requirement_score, recommendation_outcome, is_test_fixture)
     VALUES ($1, $2, 'Blind Fixture', 'Fixture Role', $3, $4, $4, $5, $6, 0.7, $7, $8)`,
    [jobId, ctx().workspaceId, `https://example.test/blind/${jobId}`, options.state ?? "MATCHED", options.gate ?? "PASS",
      options.quality ?? "COMPLETE", options.outcome === undefined ? "REVIEW" : options.outcome, options.fixture === true],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'fixture', NOW())`,
    [versionId, ctx().workspaceId, jobId, `hash-${versionId}`],
  );
  const run = await db().query<{ id: string }>(
    `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, job_content_hash, context_fingerprint, status,
                             requirement_count, matched_count, policy_version, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETED', 5, 3, 'deterministic_v3_topk_capability_semantic_v1', NOW()) RETURNING id`,
    [ctx().workspaceId, jobId, versionId, profileVersionId, `hash-${versionId}`, `ctx-${versionId}`],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $2, latest_match_run_id = $3 WHERE id = $1`, [jobId, versionId, run.rows[0]!.id]);
  await db().query(
    `INSERT INTO test_availability (workspace_id, canonical_job_id, job_version_id, availability_current) VALUES ($1, $2, $3, $4)`,
    [ctx().workspaceId, jobId, versionId, options.open !== false],
  );
  if (options.archived) {
    const archiveRun = randomUUID();
    await db().query(
      `INSERT INTO job_archive_runs (id, run_started_at, cutoff_at, mode, status) VALUES ($1, NOW(), NOW() - INTERVAL '1 day', 'DRY_RUN', 'SUCCEEDED')`,
      [archiveRun],
    );
    await db().query(
      `UPDATE canonical_jobs SET archived_at = NOW(), archive_run_id = $2, archive_reason = 'fixture archive',
              archive_age_basis = 'HARD_REJECTED_DECISION', archive_reference_at = NOW() WHERE id = $1`,
      [jobId, archiveRun],
    );
  }
  return jobId;
}

describe.skipIf(skipReal)("blind review pool (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `blind_pool_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    await client.query(`CREATE TABLE test_availability (workspace_id UUID, canonical_job_id UUID, job_version_id UUID, availability_current BOOLEAN)`);
    await client.query("DROP VIEW IF EXISTS v_job_availability_current CASCADE");
    await client.query(`CREATE VIEW v_job_availability_current AS SELECT * FROM test_availability`);
    const profile = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, $2, 'Blind Fixture') RETURNING id`,
      [ctx().workspaceId, `blind-${randomUUID()}`],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW()) RETURNING id`,
      [ctx().workspaceId, profile.rows[0]!.id, `profile-${randomUUID()}`],
    );
    profileVersionId = version.rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("draws only the live, open, complete, current job and counts every other scored job under one reason", async () => {
    const good = await seedScoredJob();
    await seedScoredJob({ quality: "INCOMPLETE" });
    await seedScoredJob({ open: false });
    await seedScoredJob({ archived: true });
    await seedScoredJob({ fixture: true });
    await seedScoredJob({ gate: "HARD_REJECT", state: "HARD_REJECTED", outcome: null });
    await seedScoredJob({ state: "PREQUALIFIED" });

    const result = await loadBlindReviewPool(db(), { workspaceId: ctx().workspaceId, savedSourceName: "NO_SUCH_SOURCE", excludedIds: [] });
    expect(result.rows.map((row) => row.id)).toEqual([good]);
    expect(result.excluded).toMatchObject({
      ARCHIVED: 1, TEST_FIXTURE: 1, NOT_GATE_PASSED: 1, AWAITING_CONTENT: 1, NOT_CONFIRMED_OPEN: 1, RANKING_STALE: 1,
      MANUALLY_REMOVED: 0, NO_POSTING_LINK: 0, SAVED_BY_USER: 0, ALREADY_LABELLED: 0,
    });
  });

  it("a job labelled in an earlier sheet is counted and not drawn again", async () => {
    const labelled = await seedScoredJob();
    const result = await loadBlindReviewPool(db(), { workspaceId: ctx().workspaceId, savedSourceName: "NO_SUCH_SOURCE", excludedIds: [labelled] });
    expect(result.rows.map((row) => row.id)).not.toContain(labelled);
    expect(result.excluded.ALREADY_LABELLED).toBe(1);
  });
});
