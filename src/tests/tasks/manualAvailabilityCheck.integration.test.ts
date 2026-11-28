import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { assessAvailability } from "../../decision/availability.js";
import type { PostingFetcherDependencies, SafeHttpResponse } from "../../ingestion/jobContentFetcher.js";
import { generateContentHash } from "../../services/criteria.js";
import {
  archiveHealthGate,
  HostThrottle,
  runAvailabilityRecheck,
  seedAvailabilityRechecks,
  type AvailabilityRecheckDependencies,
} from "../../tasks/availabilityRecheck.js";
import { fetchJobContent } from "../../ingestion/jobContentFetcher.js";
import {
  applyAvailabilityCheck,
  checkDate,
  formatPlan,
  planAvailabilityCheck,
  runAvailabilityCheckCommand,
  verdictVisible,
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
    // Exclusions name the position in the list, never the entry.
    expect(result.excluded.map((e) => [e.line, e.reason])).toEqual([
      [3, "LISTED_TWICE"], [4, "LINKEDIN_LINK"], [5, "LINKEDIN_LINK"], [6, "AGGREGATOR_LINK"], [7, "JOB_BOARD_LINK"],
      [8, "NO_POSTING_LINK"], [9, "SAME_LINK_AS_ANOTHER_JOB"], [10, "MANUALLY_REMOVED"], [11, "JOB_NOT_FOUND"], [12, "NOT_A_JOB_ID"],
    ]);
    expect(formatPlan(result)).not.toContain("not-an-id");
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
      [`--job-ids=${job.id}`, "--apply", `--confirm-workspace=${randomUUID()}`, "--confirm-plan=x"],
      { REPLAY_DATABASE_URL: databaseUrl, AVAILABILITY_CHECK_APPLY_ALLOWED: "true" }, { connect, apply, log: () => undefined },
    )).rejects.toThrow(/does not equal/);
    expect(apply).not.toHaveBeenCalled();

    const planId = /plan id: ([0-9a-f]{16})/.exec(lines.join("\n"))![1]!;
    const env = { REPLAY_DATABASE_URL: databaseUrl, AVAILABILITY_CHECK_APPLY_ALLOWED: "true" };
    const confirm = [`--confirm-workspace=${ctx().workspaceId}`, `--confirm-plan=${planId}`, "--apply"];
    // Another job list than the confirmed one: refused, nothing requested.
    const other = await createJob();
    await expect(runAvailabilityCheckCommand([`--job-ids=${job.id},${other.id}`, ...confirm], env, { connect, apply, log: () => undefined }))
      .rejects.toThrow(/differ from the confirmed plan/);
    expect(apply).not.toHaveBeenCalled();
    apply.mockResolvedValue([]);
    expect(await runAvailabilityCheckCommand([`--job-ids=${job.id}`, ...confirm], env, { connect, apply, log: () => undefined })).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
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
    expect(again.excluded).toEqual([{ line: 1, reason: "ALREADY_CONFIRMED_OPEN_TODAY" }]);
  });

  it("cannot tell changes nothing, is not repeated the same day and never archives", async () => {
    const job = await createJob({ availability: "OPEN_EXPIRED" });
    const before = await availability(job);
    for (let day = 0; day < 6; day += 1) {
      const now = new Date(Date.now() + day * DAY);
      expect(await check(job, (url) => page(url, 503), now)).toMatchObject([{ result: "CANNOT_TELL", visible: null }]);
      expect((await plan([job.id], now)).excluded).toEqual([{ line: 1, reason: "ALREADY_CHECKED_TODAY" }]);
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

  it("binds a plan to its job list, links and Singapore date", async () => {
    const job = await createJob();
    const other = await createJob();
    const morning = new Date("2026-01-10T01:00:00Z");
    const first = await plan([job.id, other.id], morning);
    expect((await plan([other.id, job.id], new Date("2026-01-10T15:59:00Z"))).planId).toBe(first.planId);
    expect((await plan([job.id, other.id], new Date("2026-01-10T16:00:00Z"))).planId).not.toBe(first.planId);
    expect((await plan([job.id, other.id, "x"], morning)).planId).not.toBe(first.planId);
    await db().query(`UPDATE raw_job_observations SET source_url = source_url || '?v=2', canonical_apply_url = NULL WHERE job_version_id = $1`, [job.versionId]);
    expect((await plan([job.id, other.id], morning)).planId).not.toBe(first.planId);

    // Past midnight in Singapore nothing more is requested.
    const planned = await plan([other.id], new Date("2026-01-10T15:00:00Z"));
    const requested: string[] = [];
    const results = await applyAvailabilityCheck(db(), ctx(), planned, {
      throttle: noWait(), fetcher: fetcher((url) => page(url, 503), requested), now: () => new Date("2026-01-10T16:00:01Z"),
    });
    expect(results).toMatchObject([{ result: "SKIPPED", detail: "CHECK_DATE_CHANGED" }]);
    expect(requested).toEqual([]);
  });

  it("never requests a link shared by two jobs again in a later run", async () => {
    const first = await createJob();
    const second = await createJob({ url: first.url });
    await check(first, (url) => page(url, 503));
    expect((await plan([second.id])).excluded).toEqual([{ line: 1, reason: "SAME_LINK_AS_ANOTHER_JOB" }]);
    expect((await plan([first.id, second.id])).reads).toEqual([]);
  });

  it.each([429, 403])("stops reading a site after a %i, in the run and for the rest of the day", async (status) => {
    const host = `stop-${randomUUID().slice(0, 8)}.example.com`;
    const a = await createJob({ url: `https://${host}/jobs/1` });
    const b = await createJob({ url: `https://${host}/jobs/2` });
    const requested: string[] = [];
    const results = await applyAvailabilityCheck(db(), ctx(), await plan([a.id, b.id]), {
      throttle: noWait(), fetcher: fetcher((url) => page(url, status), requested),
    });
    expect(results).toMatchObject([{ result: "CANNOT_TELL" }, { result: "SKIPPED", detail: "SITE_STOPPED_AFTER_429_OR_BLOCK" }]);
    expect(requested).toEqual([a.url]);
    expect(await events(b)).toEqual([]);
    expect((await plan([b.id])).excluded).toEqual([{ line: 1, reason: "SITE_STOPPED_TODAY" }]);
  });

  it("paces a redirect hop by the same interval as the next job", async () => {
    const job = await createJob({ url: `https://hop-${randomUUID().slice(0, 8)}.example.com/jobs/1` });
    const log: string[] = [];
    let clock = 0;
    const throttle = new HostThrottle(() => clock, async (ms) => { log.push(`pause ${ms}`); clock += ms; });
    await applyAvailabilityCheck(db(), ctx(), await plan([job.id]), {
      throttle,
      fetcher: fetcher((url) => {
        log.push(url.pathname);
        return url.pathname === "/jobs/1" ? page(url, 302, "", { location: "/jobs/moved" }) : page(url, 503);
      }),
    });
    expect(log).toEqual(["/jobs/1", "pause 5000", "/jobs/moved"]);
  });

  it("puts the minimum interval into the plan id", async () => {
    const job = await createJob();
    const now = new Date();
    const at = (intervalSeconds: number) => planAvailabilityCheck(db(), ctx(), [job.id], { now, intervalSeconds, requestsPerMinute: async () => 2 });
    // The manifest's slower pace hides the difference in the reads themselves; the plan id still differs.
    const [five, ten] = [await at(5), await at(10)];
    expect(five.reads).toEqual(ten.reads);
    expect(five.planId).not.toBe(ten.planId);
  });

  it("never requests a site stopped earlier today, also not through a redirect", async () => {
    const stoppedHost = `halt-${randomUUID().slice(0, 8)}.example.com`;
    const first = await createJob({ url: `https://${stoppedHost}/jobs/1` });
    await check(first, (url) => page(url, 429));
    const second = await createJob();
    const planned = await plan([second.id]);
    expect(planned.stoppedSites).toContain(stoppedHost);
    const requested: string[] = [];
    const results = await applyAvailabilityCheck(db(), ctx(), planned, {
      throttle: noWait(), fetcher: fetcher((url) => page(url, 302, "", { location: `https://${stoppedHost}/jobs/9` }), requested),
    });
    expect(results).toMatchObject([{ result: "CANNOT_TELL" }]);
    expect(requested).toEqual([second.url]);
  });

  it.each([200, 503])("treats a challenge page answering %i as a site stop", async (status) => {
    const host = `wall-${randomUUID().slice(0, 8)}.example.com`;
    const a = await createJob({ url: `https://${host}/jobs/1` });
    const b = await createJob({ url: `https://${host}/jobs/2` });
    const requested: string[] = [];
    const results = await applyAvailabilityCheck(db(), ctx(), await plan([a.id, b.id]), {
      throttle: noWait(),
      fetcher: fetcher((url) => page(url, status, "<html><head><title>Just a moment...</title></head><body></body></html>"), requested),
    });
    expect(results).toMatchObject([{ result: "CANNOT_TELL" }, { result: "SKIPPED", detail: "SITE_STOPPED_AFTER_429_OR_BLOCK" }]);
    expect(requested).toEqual([a.url]);
    expect((await plan([b.id])).excluded).toEqual([{ line: 1, reason: "SITE_STOPPED_TODAY" }]);
  });

  it("stops the host that served a challenge after a redirect, as well as the site being read", async () => {
    const wall = `wall-${randomUUID().slice(0, 8)}.example.com`;
    const job = await createJob();
    const behindWall = await createJob({ url: `https://${wall}/jobs/1` });
    await check(job, (url) => url.hostname === wall
      ? page(url, 200, "<html><head><title>Just a moment...</title></head></html>")
      : page(url, 302, "", { location: `https://${wall}/challenge` }));
    expect((await plan([behindWall.id])).excluded).toEqual([{ line: 1, reason: "SITE_STOPPED_TODAY" }]);
  });

  it("takes an open page with closure wording back to cannot-tell and leaves the automatic re-check as it was", async () => {
    const job = await createJob();
    const closing = (url: URL) => {
      const body = openPage(url, job.board).body.toString("utf8").replace("</h1>", "</h1><p>Applications are now closed.</p>");
      return page(url, 200, body);
    };
    const results = await check(job, closing);
    expect(results).toMatchObject([{ result: "CANNOT_TELL", visible: null }]);
    expect(results[0]!.detail).toContain("CLOSURE_WORDING");
    expect((await availability(job)).availability_state).toBe("UNKNOWN");

    // The same page read by the automatic re-check is open, as on main.
    const other = await createJob({ availability: "OPEN_EXPIRED" });
    const automatic = await runAvailabilityRecheck(db(), ctx(),
      { canonical_job_id: other.id, job_version_id: other.versionId, cycle_started_at: new Date().toISOString() }, null, {
        fetchJobContent: (url, expected) => fetchJobContent(url, expected, fetcher((target) => {
          const body = openPage(target, other.board).body.toString("utf8").replace("</h1>", "</h1><p>Applications are now closed.</p>");
          return page(target, 200, body);
        })),
        refreshSourceEvidence: async () => { throw new Error("no feed in this test"); },
        createFeedAdapter: () => null,
        requestsPerMinute: async () => null,
        throttle: noWait(),
        now: () => new Date(),
      });
    expect(automatic).toMatchObject({ outcome: "OPEN" });
  });

  it("flags a closed verdict taken from page wording for a check by hand", async () => {
    const job = await createJob();
    const results = await check(job, (url) => page(url, 200, "<html><body><p>This position has been filled.</p></body></html>"));
    expect(results).toMatchObject([{ result: "CLOSED", checkByHand: true, line: 1 }]);
    const gone = await createJob();
    expect(await check(gone, (url) => page(url, 404))).toMatchObject([{ result: "CLOSED", checkByHand: false }]);
  });

  it("leaves out hard-rejected jobs and test fixtures", async () => {
    const rejected = await createJob();
    const gateRejected = await createJob();
    const fixture = await createJob();
    await db().query(`UPDATE canonical_jobs SET processing_state = 'HARD_REJECTED', processing_status = 'HARD_REJECTED' WHERE id = $1`, [rejected.id]);
    await db().query(`UPDATE canonical_jobs SET gate_decision = 'HARD_REJECT' WHERE id = $1`, [gateRejected.id]);
    await db().query(`UPDATE canonical_jobs SET is_test_fixture = TRUE WHERE id = $1`, [fixture.id]);
    const result = await plan([rejected.id, gateRejected.id, fixture.id]);
    expect(result.reads).toEqual([]);
    expect(result.excluded.map((e) => e.reason)).toEqual(["HARD_REJECTED", "HARD_REJECTED", "TEST_FIXTURE"]);
  });

  it("reports a verdict the read model does not hold as not visible", async () => {
    expect(await verdictVisible(db(), ctx().workspaceId, randomUUID(), true, new Date())).toBe(false);
    expect(await verdictVisible(db(), ctx().workspaceId, randomUUID(), false, new Date())).toBe(false);
  });

  it("keeps the stored score of a job whose match is not current, and writes a posting that closed", async () => {
    const withScore = async () => {
      const job = await createJob();
      await db().query(
        `UPDATE canonical_jobs SET gate_decision = 'PASS', processing_state = 'MATCHED', processing_status = 'MATCHED',
                recommendation_requirement_score = 0.75, recommendation_outcome = 'REVIEW', recommendation_eligibility = 'ELIGIBLE'
          WHERE id = $1`, [job.id]);
      return job;
    };
    const stored = async (job: Fixture) => (await db().query(
      `SELECT recommendation_requirement_score::float AS score, recommendation_outcome AS outcome,
              recommendation_eligibility AS eligibility, latest_deterministic_decision_id IS NOT NULL AS decided
         FROM canonical_jobs WHERE id = $1`, [job.id])).rows[0];

    const open = await withScore();
    expect(await check(open, (url) => openPage(url, open.board))).toMatchObject([{ visible: true }]);
    expect(await stored(open)).toEqual({ score: 0.75, outcome: "REVIEW", eligibility: "ELIGIBLE", decided: true });
    const closed = await withScore();
    expect(await check(closed, (url) => page(url, 404))).toMatchObject([{ visible: true }]);
    expect(await stored(closed)).toEqual({ score: 0.75, outcome: "SKIP", eligibility: "INELIGIBLE", decided: true });
  });

  it("a manual cannot-tell between automatic reads neither forks the retry chain nor brings the archive closer", async () => {
    const job = await createJob({ availability: "OPEN_EXPIRED" });
    const scope = { jobVersionIds: [job.versionId] };
    const start = Date.now();
    const hours = (n: number) => new Date(start + n * 3_600_000);
    const deps = (now: Date): AvailabilityRecheckDependencies => ({
      fetchJobContent: async () => ({ kind: "RETRYABLE_FAILURE", reason: "Posting provider returned HTTP 503." }),
      refreshSourceEvidence: async () => { throw new Error("no feed in this test"); },
      createFeedAdapter: () => null,
      requestsPerMinute: async () => null,
      throttle: noWait(),
      now: () => now,
    });
    const pending = async () => (await db().query<{ task_key: string; payload: Record<string, unknown> }>(
      `SELECT task_key, payload FROM pipeline_tasks
        WHERE task_type = 'RECHECK_AVAILABILITY' AND payload->>'canonical_job_id' = $1 AND status = 'PENDING'`, [job.id])).rows;
    const runQueued = async (now: Date) => {
      const [task, ...others] = await pending();
      expect(others).toEqual([]);
      const result = await runAvailabilityRecheck(db(), ctx(), task!.payload, null, deps(now));
      await db().query(`UPDATE pipeline_tasks SET status = 'COMPLETED', completed_at = NOW() WHERE task_key = $1`, [task!.task_key]);
      return result;
    };

    expect(await seedAvailabilityRechecks(db(), ctx(), scope)).toMatchObject({ inserted: 1 });
    expect(await runQueued(hours(0))).toMatchObject({ action: "RETRY_LATER" });
    const chain = await pending();
    await check(job, (url) => page(url, 503), hours(6));
    expect(await seedAvailabilityRechecks(db(), ctx(), scope)).toMatchObject({ inserted: 0, existing: 1 });
    expect(await pending()).toEqual(chain);
    expect(await state(job)).toMatchObject({ cannot_tell_attempts: 1 });
    // The chain goes on one retry at a time: attempts 2 and 3 are retries, as without the manual check.
    expect(await runQueued(hours(24))).toMatchObject({ action: "RETRY_LATER" });
    expect(await seedAvailabilityRechecks(db(), ctx(), scope)).toMatchObject({ inserted: 0 });
    expect(await runQueued(hours(48))).toMatchObject({ action: "RETRY_LATER" });
    expect(await state(job)).toMatchObject({ cannot_tell_attempts: 3 });
    expect((await jobRow(job)).archived_at).toBeNull();
  });

  it("a manual cannot-tell today does not hide today's automatic failure from the archive gate", async () => {
    const job = await createJob({ availability: "OPEN_EXPIRED" });
    const now = new Date("2026-03-10T08:00:00Z");
    await db().query(
      `INSERT INTO job_availability_recheck_events (workspace_id, canonical_job_id, job_version_id, read_kind, outcome, decision,
         reason_code, consecutive_absent_reads_after, cannot_tell_attempts_after, occurred_at)
       VALUES ($1, $2, $3, 'PAGE', 'CANNOT_TELL', 'RETRY_LATER', 'FIXTURE', 0, 1, $4)`,
      [ctx().workspaceId, job.id, job.versionId, new Date("2026-03-09T08:00:00Z")]);
    await check(job, (url) => page(url, 503), now);
    expect((await archiveHealthGate(db(), ctx().workspaceId, job.id, "host.example.com", now)).failedDays).toBe(2);
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
