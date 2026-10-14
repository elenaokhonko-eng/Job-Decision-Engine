import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function run() {
  const pool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL_UNPOOLED));

  const gitSha = "6665de4";
  const cj = await pool.query(
    "SELECT count(*) as total, count(CASE WHEN NOT is_test_fixture THEN 1 END) as operational, count(CASE WHEN is_test_fixture THEN 1 END) as fixtures FROM canonical_jobs"
  );
  const states = await pool.query(
    "SELECT COALESCE(processing_state, processing_status) as state, count(*) as count FROM canonical_jobs WHERE NOT is_test_fixture GROUP BY 1 ORDER BY 2 DESC"
  );
  const gatePass = await pool.query(
    "SELECT count(*) as count FROM canonical_jobs WHERE NOT is_test_fixture AND gate_decision = 'PASS'"
  );
  const recs = await pool.query(
    "SELECT recommendation_outcome, count(*) as count FROM canonical_jobs WHERE NOT is_test_fixture AND recommendation_outcome IS NOT NULL GROUP BY 1 ORDER BY 2 DESC"
  );

  const cohorts = await pool.query(`
    WITH latest_gates AS (
      SELECT DISTINCT ON (canonical_job_id) canonical_job_id, rejection_codes
      FROM gate_decisions
      ORDER BY canonical_job_id, created_at DESC, id DESC
    )
    SELECT
      count(CASE WHEN lg.rejection_codes ? 'GATE_EXPERIENCE_TOO_LOW' THEN 1 END) as exp_too_low,
      count(CASE WHEN lg.rejection_codes = '["GATE_EXPERIENCE_TOO_LOW"]'::jsonb THEN 1 END) as exp_too_low_sole,
      count(CASE WHEN lg.rejection_codes ? 'GATE_OUT_OF_SCOPE_DOMAIN' THEN 1 END) as out_of_scope,
      count(CASE WHEN lg.rejection_codes = '["GATE_OUT_OF_SCOPE_DOMAIN"]'::jsonb THEN 1 END) as out_of_scope_sole,
      count(CASE WHEN lg.rejection_codes ? 'GATE_UNKNOWN_WORK_MODE' THEN 1 END) as unknown_work_mode,
      count(CASE WHEN lg.rejection_codes = '["GATE_UNKNOWN_WORK_MODE"]'::jsonb THEN 1 END) as unknown_work_mode_sole,
      count(CASE WHEN lg.rejection_codes ? 'WORK_AUTHORIZATION_INCOMPATIBLE' THEN 1 END) as work_auth,
      count(CASE WHEN lg.rejection_codes = '["WORK_AUTHORIZATION_INCOMPATIBLE"]'::jsonb THEN 1 END) as work_auth_sole,
      count(CASE WHEN lg.rejection_codes ? 'GATE_LIFESTYLE_INCOMPATIBLE' THEN 1 END) as lifestyle,
      count(CASE WHEN lg.rejection_codes = '["GATE_LIFESTYLE_INCOMPATIBLE"]'::jsonb THEN 1 END) as lifestyle_sole
    FROM canonical_jobs c
    JOIN latest_gates lg ON lg.canonical_job_id = c.id
    WHERE NOT c.is_test_fixture
  `);

  const routingDist = await pool.query(`
    SELECT COALESCE(routing_disposition, 'NONE') as disposition, count(*)
    FROM canonical_jobs
    WHERE NOT is_test_fixture
    GROUP BY 1 ORDER BY 2 DESC
  `);

  const baselineData = {
    gitSha,
    capturedAt: new Date().toISOString(),
    canonicalJobs: cj.rows[0],
    states: states.rows,
    gatePass: Number(gatePass.rows[0].count),
    recommendations: recs.rows,
    cohorts: cohorts.rows[0],
    routingDispositions: routingDist.rows,
  };

  console.log("PRODUCTION_BASELINE_V42:", JSON.stringify(baselineData, null, 2));

  await pool.end();
}

run().catch(console.error);
