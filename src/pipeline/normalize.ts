import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

export async function runNormalization() {
  console.log("Starting normalization of raw_job_observations...");
  
  // Find observations that have not been canonicalized yet
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
        let isExistingJob = false;
        
        // Check if we have seen this external ID before
        const checkExt = await client.query(
          `SELECT canonical_job_id FROM job_versions jv 
           JOIN raw_job_observations rjo ON jv.content_hash = rjo.raw_payload_hash
           WHERE rjo.source_name = $1 AND rjo.source_external_id = $2 LIMIT 1`,
          [obs.source_name, obs.source_external_id]
        );
        
        if (checkExt.rows.length > 0) {
          canonicalJobId = checkExt.rows[0].canonical_job_id;
          isExistingJob = true;
        } else {
          // Check title + company
          const checkTitle = await client.query(
            `SELECT id FROM canonical_jobs WHERE company_name = $1 AND normalized_title = $2 LIMIT 1`,
            [obs.company_name, obs.title.toLowerCase()]
          );
          if (checkTitle.rows.length > 0) {
            canonicalJobId = checkTitle.rows[0].id;
            isExistingJob = true;
          }
        }
        
        if (!canonicalJobId) {
          // Create new canonical job
          const insertCanon = await client.query(
            `INSERT INTO canonical_jobs (
               company_name, normalized_title, canonical_url, location, 
               workplace_type, employment_type, processing_status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [
              obs.company_name,
              obs.title.toLowerCase(),
              obs.source_url,
              obs.location_raw || "Singapore",
              obs.workplace_type_raw || "UNKNOWN",
              obs.employment_type_raw || "PERMANENT",
              "RAW_STAGED"
            ]
          );
          canonicalJobId = insertCanon.rows[0].id;
        }
        
        // Create new job version
        const verInsert = await client.query(
          `INSERT INTO job_versions (canonical_job_id, content_hash, description_text, observed_at) 
           VALUES ($1, $2, $3, NOW()) RETURNING id`,
          [canonicalJobId, obs.raw_payload_hash, obs.description_raw]
        );
        const newVersionId = verInsert.rows[0].id;

        // Transactionally update canonical job with latest version pointer and reset status for reevaluation
        await client.query(
          `UPDATE canonical_jobs 
           SET latest_job_version_id = $1,
               version_count = COALESCE(version_count, 0) + 1,
               location = COALESCE($2, location),
               workplace_type = COALESCE($3, workplace_type),
               employment_type = COALESCE($4, employment_type),
               processing_status = 'RAW_STAGED',
               updated_at = NOW()
           WHERE id = $5`,
          [
            newVersionId,
            obs.location_raw || "Singapore",
            obs.workplace_type_raw || "UNKNOWN",
            obs.employment_type_raw || "PERMANENT",
            canonicalJobId
          ]
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
