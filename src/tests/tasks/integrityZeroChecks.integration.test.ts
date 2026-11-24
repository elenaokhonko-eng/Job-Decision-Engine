import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import {
  completedTasksWithoutResult,
  listedJobsNotCurrentlyOpen,
  protectedJobsAutoArchived,
  rejectedJobsWithRecommendation,
  routableVerificationJobsStranded,
  runZeroChecks,
  zeroChecksExitCode,
} from "../../tasks/integrityZeroChecks.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// Each must-be-zero check is shown to be zero on a clean schema and to fail on a seeded violation.
// Synthetic data only.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the zero-check tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };
const ctx = (): WorkspaceContext => { if (!context) throw new Error("not initialised"); return context; };

async function job(fields: { gate?: string; reason?: string | null; outcome?: string | null; state?: string } = {}): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status,
       gate_decision, rejection_reason, recommendation_outcome)
     VALUES ($1, $2, 'Zero Check Co', 'fixture role', $3, $4, $4, $5, $6, $7)`,
    [canonicalJobId, ctx().workspaceId, `https://example.test/z/${canonicalJobId}`, fields.state ?? "MATCHED",
      fields.gate ?? null, fields.reason ?? null, fields.outcome ?? null],
  );
  await db().query(
    `INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Synthetic.', NOW())`,
    [jobVersionId, ctx().workspaceId, canonicalJobId, `h-${jobVersionId}`],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  return { canonicalJobId, jobVersionId };
}

