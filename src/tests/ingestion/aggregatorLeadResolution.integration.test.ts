import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { alertLinkHost, reportAggregatorLeadResolution } from "../../ingestion/aggregatorLeadResolution.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Counts how far current aggregator leads have got toward a rankable job. Synthetic fixtures; real PostgreSQL in a
// private schema; read-only report.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const DAY = 24 * 3_600_000;
const NOW = new Date("2026-11-23T12:00:00.000Z");

describe("alertLinkHost", () => {
  it("reads the destination host through SES click tracking and rejects a malformed link", () => {
    expect(alertLinkHost("https://www.linkedin.com/jobs/view/1")).toBe("www.linkedin.com");
    const wrapped = `https://abc.r.us-east-1.awstrack.me/L0/${encodeURIComponent("https://www.mycareersfuture.gov.sg/job/x/y")}/1/sig`;
    expect(alertLinkHost(wrapped)).toBe("www.mycareersfuture.gov.sg");
    expect(alertLinkHost("not a url")).toBeNull();
    expect(alertLinkHost("https://abc.r.us-east-1.awstrack.me/nothing")).toBeNull();
  });
});

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The lead resolution test client is not initialized.");
  return client;
}

async function seedObservation(input: {
  sourceName: string; url: string; company: string; status: string; ageMs: number; jobVersionId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO raw_job_observations (
       id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
       company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'Synthetic Role', 'Synthetic.', '{}'::jsonb, $8, $9, $10)`,
    [id, context!.workspaceId, input.sourceName, `lead-${id}`, input.url, new Date(NOW.getTime() - input.ageMs), input.company, `raw-${id}`, input.status, input.jobVersionId ?? null],
  );
  return id;
}

async function seedLiveJob(label: string, availabilityOpen: boolean): Promise<string> {
  const workspaceId = context!.workspaceId;
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, description_quality_status)
     VALUES ($1, 'Lead Fixture Co', $2, $3, 'RAW_STAGED', 'RAW_STAGED', 'COMPLETE') RETURNING id`,
    [workspaceId, label, `https://example.test/lead/${randomUUID()}`],
  );
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (
       workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at, evidence_revision_hash,
       availability_status, availability_evidence, availability_verified_at, availability_recheck_at
     ) VALUES ($1, $2, 1, $3, 'Synthetic posting.', NOW(), $4, $5, $6::jsonb, NOW(), $7) RETURNING id`,
    [
      workspaceId, canonical.rows[0]!.id, `lead-${randomUUID()}`, "e".repeat(64),
      availabilityOpen ? "OPEN" : "UNKNOWN",
      JSON.stringify({ status: availabilityOpen ? "OPEN" : "UNKNOWN", verification_method: "TEST_FIXTURE", reason_code: "SOURCE_CONFIRMED", evidence: [] }),
      new Date(Date.now() + (availabilityOpen ? 5 * DAY : -DAY)),
    ],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`, [version.rows[0]!.id, workspaceId, canonical.rows[0]!.id]);
  return version.rows[0]!.id;
}

async function cacheBoard(company: string, status: "FOUND" | "NOT_FOUND"): Promise<void> {
  const key = company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  await db().query(
    `INSERT INTO employer_board_resolutions (employer_key, employer_name, status, provider, board_token, resolution_method, resolver_version, resolved_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'test', NOW(), NOW() + INTERVAL '7 days')`,
    [key, company, status, status === "FOUND" ? "GREENHOUSE" : null, status === "FOUND" ? "synthetic" : null, status === "FOUND" ? "DERIVED_SLUG" : "NONE"],
  );
}

