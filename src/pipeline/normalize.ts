import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && (process.env.DATABASE_URL.includes("localhost") || process.env.DATABASE_URL.includes("127.0.0.1")) ? false : { rejectUnauthorized: false }
});

export async function runNormalization() {
  console.log("Starting normalization of raw_job_observations...");
  
  // Find observations that have not been canonicalized yet
  // For simplicity in Stage 0, we'll assume any observation without a matching payload hash in job_versions is new.
  // In a real system, we'd add a processed flag to raw_job_observations. We will add a processed flag to the query via NOT EXISTS.
  
  const query = `
    SELECT obs.* 
    FROM raw_job_observations obs
    WHERE NOT EXISTS (
      SELECT 1 FROM job_versions jv WHERE jv.content_hash = obs.raw_payload_hash
    )
  `;
  
  const { rows: pendingObservations } = await pool.query(query);
  console.log(`Found ${pendingObservations.length} pending observations.`);
  
  const client = await pool.connect();
  try {
    for (const obs of pendingObservations) {
      await client.query("BEGIN");
      try {
        let canonicalJobId: string | null = null;
        
        // Check if we have seen this external ID before
        const checkExt = await client.query(
          `SELECT canonical_job_id FROM job_versions jv 
           JOIN raw_job_observations rjo ON jv.content_hash = rjo.raw_payload_hash
           WHERE rjo.source_name = $1 AND rjo.source_external_id = $2 LIMIT 1`,
          [obs.source_name, obs.source_external_id]
        );
        
        if (checkExt.rows.length > 0) {
          canonicalJobId = checkExt.rows[0].canonical_job_id;
        } else {
          // Check title + company
          const checkTitle = await client.query(
            `SELECT id FROM canonical_jobs WHERE company_name = $1 AND normalized_title = $2 LIMIT 1`,
            [obs.company_name, obs.title.toLowerCase()]
          );
          if (checkTitle.rows.length > 0) {
            canonicalJobId = checkTitle.rows[0].id;
          }
        }
        
        if (!canonicalJobId) {
          // Create new canonical job
          const insertCanon = await client.query(
            `INSERT INTO canonical_jobs (company_name, normalized_title, canonical_url, processing_status) 
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [obs.company_name, obs.title.toLowerCase(), obs.source_url, "RAW_STAGED"]
          );
          canonicalJobId = insertCanon.rows[0].id;
        }
        
        // Create new job version
        await client.query(
          `INSERT INTO job_versions (canonical_job_id, content_hash, description_text) 
           VALUES ($1, $2, $3)`,
          [canonicalJobId, obs.raw_payload_hash, obs.description_raw]
        );

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`❌ Failed to normalize observation ${obs.id}:`, err);
      }
    }
  } finally {
    client.release();
  }
  
  console.log(`Normalization complete.`);
}
