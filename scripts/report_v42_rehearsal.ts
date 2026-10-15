import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../src/db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

async function run() {
  const pool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL_UNPOOLED));

  const summary = await pool.query("SELECT * FROM v_job_engine_dashboard_summary_scoped");
  const states = await pool.query(`
    SELECT COALESCE(processing_state, processing_status) AS state, count(*)::int AS count
    FROM canonical_jobs WHERE NOT is_test_fixture GROUP BY 1 ORDER BY count DESC
  `);
  const recs = await pool.query(`
    SELECT COALESCE(recommendation_outcome, 'NONE') AS outcome, count(*)::int AS count
    FROM canonical_jobs WHERE NOT is_test_fixture GROUP BY 1 ORDER BY count DESC
  `);
  const tasks = await pool.query(`
    SELECT status, count(*)::int AS count FROM pipeline_tasks GROUP BY 1 ORDER BY 1
  `);
  const laneProof = await pool.query(`
    SELECT DISTINCT ON (primary_lane)
      primary_lane,
      normalized_title AS title,
      company_name,
      semantic_score,
      lane_confidence,
      lane_evidence,
      recommendation_outcome
    FROM canonical_jobs
    WHERE NOT is_test_fixture
      AND primary_lane IS NOT NULL
      AND primary_lane <> 'UNCLASSIFIED'
    ORDER BY primary_lane, semantic_score DESC NULLS LAST, updated_at DESC
  `);
  const laneCounts = await pool.query(`
    SELECT primary_lane, count(*)::int AS count
    FROM canonical_jobs
    WHERE NOT is_test_fixture AND primary_lane IS NOT NULL AND primary_lane <> 'UNCLASSIFIED'
    GROUP BY primary_lane ORDER BY primary_lane
  `);
  const noMatch = await pool.query(`
    SELECT normalized_title AS title, company_name, primary_lane, semantic_score,
           routing_disposition, lane_evidence
    FROM canonical_jobs
    WHERE NOT is_test_fixture
      AND COALESCE(processing_state, processing_status) = 'UNMATCHED'
    ORDER BY updated_at DESC
    LIMIT 20
  `);
  const enrichments = await pool.query(`
    SELECT status, workplace_type, attendance_basis, count(*)::int AS count
    FROM work_mode_enrichments GROUP BY 1,2,3 ORDER BY count DESC
  `);
  const activeLanes = await pool.query(`
    SELECT li.lane_key, lr.revision_number, lr.content_hash, lar.activated_at
    FROM lane_identities li
    JOIN lane_active_revisions lar ON lar.lane_identity_id = li.id
    JOIN lane_revisions lr ON lr.id = lar.lane_revision_id
    WHERE li.status = 'ACTIVE' ORDER BY li.lane_key
  `);
  const alerts = await pool.query(`SELECT lifecycle_status, count(*)::int AS count FROM raw_email_alerts GROUP BY 1 ORDER BY 1`);

  console.log(JSON.stringify({
    dashboardSummary: summary.rows[0],
    states: states.rows,
    recommendations: recs.rows,
    tasks: tasks.rows,
    laneCounts: laneCounts.rows,
    laneProof: laneProof.rows,
    representativeUnmatched: noMatch.rows,
    workModeEnrichments: enrichments.rows,
    activeLaneRevisions: activeLanes.rows,
    emailAlerts: alerts.rows,
  }, null, 2));

  await pool.end();
}

run().catch(console.error);