describe.skipIf(skipReal)("aggregator lead resolution report (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `lead_report_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    await cacheBoard("Alpha Systems", "FOUND");
    await cacheBoard("Beta Labs", "NOT_FOUND");
    const blocked = "FETCH_BLOCKED";
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://www.linkedin.com/jobs/view/1", company: "Alpha Systems", status: blocked, ageMs: DAY });
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://www.linkedin.com/jobs/view/2", company: "Alpha Systems Pte Ltd", status: blocked, ageMs: 2 * DAY });
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://www.mycareersfuture.gov.sg/job/x/y", company: "", status: blocked, ageMs: DAY });
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://www.linkedin.com/jobs/view/3", company: "Beta Labs", status: blocked, ageMs: DAY });
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://www.linkedin.com/jobs/view/4", company: "Gamma Works", status: "FETCH_PENDING", ageMs: DAY });
    await seedObservation({
      sourceName: "GMAIL_ALERT", company: "Delta Group", status: blocked, ageMs: DAY,
      url: `https://abc.r.us-east-1.awstrack.me/L0/${encodeURIComponent("https://www.linkedin.com/comm/jobs/view/5")}/1/sig`,
    });
    // Not current: 60 days old and never became a job.
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://www.linkedin.com/jobs/view/6", company: "Old Co", status: blocked, ageMs: 60 * DAY });
    // Not a lead: a company alert on the employer's own site.
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://careers.example.com/jobs/4900000001", company: "Example Analytics", status: "FETCH_PENDING", ageMs: DAY });

    // A lead that became a live job with employer-sourced content and a verified-open posting.
    const open = await seedLiveJob("open", true);
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://www.linkedin.com/jobs/view/7", company: "Alpha Systems", status: "PROCESSED", ageMs: 3 * DAY, jobVersionId: open });
    await seedObservation({ sourceName: "GREENHOUSE", url: "https://boards.greenhouse.io/synthetic/jobs/1", company: "Alpha Systems", status: "PROCESSED", ageMs: DAY, jobVersionId: open });
    // A lead whose employer content arrived but whose availability is not current.
    const stale = await seedLiveJob("stale", false);
    await seedObservation({ sourceName: "GMAIL_ALERT", url: "https://www.linkedin.com/jobs/view/8", company: "Alpha Systems", status: "PROCESSED", ageMs: 3 * DAY, jobVersionId: stale });
    await seedObservation({ sourceName: "EMPLOYER_WEBSITE", url: "https://careers.example.com/jobs/77", company: "Alpha Systems", status: "PROCESSED", ageMs: DAY, jobVersionId: stale });
  }, 180_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("counts current leads, their employers' boards and how far each got", async () => {
    const before = await db().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM raw_job_observations`);
    const report = await reportAggregatorLeadResolution(db(), { workspaceId: context!.workspaceId, now: NOW });

    expect(report.leads).toBe(8);
    expect(report.byAggregator).toEqual({ "linkedin.com": 7, "mycareersfuture.gov.sg": 1 });
    expect(report.withoutEmployerName).toBe(1);
    expect(report.withEmployerName).toBe(7);
    // Alpha (x4: two blocked, one open job, one stale job), Beta, Gamma, Delta = 4 distinct employers.
    expect(report.distinctEmployers).toBe(4);
    expect(report.employerBoard).toEqual({ found: 4, notFound: 1, notResolved: 2, unknownEmployer: 1 });
    expect(report.employersWithKnownBoard).toBe(1);
    expect(report.byStatus).toEqual({ FETCH_BLOCKED: 5, FETCH_PENDING: 1, PROCESSED: 2 });
    expect(report.stages).toEqual({ leads: 8, linkedToLiveJob: 2, contentComplete: 2, employerSourcedContent: 2, verifiedOpen: 1 });

    // Read only: nothing changed.
    const after = await db().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM raw_job_observations`);
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("a longer window counts the old lead too", async () => {
    const report = await reportAggregatorLeadResolution(db(), { workspaceId: context!.workspaceId, now: NOW, windowDays: 90 });
    expect(report.leads).toBe(9);
  });

  it("rejects a window that is not a whole number of days", async () => {
    await expect(reportAggregatorLeadResolution(db(), { workspaceId: context!.workspaceId, windowDays: 0 })).rejects.toThrow(RangeError);
  });
});
