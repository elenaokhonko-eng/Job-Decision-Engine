import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import {
  alertFetchTaskKey,
  assertObservationsHaveFetchTask,
  enqueueAlertFetchTask,
  ensureFetchTasksForAwaitingContent,
  reportContentWithoutFetchTask,
} from "../../ingestion/fetchTaskCoverage.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { parseEmails, parseEmailsExitCode } from "../../../scripts/parse_emails.js";
import { digestAlertRaw } from "../fixtures/gmailDigestAlerts.js";

// Every alert observation gets a FETCH_JOB_CONTENT task at ingest, and reconciliation reports a live job that has
// neither complete content nor a fetch task. Synthetic fixtures; real PostgreSQL in a private schema.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the fetch-task coverage integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let schemaPool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The fetch-task coverage test client is not initialized.");
  return client;
}

async function seedAlertJob(label: string): Promise<{ canonicalJobId: string; observationId: string }> {
  const workspaceId = context!.workspaceId;
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, description_quality_status)
     VALUES ($1, 'Coverage Fixture Co', $2, $3, 'RAW_STAGED', 'RAW_STAGED', 'INCOMPLETE') RETURNING id`,
    [workspaceId, label, `https://example.test/coverage/${randomUUID()}`],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, 1, $3, 'Short snippet.', NOW()) RETURNING id`,
    [workspaceId, canonicalJobId, `coverage-${randomUUID()}`],
  );
  const jobVersionId = version.rows[0]!.id;
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`, [jobVersionId, workspaceId, canonicalJobId]);
  const observationId = randomUUID();
  await db().query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id
     ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), 'Coverage Fixture Co', $5, 'Short snippet.', '{}'::jsonb, $6, 'FETCH_PENDING', $7)`,
    [observationId, workspaceId, `coverage-${observationId}`, `https://example.test/coverage/${observationId}`, label, `raw-${observationId}`, jobVersionId],
  );
  return { canonicalJobId, observationId };
}

