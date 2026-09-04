import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgSslConfig } from "../db/pgSsl.js";
import { generateContentHash } from "../services/criteria.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";

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

export async function runNormalization(
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<NormalizationSummary> {
  console.log("Starting normalization of raw_job_observations...");
  const pool = clientOrPool || defaultPool;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

  // Explicit linkage is authoritative; hash-only inference strands duplicate observations.
  const query = `
    SELECT obs.*
    FROM raw_job_observations obs
    WHERE obs.workspace_id = $1
      AND obs.job_version_id IS NULL
      AND COALESCE(obs.processing_status, 'PENDING') = 'PENDING'
  `;

  const { rows: pendingObservations } = await client.query(query, [ctx.workspaceId]);
  console.log(`Found ${pendingObservations.length} pending observations.`);

  const summary: NormalizationSummary = {
    totalDiscovered: pendingObservations.length,
    totalProcessed: 0,
    totalErrors: 0,
    details: []
  };
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
           WHERE rjo.workspace_id = $1
             AND jv.workspace_id = $1
             AND rjo.source_name = $2
             AND rjo.source_external_id = $3
           ORDER BY rjo.retrieved_at DESC
           LIMIT 1`,
          [ctx.workspaceId, obs.source_name, obs.source_external_id]
        );

        let existingVersionId: string | null = null;
        
        if (checkExt.rows.length > 0) {
          canonicalJobId = checkExt.rows[0].canonical_job_id;
          isExistingJob = true;
        } else {
          const checkUrl = await client.query(
            `SELECT id FROM canonical_jobs
             WHERE workspace_id = $1
               AND canonical_url = $2
             LIMIT 1`,
            [ctx.workspaceId, obs.canonical_apply_url || obs.source_url]
          );
          if (checkUrl.rows.length > 0) {
            canonicalJobId = checkUrl.rows[0].id;
            isExistingJob = true;
          } else {
            const checkTitleLocation = await client.query(
              `SELECT id FROM canonical_jobs
               WHERE workspace_id = $1
                 AND company_name = $2
                 AND normalized_title = $3
                 AND COALESCE(location, location_summary, 'Unknown') = $4
               LIMIT 1`,
              [ctx.workspaceId, obs.company_name, obs.title.toLowerCase(), obs.location_raw || "Unknown"]
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
               workspace_id,
               company_name, normalized_title, canonical_url, location, 
               workplace_type, employment_type, processing_state, processing_status, version_count
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1) RETURNING id`,
            [
              ctx.workspaceId,
              obs.company_name,
              obs.title.toLowerCase(),
              obs.source_url,
              obs.location_raw || "Unknown",
              obs.workplace_type_raw || "UNKNOWN",
              obs.employment_type_raw || "UNKNOWN",
              "RAW_STAGED",
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
             WHERE workspace_id = $1
               AND canonical_job_id = $2
               AND content_hash = $3
             LIMIT 1`,
            [ctx.workspaceId, canonicalJobId, normalizedContentHash]
          );
          existingVersionId = existingVersion.rows[0]?.id || null;
        }

        let resolvedVersionId = existingVersionId;
        let createdNewVersion = false;
        if (!resolvedVersionId) {
          const verInsert = await client.query(
            `INSERT INTO job_versions (workspace_id, canonical_job_id, content_hash, description_text, observed_at)
             VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
            [ctx.workspaceId, canonicalJobId, normalizedContentHash, obs.description_raw]
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
                 processing_state = 'RAW_STAGED',
                 processing_status = 'RAW_STAGED',
                 updated_at = NOW()
             WHERE workspace_id = $6
               AND id = $7`,
            [
              resolvedVersionId,
              isExistingJob,
              obs.location_raw || "Unknown",
              obs.workplace_type_raw || "UNKNOWN",
              obs.employment_type_raw || "UNKNOWN",
              ctx.workspaceId,
              canonicalJobId,
            ]
          );
        }

        // Every observation, including a duplicate, receives a durable version mapping.
        if (obs.id) {
          await client.query(
            `UPDATE raw_job_observations
             SET job_version_id = $1, processing_status = 'PROCESSED'
             WHERE workspace_id = $2 AND id = $3`,
            [resolvedVersionId, ctx.workspaceId, obs.id]
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
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
  
  console.log(`Normalization complete. Processed: ${summary.totalProcessed}, Errors: ${summary.totalErrors}`);
  return summary;
}
