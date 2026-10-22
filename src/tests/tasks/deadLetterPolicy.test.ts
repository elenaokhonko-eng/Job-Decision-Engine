import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { isLocalPostgresConnectionString, pgConnectionConfig } from "../../db/pgSsl.js";
import { resolveWorkspaceContext } from "../../workspace/context.js";
import {
  readDeadLetterTaskHealth,
  reconcileStaleSupersededEmbeddingDeadLetters,
  STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION,
} from "../../tasks/deadLetterPolicy.js";

const DATABASE_URL = process.env.DATABASE_URL || "";
const skipRealPostgres = !DATABASE_URL || !isLocalPostgresConnectionString(DATABASE_URL);
let workspaceId: string;
const JOB_ID = "99000000-0000-4000-8000-000000000001";
const OLD_VERSION_ID = "99000000-0000-4000-8000-000000000002";
const CURRENT_VERSION_ID = "99000000-0000-4000-8000-000000000003";
const STALE_EMBEDDING_TASK_ID = "99000000-0000-4000-8000-000000000004";
const CURRENT_EMBEDDING_TASK_ID = "99000000-0000-4000-8000-000000000005";
const STALE_ROUTING_TASK_ID = "99000000-0000-4000-8000-000000000006";
const MISSING_LINEAGE_TASK_ID = "99000000-0000-4000-8000-000000000007";

let pool: pg.Pool;

async function seedFixture(): Promise<void> {
  await pool.query(
    `INSERT INTO canonical_jobs (
       id, workspace_id, company_name, normalized_title, canonical_url,
       processing_state, processing_status, primary_lane
     ) VALUES ($1, $2, 'Dead-letter fixture', 'Superseded embedding fixture',
               'https://example.invalid/dead-letter-fixture', 'LANE_ROUTED', 'LANE_ROUTED', 'CORE_AI_DATA')
     ON CONFLICT (id) DO NOTHING`,
    [JOB_ID, workspaceId],
  );
  await pool.query(
    `INSERT INTO job_versions (
       id, workspace_id, canonical_job_id, content_hash, description_text, observed_at
     ) VALUES
       ($1, $3, $4, 'dead-letter-old-version', 'Old version fixture description', NOW() - INTERVAL '1 day'),
       ($2, $3, $4, 'dead-letter-current-version', 'Current version fixture description', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [OLD_VERSION_ID, CURRENT_VERSION_ID, workspaceId, JOB_ID],
  );
  await pool.query(
    "UPDATE canonical_jobs SET latest_job_version_id = $1 WHERE workspace_id = $2 AND id = $3",
    [CURRENT_VERSION_ID, workspaceId, JOB_ID],
  );
  const tasks = [
    {
      id: STALE_EMBEDDING_TASK_ID,
      task_type: "PUBLISH_EMBEDDING",
      task_key: "dead-letter-fixture:stale-embedding",
      payload: { canonical_job_id: JOB_ID, job_version_id: OLD_VERSION_ID },
    },
    {
      id: CURRENT_EMBEDDING_TASK_ID,
      task_type: "PUBLISH_EMBEDDING",
      task_key: "dead-letter-fixture:current-embedding",
      payload: { canonical_job_id: JOB_ID, job_version_id: CURRENT_VERSION_ID },
    },
    {
      id: STALE_ROUTING_TASK_ID,
      task_type: "ROUTE_LANE",
      task_key: "dead-letter-fixture:stale-routing",
      payload: { canonical_job_id: JOB_ID, job_version_id: OLD_VERSION_ID },
    },
    {
      id: MISSING_LINEAGE_TASK_ID,
      task_type: "PUBLISH_EMBEDDING",
      task_key: "dead-letter-fixture:missing-lineage",
      payload: { canonical_job_id: JOB_ID, job_version_id: "99000000-0000-4000-8000-000000000099" },
    },
  ];
  for (const task of tasks) {
    await pool.query(
      `INSERT INTO pipeline_tasks (
         id, workspace_id, task_type, task_key, payload, status,
         attempt_count, max_attempts, last_error, dead_letter_reason
       ) VALUES ($1, $2, $3, $4, $5::JSONB, 'DEAD_LETTER', 3, 3,
                 'original error retained', 'original terminal reason retained')
       ON CONFLICT DO NOTHING`,
      [task.id, workspaceId, task.task_type, task.task_key, JSON.stringify(task.payload)],
    );
  }
}

describe.skipIf(skipRealPostgres)("dead-letter reconciliation with PostgreSQL", () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(DATABASE_URL));
    await runMigrations(pool);
    workspaceId = (await resolveWorkspaceContext(pool as unknown as pg.PoolClient)).workspaceId;
    await seedFixture();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM pipeline_tasks WHERE id = ANY($1::UUID[])", [[
      STALE_EMBEDDING_TASK_ID,
      CURRENT_EMBEDDING_TASK_ID,
      STALE_ROUTING_TASK_ID,
      MISSING_LINEAGE_TASK_ID,
    ]]);
    await pool.query("DELETE FROM job_versions WHERE id = ANY($1::UUID[])", [[OLD_VERSION_ID, CURRENT_VERSION_ID]]);
    await pool.query("DELETE FROM canonical_jobs WHERE id = $1", [JOB_ID]);
    await pool.end();
  });

  it("reconciles only provably superseded embedding dead letters and preserves their audit rows", async () => {
    const reconciled = await reconcileStaleSupersededEmbeddingDeadLetters(pool, workspaceId);
    expect(reconciled).toBe(1);

    const { rows } = await pool.query<{
      id: string;
      status: string;
      repair_action: string | null;
      last_error: string | null;
      dead_letter_reason: string | null;
    }>(
      `SELECT id, status, repair_action, last_error, dead_letter_reason
       FROM pipeline_tasks
       WHERE id = ANY($1::UUID[])
       ORDER BY id`,
      [[STALE_EMBEDDING_TASK_ID, CURRENT_EMBEDDING_TASK_ID, STALE_ROUTING_TASK_ID, MISSING_LINEAGE_TASK_ID]],
    );
    const stale = rows.find((row) => row.id === STALE_EMBEDDING_TASK_ID);
    expect(stale).toMatchObject({
      status: "DEAD_LETTER",
      repair_action: STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION,
      last_error: "original error retained",
      dead_letter_reason: "original terminal reason retained",
    });
    expect(rows.filter((row) => row.repair_action === STALE_SUPERSEDED_EMBEDDING_REPAIR_ACTION)).toHaveLength(1);
    expect(rows.filter((row) => row.status === "DEAD_LETTER")).toHaveLength(4);

    const health = await readDeadLetterTaskHealth(pool, workspaceId);
    expect(health).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task_type: "PUBLISH_EMBEDDING",
        actionable_dead_letter_count: 2,
        stale_historical_dead_letter_count: 1,
      }),
      expect.objectContaining({
        task_type: "ROUTE_LANE",
        actionable_dead_letter_count: 1,
        stale_historical_dead_letter_count: 0,
      }),
    ]));
    expect(await reconcileStaleSupersededEmbeddingDeadLetters(pool, workspaceId)).toBe(0);
  });
});