describe.skipIf(skipReal)("fetch-task coverage for alert observations (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `fetch_coverage_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    schemaPool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public`, max: 4 });
  }, 180_000);

  afterAll(async () => {
    await schemaPool?.end();
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("parse_emails queues one fetch task per staged alert observation under the shared key", async () => {
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO raw_email_alerts (workspace_id, subject, body, gmail_message_id, processed, lifecycle_status, received_at)
       VALUES ($1, '3 new synthetic jobs for you', $2, 'coverage-message-1', FALSE, 'IN_PROCESSING', NOW()) RETURNING id`,
      [context!.workspaceId, digestAlertRaw({ digestIndex: 0, cardsPerDigest: 3 })],
    );
    expect(rows).toHaveLength(1);
    const summary = await parseEmails({ limit: 5, concurrency: 1, maxRuntimeSeconds: 600 }, { pool: schemaPool!, log: () => undefined, now: () => 0 });
    expect(summary.extractedJobs).toBe(3);

    const observations = await db().query<{ id: string }>(
      `SELECT id::text FROM raw_job_observations WHERE workspace_id = $1 AND source_name = 'GMAIL_ALERT'`, [context!.workspaceId]);
    expect(observations.rows).toHaveLength(3);
    const tasks = await db().query<{ task_key: string }>(
      `SELECT task_key FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'FETCH_JOB_CONTENT'`, [context!.workspaceId]);
    expect(tasks.rows.map((row) => row.task_key).sort()).toEqual(observations.rows.map((row) => alertFetchTaskKey(row.id)).sort());
    await assertObservationsHaveFetchTask(db(), context!.workspaceId, observations.rows.map((row) => row.id));
  });

  it("assertObservationsHaveFetchTask fails when a task is missing, so staging would roll the alert back", async () => {
    const { observationId } = await seedAlertJob("assert-missing");
    await expect(assertObservationsHaveFetchTask(db(), context!.workspaceId, [observationId])).rejects.toThrow(/without a FETCH_JOB_CONTENT task/);
    await enqueueAlertFetchTask(db(), context!, { observationId, producer: "test" });
    await expect(assertObservationsHaveFetchTask(db(), context!.workspaceId, [observationId])).resolves.toBeUndefined();
  });

  it("enqueueAlertFetchTask is idempotent on the shared key", async () => {
    const { observationId } = await seedAlertJob("idempotent");
    const first = await enqueueAlertFetchTask(db(), context!, { observationId, producer: "test" });
    const second = await enqueueAlertFetchTask(db(), context!, { observationId, producer: "test" });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.taskId).toBe(first.taskId);
  });

  it("a staging rollback fails the run: the alert stays unprocessed and the exit code is non-zero", async () => {
    await db().query(`
      CREATE OR REPLACE FUNCTION drop_fetch_task() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.task_type = 'FETCH_JOB_CONTENT' THEN RETURN NULL; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await db().query(`CREATE TRIGGER trg_drop_fetch_task BEFORE INSERT ON pipeline_tasks FOR EACH ROW EXECUTE FUNCTION drop_fetch_task()`);
    try {
      const before = await db().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM raw_job_observations WHERE workspace_id = $1`, [context!.workspaceId]);
      const inserted = await db().query<{ id: string }>(
        `INSERT INTO raw_email_alerts (workspace_id, subject, body, gmail_message_id, processed, lifecycle_status, received_at)
         VALUES ($1, '2 new synthetic jobs for you', $2, 'coverage-message-rollback', FALSE, 'IN_PROCESSING', NOW()) RETURNING id`,
        [context!.workspaceId, digestAlertRaw({ digestIndex: 7, cardsPerDigest: 2 })],
      );
      const summary = await parseEmails({ limit: 5, concurrency: 1, maxRuntimeSeconds: 600 }, { pool: schemaPool!, log: () => undefined, now: () => 0 });
      expect(summary.failedEmails).toBe(1);
      expect(parseEmailsExitCode(summary)).toBe(1);
      const after = await db().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM raw_job_observations WHERE workspace_id = $1`, [context!.workspaceId]);
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
      const alert = await db().query<{ processed: boolean }>(`SELECT processed FROM raw_email_alerts WHERE id = $1`, [inserted.rows[0]!.id]);
      expect(alert.rows[0]!.processed).toBe(false);
    } finally {
      await db().query(`DROP TRIGGER IF EXISTS trg_drop_fetch_task ON pipeline_tasks`);
      await db().query(`UPDATE raw_email_alerts SET processed = TRUE WHERE gmail_message_id = 'coverage-message-rollback'`);
    }
    expect(parseEmailsExitCode({ failedEmails: 0, noVacancyFunnelBroken: false })).toBe(0);
    expect(parseEmailsExitCode({ failedEmails: 0, noVacancyFunnelBroken: true })).toBe(1);
  });

  it("an aggregator lead without a fetch task is not a coverage violation, a legacy snippet job is", async () => {
    const lead = await seedAlertJob("lead-backed");
    await db().query(
      `UPDATE raw_job_observations SET processing_status = 'FETCH_BLOCKED', raw_payload = '{"lead_kind":"AGGREGATOR_LEAD"}'::jsonb WHERE id = $1`,
      [lead.observationId]);
    const legacy = await seedAlertJob("legacy-snippet");
    const report = await reportContentWithoutFetchTask(db(), context!.workspaceId);
    expect(report.withoutFetchTask).not.toContain(lead.canonicalJobId);
    expect(report.withoutFetchTask).toContain(legacy.canonicalJobId);
  });

  it("ensureFetchTasksForAwaitingContent queues tasks additively, dry run first, and is idempotent", async () => {
    const job = await seedAlertJob("ensure");
    const dry = await ensureFetchTasksForAwaitingContent(db(), context!, { apply: false, producer: "test" });
    expect(dry.candidates).toBe(2);
    expect(dry.queued).toBe(0);
    expect((await reportContentWithoutFetchTask(db(), context!.workspaceId)).withoutFetchTask).toContain(job.canonicalJobId);
    const applied = await ensureFetchTasksForAwaitingContent(db(), context!, { apply: true, producer: "test" });
    expect(applied.queued).toBe(2);
    expect((await reportContentWithoutFetchTask(db(), context!.workspaceId)).withoutFetchTask).not.toContain(job.canonicalJobId);
    const again = await ensureFetchTasksForAwaitingContent(db(), context!, { apply: true, producer: "test" });
    expect(again.queued).toBe(0);
    const state = await db().query<{ state: string }>(`SELECT processing_state AS state FROM canonical_jobs WHERE id = $1`, [job.canonicalJobId]);
    expect(state.rows[0]!.state).toBe("RAW_STAGED");
  });

  it("reconciliation lists exactly the live jobs with neither complete content nor a fetch task", async () => {
    const withoutTask = await seedAlertJob("no-task");
    const withTask = await seedAlertJob("with-task");
    await enqueueAlertFetchTask(db(), context!, { observationId: withTask.observationId, producer: "test" });
    const deadLettered = await seedAlertJob("dead-lettered");
    await enqueueAlertFetchTask(db(), context!, { observationId: deadLettered.observationId, producer: "test" });
    await db().query(
      `UPDATE pipeline_tasks SET status = 'DEAD_LETTER' WHERE workspace_id = $1 AND payload->>'observation_id' = $2`,
      [context!.workspaceId, deadLettered.observationId],
    );

    const report = await reportContentWithoutFetchTask(db(), context!.workspaceId);
    expect(report.withoutFetchTask).toContain(withoutTask.canonicalJobId);
    expect(report.withoutFetchTask).not.toContain(withTask.canonicalJobId);
    expect(report.withoutFetchTask).not.toContain(deadLettered.canonicalJobId);
    expect(report.fetchDeadLetteredOnly).toBe(1);

    // Complete content clears the job from the report even with no task.
    await db().query(`UPDATE canonical_jobs SET description_quality_status = 'COMPLETE' WHERE id = $1`, [withoutTask.canonicalJobId]);
    await db().query(`UPDATE raw_job_observations SET raw_payload = '{"source_content_status":"COMPLETE"}'::jsonb WHERE id = $1`, [withoutTask.observationId]);
    const after = await reportContentWithoutFetchTask(db(), context!.workspaceId);
    expect(after.withoutFetchTask).not.toContain(withoutTask.canonicalJobId);
  });
});
