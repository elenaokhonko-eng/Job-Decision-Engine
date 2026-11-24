import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { expireSnippetOnlyJobs, expireSnippetOnlyJobsInTransaction } from "../../ingestion/snippetExpiry.js";
import { createArchiveHold, restoreArchivedJob } from "../../services/jobArchive.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// A snippet-only job whose fetch has not succeeded is archived POSTING_NOT_CONFIRMABLE 7 days after it was last
// seen or 21 days after it was first seen, unless a fetch is still within its retry budget. Synthetic fixtures; real PostgreSQL in a private schema.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the snippet expiry integration tests against its PostgreSQL service.");
}

const DAY = 24 * 3_600_000;
const NOW = new Date("2026-11-23T12:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The snippet expiry test client is not initialized.");
  return client;
}

interface JobOptions {
  /** Sightings of the alert, as ages in ms before NOW (one observation each). */
  readonly seen: readonly number[];
  readonly quality?: "COMPLETE" | "INCOMPLETE";
  readonly alertContentStatus?: string;
  readonly extraSource?: string;
  readonly fetchTask?: "PENDING" | "COMPLETED" | "RETRY_WAIT" | "BLOCKED_DEPENDENCY" | "DEAD_LETTER";
  /** Attempts already made by the fetch task (its budget is 8). */
  readonly fetchAttempts?: number;
  /** The fetch task's last error text. */
  readonly fetchError?: string;
  /** More fetch tasks for the same observation (e.g. an old 404 and a newer timeout). */
  readonly extraFetchTasks?: readonly { readonly status: string; readonly error: string | null }[];
  readonly state?: string;
}

async function seedJob(label: string, options: JobOptions, workspaceId: string = context!.workspaceId): Promise<string> {
  const state = options.state ?? "RAW_STAGED";
  const canonical = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, description_quality_status, gate_decision)
     VALUES ($1, 'Expiry Fixture Co', $2, $3, $4, $4, $5, 'PASS') RETURNING id`,
    [workspaceId, label, `https://example.test/expiry/${randomUUID()}`, state, options.quality ?? "INCOMPLETE"],
  );
  const canonicalJobId = canonical.rows[0]!.id;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, 1, $3, 'Short snippet.', $4) RETURNING id`,
    [workspaceId, canonicalJobId, `expiry-${randomUUID()}`, ago(Math.max(...options.seen))],
  );
  const jobVersionId = version.rows[0]!.id;
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3`, [jobVersionId, workspaceId, canonicalJobId]);
  let firstObservation = "";
  for (const [index, age] of options.seen.entries()) {
    const observationId = randomUUID();
    if (index === 0) firstObservation = observationId;
    await db().query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id
       ) VALUES ($1, $2, 'GMAIL_ALERT', $3, $4, $5, 'Expiry Fixture Co', $6, 'Short snippet.', $7::jsonb, $8, 'FETCH_PENDING', $9)`,
      [
        observationId, workspaceId, `expiry-${observationId}`, `https://example.test/expiry/${observationId}`, ago(age), label,
        JSON.stringify(options.alertContentStatus ? { source_content_status: options.alertContentStatus } : {}), `raw-${observationId}`, jobVersionId,
      ],
    );
  }
  if (options.extraSource) {
    const extra = randomUUID();
    await db().query(
      `INSERT INTO raw_job_observations (
         id, workspace_id, source_name, source_external_id, source_url, retrieved_at,
         company_name, title, description_raw, raw_payload, raw_payload_hash, processing_status, job_version_id
       ) VALUES ($1, $2, $3, $4, $5, $6, 'Expiry Fixture Co', $7, 'Short snippet.', '{}'::jsonb, $8, 'PROCESSED', $9)`,
      [extra, workspaceId, options.extraSource, `expiry-${extra}`, `https://example.test/expiry/${extra}`, ago(DAY), label, `raw-${extra}`, jobVersionId],
    );
  }
  if (options.fetchTask) {
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, attempt_count, max_attempts, last_error)
       VALUES ($1, 'FETCH_JOB_CONTENT', $2, $3::jsonb, $4, $5, 8, $6)`,
      [workspaceId, `FETCH_JOB_CONTENT:${firstObservation}:posting_fetch_v1`, JSON.stringify({ observation_id: firstObservation }), options.fetchTask, options.fetchAttempts ?? 0, options.fetchError ?? null],
    );
  }
  for (const [index, extra] of (options.extraFetchTasks ?? []).entries()) {
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, attempt_count, max_attempts, last_error)
       VALUES ($1, 'FETCH_JOB_CONTENT', $2, $3::jsonb, $4, 8, 8, $5)`,
      [workspaceId, `FETCH_JOB_CONTENT:${firstObservation}:extra:${index}`, JSON.stringify({ observation_id: firstObservation }), extra.status, extra.error],
    );
  }
  return canonicalJobId;
}

