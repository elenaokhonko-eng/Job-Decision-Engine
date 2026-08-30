import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL)
});

export interface NormalizationSummary {
  totalDiscovered: number;
  totalProcessed: number;
  totalErrors: number;
  details: Array<{
    observationId: string;
    canonicalJobId?: string;
    versionId?: string;
    isNewJob: boolean;
    error?: string;
  }>;
}

export async function runNormalization(clientOrPool?: pg.Pool | pg.PoolClient): Promise<NormalizationSummary> {
  console.log("Starting normalization of raw_job_observations...");
  const pool = clientOrPool || defaultPool;
  
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
  
  const summary: NormalizationSummary = {
    totalDiscovered: pendingObservations.length,
    totalProcessed: 0,
    totalErrors: 0,
    details: []
  };

  const client = 'connect' in pool ? await pool.connect() : pool;
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
               workplace_type, employment_type, processing_status, version_count
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 1) RETURNING id`,
            [
              obs.company_name,
              obs.title.toLowerCase(),
              obs.source_url,
              obs.location_raw || "Unknown",
              obs.workplace_type_raw || "UNKNOWN",
              obs.employment_type_raw || "UNKNOWN",
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
               version_count = CASE WHEN $2::boolean THEN COALESCE(version_count, 0) + 1 ELSE COALESCE(version_count, 1) END,
               location = COALESCE($3, location),
               workplace_type = COALESCE($4, workplace_type),
               employment_type = COALESCE($5, employment_type),
               processing_status = 'RAW_STAGED',
               updated_at = NOW()
           WHERE id = $6`,
          [
            newVersionId,
            isExistingJob,
            obs.location_raw || "Unknown",
            obs.workplace_type_raw || "UNKNOWN",
            obs.employment_type_raw || "UNKNOWN",
            canonicalJobId
          ]
        );

        // Mark observation as PROCESSED
        if (obs.id) {
          await client.query(
            `UPDATE raw_job_observations SET processing_status = 'PROCESSED' WHERE id = $1`,
            [obs.id]
          );
        }

        await client.query("COMMIT");
        summary.totalProcessed++;
        summary.details.push({
          observationId: obs.id,
          canonicalJobId: canonicalJobId || undefined,
          versionId: newVersionId || undefined,
          isNewJob: !isExistingJob
        });
      } catch (err: any) {
        await client.query("ROLLBACK");
        console.error(`❌ Failed to normalize observation ${obs.id}:`, err);
        summary.totalErrors++;
        summary.details.push({
          observationId: obs.id,
          isNewJob: false,
          error: err.message || String(err)
        });
      }
    }
  } finally {
    if ('release' in client && typeof client.release === 'function') {
      client.release();
    }
  }
  
  console.log(`Normalization complete. Processed: ${summary.totalProcessed}, Errors: ${summary.totalErrors}`);
  return summary;
}
