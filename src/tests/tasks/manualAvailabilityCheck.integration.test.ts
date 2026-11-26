import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { assessAvailability } from "../../decision/availability.js";
import type { PostingFetcherDependencies, SafeHttpResponse } from "../../ingestion/jobContentFetcher.js";
import { generateContentHash } from "../../services/criteria.js";
import { archiveHealthGate, HostThrottle, runAvailabilityRecheck, type AvailabilityRecheckDependencies } from "../../tasks/availabilityRecheck.js";
import {
  applyAvailabilityCheck,
  checkDate,
  planAvailabilityCheck,
  runAvailabilityCheckCommand,
} from "../../tasks/manualAvailabilityCheck.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

vi.mock("../../reporting/replayGuard.js", () => ({ requireApprovedReplayTarget: () => ({ host: "test", branchId: null }) }));

// The manual same-day check against real PostgreSQL. Every job, employer and page below is synthetic and fake-fetched.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const DAY = 24 * 3_600_000;
const TITLE = "Synthetic Platform Engineer";
const DESCRIPTION = [
  "Responsibilities", "Build and operate synthetic data pipelines for an imaginary engineering organisation, end to end.",
  "Design reliable services, review changes, write documentation and support colleagues across several teams.",
  "Requirements", "Five years of software engineering with TypeScript and PostgreSQL in production systems.",
  "Experience with data modelling, observability, incident response and automated testing is expected.",
  "Benefits", "A fictional employer offering imaginary benefits to fictional people who apply to this fictional role.",
].join("\n").repeat(3);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const db = (): pg.PoolClient => client!;
const ctx = (): WorkspaceContext => context!;

interface Fixture { id: string; versionId: string; url: string; board: string }

async function createJob(options: { url?: string | null; availability?: "NEVER" | "OPEN_EXPIRED" } = {}): Promise<Fixture> {
  const id = randomUUID();
  const versionId = randomUUID();
  const observationId = randomUUID();
  const board = `board-${id.slice(0, 8)}`;
  const url = options.url === undefined ? `https://careers-${board}.example.com/jobs/${id}` : options.url;
  const company = board.toUpperCase();
  const record = { id: observationId, title: TITLE };
  const expired = options.availability === "OPEN_EXPIRED";
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, location,
       workplace_type, processing_state, processing_status, description_quality_status, version_count)
     VALUES ($1, $2, $3, $4, $5, 'Singapore', 'UNKNOWN', 'NEEDS_VERIFICATION', 'NEEDS_VERIFICATION', 'COMPLETE', 1)`,
    [id, ctx().workspaceId, company, TITLE.toLowerCase(), url ?? ""],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at,
       availability_status, availability_verified_at, availability_recheck_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6,
       CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() - INTERVAL '8 days' END,
       CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() - INTERVAL '1 day' END)`,
    [versionId, ctx().workspaceId, id, generateContentHash(company, TITLE, DESCRIPTION), DESCRIPTION, expired ? "OPEN" : null],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [versionId, id]);
  await db().query(
    `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_plugin_key, source_external_id, source_url,
       retrieved_at, company_name, title, description_raw, location_raw, workplace_type_raw, employment_type_raw,
       compensation_raw, canonical_apply_url, raw_payload, raw_payload_hash, processing_status, job_version_id)
     VALUES ($1, $2, 'MANUAL_IMPORT', 'manual_import', $1::uuid::text, $3, NOW() - INTERVAL '8 days', $4, $5, $6, 'Singapore',
       'UNKNOWN', 'FULL_TIME', 'UNKNOWN', $3, $7::jsonb, $8, 'PROCESSED', $9)`,
    [observationId, ctx().workspaceId, url, company, TITLE, DESCRIPTION, JSON.stringify(record),
      createHash("sha256").update(JSON.stringify(record)).digest("hex"), versionId],
  );
  return { id, versionId, url: url ?? "", board };
}

function page(url: URL, status: number, body = "", headers: Record<string, string> = {}): SafeHttpResponse {
  return { status, headers: { "content-type": "text/html", ...headers }, body: Buffer.from(body), url: url.toString() };
}

function openPage(url: URL, board: string): SafeHttpResponse {
  const posting = {
    "@context": "https://schema.org", "@type": "JobPosting", title: TITLE, description: DESCRIPTION,
    hiringOrganization: { "@type": "Organization", name: board.toUpperCase() },
    jobLocationType: "TELECOMMUTE",
    jobLocation: { "@type": "Place", address: { addressLocality: "London" } },
  };
  return page(url, 200, `<html><body><h1>${TITLE}</h1><script type="application/ld+json">${JSON.stringify(posting)}</script></body></html>`);
}

