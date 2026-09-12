import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { generateContentHash } from "../services/criteria.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { classifyDescriptionQuality, MIN_COMPLETE_DESCRIPTION_CHARS } from "./descriptionQuality.js";

dotenv.config();
dotenv.config({ path: ".env.local" });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

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
  options?: { context?: WorkspaceContext; observationIds?: string[]; limit?: number }
): Promise<NormalizationSummary> {
  console.log("Starting normalization of raw_job_observations...");
  const pool = clientOrPool || defaultPool;

  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

  // Explicit linkage is authoritative; hash-only inference strands duplicate observations.
  const params: unknown[] = [ctx.workspaceId];
  const observationIds = options?.observationIds?.filter(Boolean) ?? [];
  const observationFilter = observationIds.length > 0
    ? `AND obs.id = ANY($${params.push(observationIds)}::uuid[])`
    : "";
  const limit = Number.isInteger(options?.limit) && Number(options?.limit) > 0
    ? Number(options?.limit)
    : null;
  const limitClause = limit ? `LIMIT $${params.push(limit)}` : "";
  const query = `
    SELECT obs.*
    FROM raw_job_observations obs
    WHERE obs.workspace_id = $1
      AND obs.job_version_id IS NULL
      AND COALESCE(obs.processing_status, 'PENDING') = 'PENDING'
      ${observationFilter}
    ORDER BY obs.retrieved_at ASC, obs.id ASC
    ${limitClause}
  `;

  const { rows: pendingObservations } = await client.query(query, params);
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
          const descriptionQuality = classifyDescriptionQuality(obs.description_raw);
          const insertCanon = await client.query(
            `INSERT INTO canonical_jobs (
               workspace_id,
               company_name, normalized_title, canonical_url, location, 
               workplace_type, employment_type, processing_state, processing_status,
               description_quality_status, description_quality_reason, version_count
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1) RETURNING id`,
            [
              ctx.workspaceId,
              obs.company_name,
              obs.title.toLowerCase(),
              obs.source_url,
              obs.location_raw || "Unknown",
              obs.workplace_type_raw || "UNKNOWN",
              obs.employment_type_raw || "UNKNOWN",
              "RAW_STAGED",
              "RAW_STAGED",
              descriptionQuality.status,
              descriptionQuality.reason,
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
          const descriptionQuality = classifyDescriptionQuality(obs.description_raw);

          const existingJobState = await client.query<{
            latest_job_version_id: string | null;
            description_quality_status: string | null;
            existing_desc_len: number | null;
          }>(
            `SELECT c.latest_job_version_id,
                    c.description_quality_status,
                    LENGTH(COALESCE(jv.description_text, '')) AS existing_desc_len
             FROM canonical_jobs c
             LEFT JOIN job_versions jv
               ON jv.workspace_id = c.workspace_id
              AND jv.id = c.latest_job_version_id
             WHERE c.workspace_id = $1
               AND c.id = $2
             LIMIT 1`,
            [ctx.workspaceId, canonicalJobId]
          );

          const existingRow = existingJobState.rows[0];
          const hasExistingComplete =
            existingRow?.description_quality_status === 'COMPLETE' ||
            (existingRow?.existing_desc_len ?? 0) >= MIN_COMPLETE_DESCRIPTION_CHARS;
          const isNewVersionInferior = hasExistingComplete && descriptionQuality.status === 'INCOMPLETE';

          const versionToSetAsLatest =
            isNewVersionInferior && existingRow?.latest_job_version_id
              ? existingRow.latest_job_version_id
              : resolvedVersionId;
          const statusToSet = isNewVersionInferior
            ? 'COMPLETE'
            : descriptionQuality.status;
          const reasonToSet = isNewVersionInferior
            ? null
            : descriptionQuality.reason;

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
                 description_quality_status = $8,
                 description_quality_reason = $9,
                 processing_state = CASE
                   WHEN $10::boolean THEN processing_state
                   ELSE 'RAW_STAGED'
                 END,
                 processing_status = CASE
                   WHEN $10::boolean THEN processing_status
                   ELSE 'RAW_STAGED'
                 END,
                 updated_at = NOW()
             WHERE workspace_id = $6
               AND id = $7`,
            [
              versionToSetAsLatest,
              isExistingJob,
              obs.location_raw || "Unknown",
              obs.workplace_type_raw || "UNKNOWN",
              obs.employment_type_raw || "UNKNOWN",
              ctx.workspaceId,
              canonicalJobId,
              statusToSet,
              reasonToSet,
              isNewVersionInferior,
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
