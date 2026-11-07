import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import {
  PARKED_REPAIR_ACTION,
  parkRetiredAlertSources,
  retiredHostOf,
} from "../../../scripts/park_retired_alert_sources.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run retired alert source parking integration tests against its PostgreSQL service.");
}

describe("retiredHostOf", () => {
  it("matches retired hosts directly and through SES click tracking", () => {
    expect(retiredHostOf("https://www.linkedin.com/comm/jobs/view/4300000001/?trackingId=x")).toBe("linkedin.com");
    expect(retiredHostOf("https://www.mycareersfuture.gov.sg/job/it/synthetic-role-0123456789abcdef0123456789abcdef")).toBe("mycareersfuture.gov.sg");
    const wrapped = "https://abc.r.ap-southeast-1.awstrack.me/L0/"
      + encodeURIComponent("https://www.mycareersfuture.gov.sg/jobalert/remove/0123456789abcdef") + "/1/sig";
    expect(retiredHostOf(wrapped)).toBe("mycareersfuture.gov.sg");
    expect(retiredHostOf("https://careers.example.com/jobs/42")).toBeNull();
    expect(retiredHostOf("https://notlinkedin.com/jobs/view/1")).toBeNull();
    expect(retiredHostOf("not a url")).toBeNull();
  });
});

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

describe.skipIf(skipReal)("parkRetiredAlertSources (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `park_retired_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  async function gmailObservationWithFetch(url: string, status: "PENDING" | "RUNNING" = "PENDING") {
    if (!client || !context) throw new Error("The parking test database is not initialized.");
    const observationId = randomUUID();
    const messageId = randomUUID();
    const rawPayload = { message_id: messageId, title: "Synthetic Role" };
    await client.query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, gmail_message_id
       ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), 'Example Co', 'Synthetic Role', 'card only',
         $5::jsonb, $6, 'FETCH_PENDING', $7)`,
      [observationId, context.workspaceId, `gmail-${messageId}`, url, JSON.stringify(rawPayload),
        createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex"), messageId],
    );
    const requestId = randomUUID();
    const { taskId } = await enqueuePipelineTask({
      taskType: "FETCH_JOB_CONTENT",
      taskKey: `FETCH_JOB_CONTENT:${observationId}:posting_fetch_v1:${requestId}`,
      payload: { observation_id: observationId },
      maxAttempts: 8,
      producer: "park_retired_alert_sources_test",
      stageVersion: "posting_fetch_v1",
      requestId,
    }, client, { context });
    if (status === "RUNNING") {
      await client.query(
        `UPDATE pipeline_tasks SET status = 'RUNNING', lease_id = gen_random_uuid(), lease_expires_at = NOW() + INTERVAL '5 minutes'
         WHERE id = $1`,
        [taskId],
      );
    }
    return { observationId, taskId };
  }

  it("dry-runs without writing, then parks only waiting retired-source fetches", async () => {
    if (!client || !context) throw new Error("The parking test database is not initialized.");
    const linkedIn = await gmailObservationWithFetch("https://www.linkedin.com/comm/jobs/view/4300000001/?trackingId=x");
    const mcf = await gmailObservationWithFetch("https://www.mycareersfuture.gov.sg/job/it/synthetic-role-0123456789abcdef0123456789abcdef");
    const employer = await gmailObservationWithFetch("https://careers.example.com/jobs/42");
    const running = await gmailObservationWithFetch("https://www.linkedin.com/comm/jobs/view/4300000002/", "RUNNING");

    const dryRun = await parkRetiredAlertSources(client, context, { apply: false });
    expect(dryRun).toMatchObject({ mode: "DRY_RUN", candidates: 2, parkedTasks: 0 });
    expect(dryRun.byHost).toEqual({ "linkedin.com": 1, "mycareersfuture.gov.sg": 1 });
    const untouched = await client.query(`SELECT count(*)::int AS n FROM pipeline_tasks WHERE status = 'BLOCKED_DEPENDENCY'`);
    expect(untouched.rows[0].n).toBe(0);

    const applied = await parkRetiredAlertSources(client, context, { apply: true });
    expect(applied).toMatchObject({ mode: "APPLY", candidates: 2, parkedTasks: 2, parkedObservations: 2 });

    const { rows: tasks } = await client.query(
      `SELECT id::text AS id, status, blocked_on, repair_action FROM pipeline_tasks WHERE id::text = ANY($1::text[])`,
      [[linkedIn.taskId, mcf.taskId, employer.taskId, running.taskId]],
    );
    const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
    for (const parked of [linkedIn, mcf]) {
      expect(byId[parked.taskId]).toMatchObject({ status: "BLOCKED_DEPENDENCY", blocked_on: "JOB_CONTENT", repair_action: PARKED_REPAIR_ACTION });
    }
    expect(byId[employer.taskId].status).toBe("PENDING");
    expect(byId[running.taskId].status).toBe("RUNNING");

    const { rows: observations } = await client.query(
      `SELECT id::text AS id, processing_status, jsonb_array_length(error_history) AS errors
       FROM raw_job_observations WHERE id::text = ANY($1::text[])`,
      [[linkedIn.observationId, mcf.observationId, employer.observationId]],
    );
    const observationById = Object.fromEntries(observations.map((row) => [row.id, row]));
    expect(observationById[linkedIn.observationId]).toMatchObject({ processing_status: "FETCH_BLOCKED", errors: 1 });
    expect(observationById[mcf.observationId]).toMatchObject({ processing_status: "FETCH_BLOCKED", errors: 1 });
    expect(observationById[employer.observationId].processing_status).toBe("FETCH_PENDING");

    // Nothing is deleted, and a second run finds nothing left to park.
    const counts = await client.query(`SELECT count(*)::int AS n FROM raw_job_observations`);
    expect(counts.rows[0].n).toBe(4);
    expect(await parkRetiredAlertSources(client, context, { apply: true })).toMatchObject({ candidates: 0, parkedTasks: 0 });
  });
});
