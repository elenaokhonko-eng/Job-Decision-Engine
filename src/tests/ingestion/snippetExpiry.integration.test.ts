import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { expireSnippetOnlyJobs } from "../../ingestion/snippetExpiry.js";
import { createArchiveHold, restoreArchivedJob } from "../../services/jobArchive.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// A snippet-only job whose fetch has not succeeded is archived POSTING_NOT_CONFIRMABLE 7 days after it was last
// seen and in any case 21 days after it was first seen. Synthetic fixtures; real PostgreSQL in a private schema.
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
  readonly fetchTask?: "PENDING" | "COMPLETED" | "RETRY_WAIT" | "BLOCKED_DEPENDENCY";
  /** Attempts already made by the fetch task (its budget is 8). */
  readonly fetchAttempts?: number;
  readonly state?: string;
}

async function seedJob(label: string, options: JobOptions): Promise<string> {
  const workspaceId = context!.workspaceId;
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
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, attempt_count, max_attempts)
       VALUES ($1, 'FETCH_JOB_CONTENT', $2, $3::jsonb, $4, $5, 8)`,
      [workspaceId, `FETCH_JOB_CONTENT:${firstObservation}:posting_fetch_v1`, JSON.stringify({ observation_id: firstObservation }), options.fetchTask, options.fetchAttempts ?? 0],
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
    ids.exhaustedFetch = await seedJob("fetch-budget-exhausted-expires", { seen: [9 * DAY], fetchTask: "RETRY_WAIT", fetchAttempts: 8 });
    ids.parkedFetch = await seedJob("fetch-parked-expires", { seen: [9 * DAY], fetchTask: "BLOCKED_DEPENDENCY" });
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

  it("the limits must be whole days and the first-seen limit cannot be shorter", async () => {
    await expect(expireSnippetOnlyJobs(db(), { workspaceId: context!.workspaceId, apply: false, actor: "t", lastSeenDays: 0 })).rejects.toThrow(RangeError);
    await expect(expireSnippetOnlyJobs(db(), { workspaceId: context!.workspaceId, apply: false, actor: "t", lastSeenDays: 10, firstSeenDays: 5 })).rejects.toThrow(RangeError);
  });
});
