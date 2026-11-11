import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { MAX_JOB_CARDS_PER_EMAIL } from "../../ingestion/emailAlertExtractor.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";
import { isNoVacancyFunnelBroken, parseEmails, type ParseEmailsDependencies } from "../../../scripts/parse_emails.js";
import {
  CAREER_SITE_NAVIGATION_LINKS,
  careerSiteAlertRaw,
  digestAlertRaw,
  digestVacancyUrl,
  LINKEDIN_ALERT_MANAGEMENT_LINKS,
  LINKEDIN_NON_JOB_LINKS_PER_DIGEST,
  linkedInDigestAlertRaw,
  linkedInJobId,
  linkedInLayoutAlertRaw,
} from "../fixtures/gmailDigestAlerts.js";

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

async function seedDigests(
  count: number,
  cardsPerDigest: number,
  build: (options: { digestIndex: number; cardsPerDigest: number }) => string = digestAlertRaw,
): Promise<string[]> {
  const ids: string[] = [];
  for (let digestIndex = 0; digestIndex < count; digestIndex += 1) {
    const { rows } = await db().query<{ id: string }>(
      `INSERT INTO raw_email_alerts (workspace_id, subject, body, gmail_message_id, processed, lifecycle_status, received_at)
       VALUES ($1, $2, $3, $4, FALSE, 'IN_PROCESSING', TIMESTAMPTZ '2026-11-01T00:00:00Z' + ($5 || ' minutes')::interval)
       RETURNING id`,
      [workspaceId(), `${cardsPerDigest} new synthetic jobs for you`, build({ digestIndex, cardsPerDigest }),
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
      noVacancyEmails: 0,
      noVacancyFunnelBroken: false,
      // Per 3-card digest: 26 links seen (anchors plus the generated text
      // alternative), 8 navigation/image links skipped, 15 repeats collapsed.
      linksSeen: 130,
      nonJobLinksSkipped: 40,
      duplicateLinksCollapsed: 75,
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
    expect(progress[0]).toContain(
      "batch 1 alert 1 staged 3 vacancy link(s) [26 link(s) seen, 3 job card(s), 8 non-job skipped, 15 duplicate(s) collapsed]; totals",
    );
    expect(progress[0]).toContain("totals: 1 parsed, 3 links, 0 without vacancies, 0 failed");
    expect(progress[4]).toContain("batch 3 alert 5 staged 3 vacancy link(s)");
    expect(progress[4]).toContain("totals: 5 parsed, 15 links, 0 without vacancies, 0 failed");
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
      noVacancyEmails: 0,
      noVacancyFunnelBroken: false,
      linksSeen: 52,
      nonJobLinksSkipped: 16,
      duplicateLinksCollapsed: 30,
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

  it("stages one canonical observation per LinkedIn job and records the email's link accounting", async () => {
    const alertIds = await seedDigests(2, 3, linkedInDigestAlertRaw);
    const { lines, log } = recordingLog();

    const summary = await parseEmails({ limit: 20, concurrency: 2 }, { pool: stagingPool(), log, now: () => 0 });

    expect(summary).toMatchObject({
      parsedEmails: 2,
      extractedJobs: 6,
      failedEmails: 0,
      linksSeen: 50,
      nonJobLinksSkipped: 26,
      duplicateLinksCollapsed: 18,
    });
    expect(await stagingState()).toEqual({
      observations: 6,
      distinctSources: 6,
      fetchPending: 6,
      fetchTasks: 6,
      orphanTasks: 0,
      processedAlerts: 2,
    });
    const staged = await db().query<{ source_url: string; canonical_apply_url: string; title: string; raw_payload: Record<string, unknown> }>(
      `SELECT source_url, canonical_apply_url, title, raw_payload
       FROM raw_job_observations WHERE workspace_id = $1 AND raw_email_alert_id = $2 ORDER BY source_url`,
      [workspaceId(), alertIds[1]],
    );
    expect(staged.rows.map((row) => row.source_url)).toEqual(
      [0, 1, 2].map((card) => `https://www.linkedin.com/jobs/view/${linkedInJobId(1, card)}`),
    );
    expect(staged.rows.map((row) => row.canonical_apply_url)).toEqual(staged.rows.map((row) => row.source_url));
    expect(staged.rows.map((row) => row.title)).toEqual([0, 1, 2].map((card) => `Synthetic LinkedIn Architect 1-${card}`));
    for (const row of staged.rows) {
      expect(row.raw_payload).toMatchObject({
        collapsed_link_count: 4,
        email_link_summary: { links_seen: 25, job_cards: 3, non_job_links_skipped: 13, duplicate_links_collapsed: 9 },
      });
    }
    const allUrls = await db().query<{ url: string }>(
      "SELECT source_url AS url FROM raw_job_observations WHERE workspace_id = $1",
      [workspaceId()],
    );
    for (const nonJob of LINKEDIN_NON_JOB_LINKS_PER_DIGEST) {
      expect(allUrls.rows.map((row) => row.url)).not.toContain(nonJob);
    }
    expect(allUrls.rows.every((row) => !row.url.includes("trackingId"))).toBe(true);
    expect(lines.join(" ")).not.toContain("linkedin.com");
    expect(lines.filter((line) => line.includes("[25 link(s) seen, 3 job card(s), 13 non-job skipped, 9 duplicate(s) collapsed]")))
      .toHaveLength(2);
  });

  it("records a navigation-only email as SOURCE_BLOCKED without failing the run, with counts but no URLs in the error", async () => {
    const [alertId] = await seedDigests(1, 1, () => navigationOnlyEmail());

    const summary = await parseEmails({ limit: 20 }, { pool: stagingPool(), log: () => undefined, now: () => 0 });

    expect(summary).toMatchObject({
      parsedEmails: 0, extractedJobs: 0, failedEmails: 0, noVacancyEmails: 1, noVacancyFunnelBroken: false,
      nonJobLinksSkipped: 16, linksSeen: 16,
    });
    const alert = await db().query<{ processed: boolean; lifecycle_status: string; last_error: string }>(
      "SELECT processed, lifecycle_status, last_error FROM raw_email_alerts WHERE id = $1",
      [alertId],
    );
    expect(alert.rows[0]).toMatchObject({ processed: true, lifecycle_status: "SOURCE_BLOCKED" });
    expect(alert.rows[0]?.last_error).toMatch(/^MISSING_POSTING_URL: /);
    expect(alert.rows[0]?.last_error).toContain("16 link(s) seen, 0 job card(s), 16 non-job skipped");
    expect(alert.rows[0]?.last_error).not.toContain("linkedin.com");
    expect((await stagingState()).observations).toBe(0);
  });

  it("stages employer career-site postings with an empty employer, never a placeholder, and no navigation", async () => {
    await seedDigests(2, 2, ({ digestIndex }) =>
      careerSiteAlertRaw({ senderName: digestIndex === 0 ? "Synthetic Sender" : "Example Group Bank Careers" }));

    const summary = await parseEmails({ limit: 20 }, { pool: stagingPool(), log: () => undefined, now: () => 0 });

    expect(summary).toMatchObject({ parsedEmails: 2, extractedJobs: 4, failedEmails: 0 });
    const { rows } = await db().query<{
      source_url: string; company_name: string; processing_status: string; raw_payload: Record<string, unknown>;
    }>(
      `SELECT source_url, company_name, processing_status, raw_payload
       FROM raw_job_observations WHERE workspace_id = $1 AND source_name = 'GMAIL_ALERT'
       ORDER BY company_name, source_url`,
      [workspaceId()],
    );
    expect(rows.map((row) => row.company_name)).toEqual(["", "", "Example Group Bank", "Example Group Bank"]);
    expect(rows.every((row) => row.processing_status === "FETCH_PENDING")).toBe(true);
    expect(rows.every((row) => !row.source_url.includes("refid") && !row.source_url.includes("eid="))).toBe(true);
    for (const navigation of CAREER_SITE_NAVIGATION_LINKS) {
      expect(rows.map((row) => row.source_url)).not.toContain(navigation);
    }
    expect(rows[0]?.raw_payload).toMatchObject({ company_name: "", source_content_status: "DISCOVERY_ONLY" });
    expect(rows[0]?.raw_payload).not.toHaveProperty("discovered_company_source");
    expect(rows[2]?.raw_payload).toMatchObject({
      company_name: "Example Group Bank",
      discovered_company_source: "EMAIL_SENDER",
    });
    expect(JSON.stringify(rows)).not.toContain("Unknown Company");
    expect((await stagingState()).fetchTasks).toBe(4);
  });

  it("stages LinkedIn-layout cards with the card's employer, never a logo URL, and no alert-management observation or task", async () => {
    const cards = [
      { jobId: "4400000201", title: "Synthetic AI COE Lead", subtitle: "Example Charter Holdings &middot; Example City (Hybrid)", logoAlt: "Example Charter Holdings" },
      { jobId: "4400000202", title: "Synthetic Data Steward", subtitle: null, logoAlt: "" },
    ];
    await seedDigests(1, cards.length, () => linkedInLayoutAlertRaw(cards));

    const summary = await parseEmails({ limit: 20 }, { pool: stagingPool(), log: () => undefined, now: () => 0 });

    expect(summary).toMatchObject({ parsedEmails: 1, extractedJobs: 2, failedEmails: 0 });
    const { rows } = await db().query<{ source_url: string; company_name: string; raw_payload: Record<string, unknown> }>(
      `SELECT source_url, company_name, raw_payload
       FROM raw_job_observations WHERE workspace_id = $1 AND source_name = 'GMAIL_ALERT' ORDER BY source_url`,
      [workspaceId()],
    );
    expect(rows.map((row) => [row.source_url, row.company_name])).toEqual([
      ["https://www.linkedin.com/jobs/view/4400000201", "Example Charter Holdings"],
      ["https://www.linkedin.com/jobs/view/4400000202", ""],
    ]);
    expect(rows[0]?.raw_payload).toMatchObject({ company_name: "Example Charter Holdings", discovered_company_source: "EMAIL_CARD" });
    expect(rows[1]?.raw_payload).not.toHaveProperty("discovered_company_source");
    expect(JSON.stringify(rows.map((row) => row.company_name))).not.toMatch(/logo|https?:|=/i);
    for (const link of LINKEDIN_ALERT_MANAGEMENT_LINKS) {
      expect(rows.map((row) => row.source_url)).not.toContain(link.url);
    }
    expect(await stagingState()).toMatchObject({ observations: 2, fetchTasks: 2, orphanTasks: 0, processedAlerts: 1 });
  });

  it("blocks an email over the per-email card cap visibly, stages nothing and keeps the raw alert", async () => {
    const html = Array.from({ length: MAX_JOB_CARDS_PER_EMAIL + 1 }, (_, index) =>
      `<p><a href="https://www.linkedin.com/comm/jobs/view/${4_500_000_000 + index}/">Synthetic Role ${index}</a></p>`).join("");
    const body = Buffer.from(
      ["MIME-Version: 1.0", 'Content-Type: text/html; charset="UTF-8"', "", html].join(String.fromCharCode(13, 10)),
      "utf8",
    ).toString("base64url");
    const [alertId] = await seedDigests(1, 1, () => body);
    const { lines, log } = recordingLog();

    const summary = await parseEmails({ limit: 20 }, { pool: stagingPool(), log, now: () => 0 });

    expect(summary).toMatchObject({ parsedEmails: 0, extractedJobs: 0, failedEmails: 1 });
    const alert = await db().query<{ processed: boolean; lifecycle_status: string; last_error: string; body: string }>(
      "SELECT processed, lifecycle_status, last_error, body FROM raw_email_alerts WHERE id = $1",
      [alertId],
    );
    expect(alert.rows[0]).toMatchObject({ processed: true, lifecycle_status: "SOURCE_BLOCKED", body });
    expect(alert.rows[0]?.last_error).toMatch(/^TOO_MANY_JOB_CARDS: /);
    expect((await stagingState()).observations).toBe(0);
    expect(lines.some((line) => line.includes("blocked (TOO_MANY_JOB_CARDS"))).toBe(true);
  });

  it("flags a broken funnel when most decoded alerts have no vacancy link", async () => {
    await seedDigests(4, 2, (options) => options.digestIndex < 3 ? navigationOnlyEmail() : digestAlertRaw(options));

    const summary = await parseEmails({ limit: 20 }, { pool: stagingPool(), log: () => undefined, now: () => 0 });

    expect(summary).toMatchObject({ parsedEmails: 1, failedEmails: 0, noVacancyEmails: 3, noVacancyFunnelBroken: true });
  });
});

function navigationOnlyEmail(): string {
  const html = LINKEDIN_NON_JOB_LINKS_PER_DIGEST.map((url) => `<a href="${url.replaceAll("&", "&amp;")}">See jobs</a>`).join(" ");
  return Buffer.from(
    ["MIME-Version: 1.0", 'Content-Type: text/html; charset="UTF-8"', "", html].join(String.fromCharCode(13, 10)),
    "utf8",
  ).toString("base64url");
}

describe("isNoVacancyFunnelBroken", () => {
  it("tolerates a few stray non-job emails but not a majority of empty alerts", () => {
    expect(isNoVacancyFunnelBroken(116, 1)).toBe(false);
    expect(isNoVacancyFunnelBroken(0, 2)).toBe(false);
    expect(isNoVacancyFunnelBroken(3, 3)).toBe(false);
    expect(isNoVacancyFunnelBroken(2, 3)).toBe(true);
    expect(isNoVacancyFunnelBroken(0, 3)).toBe(true);
  });
});
