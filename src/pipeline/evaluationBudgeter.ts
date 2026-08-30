import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

const MAX_PER_LANE = 3;

export async function runEvaluationBudgeter(clientOrPool?: pg.Pool | pg.PoolClient): Promise<{ queued: number; deferred: number }> {
  console.log("Starting Evaluation Budgeter...");
  const pool = clientOrPool || defaultPool;

  // Select jobs that are either newly lane-routed or were deferred in prior runs
  const query = `
    SELECT c.*, COALESCE(c.latest_job_version_id, jv.id) AS resolved_job_version_id
    FROM canonical_jobs c
    LEFT JOIN LATERAL (
      SELECT id FROM job_versions WHERE canonical_job_id = c.id ORDER BY observed_at DESC LIMIT 1
    ) jv ON TRUE
    WHERE c.processing_status IN ('LANE_ROUTED', 'SEMANTIC_SHORTLISTED', 'DEFERRED_BUDGET')
      AND c.primary_lane IS NOT NULL
      AND c.primary_lane != 'UNCLASSIFIED'
  `;
  
  const { rows: jobs } = await pool.query(query);
  console.log(`Found ${jobs.length} jobs eligible for AI Evaluation budgeting.`);

  const jobsByLane: Record<string, typeof jobs> = {};
  for (const job of jobs) {
    if (!jobsByLane[job.primary_lane]) jobsByLane[job.primary_lane] = [];
    jobsByLane[job.primary_lane].push(job);
  }

  let queuedCount = 0;
  let deferredCount = 0;

  const client = 'connect' in pool ? await pool.connect() : pool;
  try {
    for (const lane of Object.keys(jobsByLane)) {
      // Sort by semantic score descending
      jobsByLane[lane].sort((a, b) => (b.semantic_score || 0) - (a.semantic_score || 0));
      
      const eligible = jobsByLane[lane].slice(0, MAX_PER_LANE);
      const overflow = jobsByLane[lane].slice(MAX_PER_LANE);

      console.log(`- ${lane}: Enqueueing top ${eligible.length} of ${jobsByLane[lane].length} jobs (deferring ${overflow.length}).`);
      
      for (const job of eligible) {
        await client.query("BEGIN");
        try {
          const versionId = job.resolved_job_version_id || job.latest_job_version_id || job.job_version_id;
          if (!versionId) {
            throw new Error(`Cannot enqueue canonical job ${job.id} without a valid job_version_id`);
          }

          await client.query(
            `INSERT INTO evaluation_queue (canonical_job_id, job_version_id, lane, priority_score, status, enqueued_at, updated_at) 
             VALUES ($1, $2, $3, $4, 'PENDING', NOW(), NOW())`,
            [job.id, versionId, lane, job.semantic_score]
          );
          
          await client.query(
            `UPDATE canonical_jobs SET processing_status = 'QUEUED_FOR_AI', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );
          await client.query("COMMIT");
          queuedCount++;
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`❌ Failed to enqueue budgeted job ${job.id}:`, err);
        }
      }
      
      // Overflow items are durably deferred (NEVER rejected)
      for (const job of overflow) {
        await client.query("BEGIN");
        try {
          await client.query(
            `UPDATE canonical_jobs 
             SET processing_status = 'DEFERRED_BUDGET', rejection_reason = NULL, updated_at = NOW() 
             WHERE id = $1`,
            [job.id]
          );
          await client.query("COMMIT");
          deferredCount++;
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`❌ Failed to defer overflow job ${job.id}:`, err);
        }
      }
    }
  } finally {
    if ('release' in client && typeof client.release === 'function') {
      client.release();
    }
  }

  console.log(`Evaluation Budgeter complete. Queued: ${queuedCount}, Deferred: ${deferredCount}`);
  return { queued: queuedCount, deferred: deferredCount };
}

export const runBudgeter = runEvaluationBudgeter;