async function archive(canonicalJobId: string, reason: string, basis: string): Promise<void> {
  const run = await db().query<{ id: string }>(
    `INSERT INTO job_archive_runs (run_started_at, cutoff_at, mode, status) VALUES (NOW(), NOW() - INTERVAL '1 second', 'APPLY', 'RUNNING') RETURNING id::text`,
  );
  await db().query(
    `UPDATE canonical_jobs SET archived_at = NOW(), archive_reason = $2, archive_age_basis = $3, archive_reference_at = NOW(), archive_run_id = $4 WHERE id = $1`,
    [canonicalJobId, reason, basis, run.rows[0]!.id],
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
    context = await resolveWorkspaceContext(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("every check is zero on a clean schema, and the exit code follows the totals", async () => {
    const results = await runZeroChecks(db(), ctx().workspaceId);
    expect(results.map((check) => check.name)).toEqual([
      "rejected_job_with_recommendation", "listed_job_not_currently_open", "task_completed_without_result",
      "routable_verification_job_stranded", "protected_job_auto_archived",
    ]);
    expect(results.every((check) => check.total === 0)).toBe(true);
    expect(zeroChecksExitCode(results)).toBe(0);
    expect(zeroChecksExitCode([{ total: 0 }, { total: 2 }])).toBe(1);
  });

  it("fails on a rejected job that still carries a recommendation", async () => {
    const bad = await job({ outcome: "REVIEW" });
    await db().query(`INSERT INTO gate_decisions (canonical_job_id, job_version_id, decision, workspace_id) VALUES ($1, $2, 'HARD_REJECT', $3)`,
      [bad.canonicalJobId, bad.jobVersionId, ctx().workspaceId]);
    const good = await job({ outcome: null });
    await db().query(`INSERT INTO gate_decisions (canonical_job_id, job_version_id, decision, workspace_id) VALUES ($1, $2, 'HARD_REJECT', $3)`,
      [good.canonicalJobId, good.jobVersionId, ctx().workspaceId]);
    const check = await rejectedJobsWithRecommendation(db(), ctx().workspaceId);
    expect(check.sample).toEqual([bad.canonicalJobId]);
  });

  it("fails on a listed job that is not currently open (stand-in list view; the real views run without error)", async () => {
    const real = await listedJobsNotCurrentlyOpen(db(), ctx().workspaceId);
    expect(real.total).toBe(0);
    const open = await job();
    const closed = await job();
    await db().query(
      `UPDATE job_versions SET availability_status = 'OPEN', availability_verified_at = NOW(), availability_recheck_at = NOW() + INTERVAL '3 days' WHERE id = $1`, [open.jobVersionId]);
    await db().query(`UPDATE job_versions SET availability_status = 'CLOSED', availability_verified_at = NOW(), availability_recheck_at = NOW() + INTERVAL '3 days' WHERE id = $1`, [closed.jobVersionId]);
    await db().query(
      `CREATE VIEW zero_check_listed AS
         SELECT c.workspace_id, c.id AS canonical_job_id, c.latest_job_version_id AS job_version_id
           FROM canonical_jobs c WHERE c.id = ANY($1::uuid[])`.replace("$1::uuid[]", `ARRAY['${open.canonicalJobId}','${closed.canonicalJobId}']::uuid[]`));
    const check = await listedJobsNotCurrentlyOpen(db(), ctx().workspaceId, { stand_in: "zero_check_listed" });
    // The open job is current only when the read model says so; the closed job must be reported.
    expect(check.sample).toContain(`stand_in:${closed.canonicalJobId}`);
    expect(check.sample).not.toContain(`stand_in:${open.canonicalJobId}`);
    await expect(listedJobsNotCurrentlyOpen(db(), ctx().workspaceId, { bad: "x; DROP TABLE y" })).rejects.toThrow(/plain identifier/);
  });

  it("fails on a completed task with no result, including RECHECK_AVAILABILITY", async () => {
    const target = await job();
    const taskId = randomUUID();
    await db().query(
      `INSERT INTO pipeline_tasks (id, workspace_id, task_type, task_key, payload, status, completed_at)
       VALUES ($1, $2, 'RECHECK_AVAILABILITY', $3, $4::jsonb, 'COMPLETED', NOW())`,
      [taskId, ctx().workspaceId, `RECHECK_AVAILABILITY:${target.jobVersionId}:x`, JSON.stringify({ job_version_id: target.jobVersionId })],
    );
    const check = await completedTasksWithoutResult(db(), ctx().workspaceId);
    expect(check.sample).toContain(taskId);
    expect(check.detail).toMatchObject({ RECHECK_AVAILABILITY: 1 });
  });

  it("fails on a routable NEEDS_VERIFICATION job with no task and no match run", async () => {
    const stranded = await job({ gate: "NEEDS_VERIFICATION", reason: "GATE_UNKNOWN_WORK_MODE", state: "NEEDS_VERIFICATION" });
    const waiting = await job({ gate: "NEEDS_VERIFICATION", reason: "GATE_UNKNOWN_WORK_MODE", state: "NEEDS_VERIFICATION" });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status) VALUES ($1, 'PUBLISH_EMBEDDING', $2, $3::jsonb, 'PENDING')`,
      [ctx().workspaceId, `PUBLISH_EMBEDDING:${waiting.jobVersionId}:x`, JSON.stringify({ canonical_job_id: waiting.canonicalJobId, job_version_id: waiting.jobVersionId })],
    );
    const check = await routableVerificationJobsStranded(db(), ctx().workspaceId);
    expect(check.sample).toContain(stranded.canonicalJobId);
    expect(check.sample).not.toContain(waiting.canonicalJobId);
  });

  it("fails on a saved job archived as not confirmable, counted by archive reason; an unsaved one is fine", async () => {
    const saved = await job();
    await db().query(
      `INSERT INTO raw_job_observations (workspace_id, source_name, source_external_id, source_url, retrieved_at, company_name, title, description_raw,
         raw_payload, raw_payload_hash, processing_status, job_version_id)
       VALUES ($1, 'LINKEDIN_SAVED', $2, $3, NOW(), 'Zero Check Co', 'fixture role', 'x', '{}'::jsonb, $4, 'PROCESSED', $5)`,
      [ctx().workspaceId, `s-${randomUUID()}`, `https://example.test/s/${randomUUID()}`, randomUUID().replaceAll("-", "").padEnd(64, "0"), saved.jobVersionId],
    );
    await archive(saved.canonicalJobId, "POSTING_NOT_CONFIRMABLE", "POSTING_LINK_UNVERIFIABLE");
    const unsaved = await job();
    await archive(unsaved.canonicalJobId, "POSTING_NOT_CONFIRMABLE", "POSTING_LINK_UNVERIFIABLE");
    const check = await protectedJobsAutoArchived(db(), ctx().workspaceId);
    expect(check.sample).toContain(saved.canonicalJobId);
    expect(check.sample).not.toContain(unsaved.canonicalJobId);
    expect(check.detail).toMatchObject({ POSTING_NOT_CONFIRMABLE: check.total });
  });
});
