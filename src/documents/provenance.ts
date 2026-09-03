import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

export interface DocumentClaimInput {
  sectionLabel: string;
  claimText: string;
  profileFactIds: string[];
  requirementKeys?: string[];
}

export interface DocumentProvenanceInput {
  canonicalJobId: string;
  jobVersionId: string;
  matchRunId?: string | null;
  documentType: 'CV' | 'COVER_LETTER';
  policyVersion: string;
  generatorVersion: string;
  outputManifest: Record<string, unknown>;
  claims: DocumentClaimInput[];
}

export interface DocumentProvenanceResult {
  documentRunId: string;
  claimCount: number;
}

interface RequirementRow {
  id: string;
  requirement_key: string;
}

function uniqueStrings(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

function hashManifest(outputManifest: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(outputManifest)).digest('hex');
}

async function upsertDocumentReadyStage(
  client: { query: pg.PoolClient['query'] },
  canonicalJobId: string,
  jobVersionId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO job_version_pipeline_state (
       canonical_job_id,
       job_version_id,
       current_stage,
       stage_status,
       attempt_count,
       last_error,
       next_retry_at,
       updated_at
     )
     VALUES ($1, $2, 'DOCUMENT_READY', 'COMPLETED', 0, NULL, NULL, NOW())
     ON CONFLICT (job_version_id)
     DO UPDATE SET
       current_stage = EXCLUDED.current_stage,
       stage_status = EXCLUDED.stage_status,
       last_error = NULL,
       next_retry_at = NULL,
       updated_at = NOW()`,
    [canonicalJobId, jobVersionId]
  );

  await client.query(
    `INSERT INTO pipeline_stage_events (
       canonical_job_id,
       job_version_id,
       stage,
       transition_from,
       transition_to,
       event_type,
       error_message,
       payload
     )
     VALUES ($1, $2, 'DOCUMENT_READY', NULL, 'COMPLETED', 'STAGE_COMPLETED', NULL, $3)`,
    [canonicalJobId, jobVersionId, payload]
  );
}

export async function persistDocumentProvenance(
  input: DocumentProvenanceInput,
  clientOrPool?: pg.Pool | pg.PoolClient
): Promise<DocumentProvenanceResult> {
  const pool = clientOrPool || defaultPool;
  const client = 'connect' in pool ? await pool.connect() : pool;

  try {
    await client.query('BEGIN');

    const claimRows = input.claims.filter(
      (claim) => claim.claimText.trim().length > 0 && uniqueStrings(claim.profileFactIds).length > 0
    );

    const runRes = await client.query<{ id: string }>(
      `INSERT INTO document_runs (
         canonical_job_id,
         job_version_id,
         match_run_id,
         document_type,
         status,
         policy_version,
         generator_version,
         output_manifest,
         claim_count,
         error_message,
         completed_at
       )
       VALUES ($1, $2, $3, $4, 'COMPLETED', $5, $6, $7, $8, NULL, NOW())
       RETURNING id`,
      [
        input.canonicalJobId,
        input.jobVersionId,
        input.matchRunId || null,
        input.documentType,
        input.policyVersion,
        input.generatorVersion,
        {
          ...input.outputManifest,
          manifest_hash: hashManifest(input.outputManifest),
        },
        claimRows.length,
      ]
    );

    const documentRunId = runRes.rows[0].id;

    const allRequirementKeys = uniqueStrings(
      claimRows.flatMap((claim) => claim.requirementKeys || [])
    );
    const requirementMap = new Map<string, string>();

    if (allRequirementKeys.length > 0) {
      const reqRes = await client.query<RequirementRow>(
        `SELECT id, requirement_key
         FROM job_requirements
         WHERE job_version_id = $1
           AND requirement_key = ANY($2::text[])`,
        [input.jobVersionId, allRequirementKeys]
      );
      for (const row of reqRes.rows) {
        requirementMap.set(row.requirement_key, row.id);
      }
    }

    for (const claim of claimRows) {
      const requirementKeys = uniqueStrings(claim.requirementKeys);
      const requirementIds: string[] = [];
      const unresolvedKeys: string[] = [];

      for (const requirementKey of requirementKeys) {
        const requirementId = requirementMap.get(requirementKey);
        if (requirementId) {
          requirementIds.push(requirementId);
        } else {
          unresolvedKeys.push(requirementKey);
        }
      }

      await client.query(
        `INSERT INTO document_claims (
           document_run_id,
           section_label,
           claim_text,
           profile_fact_ids,
           requirement_ids,
           unresolved_requirement_keys
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          documentRunId,
          claim.sectionLabel,
          claim.claimText,
          uniqueStrings(claim.profileFactIds),
          requirementIds,
          unresolvedKeys,
        ]
      );
    }

    await upsertDocumentReadyStage(client, input.canonicalJobId, input.jobVersionId, {
      document_run_id: documentRunId,
      document_type: input.documentType,
      claim_count: claimRows.length,
      policy_version: input.policyVersion,
    });

    await client.query('COMMIT');

    return {
      documentRunId,
      claimCount: claimRows.length,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if ('release' in client && typeof client.release === 'function') {
      client.release();
    }
  }
}
