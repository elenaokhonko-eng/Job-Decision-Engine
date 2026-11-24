import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { AVAILABILITY_RECHECK_ARCHIVE_RULE } from "../../services/jobArchive.js";
import {
  completedTasksWithoutResult,
  listedJobsNotCurrentlyOpen,
  protectedJobsAutoArchived,
  rejectedJobsWithRecommendation,
  routableVerificationJobsStranded,
  runZeroChecks,
  zeroChecksExitCode,
} from "../../tasks/integrityZeroChecks.js";

// Each must-be-zero check is shown to be zero on a clean workspace, to fail on a seeded violation, and
// to stay zero on a near miss. Every test makes its own workspace, so tests do not depend on each
// other or on their order. Synthetic data only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the zero-check tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };

async function newWorkspace(): Promise<string> {
  const row = await db().query<{ id: string }>(
    `INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Zero check workspace') RETURNING id::text`,
    [`zero-${randomUUID()}`],
  );
  return row.rows[0]!.id;
}

interface JobFields { gate?: string | null; reason?: string | null; outcome?: string | null; state?: string }

async function job(ws: string, fields: JobFields = {}): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status,
       gate_decision, rejection_reason, recommendation_outcome)
     VALUES ($1, $2, 'Zero Check Co', 'fixture role', $3, $4, $4, $5, $6, $7)`,
    [canonicalJobId, ws, `https://example.test/z/${canonicalJobId}`, fields.state ?? "MATCHED", fields.gate ?? null, fields.reason ?? null, fields.outcome ?? null],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Synthetic.', NOW())`,
    [jobVersionId, ws, canonicalJobId, `h-${jobVersionId}`],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  return { canonicalJobId, jobVersionId };
}

async function observation(ws: string, jobVersionId: string, sourceName: string, retrievedAtSql = "NOW()"): Promise<void> {
  await db().query(
    `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title, description_raw,
       raw_payload, raw_payload_hash, processing_status, job_version_id)
     VALUES ($1, $2, $3, $4, ${retrievedAtSql}, 'Zero Check Co', 'fixture role', 'x', '{}'::jsonb, $5, 'PROCESSED', $6)`,
    [ws, sourceName, `o-${randomUUID()}`, `https://example.test/o/${randomUUID()}`, randomUUID().replaceAll("-", "").padEnd(64, "0"), jobVersionId],
  );
}

/** Archives a job as POSTING_NOT_CONFIRMABLE; `rule` is the re-check marker or null (another rule), `daysAgo` sets archived_at. */
async function archive(ws: string, canonicalJobId: string, rule: string | null, daysAgo = 1): Promise<void> {
  const run = await db().query<{ id: string }>(
    `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`,
  );
  await db().query(
    `UPDATE canonical_jobs SET archived_at = NOW() - make_interval(days => $4::int), archive_reason = 'POSTING_NOT_CONFIRMABLE',
            archive_age_basis = 'POSTING_LINK_UNVERIFIABLE', archive_reference_at = NOW(), archive_run_id = $3 WHERE workspace_id = $2 AND id = $1`,
    [canonicalJobId, ws, run.rows[0]!.id, daysAgo],
  );
  await db().query(
    `INSERT INTO job_archive_events (workspace_id, canonical_job_id, archive_run_id, action, actor, reason, reference_at, age_basis, details, event_at)
     VALUES ($1, $2, $3, 'ARCHIVED', 'test', 'POSTING_NOT_CONFIRMABLE', NOW(), 'POSTING_LINK_UNVERIFIABLE', $4::jsonb, NOW() - make_interval(days => $5::int))`,
    [ws, canonicalJobId, run.rows[0]!.id, JSON.stringify(rule ? { rule } : {}), daysAgo],
  );
}

async function hold(ws: string, canonicalJobId: string, createdDaysAgo: number, expiresInDays: number): Promise<void> {
  await db().query(
    `INSERT INTO job_archive_holds (workspace_id, canonical_job_id, hold_reason, hold_type, created_by, created_at, expires_at)
     VALUES ($1, $2, 'owner keeps it', 'USER_PRESERVE', 'test', NOW() - make_interval(days => $3::int), NOW() + make_interval(days => $4::int))`,
    [ws, canonicalJobId, createdDaysAgo, expiresInDays],
  );
}