async function archiveState(canonicalJobId: string): Promise<{ archived: boolean; reason: string | null }> {
  const row = await db().query<{ archived_at: Date | null; archive_reason: string | null }>(
    `SELECT archived_at, archive_reason FROM canonical_jobs WHERE id = $1`, [canonicalJobId]);
  return { archived: row.rows[0]!.archived_at !== null, reason: row.rows[0]!.archive_reason };
}

describe.skipIf(skipReal)("snippet-only expiry (PostgreSQL)", () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `snippet_expiry_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);

    ids.lastSeen8 = await seedJob("last-seen-8-days", { seen: [8 * DAY] });
    ids.lastSeenExactly7 = await seedJob("last-seen-exactly-7-days", { seen: [7 * DAY] });
    ids.lastSeen6 = await seedJob("last-seen-6-days", { seen: [6 * DAY] });
    ids.resighted22 = await seedJob("first-seen-22-days-resighted", { seen: [22 * DAY, DAY] });
    ids.resighted20 = await seedJob("first-seen-20-days-resighted", { seen: [20 * DAY, DAY] });
    ids.pendingFetch = await seedJob("fetch-within-budget-deferred", { seen: [9 * DAY], fetchTask: "RETRY_WAIT", fetchAttempts: 3 });
    ids.exhaustedFetch = await seedJob("fetch-budget-exhausted-expires", { seen: [9 * DAY], fetchTask: "RETRY_WAIT", fetchAttempts: 8, fetchError: "POSTING_CONTENT_BLOCKED: UNSUPPORTED_SOURCE" });
    ids.parkedFetch = await seedJob("fetch-parked-expires", { seen: [9 * DAY], fetchTask: "BLOCKED_DEPENDENCY", fetchError: "SOURCE_RETIRED_BY_USER: content comes from the saved-jobs export" });
    ids.applied = await seedJob("has-application", { seen: [30 * DAY] });
    ids.held = await seedJob("has-hold", { seen: [30 * DAY] });
    ids.saved = await seedJob("saved-export", { seen: [30 * DAY], extraSource: "LINKEDIN_SAVED" });
    ids.complete = await seedJob("complete-content", { seen: [30 * DAY], quality: "COMPLETE", alertContentStatus: "COMPLETE" });
    ids.removed = await seedJob("manually-removed", { seen: [30 * DAY], state: "MANUALLY_REMOVED" });

    await db().query(
      `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status)
       SELECT $1, $2, $3, latest_job_version_id, 'APPLIED' FROM canonical_jobs WHERE id = $3`,
      [context.workspaceId, context.userId, ids.applied],
    );
    await createArchiveHold(db(), {
      workspaceId: context.workspaceId,
      canonicalJobId: ids.held,
      holdReason: "synthetic hold",
      holdType: "USER_PRESERVE",
      createdBy: "test",
      expiresAt: new Date(Date.now() + 30 * DAY),
    });
  }, 180_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  const run = (apply: boolean) => expireSnippetOnlyJobs(db(), {
    workspaceId: context!.workspaceId, apply, now: NOW, actor: "test:snippet_expiry", restorePoint: "test-restore-point",
  });

  it("a dry run reports the candidates and writes nothing", async () => {
    const report = await run(false);
    expect(report.mode).toBe("DRY_RUN");
    expect(report.candidates).toBe(8);
    expect(report.toArchive).toBe(5);
    expect(report.protectedSkipped).toBe(2);
    expect(report.deferredFetchInFlight).toBe(1);
    expect(report.byTrigger).toEqual({ LAST_SEEN: 4, FIRST_SEEN: 1 });
    expect(report.archived).toBe(0);
    for (const id of Object.values(ids)) expect((await archiveState(id)).archived).toBe(false);
  });

  it("applying archives exactly the expired, unprotected snippet-only jobs, as not confirmable", async () => {
    const report = await run(true);
    expect(report.archived).toBe(5);
    const expected = [ids.lastSeen8, ids.lastSeenExactly7, ids.resighted22, ids.exhaustedFetch, ids.parkedFetch].sort();
    expect([...report.archivedJobIds].sort()).toEqual(expected);
    for (const id of expected) expect(await archiveState(id)).toEqual({ archived: true, reason: "POSTING_NOT_CONFIRMABLE" });

    // Kept: seen too recently, protected, saved, complete, removed.
    for (const key of ["pendingFetch", "lastSeen6", "resighted20", "applied", "held", "saved", "complete", "removed"]) {
      expect((await archiveState(ids[key]!)).archived, key).toBe(false);
    }
    // Nothing was deleted, and every archive left an audit event.
    const total = await db().query(`SELECT COUNT(*)::int AS n FROM canonical_jobs WHERE workspace_id = $1`, [context!.workspaceId]);
    expect(Number(total.rows[0].n)).toBe(13);
    const events = await db().query(`SELECT COUNT(*)::int AS n FROM job_archive_events WHERE canonical_job_id = ANY($1::uuid[])`, [expected]);
    expect(Number(events.rows[0].n)).toBe(5);
  });

  it("is idempotent: a second run finds only the protected jobs and archives nothing", async () => {
    const report = await run(true);
    expect(report.archived).toBe(0);
    expect(report.toArchive).toBe(0);
    expect(report.protectedSkipped).toBe(2);
    expect(report.deferredFetchInFlight).toBe(1);
  });

  it("is reversible: an archived job is restored and is live again", async () => {
    await db().query("BEGIN");
    const restored = await restoreArchivedJob(db(), {
      workspaceId: context!.workspaceId,
      canonicalJobId: ids.lastSeen8!,
      actor: `user:${context!.userId}`,
      reason: "Real posting found.",
      context: context!,
    });
    await db().query("COMMIT");
    expect(restored).toMatchObject({ restored: true, reasonCode: "RESTORED" });
    expect((await archiveState(ids.lastSeen8!)).archived).toBe(false);
  });

  async function newWorkspace(): Promise<string> {
    const inserted = await db().query<{ id: string }>(
      `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Expiry') RETURNING id::text`, [`expiry-${randomUUID()}`]);
    return inserted.rows[0]!.id;
  }
  const applyIn = async (workspaceId: string, hooks: { beforeLock?: () => Promise<void> } = {}) => {
    await db().query("BEGIN");
    try {
      const report = await expireSnippetOnlyJobsInTransaction(db(), {
        workspaceId, apply: true, now: NOW, actor: "test:snippet_expiry", restorePoint: "test-restore-point",
      }, hooks);
      await db().query("COMMIT");
      return report;
    } catch (error) {
      await db().query("ROLLBACK");
      throw error;
    }
  };

  it("an application created between the first read and the archive stops the archive (locked re-check)", async () => {
    const ws = await newWorkspace();
    const raced = await seedJob("raced-application", { seen: [30 * DAY] }, ws);
    const quiet = await seedJob("quiet", { seen: [30 * DAY] }, ws);
    const report = await applyIn(ws, {
      beforeLock: async () => {
        await db().query(
          `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status)
           SELECT $1, $2, $3, latest_job_version_id, 'APPLIED' FROM canonical_jobs WHERE id = $3`,
          [ws, context!.userId, raced],
        );
      },
    });
    expect(report.droppedAtApply).toBe(1);
    expect(report.archivedJobIds).toEqual([quiet]);
    expect((await archiveState(raced)).archived).toBe(false);
    expect((await archiveState(quiet)).archived).toBe(true);
  });

  it("a running lease and a manual review protect a job from expiry, like an application or a hold", async () => {
    const ws = await newWorkspace();
    const leased = await seedJob("leased", { seen: [30 * DAY] }, ws);
    const review = await seedJob("manual-review", { seen: [30 * DAY] }, ws);
    const free = await seedJob("free", { seen: [30 * DAY] }, ws);
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, lease_id, lease_expires_at)
       VALUES ($1, 'NORMALIZE_OBSERVATION', $2, $3::jsonb, 'RUNNING', $4, NOW() + INTERVAL '1 hour')`,
      [ws, `lease-${randomUUID()}`, JSON.stringify({ canonical_job_id: leased }), randomUUID()],
    );
    await db().query(
      `INSERT INTO evaluation_queue (workspace_id, canonical_job_id, job_version_id, lane, status)
       SELECT $1, $2, latest_job_version_id, 'CORE_AI_DATA', 'NEEDS_MANUAL_REVIEW' FROM canonical_jobs WHERE id = $2`,
      [ws, review],
    );
    const dry = await expireSnippetOnlyJobs(db(), { workspaceId: ws, apply: false, now: NOW, actor: "t" });
    expect(dry.protectedSkipped).toBe(2);
    const report = await applyIn(ws);
    expect(report.archivedJobIds).toEqual([free]);
    expect((await archiveState(leased)).archived).toBe(false);
    expect((await archiveState(review)).archived).toBe(false);
  });

  it("only a recorded content or source outcome lets a job expire; every other fetch error, including no text, defers", async () => {
    const ws = await newWorkspace();
    const base = { seen: [30 * DAY], fetchTask: "DEAD_LETTER" as const, fetchAttempts: 8 };
    const infraWordings: (string | null)[] = [
      "Posting provider returned HTTP 503.",
      "Posting retrieval is retryable: Posting provider rate limited the request.",
      "Posting fetch exceeded its total request time limit.",
      "Previous task lease expired before completion; reclaiming.",
      "request timed out", "connect ECONNABORTED", "write EPIPE", "connect EHOSTUNREACH", "connect ENETUNREACH",
      "unable to verify the first certificate", "DNS resolution failed", "getaddrinfo ENOTFOUND example.test",
      "POSTING_CONTENT_BLOCKED: BOT_BLOCKED", "something nobody has seen before", "", null,
    ];
    const deferred: string[] = [];
    for (const [index, text] of infraWordings.entries()) {
      deferred.push(await seedJob(`infra-${index}`, { ...base, fetchError: text as string }, ws));
    }
    deferred.push(await seedJob("timeout-retry-wait", { seen: [30 * DAY], fetchTask: "RETRY_WAIT", fetchAttempts: 8, fetchError: "Posting fetch exceeded its total request time limit." }, ws));
    // A 404 followed by a timeout: the job is not archived on the strength of the older content outcome.
    deferred.push(await seedJob("not-found-then-timeout", {
      ...base, fetchError: "POSTING_CONTENT_UNAVAILABLE: The exact posting URL returned HTTP 404.",
      extraFetchTasks: [{ status: "DEAD_LETTER", error: "Posting fetch exceeded its total request time limit." }],
    }, ws));
    const outcomes = [
      await seedJob("unsupported-source", { ...base, fetchError: "POSTING_CONTENT_BLOCKED: UNSUPPORTED_SOURCE" }, ws),
      await seedJob("auth-required", { ...base, fetchError: "POSTING_CONTENT_BLOCKED: AUTH_REQUIRED" }, ws),
      await seedJob("not-found", { ...base, fetchError: "POSTING_CONTENT_UNAVAILABLE: The exact posting URL returned HTTP 410." }, ws),
      await seedJob("identity-conflict", { ...base, fetchError: "POSTING_IDENTITY_CONFLICT: employer differs" }, ws),
      await seedJob("parked", { seen: [30 * DAY], fetchTask: "BLOCKED_DEPENDENCY", fetchError: "SOURCE_RETIRED_BY_USER: content comes from the saved-jobs export" }, ws),
    ];
    const report = await applyIn(ws);
    expect(report.deferredInfraFailure).toBe(deferred.length);
    expect([...report.archivedJobIds].sort()).toEqual([...outcomes].sort());
    for (const id of deferred) expect((await archiveState(id)).archived).toBe(false);
  });

  async function otherConnection(): Promise<pg.PoolClient> {
    const connection = await pool!.connect();
    await connection.query(`SET search_path TO ${schemaName}, public`);
    return connection;
  }
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** Polls until the backend is blocked waiting for a lock, instead of sleeping and hoping. */
  async function waitUntilWaitingForLock(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await db().query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`, [pid]);
      if (waiting.rows[0]!.n === 1) return;
      await sleep(50);
    }
    throw new Error(`Backend ${pid} never started waiting for a lock.`);
  }
  async function backendPid(connection: pg.PoolClient): Promise<number> {
    return (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
  }
  /** Ends any open transaction before the connection goes back to the pool, so no lock outlives the test. */
  async function releaseSafely(...connections: pg.PoolClient[]): Promise<void> {
    for (const connection of connections) {
      await connection.query("ROLLBACK").catch(() => undefined);
      connection.release();
    }
  }
  const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> =>
    Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);

  // Mutation check (done by hand): removing the FOR UPDATE in snippetExpiry.ts makes this test fail. The archive primitive
  // alone does not make the insert wait: its UPDATE takes FOR NO KEY UPDATE, which does not conflict with the key-share
  // lock a foreign-key insert takes; only the explicit FOR UPDATE does.
  it("a concurrent application insert waits until the archive transaction commits", async () => {
    const ws = await newWorkspace();
    const job = await seedJob("insert-waits", { seen: [30 * DAY] }, ws);
    const archiver = await otherConnection();
    const writer = await otherConnection();
    try {
      await archiver.query("BEGIN");
      const report = await expireSnippetOnlyJobsInTransaction(archiver, { workspaceId: ws, apply: true, now: NOW, actor: "t" });
      expect(report.archivedJobIds).toEqual([job]);
      // The archive transaction is open and holds the row lock; the application insert must wait.
      const writerPid = await backendPid(writer); // read before the insert: a blocked connection cannot answer another query
      const insert = writer.query(
        `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status)
         SELECT $1, $2, $3, latest_job_version_id, 'APPLIED' FROM canonical_jobs WHERE id = $3`,
        [ws, context!.userId, job],
      );
      await waitUntilWaitingForLock(writerPid);
      expect(await settledWithin(insert, 50)).toBe(false);
      await archiver.query("COMMIT");
      await insert;
      expect((await archiveState(job)).archived).toBe(true);
    } finally {
      await releaseSafely(archiver, writer);
    }
  });

  // Mutation check (done by hand): without the FOR UPDATE the archive does not wait for the uncommitted application and the
  // job would be archived, so this test fails.
  it("an application insert in flight makes the archive wait, and the job is then not archived", async () => {
    const ws = await newWorkspace();
    const job = await seedJob("archive-waits", { seen: [30 * DAY] }, ws);
    const archiver = await otherConnection();
    const writer = await otherConnection();
    try {
      await writer.query("BEGIN");
      await writer.query(
        `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status)
         SELECT $1, $2, $3, latest_job_version_id, 'APPLIED' FROM canonical_jobs WHERE id = $3`,
        [ws, context!.userId, job],
      );
      await archiver.query("BEGIN");
      const archiverPid = await backendPid(archiver);
      const run = expireSnippetOnlyJobsInTransaction(archiver, { workspaceId: ws, apply: true, now: NOW, actor: "t" });
      await waitUntilWaitingForLock(archiverPid);
      expect(await settledWithin(run, 50)).toBe(false);
      await writer.query("COMMIT");
      const report = await run;
      await archiver.query("COMMIT");
      expect(report.droppedAtApply).toBe(1);
      expect(report.archivedJobIds).toEqual([]);
      expect((await archiveState(job)).archived).toBe(false);
    } finally {
      await releaseSafely(archiver, writer);
    }
  });

  // Mutation check (done by hand): this test also fails without the FOR UPDATE in snippetExpiry.ts.
  it("an archive hold in flight makes the archive wait and the job is not archived", async () => {
    const ws = await newWorkspace();
    const job = await seedJob("hold-race", { seen: [30 * DAY] }, ws);
    const archiver = await otherConnection();
    const writer = await otherConnection();
    try {
      await writer.query("BEGIN");
      await createArchiveHold(writer, {
        workspaceId: ws, canonicalJobId: job, holdReason: "synthetic hold", holdType: "USER_PRESERVE", createdBy: "test",
        expiresAt: new Date(Date.now() + 30 * DAY),
      });
      await archiver.query("BEGIN");
      const archiverPid = await backendPid(archiver);
      const run = expireSnippetOnlyJobsInTransaction(archiver, { workspaceId: ws, apply: true, now: NOW, actor: "t" });
      await waitUntilWaitingForLock(archiverPid);
      expect(await settledWithin(run, 50)).toBe(false);
      await writer.query("COMMIT");
      const report = await run;
      await archiver.query("COMMIT");
      expect(report.archivedJobIds).toEqual([]);
      expect((await archiveState(job)).archived).toBe(false);
    } finally {
      await releaseSafely(archiver, writer);
    }
  });

  it("a lease that committed before the locked re-read stops the archive (pipeline_tasks have no foreign key, so it cannot block)", async () => {
    const ws = await newWorkspace();
    const job = await seedJob("lease-race", { seen: [30 * DAY] }, ws);
    const report = await applyIn(ws, {
      beforeLock: async () => {
        await db().query(
          `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, lease_id, lease_expires_at)
           VALUES ($1, 'NORMALIZE_OBSERVATION', $2, $3::jsonb, 'RUNNING', $4, NOW() + INTERVAL '1 hour')`,
          [ws, `lease-${randomUUID()}`, JSON.stringify({ canonical_job_id: job }), randomUUID()],
        );
      },
    });
    expect(report.droppedAtApply).toBe(1);
    expect((await archiveState(job)).archived).toBe(false);
  });

  it("apply outside a transaction is refused, because the row locks would end with each statement", async () => {
    const ws = await newWorkspace();
    await seedJob("outside-transaction", { seen: [30 * DAY] }, ws);
    await expect(expireSnippetOnlyJobsInTransaction(db(), { workspaceId: ws, apply: true, now: NOW, actor: "t" }))
      .rejects.toThrow(/must run inside a transaction/);
    // The dry run needs no transaction.
    await expect(expireSnippetOnlyJobsInTransaction(db(), { workspaceId: ws, apply: false, now: NOW, actor: "t" })).resolves.toMatchObject({ mode: "DRY_RUN" });
  });

  it("the allowlist matches a prefix only: an outcome name inside another message still defers", async () => {
    const ws = await newWorkspace();
    const embedded = await seedJob("embedded-outcome", { seen: [30 * DAY], fetchTask: "DEAD_LETTER", fetchAttempts: 8,
      fetchError: "Posting retrieval is retryable: POSTING_CONTENT_UNAVAILABLE: lookalike inside a network failure" }, ws);
    const report = await applyIn(ws);
    expect(report.deferredInfraFailure).toBe(1);
    expect((await archiveState(embedded)).archived).toBe(false);
  });

  it("the limits must be whole days and the first-seen limit cannot be shorter", async () => {
    await expect(expireSnippetOnlyJobs(db(), { workspaceId: context!.workspaceId, apply: false, actor: "t", lastSeenDays: 0 })).rejects.toThrow(RangeError);
    await expect(expireSnippetOnlyJobs(db(), { workspaceId: context!.workspaceId, apply: false, actor: "t", lastSeenDays: 10, firstSeenDays: 5 })).rejects.toThrow(RangeError);
  });
});
