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
import { archiveJobsAsPostingNotConfirmable } from "../../services/jobArchive.js";
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

async function newContext(): Promise<WorkspaceContext> {
  const key = `coverage-${randomUUID()}`;
  const inserted = await db().query<{ id: string }>(`INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Coverage') RETURNING id::text`, [key]);
  const user = await db().query<{ id: string }>(`SELECT id::text FROM workspace_users WHERE user_key = 'local_user' LIMIT 1`);
  await db().query(`INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'OWNER', 'ACTIVE') ON CONFLICT (workspace_id, user_id) DO NOTHING`, [inserted.rows[0]!.id, user.rows[0]!.id]);
  return resolveWorkspaceContext(db(), { workspaceKey: key, userKey: "local_user" });
}

async function seedAlertJob(label: string, ctx: WorkspaceContext = context!, explicitId?: string): Promise<{ canonicalJobId: string; observationId: string }> {
  const workspaceId = ctx.workspaceId;
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, description_quality_status)
     VALUES (COALESCE($4::uuid, gen_random_uuid()), $1, 'Coverage Fixture Co', $2, $3, 'RAW_STAGED', 'RAW_STAGED', 'INCOMPLETE') RETURNING id`,
    [workspaceId, label, `https://example.test/coverage/${randomUUID()}`, explicitId ?? null],
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
    const ctx = await newContext();
    const { observationId } = await seedAlertJob("assert-missing", ctx);
    await expect(assertObservationsHaveFetchTask(db(), ctx.workspaceId, [observationId])).rejects.toThrow(/without a FETCH_JOB_CONTENT task/);
    await enqueueAlertFetchTask(db(), ctx, { observationId, producer: "test" });
    await expect(assertObservationsHaveFetchTask(db(), ctx.workspaceId, [observationId])).resolves.toBeUndefined();
  });

  it("enqueueAlertFetchTask is idempotent on the shared key", async () => {
    const ctx = await newContext();
    const { observationId } = await seedAlertJob("idempotent", ctx);
    const first = await enqueueAlertFetchTask(db(), ctx, { observationId, producer: "test" });
    const second = await enqueueAlertFetchTask(db(), ctx, { observationId, producer: "test" });
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
    const ctx = await newContext();
    const lead = await seedAlertJob("lead-backed", ctx);
    await db().query(
      `UPDATE raw_job_observations SET processing_status = 'FETCH_BLOCKED', raw_payload = '{"lead_kind":"AGGREGATOR_LEAD"}'::jsonb WHERE id = $1`,
      [lead.observationId]);
    const legacy = await seedAlertJob("legacy-snippet", ctx);
    const report = await reportContentWithoutFetchTask(db(), ctx.workspaceId);
    expect(report.withoutFetchTask).not.toContain(lead.canonicalJobId);
    expect(report.withoutFetchTask).toContain(legacy.canonicalJobId);
  });

  it("ensureFetchTasksForAwaitingContent queues tasks additively, dry run first, and is idempotent", async () => {
    const ctx = await newContext();
    // Independent of the rows other tests left: the expected count is whatever is missing a task right now, plus this job.
    const existing = (await reportContentWithoutFetchTask(db(), ctx.workspaceId)).withoutFetchTask.length;
    const job = await seedAlertJob("ensure", ctx);
    const expected = existing + 1;
    const dry = await ensureFetchTasksForAwaitingContent(db(), ctx, { apply: false, producer: "test" });
    expect(dry.candidates).toBe(expected);
    expect(dry.queued).toBe(0);
    expect((await reportContentWithoutFetchTask(db(), ctx.workspaceId)).withoutFetchTask).toContain(job.canonicalJobId);
    const applied = await ensureFetchTasksForAwaitingContent(db(), ctx, { apply: true, producer: "test" });
    expect(applied.queued).toBe(expected);
    expect((await reportContentWithoutFetchTask(db(), ctx.workspaceId)).withoutFetchTask).not.toContain(job.canonicalJobId);
    const again = await ensureFetchTasksForAwaitingContent(db(), ctx, { apply: true, producer: "test" });
    expect(again.queued).toBe(0);
    const state = await db().query<{ state: string }>(`SELECT processing_state AS state FROM canonical_jobs WHERE id = $1`, [job.canonicalJobId]);
    expect(state.rows[0]!.state).toBe("RAW_STAGED");
  });

  it("ensureFetchTasksForAwaitingContent leaves owner-saved, non-alert, aggregator-lead and archived jobs alone and applies the cap after the exclusions", async () => {
    const ctx = await newContext();
    // Ids are chosen so every excluded job sorts BEFORE every eligible job: if the cap were applied before the exclusions,
    // the cap would be spent on excluded jobs and fewer than `limit` tasks would be queued.
    const low = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
    const high = (n: number) => `ffffffff-ffff-4fff-8fff-00000000000${n}`;
    const eligible = [];
    for (let n = 1; n <= 5; n += 1) eligible.push(await seedAlertJob(`alert-${n}`, ctx, high(n)));
    // Owner saved: an alert card plus a saved-export observation on the same job version.
    const saved = await seedAlertJob("owner-saved", ctx, low(1));
    const savedVersion = await db().query<{ job_version_id: string }>(`SELECT job_version_id FROM raw_job_observations WHERE id = $1`, [saved.observationId]);
    const savedObservation = randomUUID();
    await db().query(
      `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title, description_raw,
         raw_payload, raw_payload_hash, processing_status, job_version_id)
       VALUES ($1, $2, 'MCF_SAVED', $3, 'https://example.test/saved', NOW(), 'Coverage Fixture Co', 'saved', 'Short.', '{}'::jsonb, $4, 'PROCESSED', $5)`,
      [savedObservation, ctx.workspaceId, `saved-${savedObservation}`, `raw-${savedObservation}`, savedVersion.rows[0]!.job_version_id],
    );
    // Aggregator lead: deliberately no fetch task.
    const lead = await seedAlertJob("lead", ctx, low(2));
    await db().query(`UPDATE raw_job_observations SET processing_status = 'FETCH_BLOCKED', raw_payload = '{"lead_kind":"AGGREGATOR_LEAD"}'::jsonb WHERE id = $1`, [lead.observationId]);
    // Not an alert job at all (a feed observation): nothing this fetch can retrieve.
    const feed = await seedAlertJob("feed-only", ctx, low(3));
    await db().query(`UPDATE raw_job_observations SET source_name = 'HIMALAYAS' WHERE id = $1`, [feed.observationId]);
    // Archived: not live.
    const archivedJob = await seedAlertJob("archived", ctx, low(4));
    await archiveJobsAsPostingNotConfirmable(db(), { workspaceId: ctx.workspaceId, canonicalJobIds: [archivedJob.canonicalJobId], actor: "test:ensure", details: { rule: "test" } });

    const capped = await ensureFetchTasksForAwaitingContent(db(), ctx, { apply: true, producer: "test", limit: 2 });
    expect(capped.queued).toBe(2);
    expect(capped.skippedOwnerSaved).toBe(1);
    const afterFirst = await db().query<{ observation_id: string }>(
      `SELECT payload->>'observation_id' AS observation_id FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'FETCH_JOB_CONTENT'`, [ctx.workspaceId]);
    // The first call took the two lowest-id eligible jobs, not an excluded one.
    expect(afterFirst.rows.map((row) => row.observation_id).sort()).toEqual([eligible[0]!, eligible[1]!].map((job) => job.observationId).sort());
    const rest = await ensureFetchTasksForAwaitingContent(db(), ctx, { apply: true, producer: "test", limit: 10 });
    expect(rest.queued).toBe(3);
    const tasks = await db().query<{ observation_id: string }>(
      `SELECT payload->>'observation_id' AS observation_id FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'FETCH_JOB_CONTENT'`, [ctx.workspaceId]);
    expect(tasks.rows.map((row) => row.observation_id).sort()).toEqual(eligible.map((job) => job.observationId).sort());
    for (const untouched of [saved, lead, feed, archivedJob]) {
      expect(tasks.rows.map((row) => row.observation_id)).not.toContain(untouched.observationId);
    }
  });

  it("reconciliation lists exactly the live jobs with neither complete content nor a fetch task", async () => {
    const ctx = await newContext();
    const withoutTask = await seedAlertJob("no-task", ctx);
    const withTask = await seedAlertJob("with-task", ctx);
    await enqueueAlertFetchTask(db(), ctx, { observationId: withTask.observationId, producer: "test" });
    const deadLettered = await seedAlertJob("dead-lettered", ctx);
    await enqueueAlertFetchTask(db(), ctx, { observationId: deadLettered.observationId, producer: "test" });
    await db().query(
      `UPDATE pipeline_tasks SET status = 'DEAD_LETTER' WHERE workspace_id = $1 AND payload->>'observation_id' = $2`,
      [ctx.workspaceId, deadLettered.observationId],
    );

    const report = await reportContentWithoutFetchTask(db(), ctx.workspaceId);
    expect(report.withoutFetchTask).toContain(withoutTask.canonicalJobId);
    expect(report.withoutFetchTask).not.toContain(withTask.canonicalJobId);
    expect(report.withoutFetchTask).not.toContain(deadLettered.canonicalJobId);
    expect(report.fetchDeadLetteredOnly).toBe(1);

    // Complete content clears the job from the report even with no task.
    await db().query(`UPDATE canonical_jobs SET description_quality_status = 'COMPLETE' WHERE id = $1`, [withoutTask.canonicalJobId]);
    await db().query(`UPDATE raw_job_observations SET raw_payload = '{"source_content_status":"COMPLETE"}'::jsonb WHERE id = $1`, [withoutTask.observationId]);
    const after = await reportContentWithoutFetchTask(db(), ctx.workspaceId);
    expect(after.withoutFetchTask).not.toContain(withoutTask.canonicalJobId);
  });
});
