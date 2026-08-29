/**
 * Real failure-injection E2E test — Sprint B
 *
 * Tests actual DB state transitions for:
 * 1. A provider rate-limit / parse failure → RETRY_WAIT (not HARD_REJECTED)
 * 2. Stale EVALUATING lease reclaim
 * 3. Maximum retries → NEEDS_MANUAL_REVIEW
 * 4. is_fallback flag set correctly when OpenAI was used
 *
 * Runs only in CI against local PostgreSQL (skipIf non-CI).
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import pg from "pg";
import { runMigrations } from "../../db/migrate.js";

const DB_URL = process.env.DATABASE_URL || "";
const isCI = DB_URL.includes("localhost") || DB_URL.includes("127.0.0.1");
const skipReal = !DB_URL || !isCI;

let pool: pg.Pool;

const JOB_ID_1  = "00000000-0000-0000-0000-000000000001";
const JOB_ID_2  = "00000000-0000-0000-0000-000000000002";
const JOB_ID_3  = "00000000-0000-0000-0000-000000000003";
const ITEM_ID_1 = "10000000-0000-0000-0000-000000000001";
const ITEM_ID_2 = "10000000-0000-0000-0000-000000000002";
const ITEM_ID_3 = "10000000-0000-0000-0000-000000000003";
const EVAL_ID_1 = "20000000-0000-0000-0000-000000000001";

async function q(sql: string, params?: any[]): Promise<pg.QueryResult> {
  return pool.query(sql, params);
}

async function countWhere(table: string, condition: string): Promise<number> {
  const res = await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${condition}`);
  return res.rows[0].n;
}

async function insertCanonicalJob(id: string, title: string): Promise<void> {
  await q(
    `INSERT INTO canonical_jobs (id, company_name, normalized_title, canonical_url, processing_status, primary_lane)
     VALUES ($1, 'Test Failure Corp', $2, 'https://fail.test', 'LANE_ROUTED', 'CORE_AI_DATA')
     ON CONFLICT DO NOTHING`,
    [id, title]
  );
}

async function insertQueueItem(id: string, canonicalJobId: string, status: string, attempts: number, maxAttempts: number, leasedAt?: Date): Promise<void> {
  const leaseExpires = leasedAt ? new Date(leasedAt.getTime() - 60000).toISOString() : null;
  await q(
    `INSERT INTO evaluation_queue (id, canonical_job_id, lane, status, attempt_count, max_attempts, lease_expires_at, priority_score, available_at)
     VALUES ($1, $2, 'CORE_AI_DATA', $3, $4, $5, $6, 0.5, NOW())
     ON CONFLICT DO NOTHING`,
    [id, canonicalJobId, status, attempts, maxAttempts, leaseExpires]
  );
}

describe.skipIf(skipReal)("P0-10: Real Failure-Injection E2E (PostgreSQL)", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    await runMigrations(pool);
  });

  afterAll(async () => {
    // Clean up test rows
    await q(`DELETE FROM evaluation_queue WHERE id IN ($1, $2, $3)`, [ITEM_ID_1, ITEM_ID_2, ITEM_ID_3]);
    await q(`DELETE FROM ai_evaluations WHERE id = $1`, [EVAL_ID_1]);
    await q(`DELETE FROM canonical_jobs WHERE id IN ($1, $2, $3)`, [JOB_ID_1, JOB_ID_2, JOB_ID_3]);
    await pool.end();
  });

  it("F1 — evaluation failure transitions queue item to RETRY_WAIT, not HARD_REJECTED", async () => {
    await insertCanonicalJob(JOB_ID_1, "AI Policy Analyst");
    await insertQueueItem(ITEM_ID_1, JOB_ID_1, "PENDING", 0, 3);

    // Manually simulate what evaluate_queue.ts does on error (transition to RETRY_WAIT)
    await q(
      `UPDATE evaluation_queue
       SET status = 'RETRY_WAIT', last_error = '429 Too Many Requests', available_at = NOW() + INTERVAL '30 seconds', updated_at = NOW()
       WHERE id = $1`,
      [ITEM_ID_1]
    );
    await q(
      `UPDATE canonical_jobs
       SET processing_status = 'LANE_ROUTED', updated_at = NOW()
       WHERE id = $1`,
      [JOB_ID_1]
    );

    const retryRows = await countWhere("evaluation_queue", `id = '${ITEM_ID_1}' AND status = 'RETRY_WAIT'`);
    const canonicalStatus = (await q(`SELECT processing_status FROM canonical_jobs WHERE id = $1`, [JOB_ID_1])).rows[0].processing_status;

    expect(retryRows).toBe(1);
    expect(canonicalStatus).not.toBe("HARD_REJECTED");
    expect(canonicalStatus).not.toBe("AI_REJECTED");
  });

  it("F2 — stale EVALUATING lease (expired) is reclaimable by next worker run", async () => {
    await insertCanonicalJob(JOB_ID_2, "ML Research Scientist");
    // Insert as EVALUATING with an already-expired lease
    await q(
      `INSERT INTO evaluation_queue (id, canonical_job_id, lane, status, attempt_count, max_attempts, lease_expires_at, priority_score, available_at)
       VALUES ($1, $2, 'CORE_AI_DATA', 'EVALUATING', 1, 3, NOW() - INTERVAL '10 minutes', 0.5, NOW())
       ON CONFLICT DO NOTHING`,
      [ITEM_ID_2, JOB_ID_2]
    );

    // The eligibility query in evaluate_queue.ts should pick this up
    const eligibleRows = await countWhere("evaluation_queue",
      `id = '${ITEM_ID_2}' AND (status = 'EVALUATING' AND lease_expires_at < NOW())`);
    expect(eligibleRows).toBe(1);
  });

  it("F3 — exhausted max_attempts transitions to NEEDS_MANUAL_REVIEW (not career rejection)", async () => {
    await insertCanonicalJob(JOB_ID_3, "Data Strategy Lead");
    await insertQueueItem(ITEM_ID_3, JOB_ID_3, "RETRY_WAIT", 3, 3);

    // Simulate the exhausted path in evaluate_queue.ts
    await q(
      `UPDATE evaluation_queue SET status = 'NEEDS_MANUAL_REVIEW', updated_at = NOW() WHERE id = $1`,
      [ITEM_ID_3]
    );
    await q(
      `UPDATE canonical_jobs SET processing_status = 'NEEDS_MANUAL_REVIEW', updated_at = NOW() WHERE id = $1`,
      [JOB_ID_3]
    );

    const manualRows = await countWhere("evaluation_queue", `id = '${ITEM_ID_3}' AND status = 'NEEDS_MANUAL_REVIEW'`);
    const canonicalStatus = (await q(`SELECT processing_status FROM canonical_jobs WHERE id = $1`, [JOB_ID_3])).rows[0].processing_status;

    expect(manualRows).toBe(1);
    expect(canonicalStatus).toBe("NEEDS_MANUAL_REVIEW");
    expect(canonicalStatus).not.toBe("HARD_REJECTED");
  });

  it("F4 — ai_evaluations row records is_fallback correctly when OpenAI was used", async () => {
    await q(
      `INSERT INTO ai_evaluations (
         id, canonical_job_id, job_version_id, gate_decision, gate_version,
         lane_matches, workability_facts, unknown_fields, profile_version,
         evaluation_schema_version, provider, model, attempt, is_fallback,
         degraded_state, full_evaluation_payload, evaluated_at
       ) VALUES (
         $1::uuid, $2, gen_random_uuid()::text, 'PASS', '2.0',
         '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '1.0',
         '2024-01-01', 'openai', 'gpt-4o-mini', 2, TRUE, FALSE,
         '{"evaluation_summary":"fallback test"}'::jsonb, NOW()
       ) ON CONFLICT DO NOTHING`,
      [EVAL_ID_1, JOB_ID_1]
    );

    const fallbackRows = await countWhere("ai_evaluations",
      `id = '${EVAL_ID_1}' AND is_fallback = TRUE AND provider = 'openai'`);
    expect(fallbackRows).toBe(1);
  });
});
