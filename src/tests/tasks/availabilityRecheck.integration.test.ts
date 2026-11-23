import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import type { JobContentResult } from "../../ingestion/jobContentFetcher.js";
import { refreshCanonicalJobSourceEvidence } from "../../ingestion/sourceEvidenceRefresh.js";
import { generateContentHash } from "../../services/criteria.js";
import { buildJobSourceEvidence } from "../../ingestion/jobSourceEvidence.js";
import { runNormalization } from "../../pipeline/normalize.js";
import {
  AVAILABILITY_RECHECK_ARCHIVE_RULE,
  archiveJobsAsPostingNotConfirmable,
  restoreAvailabilityArchivedJob,
} from "../../services/jobArchive.js";
import { WorkdayAdapter } from "../../ingestion/adapters/workdayAdapter.js";
import {
  HostThrottle,
  createWorkdayListingAdapter,
  compareFacts,
  createFeedAdapterForPosting,
  outcomeFromFeedRefresh,
  outcomeFromPageRead,
  runAvailabilityRecheck,
  seedAvailabilityRechecks,
  type AvailabilityRecheckDependencies,
} from "../../tasks/availabilityRecheck.js";
import { runPipelineStageTaskWorker, type PipelineStageWorkerDependencies } from "../../tasks/stageTaskWorker.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// RECHECK_AVAILABILITY against real PostgreSQL. Every job, employer and posting below is synthetic.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);

const DAY = 24 * 3_600_000;
const T0 = new Date();
const at = (days: number) => new Date(T0.getTime() + days * DAY);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The availability re-check test client is not initialized.");
  return client;
}
function ctx(): WorkspaceContext {
  if (!context) throw new Error("The availability re-check test workspace is not initialized.");
  return context;
}

interface Fixture {
  canonicalJobId: string;
  jobVersionId: string;
  observationId: string;
  postingUrl: string;
  record: Record<string, unknown>;
}

interface FixtureOptions {
  sourceName?: string;
  pluginKey?: string;
  board?: string;
  workplaceType?: string;
  location?: string;
  rawPayload?: Record<string, unknown>;
  /** Window ended this many days before T0; null leaves the job never verified. */
  windowEndedDaysAgo?: number | null;
  processingState?: string;
}

