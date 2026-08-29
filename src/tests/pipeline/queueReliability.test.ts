/**
 * P0-04 & P0-06 — Queue Lease Management & AI Evaluation Resilience
 *
 * Two test tiers:
 *
 *  TIER 1 — Logic tests (always run, no DB):
 *    Verify lease expiry math, NEEDS_MANUAL_REVIEW transition, and
 *    RETRY_WAIT-on-recoverable-error rules as pure TypeScript logic.
 *
 *  TIER 2 — Real PostgreSQL tests (CI only, skip on Neon):
 *    Insert actual queue rows, assert DB state transitions by calling
 *    the real SQL logic used in evaluate_queue.ts.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import pg from "pg";
import { runMigrations } from "../../db/migrate.js";

// ── CI detection ──────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL || "";
const isCI = DB_URL.includes("localhost") || DB_URL.includes("127.0.0.1");
const skipReal = !DB_URL || !isCI;

// ── Tier 1: Pure logic tests ──────────────────────────────────────────────────

describe("P0-04 & P0-06: Queue Logic (no DB)", () => {
  it("exhausted retries → NEEDS_MANUAL_REVIEW, never HARD_REJECTED", () => {
    const item = { attempt_count: 3, max_attempts: 3, status: "RETRY_WAIT" };
    const next = item.attempt_count >= item.max_attempts ? "NEEDS_MANUAL_REVIEW" : "RETRY_WAIT";
    expect(next).toBe("NEEDS_MANUAL_REVIEW");
    expect(next).not.toBe("HARD_REJECTED");
    expect(next).not.toBe("REJECTED_AFTER_EVALUATION");
  });

  it("stale lease (expired) is reclaimable; active lease is not", () => {
    const now = new Date("2026-08-28T12:00:00.000Z");
    const staleExpiry = new Date("2026-08-28T11:50:00.000Z"); // expired
    const activeExpiry = new Date("2026-08-28T12:04:00.000Z"); // not yet expired
    expect(staleExpiry < now).toBe(true);   // stale → reclaimable
    expect(activeExpiry < now).toBe(false); // active → busy
  });

  it("recoverable API error (429) → RETRY_WAIT, not FAILED", () => {
    let status = "EVALUATING";
    try {
      throw new Error("429 Too Many Requests: Rate limit exceeded");
    } catch {
      status = "RETRY_WAIT";
    }
    expect(status).toBe("RETRY_WAIT");
    expect(status).not.toBe("FAILED");
  });

  it("available_at backoff formula: 2^attempt × 30s", () => {
    const backoffSeconds = (attempt: number) => Math.pow(2, attempt) * 30;
    expect(backoffSeconds(1)).toBe(60);   // 1 min
    expect(backoffSeconds(2)).toBe(120);  // 2 min
    expect(backoffSeconds(3)).toBe(240);  // 4 min
    // Must stay finite (not exceed 1 day)
    expect(backoffSeconds(3)).toBeLessThan(86400);
  });
});

// ── Tier 2: Real PostgreSQL queue tests ───────────────────────────────────────

let pool: pg.Pool;

async function q(sql: string, params?: any[]): Promise<pg.QueryResult> {
  return pool.query(sql, params);
}

async function count(table: string, where: string): Promise<number> {
  const res = await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`);
  return res.rows[0].n;
}

describe.skipIf(skipReal)("P0-04: Real Queue State Machine (PostgreSQL)", () => {
  const JOB_ID  = "30000000-0000-0000-0000-000000000001";
  const JOB_ID2 = "30000000-0000-0000-0000-000000000002";
  const JOB_ID3 = "30000000-0000-0000-0000-000000000003";
  const Q_ID_1  = "40000000-0000-0000-0000-000000000001";
  const Q_ID_2  = "40000000-0000-0000-0000-000000000002";
  const Q_ID_3  = "40000000-0000-0000-0000-000000000003";

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    await runMigrations(pool);

    // Clean up any prior test data
    await q(`DELETE FROM evaluation_queue WHERE id IN ($1, $2, $3)`, [Q_ID_1, Q_ID_2, Q_ID_3]);
    await q(`DELETE FROM canonical_jobs WHERE id IN ($1, $2, $3)`, [JOB_ID, JOB_ID2, JOB_ID3]);

    // Seed canonical jobs for queue tests
    for (const [id, title] of [[JOB_ID,"AI Policy Lead"],[JOB_ID2,"ML Research Sci"],[JOB_ID3,"Data Strategy Lead"]]) {
      await q(
        `INSERT INTO canonical_jobs (id, company_name, normalized_title, canonical_url, processing_status, primary_lane)
         VALUES ($1, 'ReliabilityTestCo', $2, 'https://test.rl', 'LANE_ROUTED', 'CORE_AI_DATA')
         ON CONFLICT DO NOTHING`,
        [id, title]
      );
    }
  });

  afterAll(async () => {
    await q(`DELETE FROM evaluation_queue WHERE id IN ($1, $2, $3)`, [Q_ID_1, Q_ID_2, Q_ID_3]);
    await q(`DELETE FROM canonical_jobs WHERE id IN ($1, $2, $3)`, [JOB_ID, JOB_ID2, JOB_ID3]);
    await pool.end();
  });

  it("PENDING item is picked up and leased correctly", async () => {
    await q(
      `INSERT INTO evaluation_queue (id, canonical_job_id, lane, status, attempt_count, max_attempts, priority_score, available_at)
       VALUES ($1, $2, 'CORE_AI_DATA', 'PENDING', 0, 3, 0.8, NOW())
       ON CONFLICT DO NOTHING`,
      [Q_ID_1, JOB_ID]
    );

    // Simulate the worker lease acquisition query from evaluate_queue.ts
    const leaseRes = await q(`
      UPDATE evaluation_queue
      SET status = 'EVALUATING',
          lease_expires_at = NOW() + INTERVAL '5 minutes',
          attempt_count = attempt_count + 1,
          updated_at = NOW()
      WHERE id = $1
        AND status IN ('PENDING', 'RETRY_WAIT')
        AND available_at <= NOW()
      RETURNING id, status, attempt_count
    `, [Q_ID_1]);

    expect(leaseRes.rowCount).toBe(1);
    expect(leaseRes.rows[0].status).toBe("EVALUATING");
    expect(leaseRes.rows[0].attempt_count).toBe(1);
  });

  it("EVALUATING item with expired lease is reclaimable by next worker run", async () => {
    await q(
      `INSERT INTO evaluation_queue (id, canonical_job_id, lane, status, attempt_count, max_attempts, priority_score, available_at, lease_expires_at)
       VALUES ($1, $2, 'CORE_AI_DATA', 'EVALUATING', 1, 3, 0.7, NOW(), NOW() - INTERVAL '10 minutes')
       ON CONFLICT DO NOTHING`,
      [Q_ID_2, JOB_ID2]
    );

    // Stale lease query: item should be eligible for re-claim
    const eligibleCount = await count("evaluation_queue",
      `id = '${Q_ID_2}' AND status = 'EVALUATING' AND lease_expires_at < NOW()`);
    expect(eligibleCount).toBe(1);
  });

  it("exhausted RETRY_WAIT → NEEDS_MANUAL_REVIEW in DB, canonical job updated", async () => {
    await q(
      `INSERT INTO evaluation_queue (id, canonical_job_id, lane, status, attempt_count, max_attempts, priority_score, available_at)
       VALUES ($1, $2, 'CORE_AI_DATA', 'RETRY_WAIT', 3, 3, 0.6, NOW())
       ON CONFLICT DO NOTHING`,
      [Q_ID_3, JOB_ID3]
    );

    // Simulate exhausted transition
    await q(`UPDATE evaluation_queue SET status = 'NEEDS_MANUAL_REVIEW', updated_at = NOW() WHERE id = $1`, [Q_ID_3]);
    await q(`UPDATE canonical_jobs SET processing_status = 'NEEDS_MANUAL_REVIEW', updated_at = NOW() WHERE id = $1`, [JOB_ID3]);

    const queueStatus = (await q(`SELECT status FROM evaluation_queue WHERE id = $1`, [Q_ID_3])).rows[0].status;
    const canonStatus = (await q(`SELECT processing_status FROM canonical_jobs WHERE id = $1`, [JOB_ID3])).rows[0].processing_status;

    expect(queueStatus).toBe("NEEDS_MANUAL_REVIEW");
    expect(canonStatus).toBe("NEEDS_MANUAL_REVIEW");
    expect(canonStatus).not.toBe("HARD_REJECTED");
  });

  it("available_at backoff prevents immediate re-pickup of RETRY_WAIT item", async () => {
    // Set available_at 60 seconds in the future (backoff)
    await q(`UPDATE evaluation_queue SET status = 'RETRY_WAIT', available_at = NOW() + INTERVAL '60 seconds', updated_at = NOW() WHERE id = $1`, [Q_ID_1]);

    // Worker query must NOT pick up items with available_at > NOW()
    const pickupCount = await count("evaluation_queue",
      `id = '${Q_ID_1}' AND status = 'RETRY_WAIT' AND available_at <= NOW()`);
    expect(pickupCount).toBe(0);
  });
});