describe.skipIf(skipReal)("must-be-zero checks (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `zero_checks_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("every check is zero on a clean workspace, and the exit code follows the totals", async () => {
    const ws = await newWorkspace();
    const results = await runZeroChecks(db(), ws);
    expect(results.map((check) => check.name)).toEqual([
      "rejected_job_with_recommendation", "listed_job_not_currently_open", "task_completed_without_result",
      "routable_verification_job_stranded", "protected_job_auto_archived",
    ]);
    expect(results.map((check) => check.total)).toEqual([0, 0, 0, 0, 0]);
    expect(zeroChecksExitCode(results)).toBe(0);
    expect(zeroChecksExitCode([{ total: 0 }, { total: 2 }])).toBe(1);
  });

  it("rejected job with a recommendation: reported; a rejected job without one, and a recommended job that was not rejected, are not", async () => {
    const ws = await newWorkspace();
    const rejectedWithRecommendation = await job(ws, { outcome: "REVIEW" });
    const rejectedClean = await job(ws, { outcome: null });
    const recommendedNotRejected = await job(ws, { outcome: "REVIEW" });
    const gate = (j: { canonicalJobId: string; jobVersionId: string }, decision: string) => db().query(
      `INSERT INTO gate_decisions (canonical_job_id, job_version_id, decision, workspace_id) VALUES ($1, $2, $3, $4)`,
      [j.canonicalJobId, j.jobVersionId, decision, ws]);
    await gate(rejectedWithRecommendation, "HARD_REJECT");
    await gate(rejectedClean, "HARD_REJECT");
    await gate(recommendedNotRejected, "PASS");
    const check = await rejectedJobsWithRecommendation(db(), ws);
    expect(check.sample).toEqual([rejectedWithRecommendation.canonicalJobId]);
    expect(check.total).toBe(1);
  });

  it("listed job not currently open: reported for a closed job in the list; an open one is not (stand-in list view); the real views run clean", async () => {
    const ws = await newWorkspace();
    expect((await listedJobsNotCurrentlyOpen(db(), ws)).total).toBe(0);
    const open = await job(ws);
    const closed = await job(ws);
    const windowRanOut = await job(ws);
    await db().query(`UPDATE job_versions SET availability_status = 'OPEN', availability_verified_at = NOW(), availability_recheck_at = NOW() + INTERVAL '3 days' WHERE id = $1`, [open.jobVersionId]);
    await db().query(`UPDATE job_versions SET availability_status = 'CLOSED', availability_verified_at = NOW(), availability_recheck_at = NOW() + INTERVAL '3 days' WHERE id = $1`, [closed.jobVersionId]);
    await db().query(`UPDATE job_versions SET availability_status = 'OPEN', availability_verified_at = NOW() - INTERVAL '9 days', availability_recheck_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [windowRanOut.jobVersionId]);
    const view = `zero_check_listed_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await db().query(
      `CREATE VIEW ${view} AS SELECT c.workspace_id, c.id AS canonical_job_id, c.latest_job_version_id AS job_version_id
         FROM canonical_jobs c WHERE c.workspace_id = '${ws}'::uuid`);
    const check = await listedJobsNotCurrentlyOpen(db(), ws, { stand_in: view });
    expect([...check.sample].sort()).toEqual([`stand_in:${closed.canonicalJobId}`, `stand_in:${windowRanOut.canonicalJobId}`].sort());
    await expect(listedJobsNotCurrentlyOpen(db(), ws, { bad: "x; DROP TABLE y" })).rejects.toThrow(/plain identifier/);
  });

  it("completed task with no result: reported incl. RECHECK_AVAILABILITY; a re-check with an event, and a legitimately skipped re-check, are not", async () => {
    const ws = await newWorkspace();
    const taskFor = async (j: { canonicalJobId: string; jobVersionId: string }) => {
      const id = randomUUID();
      await db().query(
        `INSERT INTO pipeline_tasks (id, workspace_id, task_type, task_key, payload, status, completed_at)
         VALUES ($1, $2, 'RECHECK_AVAILABILITY', $3, $4::jsonb, 'COMPLETED', NOW())`,
        [id, ws, `RECHECK_AVAILABILITY:${j.jobVersionId}:${id}`, JSON.stringify({ canonical_job_id: j.canonicalJobId, job_version_id: j.jobVersionId })],
      );
      return id;
    };
    const missing = await job(ws);
    await observation(ws, missing.jobVersionId, "GREENHOUSE");
    const missingTask = await taskFor(missing);

    const recorded = await job(ws);
    await observation(ws, recorded.jobVersionId, "GREENHOUSE");
    const recordedTask = await taskFor(recorded);
    await db().query(
      `INSERT INTO job_availability_recheck_events (workspace_id, canonical_job_id, job_version_id, task_id, read_kind, outcome, decision, reason_code,
         consecutive_absent_reads_after, cannot_tell_attempts_after) VALUES ($1, $2, $3, $4, 'PAGE', 'OPEN', 'MARK_OPEN', 'TEST', 0, 0)`,
      [ws, recorded.canonicalJobId, recorded.jobVersionId, recordedTask]);

    const skipped = await job(ws); // no observation to read: the re-check skips it and records nothing, by design
    await taskFor(skipped);

    const check = await completedTasksWithoutResult(db(), ws);
    expect(check.sample).toEqual([missingTask]);
    expect(check.detail).toEqual({ RECHECK_AVAILABILITY: 1 });
  });

  it("routable verification job stranded: reported with no task and no match run; one with a task, one with a match run, and a non-routable one are not", async () => {
    const ws = await newWorkspace();
    const routable = { gate: "NEEDS_VERIFICATION", reason: "GATE_UNKNOWN_WORK_MODE", state: "NEEDS_VERIFICATION" } as const;
    const stranded = await job(ws, routable);
    const waiting = await job(ws, routable);
    const matched = await job(ws, routable);
    const notRoutable = await job(ws, { gate: "NEEDS_VERIFICATION", reason: "GATE_WORK_AUTH", state: "NEEDS_VERIFICATION" });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status) VALUES ($1, 'PUBLISH_EMBEDDING', $2, $3::jsonb, 'PENDING')`,
      [ws, `PUBLISH_EMBEDDING:${waiting.jobVersionId}:x`, JSON.stringify({ canonical_job_id: waiting.canonicalJobId, job_version_id: waiting.jobVersionId })]);
    const profile = await db().query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name) VALUES ($1, $2, 'Fixture') RETURNING id`, [ws, `fixture-${randomUUID()}`]);
    const version = await db().query<{ id: string }>(
      `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, schema_version, source_hash, status, effective_at)
       VALUES ($1, $2, 1, '2.2.0', $3, 'DRAFT', NOW()) RETURNING id`, [ws, profile.rows[0]!.id, `fixture-${randomUUID()}`]);
    const run = await db().query<{ id: string }>(
      `INSERT INTO match_runs (workspace_id, canonical_job_id, job_version_id, profile_version_id, status, requirement_count, matched_count, policy_version, job_content_hash, context_fingerprint)
       VALUES ($1, $2, $3, $4, 'COMPLETED', 1, 1, 'fixture', 'h', 'fp') RETURNING id`, [ws, matched.canonicalJobId, matched.jobVersionId, version.rows[0]!.id]);
    await db().query(`UPDATE canonical_jobs SET latest_match_run_id = $1 WHERE id = $2`, [run.rows[0]!.id, matched.canonicalJobId]);
    const check = await routableVerificationJobsStranded(db(), ws);
    expect(check.sample).toEqual([stranded.canonicalJobId]);
    expect(notRoutable.canonicalJobId).not.toBe(stranded.canonicalJobId);
  });

  it("protected job auto-archived: only an archive by the re-check rule, with the protection in force before it, is reported", async () => {
    const ws = await newWorkspace();
    // Violation: saved before the re-check archived it.
    const savedThenArchived = await job(ws);
    await observation(ws, savedThenArchived.jobVersionId, "LINKEDIN_SAVED", "NOW() - INTERVAL '5 days'");
    await archive(ws, savedThenArchived.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    // Violation: held (unexpired) before the archive.
    const heldThenArchived = await job(ws);
    await hold(ws, heldThenArchived.canonicalJobId, 5, 20);
    await archive(ws, heldThenArchived.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    // Near misses.
    const unsaved = await job(ws);
    await archive(ws, unsaved.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    const savedAfter = await job(ws);
    await archive(ws, savedAfter.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 3);
    await observation(ws, savedAfter.jobVersionId, "LINKEDIN_SAVED", "NOW()");
    const expiredHold = await job(ws);
    await hold(ws, expiredHold.canonicalJobId, 10, -4); // created 10 days ago, expired 4 days ago? expiry must exceed creation
    await archive(ws, expiredHold.canonicalJobId, AVAILABILITY_RECHECK_ARCHIVE_RULE, 1);
    const otherRule = await job(ws); // e.g. the Himalayas link repair: saved, archived by another rule
    await observation(ws, otherRule.jobVersionId, "LINKEDIN_SAVED", "NOW() - INTERVAL '5 days'");
    await archive(ws, otherRule.canonicalJobId, null, 1);
    const check = await protectedJobsAutoArchived(db(), ws);
    expect([...check.sample].sort()).toEqual([savedThenArchived.canonicalJobId, heldThenArchived.canonicalJobId].sort());
  });
});