function fetcher(respond: (url: URL) => SafeHttpResponse, requested: string[] = []): PostingFetcherDependencies {
  return {
    resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchOnce: async (url) => { requested.push(url.toString()); return respond(url); },
  };
}

const noWait = () => new HostThrottle(() => 0, async () => undefined);

async function plan(jobs: string[], now = new Date()) {
  return planAvailabilityCheck(db(), ctx(), jobs, { now, requestsPerMinute: async () => null });
}

async function check(job: Fixture, respond: (url: URL) => SafeHttpResponse, now = new Date(), requested: string[] = []) {
  const planned = await plan([job.id], now);
  return applyAvailabilityCheck(db(), ctx(), planned, { fetcher: fetcher(respond, requested), throttle: noWait(), now: () => now });
}

async function availability(job: Fixture) {
  const { rows } = await db().query(
    `SELECT availability_status, availability_verified_at, availability_recheck_at, availability_state, availability_current, source_expires_at
       FROM v_job_availability_current WHERE workspace_id = $1 AND canonical_job_id = $2`, [ctx().workspaceId, job.id]);
  return rows[0]!;
}

async function jobRow(job: Fixture) {
  const { rows } = await db().query(
    `SELECT archived_at, workplace_type, location FROM canonical_jobs WHERE id = $1`, [job.id]);
  return rows[0]!;
}

async function state(job: Fixture) {
  const { rows } = await db().query(
    `SELECT consecutive_absent_reads, cannot_tell_attempts, cycle_started_at, next_check_at
       FROM job_availability_recheck_state WHERE canonical_job_id = $1`, [job.id]);
  return rows[0] ?? null;
}

async function events(job: Fixture) {
  const { rows } = await db().query(
    `SELECT outcome, decision, reason_code, cannot_tell_attempts_after AS attempts, details->>'trigger' AS trigger
       FROM job_availability_recheck_events WHERE canonical_job_id = $1 ORDER BY id`, [job.id]);
  return rows;
}

