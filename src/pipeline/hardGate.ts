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

export async function runHardGates() {
  console.log("Starting Hard Gate engine on RAW_STAGED canonical jobs...");
  
  const query = `
    SELECT c.*, jv.description_text 
    FROM canonical_jobs c
    JOIN job_versions jv ON jv.canonical_job_id = c.id
    WHERE c.processing_status = 'RAW_STAGED'
  `;
  
  const { rows: stagedJobs } = await pool.query(query);
  console.log(`Found ${stagedJobs.length} canonical jobs to gate.`);
  
  for (const job of stagedJobs) {
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
    
    let gateDecision = "PASS";
    let status = "PREQUALIFIED";
    
    if (!gateResult.passed) {
      gateDecision = "FAIL";
      status = "HARD_REJECTED";
    }
    
    await pool.query(
      `UPDATE canonical_jobs 
       SET gate_decision = $1, processing_status = $2, rejection_reason = $3
       WHERE id = $4`,
      [gateDecision, status, gateResult.rejection_code || null, job.id]
    );
    
    console.log(`-> ${job.company_name} - ${job.normalized_title} : ${gateDecision} (${gateResult.rejection_code || 'N/A'})`);
  }
  
  console.log(`Hard Gates complete.`);
}
