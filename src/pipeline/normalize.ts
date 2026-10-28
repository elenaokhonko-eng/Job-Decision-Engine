import { db } from "../db/db.js";
import pg from "pg";
import dotenv from "dotenv";
import { pgPoolConfig } from "../db/pgSsl.js";
import { generateContentHash } from "../services/criteria.js";
import { resolveWorkspaceContext, type WorkspaceContext } from "../workspace/context.js";
import { classifyDescriptionQuality, MIN_COMPLETE_DESCRIPTION_CHARS } from "./descriptionQuality.js";
import { buildEvidenceRevisionHash } from "../ingestion/jobSourceEvidence.js";
import { extractFreshnessEvidence } from "../ingestion/freshnessEvidence.js";
import { JobSourceEvidenceSchema, type JobSourceEvidence } from "../contracts/jobSourceEvidence.js";
import { assessJobArchiveAge, referenceIsOlderThanCutoff, subtractCalendarMonths } from "../services/jobArchivePolicy.js";
import { reactivateGenuineRepost } from "../services/jobArchive.js";

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
        const freshnessEvidence = extractFreshnessEvidence({
          rawPayload: obs.raw_payload,
          sourceName: String(obs.source_name || ''),
          sourceExternalId: typeof obs.source_external_id === 'string' ? obs.source_external_id : null,
          canonicalUrl: typeof (obs.canonical_apply_url || obs.source_url) === 'string'
            ? String(obs.canonical_apply_url || obs.source_url)
            : null,
          contentHash: normalizedContentHash,
        });
        let normalizedEvidence: JobSourceEvidence | null = null;
        if (obs.normalized_evidence !== null && obs.normalized_evidence !== undefined) {
          let evidencePayload: unknown = obs.normalized_evidence;
          if (typeof evidencePayload === "string") {
            try {
              evidencePayload = JSON.parse(evidencePayload) as unknown;
            } catch {
              evidencePayload = null;
            }
          }
          const evidenceResult = JobSourceEvidenceSchema.safeParse(evidencePayload);
          if (evidenceResult.success && evidenceResult.data.raw_payload_hash === obs.raw_payload_hash) {
            normalizedEvidence = evidenceResult.data;
          } else {
            const evidenceError = evidenceResult.success
              ? "Normalized source evidence raw payload hash does not match its observation."
              : evidenceResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
            await client.query(
              `UPDATE raw_job_observations
               SET error_history = COALESCE(error_history, '[]'::jsonb) || jsonb_build_array($1::jsonb)
               WHERE workspace_id = $2 AND id = $3`,
              [JSON.stringify({ stage: "NORMALIZED_SOURCE_EVIDENCE", error: evidenceError, occurred_at: obs.retrieved_at }), ctx.workspaceId, obs.id],
            );
            console.warn(`Normalized source evidence is invalid for observation ${obs.id}; continuing with unknown evidence.`);
          }
        }
        const normalizationStartedAt = new Date();
        const incomingAgeAssessment = assessJobArchiveAge([{
          job_version_id: "incoming-observation",
          source_posting_identity_hash: freshnessEvidence.postingIdentityHash,
          source_published_at: freshnessEvidence.sourcePublishedAt,
          reposted_at: freshnessEvidence.repostedAt,
          first_seen_at: obs.retrieved_at,
          observation_first_seen_at: obs.retrieved_at,
          date_evidence: normalizedEvidence,
        }], freshnessEvidence.postingIdentityHash, normalizationStartedAt);
        let incomingSourcePublishedAt: string | null = null;
        if (incomingAgeAssessment.status === "REFERENCE_FOUND" &&
            (incomingAgeAssessment.ageBasis === "AUTHORITATIVE_PUBLICATION_DATE" ||
              incomingAgeAssessment.ageBasis === "GENUINE_REPOST_DATE")) {
          incomingSourcePublishedAt = normalizedEvidence?.dates.published_at.status === "SUPPORTED"
            ? normalizedEvidence.dates.published_at.value
            : freshnessEvidence.sourcePublishedAt;
        }
        const incomingRepostedAt = incomingAgeAssessment.status === "REFERENCE_FOUND" &&
          incomingAgeAssessment.ageBasis === "GENUINE_REPOST_DATE"
          ? incomingAgeAssessment.referenceAt.toISOString()
          : null;
        const evidenceRevisionHash = normalizedEvidence ? buildEvidenceRevisionHash(normalizedEvidence) : null;
        let canonicalJobId: string | null = null;
        let isExistingJob = false;
        let existingVersionId: string | null = null;
        let sourcePostingIdentitySeen = false;
        
        // Stable source identity is accepted only when normalized employer and location also agree.
        const checkExt = freshnessEvidence.postingIdentityHash
          ? await client.query(
              `SELECT version.canonical_job_id, version.id AS job_version_id, version.content_hash
               FROM job_versions version
               JOIN canonical_jobs canonical
                 ON canonical.workspace_id = version.workspace_id
                AND canonical.id = version.canonical_job_id
               WHERE version.workspace_id = $1
                 AND (
                   version.source_posting_identity_hash = $2
                   OR EXISTS (
                     SELECT 1
                     FROM raw_job_observations observation
                     WHERE observation.workspace_id = version.workspace_id
                       AND observation.job_version_id = version.id
                       AND observation.source_name = $3
                       AND observation.source_external_id = $4
                   )
                 )
                 AND BTRIM(regexp_replace(lower(canonical.company_name), '[^a-z0-9]+', ' ', 'g'))
                   = BTRIM(regexp_replace(lower($5), '[^a-z0-9]+', ' ', 'g'))
                 AND BTRIM(regexp_replace(lower(COALESCE(canonical.location, canonical.location_summary, 'Unknown')), '[^a-z0-9]+', ' ', 'g'))
                   = BTRIM(regexp_replace(lower(COALESCE($6, 'Unknown')), '[^a-z0-9]+', ' ', 'g'))
               ORDER BY version.observed_at DESC, version.id DESC
               LIMIT 1`,
              [ctx.workspaceId, freshnessEvidence.postingIdentityHash, obs.source_name, obs.source_external_id, obs.company_name, obs.location_raw || "Unknown"]
            )
          : { rows: [] };

        // Identity precedence: source/requisition identity, canonical URL, company+title+location,
        // then company+title only as a deliberately low-confidence fallback.

        if (checkExt.rows.length > 0) {
          canonicalJobId = checkExt.rows[0].canonical_job_id;
          isExistingJob = true;
          sourcePostingIdentitySeen = true;
          if (checkExt.rows[0].content_hash === normalizedContentHash) {
            existingVersionId = checkExt.rows[0].job_version_id;
          }
        } else {
          const checkUrl = await client.query(
            `SELECT id FROM canonical_jobs
             WHERE workspace_id = $1
               AND canonical_url = $2
               AND BTRIM(regexp_replace(lower(company_name), '[^a-z0-9]+', ' ', 'g'))
                 = BTRIM(regexp_replace(lower($3), '[^a-z0-9]+', ' ', 'g'))
               AND BTRIM(regexp_replace(lower(COALESCE(location, location_summary, 'Unknown')), '[^a-z0-9]+', ' ', 'g'))
                 = BTRIM(regexp_replace(lower(COALESCE($4, 'Unknown')), '[^a-z0-9]+', ' ', 'g'))
             LIMIT 1`,
            [ctx.workspaceId, obs.canonical_apply_url || obs.source_url, obs.company_name, obs.location_raw || "Unknown"]
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
        if (canonicalJobId === null) throw new Error("Normalization did not resolve a canonical job identity.");
        const archiveStateResult = await client.query<{
          archived_at: Date | null;
          archive_reference_at: Date | null;
        }>(
          `SELECT archived_at, archive_reference_at
           FROM canonical_jobs
           WHERE workspace_id = $1 AND id = $2
           FOR UPDATE`,
          [ctx.workspaceId, canonicalJobId],
        );
        const archiveState = archiveStateResult.rows[0];
        if (!archiveState) throw new Error(`Canonical job ${canonicalJobId} disappeared during normalization.`);

        // A repeated source posting identity reuses its version; a verified new posting
        // identity can create a new version even when the description content hash is equal.
        if (!existingVersionId) {
          const existingVersion = freshnessEvidence.postingIdentityHash
            ? await client.query(
                `SELECT id
                 FROM job_versions
                 WHERE workspace_id = $1
                   AND canonical_job_id = $2
                   AND source_posting_identity_hash = $3
                   AND content_hash = $4
                 ORDER BY observed_at DESC, id DESC
                 LIMIT 1`,
                [ctx.workspaceId, canonicalJobId, freshnessEvidence.postingIdentityHash, normalizedContentHash]
              )
            : await client.query(
                `SELECT id
                 FROM job_versions
                 WHERE workspace_id = $1
                   AND canonical_job_id = $2
                   AND content_hash = $3
                   AND source_posting_identity_hash IS NULL
                 LIMIT 1`,
                [ctx.workspaceId, canonicalJobId, normalizedContentHash]
              );
          existingVersionId = existingVersion.rows[0]?.id || null;
        }

        const newSourcePostingIdentity =
          isExistingJob &&
          !sourcePostingIdentitySeen &&
          !existingVersionId &&
          typeof obs.source_external_id === 'string' &&
          obs.source_external_id.trim().length > 0;
        let effectiveFreshnessBasis: 'REPOSTED_AT' | 'POSTED_AT' | 'NEW_POSTING_ID' | null = null;
        if (incomingRepostedAt !== null) {
          effectiveFreshnessBasis = 'REPOSTED_AT';
        } else if (incomingSourcePublishedAt !== null) {
          effectiveFreshnessBasis = 'POSTED_AT';
        } else if (newSourcePostingIdentity) {
          effectiveFreshnessBasis = 'NEW_POSTING_ID';
        }
        const effectiveFreshnessConfidence = effectiveFreshnessBasis === 'NEW_POSTING_ID'
          ? 75
          : effectiveFreshnessBasis === null
            ? null
            : 100;

        let resolvedVersionId = existingVersionId;
        let createdNewVersion = false;
        if (!resolvedVersionId) {
          const verInsert = await client.query<{ id: string }>(
            `INSERT INTO job_versions (
               workspace_id, canonical_job_id, content_hash, description_text, observed_at,
               source_published_at, source_updated_at, source_expires_at, reposted_at,
               source_posting_identity_hash, first_seen_at, last_seen_at,
               freshness_basis, freshness_confidence,
               availability_status, availability_evidence, availability_verified_at,
               availability_recheck_at, evidence_revision_hash
             ) VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8, $9, $10, $10, $11, $12, $13, $14, $15, $16, $17)
             RETURNING id`,
            [
              ctx.workspaceId,
              canonicalJobId,
              normalizedContentHash,
              obs.description_raw,
              incomingSourcePublishedAt,
              freshnessEvidence.sourceUpdatedAt,
              freshnessEvidence.sourceExpiresAt,
              incomingRepostedAt,
              freshnessEvidence.postingIdentityHash,
              obs.retrieved_at,
              effectiveFreshnessBasis,
              effectiveFreshnessConfidence,
              normalizedEvidence?.availability.status ?? null,
              normalizedEvidence ? JSON.stringify(normalizedEvidence.availability) : null,
              normalizedEvidence?.availability.verified_at ?? null,
              normalizedEvidence?.availability.expires_at ?? null,
              evidenceRevisionHash,
            ]
          );
          resolvedVersionId = verInsert.rows[0].id;
          createdNewVersion = true;
        } else {
          await client.query(
            `UPDATE job_versions
             SET first_seen_at = COALESCE(first_seen_at, $1),
                 last_seen_at = GREATEST(COALESCE(last_seen_at, $1), $1),
                 source_published_at = COALESCE(source_published_at, $2),
                 source_updated_at = CASE
                   WHEN $3::timestamptz IS NULL THEN source_updated_at
                   WHEN source_updated_at IS NULL OR source_updated_at < $3::timestamptz THEN $3::timestamptz
                   ELSE source_updated_at
                 END,
                 source_expires_at = COALESCE(source_expires_at, $4),
                 reposted_at = CASE
                   WHEN $5::timestamptz IS NULL THEN reposted_at
                   WHEN reposted_at IS NULL OR reposted_at < $5::timestamptz THEN $5::timestamptz
                   ELSE reposted_at
                 END,
                 freshness_basis = CASE
                   WHEN $6::text = 'REPOSTED_AT' THEN 'REPOSTED_AT'
                   WHEN freshness_basis IS NULL THEN $6
                   ELSE freshness_basis
                 END,
                 freshness_confidence = CASE
                   WHEN $6::text = 'REPOSTED_AT' THEN $7
                   WHEN freshness_confidence IS NULL THEN $7
                   ELSE freshness_confidence
                 END,
                 source_posting_identity_hash = COALESCE(source_posting_identity_hash, $8),
                 availability_status = CASE
                   WHEN $11::text IN ('OPEN', 'CLOSED')
                     AND (availability_verified_at IS NULL OR $13::timestamptz >= availability_verified_at) THEN $11
                   WHEN availability_status IS NULL THEN $11
                   ELSE availability_status
                 END,
                 availability_evidence = CASE
                   WHEN $12::jsonb IS NULL THEN availability_evidence
                   WHEN $11::text IN ('OPEN', 'CLOSED')
                     AND (availability_verified_at IS NULL OR $13::timestamptz >= availability_verified_at) THEN $12::jsonb
                   WHEN availability_evidence IS NULL THEN $12::jsonb
                   ELSE availability_evidence
                 END,
                 availability_verified_at = CASE
                   WHEN $11::text IN ('OPEN', 'CLOSED')
                     AND (availability_verified_at IS NULL OR $13::timestamptz >= availability_verified_at) THEN $13
                   ELSE availability_verified_at
                 END,
                 availability_recheck_at = CASE
                   WHEN $11::text IN ('OPEN', 'CLOSED')
                     AND (availability_verified_at IS NULL OR $13::timestamptz >= availability_verified_at) THEN $14
                   ELSE availability_recheck_at
                 END,
                 evidence_revision_hash = COALESCE($15, evidence_revision_hash)
             WHERE workspace_id = $9 AND id = $10`,
            [
              obs.retrieved_at,
              incomingSourcePublishedAt,
              freshnessEvidence.sourceUpdatedAt,
              freshnessEvidence.sourceExpiresAt,
              incomingRepostedAt,
              effectiveFreshnessBasis,
              effectiveFreshnessConfidence,
              freshnessEvidence.postingIdentityHash,
              ctx.workspaceId,
              resolvedVersionId,
              normalizedEvidence?.availability.status ?? null,
              normalizedEvidence ? JSON.stringify(normalizedEvidence.availability) : null,
              normalizedEvidence?.availability.verified_at ?? null,
              normalizedEvidence?.availability.expires_at ?? null,
              evidenceRevisionHash,
            ]
          );
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

        let reactivationDate: Date | null = null;
        let reactivationEvidenceType: "GENUINE_REPOST_DATE" | "NEW_POSTING_IDENTITY" | null = null;
        if (incomingRepostedAt !== null) {
          reactivationDate = new Date(incomingRepostedAt);
          reactivationEvidenceType = "GENUINE_REPOST_DATE";
        } else if (
          newSourcePostingIdentity &&
          incomingAgeAssessment.status === "REFERENCE_FOUND" &&
          !referenceIsOlderThanCutoff(
            incomingAgeAssessment.referenceAt,
            subtractCalendarMonths(normalizationStartedAt, 3),
          )
        ) {
          reactivationDate = incomingAgeAssessment.referenceAt;
          reactivationEvidenceType = "NEW_POSTING_IDENTITY";
        }
        if (archiveState.archived_at !== null && reactivationDate !== null && reactivationEvidenceType !== null) {
          const currentVersion = await client.query<{ latest_job_version_id: string | null }>(
            `SELECT latest_job_version_id::text
             FROM canonical_jobs
             WHERE workspace_id = $1 AND id = $2`,
            [ctx.workspaceId, canonicalJobId],
          );
          if (currentVersion.rows[0]?.latest_job_version_id === resolvedVersionId) {
            await reactivateGenuineRepost(client, {
              workspaceId: ctx.workspaceId,
              canonicalJobId,
              actor: "system:source-normalizer",
              repostedAt: reactivationDate,
              repostEvidenceHash: evidenceRevisionHash ?? freshnessEvidence.postingIdentityHash ?? String(obs.raw_payload_hash),
              evidenceType: reactivationEvidenceType,
            });
          }
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
