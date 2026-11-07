import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { enqueuePipelineTask } from "../../tasks/pipelineTasks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import {
  alertLinkHost,
  IDENTITY_CONFLICT_REPAIR_ACTION,
  REQUEUE_EVENT,
  REQUEUE_EXTRA_ATTEMPTS,
  requeueEmployerIdentityConflicts,
} from "../../../scripts/requeue_employer_identity_conflicts.js";
import { CAREER_SITE_HOST, CAREER_SITE_NAVIGATION_LINKS, careerSitePostingUrl } from "../fixtures/gmailDigestAlerts.js";

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run employer identity requeue integration tests against its PostgreSQL service.");
}

const IDENTITY_REASON = "POSTING_IDENTITY_CONFLICT: Employer page title or employer identity did not match the discovered posting.";

describe("alertLinkHost", () => {
  it("returns the destination host, looking through SES click tracking", () => {
    expect(alertLinkHost(careerSitePostingUrl("Synthetic-Role", 4_100_000_001))).toBe(CAREER_SITE_HOST);
    const wrapped = "https://abc.r.ap-southeast-1.awstrack.me/L0/"
      + encodeURIComponent("https://www.mycareersfuture.gov.sg/job/it/synthetic-role-0123456789abcdef") + "/1/sig";
    expect(alertLinkHost(wrapped)).toBe("www.mycareersfuture.gov.sg");
    expect(alertLinkHost("not a url")).toBeNull();
  });
});

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The requeue test database is not initialized.");
  return client;
}

function ctx(): WorkspaceContext {
  if (!context) throw new Error("The requeue test workspace is not initialized.");
  return context;
}

