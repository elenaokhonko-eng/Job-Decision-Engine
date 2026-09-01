import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";
import { generateContentHash } from "../services/criteria.js";

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
  
  // Explicit linkage is authoritative; hash-only inference strands duplicate observations.
  const query = `
    SELECT obs.* 
    FROM raw_job_observations obs
    WHERE obs.job_version_id IS NULL
      AND COALESCE(obs.processing_status, 'PENDING') = 'PENDING'
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
        // Raw payload hashes preserve source fidelity; normalized content hashes define JD versions.
        const normalizedContentHash = generateContentHash(
          obs.company_name,
          obs.title,
          obs.description_raw
        );
        let canonicalJobId: string | null = null;
        let isExistingJob = false;
        
        // Identity precedence: source/requisition ID, canonical URL, company+title+location,
        // then company+title only as a deliberately low-confidence fallback.
        const checkExt = await client.query(
          `SELECT jv.canonical_job_id, jv.id AS job_version_id
           FROM raw_job_observations rjo
           JOIN job_versions jv ON jv.id = rjo.job_version_id
           WHERE rjo.source_name = $1
             AND rjo.source_external_id = $2
           ORDER BY rjo.retrieved_at DESC
           LIMIT 1`,
          [obs.source_name, obs.source_external_id]
        );

        let existingVersionId: string | null = null;
        
        if (checkExt.rows.length > 0) {
          canonicalJobId = checkExt.rows[0].canonical_job_id;
          isExistingJob = true;
        } else {
          const checkUrl = await client.query(
            `SELECT id FROM canonical_jobs
             WHERE canonical_url = $1
             LIMIT 1`,
            [obs.canonical_apply_url || obs.source_url]
          );
          if (checkUrl.rows.length > 0) {
            canonicalJobId = checkUrl.rows[0].id;
            isExistingJob = true;
          } else {
            const checkTitleLocation = await client.query(
              `SELECT id FROM canonical_jobs
               WHERE company_name = $1
                 AND normalized_title = $2
                 AND COALESCE(location, location_summary, 'Unknown') = $3
               LIMIT 1`,
              [obs.company_name, obs.title.toLowerCase(), obs.location_raw || "Unknown"]
            );
            if (checkTitleLocation.rows.length > 0) {
              canonicalJobId = checkTitleLocation.rows[0].id;
              isExistingJob = true;
            }
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
        
        // A content hash duplicate is a new source observation, not a new version.
        if (!existingVersionId) {
          const existingVersion = await client.query(
            `SELECT id
             FROM job_versions
             WHERE canonical_job_id = $1 AND content_hash = $2
             LIMIT 1`,
            [canonicalJobId, normalizedContentHash]
          );
          existingVersionId = existingVersion.rows[0]?.id || null;
        }

        let resolvedVersionId = existingVersionId;
        let createdNewVersion = false;
        if (!resolvedVersionId) {
          const verInsert = await client.query(
            `INSERT INTO job_versions (canonical_job_id, content_hash, description_text, observed_at)
             VALUES ($1, $2, $3, NOW()) RETURNING id`,
            [canonicalJobId, normalizedContentHash, obs.description_raw]
          );
          resolvedVersionId = verInsert.rows[0].id;
          createdNewVersion = true;
        }

        if (createdNewVersion) {
          // Preserve established facts when later source data is explicitly Unknown.
          await client.query(
            `UPDATE canonical_jobs
             SET latest_job_version_id = $1,
                 version_count = CASE
                   WHEN $2::boolean THEN COALESCE(version_count, 0) + 1
                   ELSE GREATEST(COALESCE(version_count, 0), 1)
                 END,
                 location = CASE WHEN NULLIF($3, 'Unknown') IS NULL THEN location ELSE $3 END,
                 workplace_type = CASE WHEN NULLIF($4, 'UNKNOWN') IS NULL THEN workplace_type ELSE $4 END,
                 employment_type = CASE WHEN NULLIF($5, 'UNKNOWN') IS NULL THEN employment_type ELSE $5 END,
                 processing_status = 'RAW_STAGED',
                 updated_at = NOW()
             WHERE id = $6`,
            [resolvedVersionId, isExistingJob, obs.location_raw || "Unknown", obs.workplace_type_raw || "UNKNOWN", obs.employment_type_raw || "UNKNOWN", canonicalJobId]
          );
        }

        // Every observation, including a duplicate, receives a durable version mapping.
        if (obs.id) {
          await client.query(
            `UPDATE raw_job_observations
             SET job_version_id = $1, processing_status = 'PROCESSED'
             WHERE id = $2`,
            [resolvedVersionId, obs.id]
          );
        }

        await client.query("COMMIT");
        summary.totalProcessed++;
        summary.details.push({
          observationId: obs.id,
          canonicalJobId: canonicalJobId || undefined,
          versionId: resolvedVersionId || undefined,
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
