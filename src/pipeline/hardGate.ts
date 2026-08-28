import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { applyGlobalGates } from "../services/criteria.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

export async function runHardGates(): Promise<{ passed: number; hardRejected: number; needsVerification: number }> {
  console.log("Starting Hard Gate engine on RAW_STAGED canonical jobs...");
  
  const query = `
    SELECT c.*, jv.description_text 
    FROM canonical_jobs c
    JOIN job_versions jv ON jv.canonical_job_id = c.id
    WHERE c.processing_status = 'RAW_STAGED'
  `;
  
  const { rows: stagedJobs } = await pool.query(query);
  console.log(`Found ${stagedJobs.length} canonical jobs to gate.`);
  
  let passedCount = 0;
  let rejectedCount = 0;
  let needsVerificationCount = 0;

  const client = await pool.connect();
  try {
    for (const job of stagedJobs) {
      await client.query("BEGIN");
      try {
        // Map canonical job to RawJob interface expected by applyGlobalGates
        const rawJobAdapter = {
          id: job.id,
          title: job.normalized_title,
          company_name: job.company_name,
          source: "canonical",
          raw_description: job.description_text,
          careers_portal_url: job.canonical_url
        };
        
        const gateResult = applyGlobalGates(rawJobAdapter);
        
        let gateDecision = gateResult.status || (gateResult.passed ? "PASS" : "HARD_REJECT");
        let processingStatus = "PREQUALIFIED";
        
        if (gateDecision === "HARD_REJECT" || !gateResult.passed) {
          gateDecision = "HARD_REJECT";
          processingStatus = "HARD_REJECTED";
          rejectedCount++;
        } else if (gateDecision === "NEEDS_VERIFICATION") {
          processingStatus = "NEEDS_VERIFICATION";
          needsVerificationCount++;
        } else {
          gateDecision = "PASS";
          processingStatus = "PREQUALIFIED";
          passedCount++;
        }
        
        await client.query(
          `UPDATE canonical_jobs 
           SET gate_decision = $1, processing_status = $2, rejection_reason = $3, updated_at = NOW()
           WHERE id = $4`,
          [gateDecision, processingStatus, gateResult.rejection_code || null, job.id]
        );
        
        await client.query("COMMIT");
        console.log(`-> ${job.company_name} - ${job.normalized_title} : ${gateDecision} (${gateResult.rejection_code || 'N/A'})`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`❌ Failed to gate job ${job.id}:`, err);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
  
  console.log(`Hard Gates complete. Passed: ${passedCount}, Hard Rejected: ${rejectedCount}, Needs Verification: ${needsVerificationCount}`);
  return { passed: passedCount, hardRejected: rejectedCount, needsVerification: needsVerificationCount };
}