describe.skipIf(skipReal)("requeueEmployerIdentityConflicts (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `requeue_identity_${randomUUID().replaceAll("-", "")}`;
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

  beforeEach(async () => {
    await db().query("DELETE FROM pipeline_tasks");
    await db().query("DELETE FROM raw_job_observations");
  });

  interface Seeded {
    readonly observationId: string;
    readonly taskId: string;
  }

  async function blockedFetch(
    url: string,
    title: string,
    options: {
      readonly reason?: string;
      readonly repairAction?: string;
      readonly attemptCount?: number;
      readonly status?: "BLOCKED_DEPENDENCY" | "RUNNING";
    } = {},
  ): Promise<Seeded> {
    const observationId = randomUUID();
    const messageId = randomUUID();
    const rawPayload = { message_id: messageId, title, source_url: url };
    await db().query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, gmail_message_id,
         error_history
       ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, NOW(), 'Unknown Company', $5, 'card only',
         $6::jsonb, $7, 'FETCH_BLOCKED', $8, $9::jsonb)`,
      [observationId, ctx().workspaceId, `gmail-${messageId}`, url, title, JSON.stringify(rawPayload),
        createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex"), messageId,
        JSON.stringify([{ stage: "FETCH_JOB_CONTENT", processing_status: "FETCH_BLOCKED", error: options.reason ?? IDENTITY_REASON }])],
    );
    const requestId = randomUUID();
    const { taskId } = await enqueuePipelineTask({
      taskType: "FETCH_JOB_CONTENT",
      taskKey: `FETCH_JOB_CONTENT:${observationId}:posting_fetch_v1:${requestId}`,
      payload: { observation_id: observationId },
      maxAttempts: 8,
      producer: "requeue_employer_identity_conflicts_test",
      stageVersion: "posting_fetch_v1",
      requestId,
    }, db(), { context: ctx() });
    if (options.status === "RUNNING") {
      await db().query(
        `UPDATE pipeline_tasks SET status = 'RUNNING', lease_id = gen_random_uuid(), lease_expires_at = NOW() + INTERVAL '5 minutes'
         WHERE id = $1`,
        [taskId],
      );
    } else {
      const reason = options.reason ?? IDENTITY_REASON;
      await db().query(
        `UPDATE pipeline_tasks
         SET status = 'BLOCKED_DEPENDENCY', attempt_count = $2, last_error = $3, blocked_on = 'JOB_CONTENT',
             blocked_reason = $3, repair_action = $4
         WHERE id = $1`,
        [taskId, options.attemptCount ?? 1, reason, options.repairAction ?? IDENTITY_CONFLICT_REPAIR_ACTION],
      );
    }
    return { observationId, taskId };
  }

  async function taskRow(taskId: string) {
    const { rows } = await db().query(
      `SELECT status, attempt_count, max_attempts, blocked_on, blocked_reason, repair_action, last_error, lease_id
       FROM pipeline_tasks WHERE id = $1`,
      [taskId],
    );
    return rows[0];
  }

  async function observationRow(observationId: string) {
    const { rows } = await db().query(
      "SELECT processing_status, error_history, company_name FROM raw_job_observations WHERE id = $1",
      [observationId],
    );
    return rows[0];
  }

  it("dry-runs without writing, then requeues only employer posting links blocked as identity conflicts", async () => {
    const posting = await blockedFetch(
      careerSitePostingUrl("Synthetic-Platform-Lead", 4_100_000_001) + "?from=email&refid=synthrefid01&source=2&eid=synthetic01&locale=en_US",
      "Synthetic Platform Lead - Example City",
    );
    const exhausted = await blockedFetch(
      careerSitePostingUrl("Synthetic-Risk-Analyst", 4_100_000_002),
      "Synthetic Risk Analyst - Example City, EC (EC)",
      { attemptCount: 8 },
    );
    const byReasonOnly = await blockedFetch(
      careerSitePostingUrl("Synthetic-Data-Lead", 4_100_000_003),
      "Synthetic Data Lead",
      { repairAction: "SOMETHING_ELSE" },
    );
    const manageAlerts = await blockedFetch(CAREER_SITE_NAVIGATION_LINKS[0], "Manage your Job Alerts");
    const here = await blockedFetch(CAREER_SITE_NAVIGATION_LINKS[1], "here");
    const home = await blockedFetch(CAREER_SITE_NAVIGATION_LINKS[2], CAREER_SITE_HOST);
    const careersWebsite = await blockedFetch(CAREER_SITE_NAVIGATION_LINKS[3], "Careers website");
    const stories = await blockedFetch(CAREER_SITE_NAVIGATION_LINKS[4], "Employee Stories");
    const linkedIn = await blockedFetch("https://www.linkedin.com/jobs/view/4300000001", "Synthetic LinkedIn Role");
    const mcf = await blockedFetch(
      "https://www.mycareersfuture.gov.sg/job/it/synthetic-role-0123456789abcdef0123456789abcdef",
      "Synthetic MCF Role",
    );
    const contentBlocked = await blockedFetch(
      careerSitePostingUrl("Synthetic-Ops-Lead", 4_100_000_004),
      "Synthetic Ops Lead",
      { reason: "POSTING_CONTENT_BLOCKED: UNSUPPORTED_SOURCE", repairAction: "PROVIDE_EMPLOYER_URL_OR_FULL_JD" },
    );
    const running = await blockedFetch(careerSitePostingUrl("Synthetic-Running", 4_100_000_005), "Synthetic Running", { status: "RUNNING" });

    const dryRun = await requeueEmployerIdentityConflicts(db(), ctx(), { apply: false });
    expect(dryRun).toEqual({
      mode: "DRY_RUN",
      identityConflictTasks: 10,
      requeueable: 3,
      requeueableByHost: { [CAREER_SITE_HOST]: 3 },
      skippedExcludedHost: 2,
      skippedNavigation: 5,
      skippedNavigationByHost: {
        "career9.successfactors.eu": 2,
        [CAREER_SITE_HOST]: 1,
        "www.examplegroupbank.example": 2,
      },
      requeuedTasks: 0,
      requeuedObservations: 0,
    });
    expect((await taskRow(posting.taskId)).status).toBe("BLOCKED_DEPENDENCY");
    expect((await observationRow(posting.observationId)).processing_status).toBe("FETCH_BLOCKED");

    const now = new Date("2026-11-08T00:00:00.000Z");
    const applied = await requeueEmployerIdentityConflicts(db(), ctx(), { apply: true, now: () => now });
    expect(applied).toMatchObject({ mode: "APPLY", requeueable: 3, requeuedTasks: 3, requeuedObservations: 3 });

    for (const requeued of [posting, exhausted, byReasonOnly]) {
      expect(await taskRow(requeued.taskId)).toMatchObject({
        status: "PENDING",
        blocked_on: null,
        blocked_reason: null,
        repair_action: null,
        last_error: null,
        lease_id: null,
      });
      const observation = await observationRow(requeued.observationId);
      expect(observation.processing_status).toBe("FETCH_PENDING");
      // The previous block stays in the history and the stored discovery facts are untouched.
      expect(observation.error_history).toHaveLength(2);
      expect(observation.error_history[1]).toEqual({
        stage: "FETCH_JOB_CONTENT",
        processing_status: "FETCH_PENDING",
        event: REQUEUE_EVENT,
        previous_error: IDENTITY_REASON,
        occurred_at: now.toISOString(),
      });
      expect(observation.company_name).toBe("Unknown Company");
    }
    expect((await taskRow(posting.taskId)).max_attempts).toBe(8);
    expect(await taskRow(exhausted.taskId)).toMatchObject({ attempt_count: 8, max_attempts: 8 + REQUEUE_EXTRA_ATTEMPTS });

    for (const untouched of [manageAlerts, here, home, careersWebsite, stories, linkedIn, mcf, contentBlocked]) {
      expect((await taskRow(untouched.taskId)).status).toBe("BLOCKED_DEPENDENCY");
      const observation = await observationRow(untouched.observationId);
      expect(observation.processing_status).toBe("FETCH_BLOCKED");
      expect(observation.error_history).toHaveLength(1);
    }
    expect((await taskRow(running.taskId)).status).toBe("RUNNING");

    const rerun = await requeueEmployerIdentityConflicts(db(), ctx(), { apply: true });
    expect(rerun).toMatchObject({ identityConflictTasks: 7, requeueable: 0, requeuedTasks: 0 });
  });

  it("rolls back every change when a task changes underneath the apply", async () => {
    const first = await blockedFetch(careerSitePostingUrl("Synthetic-First", 4_100_000_011), "Synthetic First");
    const second = await blockedFetch(careerSitePostingUrl("Synthetic-Second", 4_100_000_012), "Synthetic Second");
    await db().query(`
      CREATE OR REPLACE FUNCTION requeue_test_fail_observation() RETURNS trigger AS $$
      BEGIN
        IF NEW.title = 'Synthetic Second' AND NEW.processing_status = 'FETCH_PENDING' THEN
          RAISE EXCEPTION 'synthetic observation write failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await db().query(`
      CREATE TRIGGER trg_requeue_test_fail BEFORE UPDATE ON raw_job_observations
      FOR EACH ROW EXECUTE FUNCTION requeue_test_fail_observation()`);
    try {
      await expect(requeueEmployerIdentityConflicts(db(), ctx(), { apply: true })).rejects.toThrow(/synthetic observation write failure/);
    } finally {
      await db().query("DROP TRIGGER IF EXISTS trg_requeue_test_fail ON raw_job_observations");
    }
    for (const seeded of [first, second]) {
      expect((await taskRow(seeded.taskId)).status).toBe("BLOCKED_DEPENDENCY");
      expect((await observationRow(seeded.observationId)).processing_status).toBe("FETCH_BLOCKED");
    }
  });
});
