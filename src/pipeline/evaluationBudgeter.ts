import pg from "pg";
import dotenv from "dotenv";

import { pgSslConfig } from "../db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

const MAX_PER_LANE = 3;

export async function runEvaluationBudgeter(): Promise<{ queued: number; deferred: number }> {
  console.log("Starting Evaluation Budgeter...");

  // Select jobs that are either newly shortlisted or were deferred in prior runs
  const query = `
    SELECT * FROM canonical_jobs 
    WHERE processing_status IN ('SEMANTIC_SHORTLISTED', 'DEFERRED_BUDGET')
      AND primary_lane IS NOT NULL
      AND primary_lane != 'UNCLASSIFIED'
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

  const client = await pool.connect();
  try {
    for (const lane of Object.keys(jobsByLane)) {
      // Sort by semantic score descending
      jobsByLane[lane].sort((a, b) => b.semantic_score - a.semantic_score);
      
      const eligible = jobsByLane[lane].slice(0, MAX_PER_LANE);
      const overflow = jobsByLane[lane].slice(MAX_PER_LANE);

      console.log(`- ${lane}: Enqueueing top ${eligible.length} of ${jobsByLane[lane].length} jobs (deferring ${overflow.length}).`);
      
      for (const job of eligible) {
        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO evaluation_queue (canonical_job_id, lane, priority_score, status, enqueued_at, updated_at) 
             VALUES ($1, $2, $3, 'PENDING', NOW(), NOW())`,
            [job.id, lane, job.semantic_score]
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
    client.release();
    await pool.end();
  }

  console.log(`Evaluation Budgeter complete. Queued: ${queuedCount}, Deferred: ${deferredCount}`);
  return { queued: queuedCount, deferred: deferredCount };
}

export const runBudgeter = runEvaluationBudgeter;
