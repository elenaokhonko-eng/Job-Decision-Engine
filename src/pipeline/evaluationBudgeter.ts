import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

export async function runEvaluationBudgeter() {
  console.log("Starting Evaluation Budgeter...");

  const query = `
    SELECT * FROM canonical_jobs 
    WHERE processing_status = 'SEMANTIC_SHORTLISTED'
  `;
  
  const { rows: jobs } = await pool.query(query);
  console.log(`Found ${jobs.length} jobs to budget for AI Evaluation.`);

  const jobsByLane: Record<string, typeof jobs> = {};
  for (const job of jobs) {
    if (!jobsByLane[job.primary_lane]) jobsByLane[job.primary_lane] = [];
    jobsByLane[job.primary_lane].push(job);
  }

  const client = await pool.connect();
  try {
    for (const lane of Object.keys(jobsByLane)) {
      // Sort by semantic score descending
      jobsByLane[lane].sort((a, b) => b.semantic_score - a.semantic_score);
      
      // Top 3 jobs per lane
      const top3 = jobsByLane[lane].slice(0, 3);
      console.log(`- ${lane}: Enqueueing top ${top3.length} of ${jobsByLane[lane].length} jobs.`);
      
      for (const job of top3) {
        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO evaluation_queue (canonical_job_id, lane, priority_score, status) 
             VALUES ($1, $2, $3, $4)`,
            [job.id, lane, job.semantic_score, "PENDING"]
          );
          
          await client.query(
            `UPDATE canonical_jobs SET processing_status = 'QUEUED_FOR_AI' WHERE id = $1`,
            [job.id]
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`❌ Failed to budget job ${job.id}:`, err);
        }
      }
      
      // The rest are rejected due to budget cap
      const skipped = jobsByLane[lane].slice(3);
      for (const job of skipped) {
        await client.query("BEGIN");
        try {
          await client.query(
            `UPDATE canonical_jobs SET processing_status = 'REJECTED_AFTER_EVALUATION', rejection_reason = 'BUDGET_CAP' WHERE id = $1`,
            [job.id]
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`❌ Failed to reject budgeted job ${job.id}:`, err);
        }
      }
    }
  } finally {
    client.release();
  }

  console.log(`Evaluation Budgeter complete.`);
}
