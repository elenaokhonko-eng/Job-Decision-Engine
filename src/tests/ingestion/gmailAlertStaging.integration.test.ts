import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { parseEmails, type ParseEmailsDependencies } from "../../../scripts/parse_emails.js";
import { digestAlertRaw, digestVacancyUrl } from "../fixtures/gmailDigestAlerts.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run Gmail alert staging integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let schemaPool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The Gmail staging integration database is not initialized.");
  return client;
}

function workspaceId(): string {
  if (!context) throw new Error("The Gmail staging integration workspace is not initialized.");
  return context.workspaceId;
}

function stagingPool(): pg.Pool {
  if (!schemaPool) throw new Error("The Gmail staging schema pool is not initialized.");
  return schemaPool;
}

async function seedDigests(count: number, cardsPerDigest: number): Promise<string[]> {
  const ids: string[] = [];
  for (let digestIndex = 0; digestIndex < count; digestIndex += 1) {
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO raw_email_alerts (workspace_id, subject, body, gmail_message_id, processed, lifecycle_status, received_at)
       VALUES ($1, $2, $3, $4, FALSE, 'IN_PROCESSING', TIMESTAMPTZ '2026-11-01T00:00:00Z' + ($5 || ' minutes')::interval)
       RETURNING id`,
      [workspaceId(), `${cardsPerDigest} new synthetic jobs for you`, digestAlertRaw({ digestIndex, cardsPerDigest }),
        `synthetic-message-${digestIndex}`, String(digestIndex)],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

interface StagingState {
  readonly observations: number;
  readonly distinctSources: number;
  readonly fetchPending: number;
  readonly fetchTasks: number;
  readonly orphanTasks: number;
  readonly processedAlerts: number;
}

async function stagingState(): Promise<StagingState> {
  const { rows } = await db().query<StagingState>(
    `SELECT
       (SELECT COUNT(*)::int FROM raw_job_observations WHERE workspace_id = $1 AND source_name = 'GMAIL_ALERT') AS "observations",
       (SELECT COUNT(DISTINCT source_external_id)::int FROM raw_job_observations WHERE workspace_id = $1 AND source_name = 'GMAIL_ALERT') AS "distinctSources",
       (SELECT COUNT(*)::int FROM raw_job_observations WHERE workspace_id = $1 AND processing_status = 'FETCH_PENDING') AS "fetchPending",
       (SELECT COUNT(*)::int FROM pipeline_tasks WHERE workspace_id = $1 AND task_type = 'FETCH_JOB_CONTENT') AS "fetchTasks",
       (SELECT COUNT(*)::int FROM pipeline_tasks task
          WHERE task.workspace_id = $1 AND task.task_type = 'FETCH_JOB_CONTENT'
            AND NOT EXISTS (
              SELECT 1 FROM raw_job_observations observation
              WHERE observation.workspace_id = task.workspace_id
                AND observation.id::text = task.payload->>'observation_id'
            )) AS "orphanTasks",
       (SELECT COUNT(*)::int FROM raw_email_alerts WHERE workspace_id = $1 AND processed = TRUE) AS "processedAlerts"`,
    [workspaceId()],
  );
  return rows[0]!;
}

function recordingLog(): { readonly lines: string[]; readonly log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

describe.skipIf(skipReal)("Gmail alert staging throughput and resume (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `gmail_staging_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
    schemaPool = new pg.Pool({ ...pgConnectionConfig(databaseUrl), options: `-c search_path=${schemaName},public`, max: 10 });
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

  beforeEach(async () => {
    await db().query("DROP TRIGGER IF EXISTS trg_fail_synthetic_card ON raw_job_observations");
    await db().query("DELETE FROM pipeline_tasks");
    await db().query("DELETE FROM raw_job_observations");
    await db().query("DELETE FROM raw_email_alerts");
  });

  it("drains every alert in bounded batches and reports progress per alert", async () => {
    await seedDigests(5, 3);
    const { lines, log } = recordingLog();

    const summary = await parseEmails({ limit: 2, concurrency: 1, maxRuntimeSeconds: 600 }, { pool: stagingPool(), log, now: () => 0 });

    expect(summary).toEqual({
      parsedEmails: 5,
      extractedJobs: 15,
      failedEmails: 0,
      batches: 3,
      deferredEmails: 0,
      remainingBacklog: 0,
      stoppedForRuntimeBudget: false,
    });
    expect(lines.filter((line) => line.startsWith("Gmail extraction batch"))).toEqual([
      "Gmail extraction batch 1: selected 2 alert(s).",
      "Gmail extraction batch 2: selected 2 alert(s).",
      "Gmail extraction batch 3: selected 1 alert(s).",
    ]);
    const progress = lines.filter((line) => line.startsWith("Gmail extraction progress"));
    expect(progress).toHaveLength(5);
    expect(progress[0]).toContain("batch 1 alert 1 staged 3 vacancy link(s); totals: 1 parsed, 3 links, 0 failed");
    expect(progress[4]).toContain("batch 3 alert 5 staged 3 vacancy link(s); totals: 5 parsed, 15 links, 0 failed");
    expect(lines.at(-1)).toContain("unprocessed alerts remaining: 0");
    // Progress lines carry counts only, never email content or vacancy URLs.
    expect(lines.join("\n")).not.toContain("careers.example.com");

    expect(await stagingState()).toEqual({
      observations: 15,
      distinctSources: 15,
      fetchPending: 15,
      fetchTasks: 15,
      orphanTasks: 0,
      processedAlerts: 5,
    });
    const urls = await db().query<{ source_url: string }>(
      "SELECT source_url FROM raw_job_observations WHERE workspace_id = $1 ORDER BY source_url",
      [workspaceId()],
    );
    expect(urls.rows.map((row) => row.source_url)).toEqual(
      Array.from({ length: 5 }, (_, digest) => Array.from({ length: 3 }, (_, card) => digestVacancyUrl(digest, card)))
        .flat()
        .sort(),
    );
    const alerts = await db().query<{ lifecycle_status: string; last_error: string | null }>(
      "SELECT DISTINCT lifecycle_status, last_error FROM raw_email_alerts WHERE workspace_id = $1",
      [workspaceId()],
    );
    expect(alerts.rows).toEqual([{ lifecycle_status: "SOURCE_PENDING", last_error: null }]);
  });

  it("stages alerts concurrently with the same durable result", async () => {
    await seedDigests(6, 4);

    const summary = await parseEmails({ limit: 4, concurrency: 3, maxRuntimeSeconds: 600 }, {
      pool: stagingPool(),
      log: () => undefined,
      now: () => 0,
    });

    expect(summary).toMatchObject({ parsedEmails: 6, extractedJobs: 24, failedEmails: 0, batches: 2, remainingBacklog: 0 });
    expect(await stagingState()).toEqual({
      observations: 24,
      distinctSources: 24,
      fetchPending: 24,
      fetchTasks: 24,
      orphanTasks: 0,
      processedAlerts: 6,
    });
  });

  it("stops at the runtime budget without losing work, and a rerun resumes idempotently", async () => {
    const alertIds = await seedDigests(5, 3);
    let clock = 0;
    let progressLines = 0;
    const interrupted: ParseEmailsDependencies = {
      pool: stagingPool(),
      now: () => clock,
      log: (line) => {
        if (!line.startsWith("Gmail extraction progress")) return;
        progressLines += 1;
        // The run's clock passes its budget after the second alert commits,
        // standing in for a job that is about to be killed.
        if (progressLines === 2) clock = 61_000;
      },
    };

    const first = await parseEmails({ limit: 3, concurrency: 1, maxRuntimeSeconds: 60 }, interrupted);

    expect(first).toEqual({
      parsedEmails: 2,
      extractedJobs: 6,
      failedEmails: 0,
      batches: 1,
      deferredEmails: 1,
      remainingBacklog: 3,
      stoppedForRuntimeBudget: true,
    });
    expect(await stagingState()).toEqual({
      observations: 6,
      distinctSources: 6,
      fetchPending: 6,
      fetchTasks: 6,
      orphanTasks: 0,
      processedAlerts: 2,
    });
    const unstarted = await db().query<{ id: string }>(
      "SELECT id FROM raw_email_alerts WHERE workspace_id = $1 AND processed = FALSE ORDER BY received_at",
      [workspaceId()],
    );
    expect(unstarted.rows.map((row) => row.id)).toEqual(alertIds.slice(2));
    const unstartedObservations = await db().query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM raw_job_observations WHERE workspace_id = $1 AND raw_email_alert_id = ANY($2::uuid[])",
      [workspaceId(), alertIds.slice(2)],
    );
    expect(unstartedObservations.rows[0]?.count).toBe(0);

    const resumed = await parseEmails({ limit: 3, concurrency: 2, maxRuntimeSeconds: 60 }, {
      pool: stagingPool(),
      log: () => undefined,
      now: () => 0,
    });
    expect(resumed).toMatchObject({ parsedEmails: 3, extractedJobs: 9, failedEmails: 0, remainingBacklog: 0, stoppedForRuntimeBudget: false });
    expect(await stagingState()).toEqual({
      observations: 15,
      distinctSources: 15,
      fetchPending: 15,
      fetchTasks: 15,
      orphanTasks: 0,
      processedAlerts: 5,
    });

    const { lines, log } = recordingLog();
    const idle = await parseEmails({ limit: 3 }, { pool: stagingPool(), log, now: () => 0 });
    expect(idle).toMatchObject({ parsedEmails: 0, batches: 0, remainingBacklog: 0 });
    expect(lines).toContain("No eligible email alerts found.");

    // Re-staging an alert whose work already committed (for example after a
    // lost acknowledgement) converges on the same observations and tasks.
    await db().query("UPDATE raw_email_alerts SET processed = FALSE WHERE id = $1", [alertIds[0]]);
    const replayed = await parseEmails({ limit: 3 }, { pool: stagingPool(), log: () => undefined, now: () => 0 });
    expect(replayed).toMatchObject({ parsedEmails: 1, extractedJobs: 3, failedEmails: 0 });
    expect(await stagingState()).toEqual({
      observations: 15,
      distinctSources: 15,
      fetchPending: 15,
      fetchTasks: 15,
      orphanTasks: 0,
      processedAlerts: 5,
    });
  });

  it("rolls back an alert that fails mid-way, does not retry it in the same run, and stages it once on rerun", async () => {
    const alertIds = await seedDigests(3, 3);
    await db().query(`
      CREATE OR REPLACE FUNCTION fail_synthetic_card() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.title = 'Synthetic Data Architect 1-1' THEN
          RAISE EXCEPTION 'synthetic storage failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await db().query(`
      CREATE TRIGGER trg_fail_synthetic_card BEFORE INSERT ON raw_job_observations
      FOR EACH ROW EXECUTE FUNCTION fail_synthetic_card()`);
    const { lines, log } = recordingLog();

    const failed = await parseEmails({ limit: 20, concurrency: 2 }, { pool: stagingPool(), log, now: () => 0 });

    expect(failed).toMatchObject({ parsedEmails: 2, extractedJobs: 6, failedEmails: 1, batches: 1, remainingBacklog: 1 });
    expect(lines.filter((line) => line.includes("failed; left unprocessed for retry"))).toHaveLength(1);
    const failedAlert = await db().query<{ processed: boolean; lifecycle_status: string; last_error: string | null }>(
      "SELECT processed, lifecycle_status, last_error FROM raw_email_alerts WHERE id = $1",
      [alertIds[1]],
    );
    expect(failedAlert.rows[0]).toMatchObject({ processed: false, lifecycle_status: "IN_PROCESSING" });
    expect(failedAlert.rows[0]?.last_error).toContain("synthetic storage failure");
    // The card staged before the failure was rolled back with its alert.
    const partial = await db().query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM raw_job_observations WHERE raw_email_alert_id = $1",
      [alertIds[1]],
    );
    expect(partial.rows[0]?.count).toBe(0);
    expect(await stagingState()).toMatchObject({ observations: 6, fetchTasks: 6, orphanTasks: 0, processedAlerts: 2 });

    await db().query("DROP TRIGGER trg_fail_synthetic_card ON raw_job_observations");
    const rerun = await parseEmails({ limit: 20, concurrency: 2 }, { pool: stagingPool(), log: () => undefined, now: () => 0 });

    expect(rerun).toMatchObject({ parsedEmails: 1, extractedJobs: 3, failedEmails: 0, remainingBacklog: 0 });
    expect(await stagingState()).toEqual({
      observations: 9,
      distinctSources: 9,
      fetchPending: 9,
      fetchTasks: 9,
      orphanTasks: 0,
      processedAlerts: 3,
    });
    const recovered = await db().query<{ last_error: string | null; lifecycle_status: string }>(
      "SELECT last_error, lifecycle_status FROM raw_email_alerts WHERE id = $1",
      [alertIds[1]],
    );
    expect(recovered.rows[0]).toEqual({ last_error: null, lifecycle_status: "SOURCE_PENDING" });
  });
});
