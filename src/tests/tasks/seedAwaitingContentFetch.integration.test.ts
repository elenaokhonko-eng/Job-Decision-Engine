import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { archiveJobsAsPostingNotConfirmable } from "../../services/jobArchive.js";
import { seedRecoverablePipelineTasks } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// seedRecoverablePipelineTasks calls ensureFetchTasksForAwaitingContent: a live alert-backed job with no complete text
// and no fetch task gets exactly one FETCH_JOB_CONTENT task; aggregator leads, owner-saved, archived and non-alert jobs
// get none. Synthetic fixtures; real PostgreSQL in a private schema.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the awaiting-content seed tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let ctx: WorkspaceContext | undefined;
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };
const c = (): WorkspaceContext => { if (!ctx) throw new Error("not initialised"); return ctx; };

async function seedAlertJob(label: string): Promise<{ canonicalJobId: string; jobVersionId: string; observationId: string }> {
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, description_quality_status)
     VALUES ($1, 'Seed Fixture Co', $2, $3, 'RAW_STAGED', 'RAW_STAGED', 'INCOMPLETE') RETURNING id`,
    [c().workspaceId, label, `https://example.test/seed/${randomUUID()}`],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, 1, $3, 'Short snippet.', NOW()) RETURNING id`,
    [c().workspaceId, canonicalJobId, `seed-${randomUUID()}`],
  );
  const jobVersionId = version.rows[0]!.id;
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`, [jobVersionId, c().workspaceId, canonicalJobId]);
  const observationId = randomUUID();
  await db().query(
    `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title, description_raw,
       raw_payload, raw_payload_hash, processing_status, job_version_id)
     VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), 'Seed Fixture Co', $5, 'Short snippet.', '{}'::jsonb, $6, 'FETCH_PENDING', $7)`,
    [observationId, c().workspaceId, `seed-${observationId}`, `https://example.test/seed/${observationId}`, label, `raw-${observationId}`, jobVersionId],
  );
  return { canonicalJobId, jobVersionId, observationId };
}

async function fetchTaskObservations(): Promise<string[]> {
  const { rows } = await db().query<{ observation_id: string }>(
    `SELECT payload->>'observation_id' AS observation_id FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'FETCH_JOB_CONTENT' ORDER BY 1`, [c().workspaceId]);
  return rows.map((row) => row.observation_id);
}

describe.skipIf(skipReal)("seedRecoverablePipelineTasks queues the awaiting-content fetch (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `seed_fetch_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    ctx = await resolveWorkspaceContext(client);
  }, 180_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("queues exactly one fetch task per alert-backed awaiting-content job, none for the excluded kinds, and is idempotent", async () => {
    const eligible = [await seedAlertJob("alert-1"), await seedAlertJob("alert-2"), await seedAlertJob("alert-3")];
    const saved = await seedAlertJob("owner-saved");
    const savedObservation = randomUUID();
    await db().query(
      `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title, description_raw,
         raw_payload, raw_payload_hash, processing_status, job_version_id)
       VALUES ($1, $2, 'MCF_SAVED', $3, 'https://example.test/saved', NOW(), 'Seed Fixture Co', 'saved', 'Short.', '{}'::jsonb, $4, 'PROCESSED', $5)`,
      [savedObservation, c().workspaceId, `saved-${savedObservation}`, `raw-${savedObservation}`, saved.jobVersionId],
    );
    const lead = await seedAlertJob("lead");
    await db().query(`UPDATE raw_job_observations SET processing_status = 'FETCH_BLOCKED', raw_payload = '{"lead_kind":"AGGREGATOR_LEAD"}'::jsonb WHERE id = $1`, [lead.observationId]);
    const feed = await seedAlertJob("feed-only");
    await db().query(`UPDATE raw_job_observations SET source_name = 'HIMALAYAS' WHERE id = $1`, [feed.observationId]);
    const archived = await seedAlertJob("archived");
    await archiveJobsAsPostingNotConfirmable(db(), { workspaceId: c().workspaceId, canonicalJobIds: [archived.canonicalJobId], actor: "test:seed", details: { rule: "test" } });

    // A scoped seed never widens to the workspace.
    await seedRecoverablePipelineTasks(db(), { context: c(), jobVersionIds: [eligible[0]!.jobVersionId] });
    expect(await fetchTaskObservations()).toEqual([]);

    const first = await seedRecoverablePipelineTasks(db(), { context: c() });
    expect(first.byType.FETCH_JOB_CONTENT?.inserted).toBe(3);
    expect(await fetchTaskObservations()).toEqual(eligible.map((job) => job.observationId).sort());

    const second = await seedRecoverablePipelineTasks(db(), { context: c() });
    expect(second.byType.FETCH_JOB_CONTENT?.inserted).toBe(0);
    const tasks = await fetchTaskObservations();
    expect(tasks).toHaveLength(3);
    for (const untouched of [saved, lead, feed, archived]) expect(tasks).not.toContain(untouched.observationId);
  });

  it("an observationIds-scoped seed never widens to the workspace", async () => {
    const job = await seedAlertJob("observation-scoped");
    await seedRecoverablePipelineTasks(db(), { context: c(), taskTypes: ["FETCH_JOB_CONTENT"], observationIds: [job.observationId] });
    expect(await fetchTaskObservations()).not.toContain(job.observationId);
  });

  it("a fixture job is never fetched, even with includeTestFixtures", async () => {
    const job = await seedAlertJob("fixture");
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1`, [job.canonicalJobId]);
    await seedRecoverablePipelineTasks(db(), { context: c(), includeTestFixtures: true });
    expect(await fetchTaskObservations()).not.toContain(job.observationId);
  });

  it("a spent time budget skips the fetch call and says so", async () => {
    const job = await seedAlertJob("budget");
    const summary = await seedRecoverablePipelineTasks(db(), { context: c(), timeBudgetMs: 1 });
    expect(summary.timeBudgetExceeded).toBe(true);
    expect(await fetchTaskObservations()).not.toContain(job.observationId);
    // With budget the same job is picked up.
    const later = await seedRecoverablePipelineTasks(db(), { context: c() });
    expect(later.byType.FETCH_JOB_CONTENT?.inserted).toBeGreaterThanOrEqual(1);
    expect(await fetchTaskObservations()).toContain(job.observationId);
  });

  it("a taskTypes filter without FETCH_JOB_CONTENT queues no fetch task", async () => {
    const job = await seedAlertJob("filtered-out");
    await seedRecoverablePipelineTasks(db(), { context: c(), taskTypes: ["DECIDE_RECOMMENDATION"] });
    expect(await fetchTaskObservations()).not.toContain(job.observationId);
  });
});