async function taskCount(job: Fixture): Promise<number> {
  const { rows } = await db().query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pipeline_tasks
      WHERE payload->>'canonical_job_id' = $1 AND task_type IN ('RECHECK_AVAILABILITY', 'APPLY_HARD_GATES')`, [job.id]);
  return rows[0]!.n;
}

async function writeCounts(): Promise<unknown> {
  const { rows } = await db().query(
    `SELECT (SELECT COUNT(*) FROM job_availability_recheck_events)::int AS events,
            (SELECT COUNT(*) FROM job_availability_recheck_state)::int AS states,
            (SELECT COUNT(*) FROM source_candidate_dispositions)::int AS dispositions,
            (SELECT COUNT(*) FROM source_runs)::int AS runs,
            (SELECT COUNT(*) FROM pipeline_tasks)::int AS tasks,
            (SELECT COUNT(*) FROM job_versions WHERE availability_status IS NOT NULL)::int AS verdicts`);
  return rows[0];
}

describe.skipIf(skipReal)("manual same-day availability check (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `manual_availability_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("plans in a read-only transaction: never-checked included, every exclusion counted, nothing written", async () => {
    const never = await createJob();
    const expired = await createJob({ availability: "OPEN_EXPIRED" });
    const linkedIn = await createJob({ url: "https://www.linkedin.com/jobs/view/123" });
    const wrapped = await createJob({ url: "https://www.google.com/url?q=https%3A%2F%2Fsg.linkedin.com%2Fjobs%2Fview%2F9" });
    const aggregator = await createJob({ url: "https://www.mycareersfuture.gov.sg/job/it/x-1" });
    const board = await createJob({ url: "https://himalayas.app/companies/a/jobs/b" });
    const noLink = await createJob({ url: null });
    const sameLink = await createJob({ url: never.url });
    const removed = await createJob();
    await db().query(`UPDATE canonical_jobs SET processing_state = 'MANUALLY_REMOVED' WHERE id = $1`, [removed.id]);
    const missing = randomUUID();
    const before = await writeCounts();

    await db().query("BEGIN READ ONLY");
    const result = await plan([never.id, expired.id, never.id, linkedIn.id, wrapped.id, aggregator.id, board.id,
      noLink.id, sameLink.id, removed.id, missing, "not-an-id"]);
    await db().query("ROLLBACK");

    expect(result.reads.map((read) => read.canonicalJobId).sort()).toEqual([never.id, expired.id].sort());
    expect(Object.fromEntries(result.excluded.map((e) => [e.id === never.id ? "again" : e.id, e.reason]))).toEqual({
      again: "LISTED_TWICE", [linkedIn.id]: "LINKEDIN_LINK", [wrapped.id]: "LINKEDIN_LINK", [aggregator.id]: "AGGREGATOR_LINK",
      [board.id]: "JOB_BOARD_LINK", [noLink.id]: "NO_POSTING_LINK", [sameLink.id]: "SAME_LINK_AS_ANOTHER_JOB",
      [removed.id]: "MANUALLY_REMOVED", [missing]: "JOB_NOT_FOUND", "not-an-id": "NOT_A_JOB_ID",
    });
    expect(await writeCounts()).toEqual(before);
  });

  it("the command without --apply plans only: no read, no write", async () => {
    const job = await createJob();
    const before = await writeCounts();
    const lines: string[] = [];
    const apply = vi.fn();
    const connect = async () => ({
      query: (text: string, values?: unknown[]) => db().query(text, values),
      // Closing a real connection ends its open transaction.
      end: async () => { await db().query("ROLLBACK"); },
    }) as unknown as pg.Client;
    const code = await runAvailabilityCheckCommand([`--job-ids=${job.id}`], { REPLAY_DATABASE_URL: databaseUrl },
      { connect, apply, log: (line) => lines.push(line) });
    expect(code).toBe(0);
    expect(apply).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("posting links to read: 1");
    expect(lines.at(-1)).toBe("PLAN: no request was made and nothing was written.");
    expect(await writeCounts()).toEqual(before);

    await expect(runAvailabilityCheckCommand(
      [`--job-ids=${job.id}`, "--apply", `--confirm-workspace=${randomUUID()}`],
      { REPLAY_DATABASE_URL: databaseUrl, AVAILABILITY_CHECK_APPLY_ALLOWED: "true" }, { connect, apply, log: () => undefined },
    )).rejects.toThrow(/does not equal/);
    expect(apply).not.toHaveBeenCalled();
    expect(await writeCounts()).toEqual(before);
  });

  it("confirms a never-checked job open today with one request, as availability evidence only", async () => {
    const job = await createJob();
    const now = new Date();
    const requested: string[] = [];
    const results = await check(job, (url) => openPage(url, job.board), now, requested);

    expect(results).toMatchObject([{ result: "OPEN", visible: true }]);
    expect(requested).toEqual([job.url]);
    const row = await availability(job);
    expect(row).toMatchObject({ availability_status: "OPEN", availability_state: "OPEN", availability_current: true });
    // The review draw reads exactly these two fields.
    expect(checkDate(row.availability_verified_at)).toBe(checkDate(now));
    expect(assessAvailability({
      status: row.availability_status, verifiedAt: row.availability_verified_at,
      expiresAt: row.availability_recheck_at, sourceExpiresAt: row.source_expires_at,
    }, now).state).toBe("OPEN");
    // The page states remote work in London; a manual check fills no job fact and queues nothing.
    expect(await jobRow(job)).toMatchObject({ archived_at: null, workplace_type: "UNKNOWN", location: "Singapore" });
    expect(await taskCount(job)).toBe(0);
    expect(await events(job)).toMatchObject([{ outcome: "OPEN", decision: "MARK_OPEN", trigger: "MANUAL" }]);

    const again = await plan([job.id], now);
    expect(again.reads).toEqual([]);
    expect(again.excluded).toEqual([{ id: job.id, reason: "ALREADY_CONFIRMED_OPEN_TODAY" }]);
  });

  it("cannot tell changes nothing, is not repeated the same day and never archives", async () => {
    const job = await createJob({ availability: "OPEN_EXPIRED" });
    const before = await availability(job);
    for (let day = 0; day < 6; day += 1) {
      const now = new Date(Date.now() + day * DAY);
      expect(await check(job, (url) => page(url, 503), now)).toMatchObject([{ result: "CANNOT_TELL", visible: null }]);
      expect((await plan([job.id], now)).excluded).toEqual([{ id: job.id, reason: "ALREADY_CHECKED_TODAY" }]);
    }
    expect(await availability(job)).toEqual(before);
    expect((await jobRow(job)).archived_at).toBeNull();
    expect(await state(job)).toBeNull();
    expect(await taskCount(job)).toBe(0);
    const recorded = await events(job);
    expect(recorded).toHaveLength(6);
    for (const event of recorded) {
      expect(event).toMatchObject({ outcome: "CANNOT_TELL", reason_code: "MANUAL_CHECK:CANNOT_TELL:SERVER_ERROR", attempts: 0, trigger: "MANUAL" });
    }
  });

  it("does not move a job whose automatic retries are used up, and does not count toward the archive gate", async () => {
    const job = await createJob({ availability: "OPEN_EXPIRED" });
    await db().query(
      `INSERT INTO job_availability_recheck_state (workspace_id, canonical_job_id, job_version_id, consecutive_absent_reads,
         cannot_tell_attempts, cycle_started_at, next_check_at)
       VALUES ($1, $2, $3, 1, 3, NOW() - INTERVAL '3 days', NOW() + INTERVAL '1 day')`,
      [ctx().workspaceId, job.id, job.versionId]);
    const before = await state(job);
    const yesterday = new Date(Date.now() - DAY);
    await check(job, (url) => page(url, 503), yesterday);
    expect(await state(job)).toEqual(before);
    expect((await jobRow(job)).archived_at).toBeNull();

    // A successful manual read of another site is no health signal either.
    const healthy = await createJob();
    await check(healthy, (url) => openPage(url, healthy.board));
    const gate = await archiveHealthGate(db(), ctx().workspaceId, job.id, "some-other-host.example.com", new Date(Date.now() + 60_000));
    expect(gate).toMatchObject({ otherHostSucceeded: false, why: "NO_HEALTH_SIGNAL" });
    expect(gate.failedDays).toBe(1); // today's hypothetical automatic failure only; yesterday's manual one is not counted

    // The fourth automatic failure behaves as it would without the manual check: no second failed day, no archive.
    const deps: AvailabilityRecheckDependencies = {
      fetchJobContent: async () => ({ kind: "RETRYABLE_FAILURE", reason: "Posting provider returned HTTP 503." }),
      refreshSourceEvidence: async () => { throw new Error("no feed in this test"); },
      createFeedAdapter: () => null,
      requestsPerMinute: async () => null,
      throttle: noWait(),
      now: () => new Date(),
    };
    const automatic = await runAvailabilityRecheck(db(), ctx(),
      { canonical_job_id: job.id, job_version_id: job.versionId, cycle_started_at: new Date(Date.now() - 3 * DAY).toISOString() }, null, deps);
    expect(automatic).toMatchObject({ status: "RECORDED", action: "RETRY_LATER" });
    expect((await jobRow(job)).archived_at).toBeNull();
  });

  it("a confirmed-open read ends the retry cycle: counters go back to zero", async () => {
    const job = await createJob({ availability: "OPEN_EXPIRED" });
    await db().query(
      `INSERT INTO job_availability_recheck_state (workspace_id, canonical_job_id, job_version_id, consecutive_absent_reads,
         cannot_tell_attempts, cycle_started_at, next_check_at)
       VALUES ($1, $2, $3, 1, 3, NOW() - INTERVAL '3 days', NOW() + INTERVAL '1 day')`,
      [ctx().workspaceId, job.id, job.versionId]);
    await check(job, (url) => openPage(url, job.board));
    expect(await state(job)).toEqual({ consecutive_absent_reads: 0, cannot_tell_attempts: 0, cycle_started_at: null, next_check_at: null });
  });

  it("records a page that is gone as closed, without archiving or queueing", async () => {
    const job = await createJob();
    expect(await check(job, (url) => page(url, 404))).toMatchObject([{ result: "CLOSED", visible: true }]);
    expect((await availability(job)).availability_state).toBe("CLOSED");
    expect((await jobRow(job)).archived_at).toBeNull();
    expect(await taskCount(job)).toBe(0);
    expect(await state(job)).toBeNull();
  });

  it("does not follow a redirect to LinkedIn: one request, cannot tell, evidence unchanged", async () => {
    const job = await createJob();
    const requested: string[] = [];
    const results = await check(job, (url) => page(url, 302, "", { location: "https://www.linkedin.com/jobs/view/1" }), new Date(), requested);
    expect(results).toMatchObject([{ result: "CANNOT_TELL" }]);
    expect(requested).toEqual([job.url]);
    expect((await availability(job)).availability_state).toBe("UNKNOWN");
  });

  it("reads serially, one site after another, pausing between reads of the same site", async () => {
    const host = `site-${randomUUID().slice(0, 8)}.example.com`;
    const a = await createJob({ url: `https://${host}/jobs/1` });
    const b = await createJob({ url: `https://${host}/jobs/2` });
    const c = await createJob({ url: `https://zz-${host}/jobs/3` });
    const log: string[] = [];
    let clock = 0;
    const throttle = new HostThrottle(() => clock, async (ms) => { log.push(`pause ${ms}`); clock += ms; });
    const planned = await plan([a.id, c.id, b.id]);
    await applyAvailabilityCheck(db(), ctx(), planned, {
      throttle, fetcher: fetcher((url) => { log.push(url.toString()); return page(url, 503); }),
    });
    expect(log).toEqual([a.url, "pause 5000", b.url, c.url]);
  });
});