async function createJob(options: FixtureOptions = {}): Promise<Fixture> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  const observationId = randomUUID();
  const board = options.board ?? "recheck-board";
  const sourceName = options.sourceName ?? "GREENHOUSE";
  const pluginKey = options.pluginKey ?? "greenhouse";
  const postingUrl = `https://boards.greenhouse.io/${board}/jobs/${observationId}`;
  const title = "Synthetic Platform Engineer";
  const description = "Build and operate synthetic data pipelines for an imaginary engineering organisation, end to end.";
  const record = options.rawPayload ?? {
    id: observationId, title, location: { name: options.location ?? "Singapore" },
    absolute_url: postingUrl, content: description, status: "active", published_at: "2026-10-20T00:00:00.000Z",
  };
  const rawPayloadHash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
  const company = board.toUpperCase();
  const contentHash = generateContentHash(company, title, description);
  const workspaceId = ctx().workspaceId;
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, location,
       workplace_type, processing_state, processing_status, description_quality_status, version_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'COMPLETE', 1)`,
    [canonicalJobId, workspaceId, company, title.toLowerCase(), postingUrl, options.location ?? "Singapore",
      options.workplaceType ?? "UNKNOWN", options.processingState ?? "NEEDS_VERIFICATION"],
  );
  const ended = options.windowEndedDaysAgo === undefined ? 1 : options.windowEndedDaysAgo;
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at,
       availability_status, availability_verified_at, availability_recheck_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6,
       CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $7::int + 7) END,
       CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $7::int) END)`,
    [jobVersionId, workspaceId, canonicalJobId, contentHash, description, ended === null ? null : "OPEN", ended],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`,
    [jobVersionId, workspaceId, canonicalJobId]);
  await db().query(
    `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_plugin_key, source_external_id, source_url,
       retrieved_at, company_name, title, description_raw, location_raw, workplace_type_raw, employment_type_raw,
       compensation_raw, canonical_apply_url, raw_payload, raw_payload_hash, processing_status, job_version_id)
     VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '8 days', $7, $8, $9, $10, $11, 'FULL_TIME', 'UNKNOWN',
       $6, $12::jsonb, $13, 'PROCESSED', $14)`,
    [observationId, workspaceId, sourceName, pluginKey, observationId, postingUrl, company, title, description,
      options.location ?? "Singapore", options.workplaceType ?? "UNKNOWN", JSON.stringify(record), rawPayloadHash, jobVersionId],
  );
  return { canonicalJobId, jobVersionId, observationId, postingUrl, record };
}

async function archiveAsAged(job: Fixture): Promise<void> {
  const run = await db().query<{ id: string }>(
    `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`,
  );
  await db().query(
    `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = 'JOB_OLDER_THAN_THREE_CALENDAR_MONTHS',
            archive_age_basis = 'AUTHORITATIVE_PUBLICATION_DATE', archive_reference_at = NOW(), archive_run_id = $2
      WHERE id = $1`,
    [job.canonicalJobId, run.rows[0]!.id],
  );
}

function payload(job: Fixture, cycleStart: Date = at(-1)) {
  return { canonical_job_id: job.canonicalJobId, job_version_id: job.jobVersionId, cycle_started_at: cycleStart.toISOString() };
}

async function availabilityState(job: Fixture): Promise<string> {
  const { rows } = await db().query<{ availability_state: string }>(
    `SELECT availability_state FROM v_job_availability_current WHERE workspace_id = $1 AND canonical_job_id = $2`,
    [ctx().workspaceId, job.canonicalJobId],
  );
  return rows[0]?.availability_state ?? "MISSING";
}

async function archiveInfo(job: Fixture): Promise<{ archived: boolean; reason: string | null; basis: string | null }> {
  const { rows } = await db().query<{ archived_at: Date | null; archive_reason: string | null; archive_age_basis: string | null }>(
    `SELECT archived_at, archive_reason, archive_age_basis FROM canonical_jobs WHERE workspace_id = $1 AND id = $2`,
    [ctx().workspaceId, job.canonicalJobId],
  );
  return { archived: rows[0]?.archived_at != null, reason: rows[0]?.archive_reason ?? null, basis: rows[0]?.archive_age_basis ?? null };
}

async function events(job: Fixture): Promise<Array<{ outcome: string; decision: string; absent: number; attempts: number; reason_code: string }>> {
  const { rows } = await db().query(
    `SELECT outcome, decision, consecutive_absent_reads_after AS absent, cannot_tell_attempts_after AS attempts, reason_code
       FROM job_availability_recheck_events WHERE workspace_id = $1 AND canonical_job_id = $2 ORDER BY id`,
    [ctx().workspaceId, job.canonicalJobId],
  );
  return rows;
}

async function pendingTasks(job: Fixture, taskType: string): Promise<Array<{ task_key: string; available_at: Date; payload: Record<string, unknown> }>> {
  const { rows } = await db().query(
    `SELECT task_key, available_at, payload FROM pipeline_tasks
      WHERE workspace_id = $1 AND task_type = $2 AND payload->>'canonical_job_id' = $3 AND status = 'PENDING' ORDER BY created_at`,
    [ctx().workspaceId, taskType, job.canonicalJobId],
  );
  return rows;
}

function throttle(): HostThrottle {
  return new HostThrottle(() => 0, async () => undefined);
}

function deps(overrides: Partial<Omit<AvailabilityRecheckDependencies, "now">> & { now: Date }): AvailabilityRecheckDependencies {
  const { now, ...rest } = overrides;
  return {
    fetchJobContent: async () => { throw new Error("The page reader must not be called in this test."); },
    refreshSourceEvidence: async () => { throw new Error("The feed reader must not be called in this test."); },
    createFeedAdapter: () => null,
    requestsPerMinute: async () => null,
    throttle: throttle(),
    now: () => now,
    ...rest,
  };
}

const pageComplete = (availability: "OPEN" | "CLOSED" | "UNKNOWN", workplaceType = "UNKNOWN", location: string | null = null): JobContentResult =>
  ({ kind: "COMPLETE", posting: { availability, workplaceType, location } } as unknown as JobContentResult);

function stubFeed(jobs: Array<Record<string, unknown>> | "ERROR"): void {
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (jobs === "ERROR") return new Response("upstream error", { status: 503 });
    return new Response(JSON.stringify({ jobs }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
}

describe("pure mappings", () => {
  it("maps page reads: gone is closed, unreadable is never closed", () => {
    expect(outcomeFromPageRead({ kind: "UNAVAILABLE", reason: "The exact posting URL returned HTTP 404.", evidence: {} as never }))
      .toEqual({ kind: "CLOSED_BY_PAGE", reasonCode: "PAGE_NOT_FOUND" });
    expect(outcomeFromPageRead({ kind: "UNAVAILABLE", reason: "Page says it is no longer accepting applications.", evidence: {} as never }))
      .toEqual({ kind: "CLOSED_BY_PAGE", reasonCode: "PAGE_NO_LONGER_ACCEPTING" });
    expect(outcomeFromPageRead({ kind: "BLOCKED", reason: "AUTH_REQUIRED" })).toEqual({ kind: "CANNOT_TELL", reason: "PAYWALL_OR_LOGIN" });
    expect(outcomeFromPageRead({ kind: "BLOCKED", reason: "BOT_BLOCKED" })).toEqual({ kind: "CANNOT_TELL", reason: "BOT_BLOCKED" });
    expect(outcomeFromPageRead({ kind: "RETRYABLE_FAILURE", reason: "Posting provider returned HTTP 503." })).toEqual({ kind: "CANNOT_TELL", reason: "SERVER_ERROR" });
    expect(outcomeFromPageRead({ kind: "RETRYABLE_FAILURE", reason: "Posting provider rate limited the request." })).toEqual({ kind: "CANNOT_TELL", reason: "RATE_LIMITED" });
    expect(outcomeFromPageRead({ kind: "RETRYABLE_FAILURE", reason: "socket hang up" })).toEqual({ kind: "CANNOT_TELL", reason: "TIMEOUT_OR_NETWORK" });
    expect(outcomeFromPageRead(pageComplete("CLOSED"))).toEqual({ kind: "CLOSED_BY_PAGE", reasonCode: "PAGE_STATES_POSTING_CLOSED" });
    expect(outcomeFromPageRead(pageComplete("OPEN"))).toEqual({ kind: "OPEN" });
  });

  it("maps feed refreshes: only a complete snapshot without the posting is absence", () => {
    const base = { canonicalJobId: "a", jobVersionId: "b", observationId: "c" };
    expect(outcomeFromFeedRefresh({ ...base, status: "UNAVAILABLE" })).toEqual({ kind: "FEED_ABSENT" });
    expect(outcomeFromFeedRefresh({ ...base, status: "FETCH_FAILED" })).toEqual({ kind: "CANNOT_TELL", reason: "TIMEOUT_OR_NETWORK" });
    expect(outcomeFromFeedRefresh({ ...base, status: "UNSUPPORTED", reasonCode: "SOURCE_DATA_UNSUPPORTED" })).toEqual({ kind: "CANNOT_TELL", reason: "INCOMPLETE_FEED" });
    expect(outcomeFromFeedRefresh({ ...base, status: "CONFLICT" })).toEqual({ kind: "CANNOT_TELL", reason: "FEED_RECORD_CONFLICT" });
    expect(outcomeFromFeedRefresh({ ...base, status: "REFRESHED" })).toEqual({ kind: "OPEN" });
    expect(outcomeFromFeedRefresh({ ...base, status: "STALE_VERSION" })).toBe("STALE");
  });

  it("builds a feed adapter only for an official board link", () => {
    expect(createFeedAdapterForPosting("greenhouse", "https://boards.greenhouse.io/acme/jobs/1")?.sourceName).toBeTruthy();
    expect(createFeedAdapterForPosting("greenhouse", "http://boards.greenhouse.io/acme/jobs/1")).toBeNull();
    expect(createFeedAdapterForPosting("greenhouse", "https://evil.example/acme/jobs/1")).toBeNull();
    expect(createFeedAdapterForPosting("gmail_alert", "https://boards.greenhouse.io/acme/jobs/1")).toBeNull();
  });

  it("an unknown fact never counts as a change; a known different one does", () => {
    expect(compareFacts({ workplaceTypeRaw: "HYBRID", locationRaw: "Singapore" }, { workplaceTypeRaw: "UNKNOWN", locationRaw: "" })).toEqual({ workMode: null, territory: null });
    expect(compareFacts({ workplaceTypeRaw: "HYBRID", locationRaw: "Singapore" }, { workplaceTypeRaw: "REMOTE", locationRaw: "Singapore" }).workMode).toEqual({ before: "HYBRID", after: "REMOTE" });
    expect(compareFacts({ workplaceTypeRaw: "UNKNOWN", locationRaw: "Singapore" }, { workplaceTypeRaw: "HYBRID", locationRaw: "singapore " }).workMode).toEqual({ before: "UNKNOWN", after: "HYBRID" });
    expect(compareFacts({ workplaceTypeRaw: "HYBRID", locationRaw: "Singapore" }, { workplaceTypeRaw: "HYBRID", locationRaw: "London" }).territory).toEqual({ before: "singapore", after: "london" });
  });

  it("spaces reads of one host by the interval and leaves other hosts alone", async () => {
    let clock = 0;
    const slept: number[] = [];
    const gate = new HostThrottle(() => clock, async (ms) => { slept.push(ms); clock += ms; });
    await gate.acquire("a.example", 1000);
    await gate.acquire("a.example", 1000);
    await gate.acquire("a.example", 1000);
    await gate.acquire("b.example", 1000);
    expect(slept).toEqual([1000, 1000]);
  });
});

describe.skipIf(skipReal)("RECHECK_AVAILABILITY (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `availability_recheck_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("queues one re-check for a live job whose window ran out, and for no other job", async () => {
    const expired = await createJob({ windowEndedDaysAgo: 1 });
    const stillOpen = await createJob({ windowEndedDaysAgo: -3 });
    const neverVerified = await createJob({ windowEndedDaysAgo: null });
    const rejected = await createJob({ windowEndedDaysAgo: 2, processingState: "HARD_REJECTED" });
    const archived = await createJob({ windowEndedDaysAgo: 2 });
    await archiveAsAged(archived);
    const first = await seedAvailabilityRechecks(db(), ctx(), { jobVersionIds: [expired.jobVersionId, stillOpen.jobVersionId, neverVerified.jobVersionId, rejected.jobVersionId, archived.jobVersionId] });
    expect(first).toMatchObject({ candidates: 1, inserted: 1, existing: 0 });
    expect(await pendingTasks(expired, "RECHECK_AVAILABILITY")).toHaveLength(1);
    for (const other of [stillOpen, neverVerified, rejected, archived]) {
      expect(await pendingTasks(other, "RECHECK_AVAILABILITY")).toHaveLength(0);
    }
    const again = await seedAvailabilityRechecks(db(), ctx(), { jobVersionIds: [expired.jobVersionId] });
    expect(again).toMatchObject({ candidates: 1, inserted: 0, existing: 1 });
  });

  it("feed read: absent once waits a day; absent twice in a row closes; the job is hidden, not archived", async () => {
    const job = await createJob({ windowEndedDaysAgo: 1 });
    const other = { id: "someone-else", title: "Another Role", location: { name: "Singapore" }, absolute_url: "https://boards.greenhouse.io/recheck-board/jobs/other", content: "Another synthetic posting with enough text to be valid.", status: "active" };
    stubFeed([other]);
    const feedDeps = (now: Date) => deps({
      now,
      createFeedAdapter: createFeedAdapterForPosting,
      refreshSourceEvidence: refreshCanonicalJobSourceEvidence,
    });
    const first = await runAvailabilityRecheck(db(), ctx(), payload(job), null, feedDeps(at(0)));
    expect(first).toMatchObject({ status: "RECORDED", readKind: "FEED", outcome: "FEED_ABSENT", action: "WAIT_NEXT_READ", nextTaskQueued: true });
    expect(await availabilityState(job)).toBe("UNKNOWN");
    const queued = await pendingTasks(job, "RECHECK_AVAILABILITY");
    expect(queued).toHaveLength(1);
    expect(new Date(queued[0]!.available_at).getTime()).toBe(at(1).getTime());

    const second = await runAvailabilityRecheck(db(), ctx(), payload(job), null, feedDeps(at(1)));
    expect(second).toMatchObject({ outcome: "FEED_ABSENT", action: "MARK_CLOSED", nextTaskQueued: false });
    expect(await availabilityState(job)).toBe("CLOSED");
    expect((await archiveInfo(job)).archived).toBe(false);
    expect(await events(job)).toMatchObject([
      { outcome: "FEED_ABSENT", decision: "WAIT_NEXT_READ", absent: 1 },
      { outcome: "FEED_ABSENT", decision: "MARK_CLOSED", absent: 2 },
    ]);
  });

  it("feed read: a failed read is cannot-tell; it neither closes nor counts as absence", async () => {
    const job = await createJob({ windowEndedDaysAgo: 1 });
    stubFeed("ERROR");
    const result = await runAvailabilityRecheck(db(), ctx(), payload(job), null, deps({
      now: at(0), createFeedAdapter: createFeedAdapterForPosting, refreshSourceEvidence: refreshCanonicalJobSourceEvidence,
    }));
    expect(result).toMatchObject({ outcome: "CANNOT_TELL", action: "RETRY_LATER", nextTaskQueued: true });
    expect(await availabilityState(job)).toBe("UNKNOWN");
    expect((await events(job))[0]).toMatchObject({ absent: 0, attempts: 1 });
  });

  it("feed read: the posting present refreshes it open and restarts the 7-day window", async () => {
    const job = await createJob({ windowEndedDaysAgo: 1 });
    stubFeed([job.record]);
    const result = await runAvailabilityRecheck(db(), ctx(), payload(job), null, deps({
      now: new Date(), createFeedAdapter: createFeedAdapterForPosting, refreshSourceEvidence: refreshCanonicalJobSourceEvidence,
    }));
    expect(result).toMatchObject({ outcome: "OPEN", action: "MARK_OPEN", nextTaskQueued: false });
    expect(await availabilityState(job)).toBe("OPEN");
  });

  it("cannot tell three times archives as POSTING_NOT_CONFIRMABLE by day 3 of the cycle, and keeps every record", async () => {
    const job = await createJob({ windowEndedDaysAgo: 1 });
    const login = deps({ now: at(0), fetchJobContent: async () => ({ kind: "BLOCKED", reason: "AUTH_REQUIRED" }) });
    const cycle = at(0);
    const outcomes: string[] = [];
    for (let day = 0; day <= 3; day += 1) {
      const result = await runAvailabilityRecheck(db(), ctx(), payload(job, cycle), null, { ...login, now: () => at(day) });
      if (result.status === "RECORDED") outcomes.push(result.action);
      expect((await availabilityState(job))).not.toBe("CLOSED");
    }
    expect(outcomes).toEqual(["RETRY_LATER", "RETRY_LATER", "RETRY_LATER", "ARCHIVE_NOT_CONFIRMABLE"]);
    expect(await archiveInfo(job)).toEqual({ archived: true, reason: "POSTING_NOT_CONFIRMABLE", basis: "POSTING_LINK_UNVERIFIABLE" });
    expect((await events(job)).map((event) => event.decision)).toEqual(["RETRY_LATER", "RETRY_LATER", "RETRY_LATER", "ARCHIVE_NOT_CONFIRMABLE"]);
    const marker = await db().query(
      `SELECT details->>'rule' AS rule FROM job_archive_events WHERE canonical_job_id = $1 AND action = 'ARCHIVED'`, [job.canonicalJobId]);
    expect(marker.rows[0]?.rule).toBe("availability-recheck");
    const observations = await db().query(`SELECT COUNT(*)::int AS n FROM raw_job_observations WHERE job_version_id = $1`, [job.jobVersionId]);
    expect(observations.rows[0]?.n).toBe(1);
  });

  it("never auto-archives a saved, applied or held job; the reason is on record", async () => {
    const saved = await createJob({ windowEndedDaysAgo: 1 });
    await db().query(
      `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title,
         description_raw, location_raw, workplace_type_raw, employment_type_raw, compensation_raw, raw_payload, raw_payload_hash,
         processing_status, job_version_id)
       VALUES ($1, 'LINKEDIN_SAVED', $2, $3, NOW() - INTERVAL '9 days', 'SAVED-CO', 'Synthetic Platform Engineer', 'x', 'Singapore',
         'UNKNOWN', 'FULL_TIME', 'UNKNOWN', '{}'::jsonb, $4, 'PROCESSED', $5)`,
      [ctx().workspaceId, `saved-${randomUUID()}`, `https://example.test/saved/${randomUUID()}`, randomUUID().replaceAll("-", "").padEnd(64, "0"), saved.jobVersionId],
    );
    const held = await createJob({ windowEndedDaysAgo: 1 });
    await db().query(
      `INSERT INTO job_archive_holds (workspace_id, canonical_job_id, hold_reason, hold_type, created_by, expires_at)
       VALUES ($1, $2, 'owner keeps it', 'USER_PRESERVE', 'test', NOW() + INTERVAL '30 days')`,
      [ctx().workspaceId, held.canonicalJobId],
    );
    for (const job of [saved, held]) {
      const cycle = at(0);
      const blocked = deps({ now: at(0), fetchJobContent: async () => ({ kind: "RETRYABLE_FAILURE", reason: "Posting provider returned HTTP 503." }) });
      for (let day = 0; day <= 3; day += 1) await runAvailabilityRecheck(db(), ctx(), payload(job, cycle), null, { ...blocked, now: () => at(day) });
      expect((await archiveInfo(job)).archived).toBe(false);
      const last = (await events(job)).at(-1);
      expect(last?.decision).toBe("KEPT_PROTECTED");
      expect(last?.reason_code).toMatch(/PROTECTED:/);
      const state = await db().query(`SELECT next_check_at, last_decision FROM job_availability_recheck_state WHERE canonical_job_id = $1`, [job.canonicalJobId]);
      expect(state.rows[0]).toMatchObject({ next_check_at: null, last_decision: "KEPT_PROTECTED" });
    }
  });

  it("page read: gone closes at once; open renews the window; login is cannot-tell", async () => {
    const gone = await createJob({ windowEndedDaysAgo: 1, board: "page-board" });
    const closed = await runAvailabilityRecheck(db(), ctx(), payload(gone), null, deps({
      now: at(0), fetchJobContent: async () => ({ kind: "UNAVAILABLE", reason: "The exact posting URL returned HTTP 404.", evidence: {} as never }),
    }));
    expect(closed).toMatchObject({ outcome: "CLOSED_BY_PAGE", action: "MARK_CLOSED" });
    expect(await availabilityState(gone)).toBe("CLOSED");
    expect((await archiveInfo(gone)).archived).toBe(false);

    const open = await createJob({ windowEndedDaysAgo: 1, board: "page-board" });
    const reopened = await runAvailabilityRecheck(db(), ctx(), payload(open), null, deps({ now: new Date(), fetchJobContent: async () => pageComplete("OPEN") }));
    expect(reopened).toMatchObject({ outcome: "OPEN", action: "MARK_OPEN" });
    expect(await availabilityState(open)).toBe("OPEN");

    const login = await createJob({ windowEndedDaysAgo: 1, board: "page-board" });
    const unreadable = await runAvailabilityRecheck(db(), ctx(), payload(login), null, deps({ now: at(0), fetchJobContent: async () => ({ kind: "BLOCKED", reason: "AUTH_REQUIRED" }) }));
    expect(unreadable).toMatchObject({ outcome: "CANNOT_TELL", action: "RETRY_LATER" });
    expect(await availabilityState(login)).toBe("UNKNOWN");
  });

  it("restores a job this rule archived when the posting is seen open again, and leaves other archives alone", async () => {
    const job = await createJob({ windowEndedDaysAgo: 1, board: "restore-board" });
    const cycle = at(0);
    const unreadable = deps({ now: at(0), fetchJobContent: async () => ({ kind: "RETRYABLE_FAILURE", reason: "timeout" }) });
    for (let day = 0; day <= 3; day += 1) await runAvailabilityRecheck(db(), ctx(), payload(job, cycle), null, { ...unreadable, now: () => at(day) });
    expect((await archiveInfo(job)).archived).toBe(true);

    await db().query("BEGIN");
    const restored = await restoreAvailabilityArchivedJob(db(), { workspaceId: ctx().workspaceId, canonicalJobId: job.canonicalJobId, context: ctx() });
    await db().query("COMMIT");
    expect(restored).toMatchObject({ restored: true, reasonCode: "RESTORED" });
    expect((await archiveInfo(job)).archived).toBe(false);

    const aged = await createJob({ windowEndedDaysAgo: 1, board: "restore-board" });
    await archiveAsAged(aged);
    expect(await restoreAvailabilityArchivedJob(db(), { workspaceId: ctx().workspaceId, canonicalJobId: aged.canonicalJobId, context: ctx() })).toBeNull();
    expect((await archiveInfo(aged)).archived).toBe(true);
  });

  it("normalizing a new OPEN observation restores a job this rule archived, and not one archived for another reason", async () => {
    const longText = "A hands-on role building and maintaining production systems for a synthetic company. ".repeat(6);
    const stage = async (externalId: string, retrievedAt: string, hashSuffix: string) => {
      const id = randomUUID();
      const url = `https://boards.greenhouse.io/reappear-board/jobs/${externalId}`;
      const payload = { id: externalId, seen: hashSuffix };
      const rawHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const evidence = buildJobSourceEvidence({
        sourceName: "GREENHOUSE", sourcePluginKey: "greenhouse", sourcePluginRevisionId: null, sourceExternalId: externalId,
        sourceUrl: url, canonicalApplyUrl: url, retrievedAt, rawPayloadHash: rawHash, rawPayload: payload,
        companyName: "Reappear Co", title: "Synthetic Analyst", locationRaw: "Singapore", workplaceTypeRaw: "REMOTE",
        employmentTypeRaw: "FULL_TIME", compensationRaw: "UNKNOWN", descriptionText: longText,
      });
      await db().query(
        `INSERT INTO raw_job_observations (id, workspace_id, source_name, source_plugin_key, source_external_id, source_url, retrieved_at,
           company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, normalized_evidence, evidence_schema_version)
         VALUES ($1, $2, 'GREENHOUSE', 'greenhouse', $3, $4, $5, 'Reappear Co', 'Synthetic Analyst', $6, $7::jsonb, $8, 'PENDING', $9::jsonb, $9::jsonb->>'schema_version')`,
        [id, ctx().workspaceId, externalId, url, retrievedAt, longText, JSON.stringify(payload), rawHash, JSON.stringify(evidence)],
      );
      return id;
    };
    const archive = async (canonicalJobId: string, details: Record<string, unknown>) => {
      await db().query("BEGIN");
      await archiveJobsAsPostingNotConfirmable(db(), { workspaceId: ctx().workspaceId, canonicalJobIds: [canonicalJobId], actor: "test", details });
      await db().query("COMMIT");
    };
    const ours = `reappear-${randomUUID()}`;
    const first = await runNormalization(db(), { context: ctx(), observationIds: [await stage(ours, new Date(Date.now() - 20 * DAY).toISOString(), "a")], limit: 1 });
    const jobId = first.details[0]?.canonicalJobId;
    if (!jobId) throw new Error("Normalization did not create the job.");
    await archive(jobId, { rule: AVAILABILITY_RECHECK_ARCHIVE_RULE });
    expect((await archiveInfo({ canonicalJobId: jobId } as Fixture)).archived).toBe(true);
    const again = await runNormalization(db(), { context: ctx(), observationIds: [await stage(ours, new Date().toISOString(), "b")], limit: 1 });
    expect(again.totalErrors).toBe(0);
    expect((await archiveInfo({ canonicalJobId: jobId } as Fixture)).archived).toBe(false);

    const other = `reappear-${randomUUID()}`;
    const second = await runNormalization(db(), { context: ctx(), observationIds: [await stage(other, new Date(Date.now() - 20 * DAY).toISOString(), "a")], limit: 1 });
    const otherId = second.details[0]?.canonicalJobId;
    if (!otherId) throw new Error("Normalization did not create the second job.");
    await archive(otherId, {});
    await runNormalization(db(), { context: ctx(), observationIds: [await stage(other, new Date().toISOString(), "b")], limit: 1 });
    expect((await archiveInfo({ canonicalJobId: otherId } as Fixture)).archived).toBe(true);
  });

  it("fills a work mode the older ingest left unknown from the Workday structured field, and queues a re-gate", async () => {
    const stored = (remoteType: string) => ({ workday: { tenant: "synthco" }, detail: { jobPostingInfo: { remoteType } } });
    const clear = await createJob({ windowEndedDaysAgo: 1, board: "wd-clear", sourceName: "WORKDAY", pluginKey: "workday", rawPayload: stored("Fully Onsite") });
    const ambiguous = await createJob({ windowEndedDaysAgo: 1, board: "wd-ambiguous", sourceName: "WORKDAY", pluginKey: "workday", rawPayload: stored("Office - Flexible") });
    const readOpen = (now: Date) => deps({ now, fetchJobContent: async () => pageComplete("OPEN") });

    const filled = await runAvailabilityRecheck(db(), ctx(), payload(clear), null, readOpen(new Date()));
    expect(filled).toMatchObject({ action: "MARK_OPEN", factsChanged: true });
    const mode = await db().query(`SELECT workplace_type FROM canonical_jobs WHERE id = $1`, [clear.canonicalJobId]);
    expect(mode.rows[0]?.workplace_type).toBe("ONSITE");
    const regate = await pendingTasks(clear, "APPLY_HARD_GATES");
    expect(regate).toHaveLength(1);
    expect(regate[0]!.payload).toMatchObject({ force_policy_recalculation: true });
    const provenance = await db().query(`SELECT details FROM job_availability_recheck_events WHERE canonical_job_id = $1`, [clear.canonicalJobId]);
    expect(provenance.rows[0]?.details.work_mode_from_structured_field).toMatchObject({
      value: "ONSITE", source_name: "WORKDAY", observation_id: clear.observationId, remote_type_raw: "Fully Onsite", replaced: "UNKNOWN",
    });

    const kept = await runAvailabilityRecheck(db(), ctx(), payload(ambiguous), null, readOpen(new Date()));
    expect(kept).toMatchObject({ action: "MARK_OPEN", factsChanged: false });
    const unknown = await db().query(`SELECT workplace_type FROM canonical_jobs WHERE id = $1`, [ambiguous.canonicalJobId]);
    expect(unknown.rows[0]?.workplace_type).toBe("UNKNOWN");
    expect(await pendingTasks(ambiguous, "APPLY_HARD_GATES")).toHaveLength(0);
  });

  it("a page that states work mode and location clearly fills them and queues a re-gate; an unstated value never overwrites", async () => {
    const stated = await createJob({ windowEndedDaysAgo: 1, board: "facts-stated", workplaceType: "UNKNOWN", location: "Singapore" });
    const result = await runAvailabilityRecheck(db(), ctx(), payload(stated), null, deps({
      now: new Date(), fetchJobContent: async () => pageComplete("OPEN", "HYBRID", "London, United Kingdom"),
    }));
    expect(result).toMatchObject({ action: "MARK_OPEN", factsChanged: true });
    const row = await db().query(`SELECT workplace_type, location FROM canonical_jobs WHERE id = $1`, [stated.canonicalJobId]);
    expect(row.rows[0]).toMatchObject({ workplace_type: "HYBRID", location: "London, United Kingdom" });
    expect(await pendingTasks(stated, "APPLY_HARD_GATES")).toHaveLength(1);
    const evidence = await db().query(`SELECT details FROM job_availability_recheck_events WHERE canonical_job_id = $1`, [stated.canonicalJobId]);
    expect(evidence.rows[0]?.details.facts_applied_from_page).toMatchObject({ work_mode: { before: "UNKNOWN", after: "HYBRID" } });

    const known = await createJob({ windowEndedDaysAgo: 1, board: "facts-unstated", workplaceType: "ONSITE", location: "Singapore" });
    const quiet = await runAvailabilityRecheck(db(), ctx(), payload(known), null, deps({
      now: new Date(), fetchJobContent: async () => pageComplete("OPEN", "UNKNOWN", null),
    }));
    expect(quiet).toMatchObject({ action: "MARK_OPEN", factsChanged: false });
    const kept = await db().query(`SELECT workplace_type, location FROM canonical_jobs WHERE id = $1`, [known.canonicalJobId]);
    expect(kept.rows[0]).toMatchObject({ workplace_type: "ONSITE", location: "Singapore" });
    expect(await pendingTasks(known, "APPLY_HARD_GATES")).toHaveLength(0);
  });

  it("Workday: the employer listing is the feed reading; absence counts only from a complete listing, twice in a row", async () => {
    const stored = { workday: { host: "synth.wd5.myworkdayjobs.com", tenant: "synth", site: "ext", external_path: "/job/X_R1" } };
    const job = await createJob({ windowEndedDaysAgo: 1, board: "wd-feed", sourceName: "WORKDAY", pluginKey: "workday", rawPayload: stored });
    const built = createWorkdayListingAdapter({ rawPayload: stored, companyName: "SYNTH", title: "synthetic platform engineer" });
    expect(built?.sourceName).toBe("WORKDAY");
    expect(createWorkdayListingAdapter({ rawPayload: {}, companyName: "SYNTH", title: "t" })).toBeNull();

    const listing = new WorkdayAdapter({ config: { host: "synth.wd5.myworkdayjobs.com", tenant: "synth", site: "ext", companyName: "SYNTH" }, searchTerms: ["synthetic platform engineer"] });
    const stats = (over: Partial<NonNullable<WorkdayAdapter["lastRunStats"]>>) => ({
      facet: null, searchRequests: 1, detailRequests: 0, termsCompleted: 1, truncatedTerms: [], hitsSeen: 0, notSingapore: 0, detailsGone: 0, stoppedForBudget: false, ...over,
    });
    const absentDeps = (now: Date) => deps({
      now,
      createFeedAdapter: () => listing,
      refreshSourceEvidence: async (_c, request) => ({ ...request, status: "UNAVAILABLE" as const }),
    });

    listing.lastRunStats = stats({ stoppedForBudget: true });
    const cut = await runAvailabilityRecheck(db(), ctx(), payload(job), null, absentDeps(at(0)));
    expect(cut).toMatchObject({ outcome: "CANNOT_TELL", action: "RETRY_LATER" });
    expect((await events(job)).at(-1)).toMatchObject({ absent: 0 });

    listing.lastRunStats = stats({});
    const first = await runAvailabilityRecheck(db(), ctx(), payload(job), null, absentDeps(at(1)));
    expect(first).toMatchObject({ readKind: "FEED", outcome: "FEED_ABSENT", action: "WAIT_NEXT_READ" });
    const second = await runAvailabilityRecheck(db(), ctx(), payload(job), null, absentDeps(at(2)));
    expect(second).toMatchObject({ outcome: "FEED_ABSENT", action: "MARK_CLOSED" });
    expect(await availabilityState(job)).toBe("CLOSED");
  });

  it("is skipped, not recorded, for a job that is archived or whose version moved on", async () => {
    const job = await createJob({ windowEndedDaysAgo: 1, board: "skip-board" });
    const stale = await runAvailabilityRecheck(db(), ctx(), { ...payload(job), job_version_id: randomUUID() }, null, deps({ now: at(0) }));
    expect(stale).toEqual({ status: "SKIPPED", reason: "STALE_VERSION" });
    await archiveAsAged(job);
    expect(await runAvailabilityRecheck(db(), ctx(), payload(job), null, deps({ now: at(0) }))).toEqual({ status: "SKIPPED", reason: "JOB_ARCHIVED" });
    expect(await events(job)).toHaveLength(0);
  });

  it("the normal worker seeds the due job, reads it and completes the task with a recorded result", async () => {
    const job = await createJob({ windowEndedDaysAgo: 1, board: "worker-board" });
    const fakeDeps = {
      availabilityRecheck: deps({ now: new Date(), fetchJobContent: async () => pageComplete("OPEN") }),
    } as unknown as PipelineStageWorkerDependencies;
    const summary = await runPipelineStageTaskWorker(db(), {
      context: ctx(), taskTypes: ["RECHECK_AVAILABILITY"], jobVersionIds: [job.jobVersionId], seed: true,
      maxTasks: 5, reconcileStalePending: false, wallClockMs: 60_000, minTimeToStartTaskMs: 1,
    }, fakeDeps);
    expect(summary.seeded?.byType.RECHECK_AVAILABILITY).toEqual({ inserted: 1, existing: 0 });
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(await availabilityState(job)).toBe("OPEN");
    expect(await events(job)).toHaveLength(1);
  });
});
