import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { diffRepairSnapshots, snapshotRepairState } from "../../tasks/repairStateSnapshot.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// The before/after proof for a repair: no live job loses a stored result and no protected job changes status.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the repair snapshot tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let ctx: WorkspaceContext | undefined;
const db = (): pg.PoolClient => { if (!client) throw new Error("not initialised"); return client; };
const c = (): WorkspaceContext => { if (!ctx) throw new Error("not initialised"); return ctx; };

async function job(label: string): Promise<{ canonicalJobId: string; jobVersionId: string }> {
  const canonicalJobId = randomUUID();
  const jobVersionId = randomUUID();
  await db().query(
    `INSERT INTO canonical_jobs (id, workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, recommendation_requirement_score)
     VALUES ($1, $2, 'Snapshot Co', $3, $4, 'MATCHED', 'MATCHED', 0.5)`, [canonicalJobId, c().workspaceId, label, `https://example.test/s/${canonicalJobId}`]);
  await db().query(`INSERT INTO job_versions (id, workspace_id, canonical_job_id, content_hash, description_text, observed_at) VALUES ($1, $2, $3, $4, 'Synthetic.', NOW())`,
    [jobVersionId, c().workspaceId, canonicalJobId, `h-${jobVersionId}`]);
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [jobVersionId, canonicalJobId]);
  return { canonicalJobId, jobVersionId };
}

describe.skipIf(skipReal)("repair state snapshot (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `repair_snapshot_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    ctx = await resolveWorkspaceContext(client);
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query("RESET search_path").catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  it("counts live results and protected jobs, and an unchanged state diffs clean", async () => {
    const plain = await job("plain");
    const applied = await job("applied");
    await db().query(
      `INSERT INTO application_records (workspace_id, user_id, canonical_job_id, job_version_id, status) VALUES ($1, $2, $3, $4, 'SUBMITTED')`,
      [c().workspaceId, c().userId, applied.canonicalJobId, applied.jobVersionId]);
    const before = await snapshotRepairState(db(), c().workspaceId);
    expect(before.liveJobs).toBe(2);
    expect(before.liveJobsWithScore).toBe(2);
    expect(before.liveJobsWithDecision).toBe(0);
    expect(before.protectedJobs).toBe(1);
    expect(Object.keys(before.protectedStatus)).toEqual([applied.canonicalJobId]);
    expect(plain.canonicalJobId in before.results).toBe(true);
    const diff = diffRepairSnapshots(before, await snapshotRepairState(db(), c().workspaceId));
    expect(diff).toMatchObject({ lostResults: [], protectedChanged: [], leftLiveSet: 0, ok: true });
  });

  it("a job that loses a stored result, and a protected job whose status changes, are reported by id", async () => {
    const lost = await job("lost");
    const held = await job("held");
    await db().query(
      `INSERT INTO job_archive_holds (workspace_id, canonical_job_id, hold_reason, hold_type, created_by, expires_at) VALUES ($1, $2, 'keep', 'USER_PRESERVE', 'test', NOW() + INTERVAL '10 days')`,
      [c().workspaceId, held.canonicalJobId]);
    const before = await snapshotRepairState(db(), c().workspaceId);
    await db().query(`UPDATE canonical_jobs SET recommendation_requirement_score = NULL WHERE id = $1`, [lost.canonicalJobId]);
    await db().query(`UPDATE job_archive_holds SET released_at = NOW(), released_by = 'test', release_reason = 'test' WHERE canonical_job_id = $1`, [held.canonicalJobId]);
    const diff = diffRepairSnapshots(before, await snapshotRepairState(db(), c().workspaceId));
    expect(diff.ok).toBe(false);
    expect(diff.lostResults).toEqual([{ jobId: lost.canonicalJobId, field: "score" }]);
    expect(diff.protectedChanged.map((entry) => entry.jobId)).toContain(held.canonicalJobId);
  });
});
