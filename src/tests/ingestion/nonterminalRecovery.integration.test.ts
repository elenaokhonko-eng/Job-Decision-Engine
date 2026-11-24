import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { findStrandedNonterminalJobs } from "../../ingestion/nonterminalRecovery.js";
import { archiveJobsAsPostingNotConfirmable } from "../../services/jobArchive.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../../workspace/context.js";

// check_integrity check 7: a live nonterminal job without an open task or active queue row is stranded; an archived one
// is not (the archive completes its open tasks on purpose). Synthetic fixtures; real PostgreSQL, private schema.
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || "";
const skipReal = !databaseUrl || !isLocalPostgresConnectionString(databaseUrl);
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true" && skipReal) {
  throw new Error("CI must run the nonterminal recovery integration tests against its PostgreSQL service.");
}

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = "";
let context: WorkspaceContext | undefined;

function db(): pg.PoolClient {
  if (!client) throw new Error("The nonterminal recovery test client is not initialized.");
  return client;
}

async function job(workspaceId: string, label: string, state: string, options: { fixture?: boolean } = {}): Promise<string> {
  const inserted = await db().query<{ id: string }>(
    `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, processing_state, processing_status, is_test_fixture)
     VALUES ($1, 'Stranded Fixture Co', $2, $3, $4, $4, $5) RETURNING id`,
    [workspaceId, label, `https://example.test/stranded/${randomUUID()}`, state, options.fixture === true],
  );
  const id = inserted.rows[0]!.id;
  const version = await db().query<{ id: string }>(
    `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
     VALUES ($1, $2, 1, $3, 'Synthetic.', NOW()) RETURNING id`,
    [workspaceId, id, `stranded-${randomUUID()}`],
  );
  await db().query(`UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE id = $2`, [version.rows[0]!.id, id]);
  return id;
}

describe.skipIf(skipReal)("stranded nonterminal jobs (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(databaseUrl));
    client = await pool.connect();
    schemaName = `stranded_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    context = await resolveWorkspaceContext(client);
  }, 180_000);

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("RESET search_path").catch(() => undefined);
      if (schemaName) await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
    }
    await pool?.end();
  });

  async function newWorkspace(): Promise<string> {
    const inserted = await db().query<{ id: string }>(`INSERT INTO workspaces (workspace_key, display_name) VALUES ($1, 'Stranded') RETURNING id::text`, [`stranded-${randomUUID()}`]);
    return inserted.rows[0]!.id;
  }

  it("counts a live stranded job, not an archived one, not a job with an open task, not a terminal job, not a fixture", async () => {
    const ws = await newWorkspace();
    const live = await job(ws, "live-stranded", "LANE_ROUTED");
    const archived = await job(ws, "archived-stranded", "RAW_STAGED");
    const withTask = await job(ws, "has-task", "RAW_STAGED");
    await job(ws, "terminal", "AI_EVALUATED");
    await job(ws, "fixture", "RAW_STAGED", { fixture: true });
    await db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status) VALUES ($1, 'ROUTE_LANE', $2, $3::jsonb, 'PENDING')`,
      [ws, `task-${randomUUID()}`, JSON.stringify({ canonical_job_id: withTask })],
    );
    await archiveJobsAsPostingNotConfirmable(db(), { workspaceId: ws, canonicalJobIds: [archived], actor: "test:stranded", details: { rule: "test" } });

    const report = await findStrandedNonterminalJobs(db(), ws);
    expect(report).toEqual({ count: 1, sample: [live] });
  });

  it("near misses: terminal-status tasks, another workspace's task and another job's task do not count as recovery work", async () => {
    const ws = await newWorkspace();
    const otherWs = await newWorkspace();
    const completedOnly = await job(ws, "completed-task-only", "RAW_STAGED");
    const skippedArchived = await job(ws, "skipped-archived-task-only", "LANE_ROUTED");
    const deadLettered = await job(ws, "dead-letter-only", "PREQUALIFIED");
    const foreignTask = await job(ws, "task-in-another-workspace", "RAW_STAGED");
    const otherJobTask = await job(ws, "task-names-another-job", "RAW_STAGED");
    const unrelated = await job(ws, "unrelated-with-task", "RAW_STAGED");
    const insert = (workspace: string, status: string, repair: string | null, payload: Record<string, string>) => db().query(
      `INSERT INTO pipeline_tasks (workspace_id, task_type, task_key, payload, status, repair_action) VALUES ($1, 'ROUTE_LANE', $2, $3::jsonb, $4, $5)`,
      [workspace, `near-${randomUUID()}`, JSON.stringify(payload), status, repair],
    );
    await insert(ws, "COMPLETED", null, { canonical_job_id: completedOnly });
    await insert(ws, "COMPLETED", "SKIPPED_ARCHIVED_JOB", { canonical_job_id: skippedArchived });
    await insert(ws, "DEAD_LETTER", null, { canonical_job_id: deadLettered });
    await insert(otherWs, "PENDING", null, { canonical_job_id: foreignTask });
    await insert(ws, "PENDING", null, { canonical_job_id: unrelated });
    // otherJobTask has no task of its own; the pending task above belongs to a different job.
    const report = await findStrandedNonterminalJobs(db(), ws);
    expect([...report.sample].sort()).toEqual([completedOnly, skippedArchived, deadLettered, foreignTask, otherJobTask].sort());
    expect(report.count).toBe(5);
  });

  it("a live job with an active evaluation queue row is not stranded", async () => {
    const ws = await newWorkspace();
    const queued = await job(ws, "queued", "QUEUED_FOR_AI");
    await db().query(
      `INSERT INTO evaluation_queue (workspace_id, canonical_job_id, job_version_id, lane, status)
       SELECT $1, $2, latest_job_version_id, 'CORE_AI_DATA', 'PENDING' FROM canonical_jobs WHERE id = $2`,
      [ws, queued],
    );
    expect(await findStrandedNonterminalJobs(db(), ws)).toEqual({ count: 0, sample: [] });
  });
});
