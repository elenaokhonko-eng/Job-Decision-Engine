/**
 * Recommendation Decider integration (real PostgreSQL)
 *
 * Guards against legacy/stale canonical_jobs.gate_decision values (e.g. "FAIL")
 * crashing the deterministic decider. Unknown values must be treated as
 * "unknown gate decision" so the policy defaults to VERIFY/TRACK.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { runMigrations } from "../../db/migrate.js";

const DB_URL = process.env.DATABASE_URL || "";
const isCI = DB_URL.includes("localhost") || DB_URL.includes("127.0.0.1");
const skipReal = !DB_URL || !isCI;

let pool: pg.Pool;

async function q(sql: string, params?: any[]): Promise<pg.QueryResult> {
  return pool.query(sql, params);
}

describe.skipIf(skipReal)("Recommendation Decider: legacy gate_decision normalization", () => {
  const JOB_ID = "91000000-0000-0000-0000-000000000001";
  const VERSION_ID = "92000000-0000-0000-0000-000000000001";

  const seed = async () => {
    await q(
      `INSERT INTO canonical_jobs (
         id, company_name, normalized_title, canonical_url,
         processing_state, processing_status, gate_decision
       )
       VALUES ($1, 'DeciderTestCo', 'Legacy Gate Decision', 'https://example.test/decider',
               'LANE_ROUTED', 'LANE_ROUTED', 'FAIL')
       ON CONFLICT (id)
       DO UPDATE SET processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED', gate_decision = 'FAIL'`,
      [JOB_ID]
    );

    await q(
      `INSERT INTO job_versions (id, canonical_job_id, content_hash, description_text, observed_at)
       VALUES ($1, $2, $3, 'Test job description', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [VERSION_ID, JOB_ID, `recommendation-decider-legacy-${JOB_ID}`]
    );

    await q(`UPDATE canonical_jobs SET latest_job_version_id = $1, updated_at = NOW() WHERE id = $2`, [
      VERSION_ID,
      JOB_ID,
    ]);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    await runMigrations(pool);
    await seed();
  });

  beforeEach(async () => {
    await seed();
    await q(`DELETE FROM deterministic_decisions WHERE canonical_job_id = $1`, [JOB_ID]);
  });

  afterAll(async () => {
    await q(`DELETE FROM deterministic_decisions WHERE canonical_job_id = $1`, [JOB_ID]);
    await q(`DELETE FROM job_versions WHERE id = $1`, [VERSION_ID]);
    await q(`DELETE FROM canonical_jobs WHERE id = $1`, [JOB_ID]);
    await pool.end();
  });

  it("does not crash on canonical_jobs.gate_decision='FAIL' and records a normalized decision", async () => {
    const { runRecommendationDecider } = await import("../../pipeline/recommendationDecider.js");
    const summary = await runRecommendationDecider(pool);
    expect(summary.errors).toBe(0);

    const res = await q(
      `SELECT decision_json
       FROM deterministic_decisions
       WHERE canonical_job_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [JOB_ID]
    );
    expect(res.rows.length).toBe(1);

    const decisionJson = typeof res.rows[0].decision_json === "string"
      ? JSON.parse(res.rows[0].decision_json)
      : res.rows[0].decision_json;

    expect(decisionJson.inputs.gate_decision).toBe("PASS");
    expect(Array.isArray(decisionJson.trace?.notes)).toBe(true);
    expect(decisionJson.trace.notes).toContain("legacy_gate_decision:FAIL->PASS");
  });
});

