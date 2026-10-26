import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { pgPoolConfig } from '../db/pgSsl.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { validatePersistedDocumentCurrentness } from './provenanceCurrentness.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool(pgPoolConfig(process.env.DATABASE_URL));

export interface DocumentClaimInput {
  sectionLabel: string;
  claimText: string;
  profileFactIds: string[];
  requirementKeys?: string[];
}

export interface DocumentProvenanceInput {
  applicationRecordId?: string | null;
  canonicalJobId: string;
  jobVersionId: string;
  matchRunId?: string | null;
  profileVersionId?: string | null;
  deterministicDecisionId?: string | null;
  contextFingerprint?: string | null;
  documentType: 'CV' | 'COVER_LETTER';
  policyVersion: string;
  generatorVersion: string;
  modelRouteInvocationId?: string | null;
  documentTemplatePluginRevisionId?: string | null;
  documentTemplatePluginKey?: string | null;
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
  workspaceId: string,
  canonicalJobId: string,
  jobVersionId: string,
  payload: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO job_version_pipeline_state (
       workspace_id,
       canonical_job_id,
       job_version_id,
       current_stage,
       stage_status,
       attempt_count,
       last_error,
       next_retry_at,
       updated_at
     )
     VALUES ($1, $2, $3, 'DOCUMENT_READY', 'COMPLETED', 0, NULL, NULL, NOW())
     ON CONFLICT (job_version_id)
     DO UPDATE SET
       current_stage = EXCLUDED.current_stage,
       stage_status = EXCLUDED.stage_status,
       last_error = NULL,
       next_retry_at = NULL,
       updated_at = NOW()`,
    [workspaceId, canonicalJobId, jobVersionId]
  );

  await client.query(
    `INSERT INTO pipeline_stage_events (
       workspace_id,
       canonical_job_id,
       job_version_id,
       stage,
       transition_from,
       transition_to,
       event_type,
       error_message,
       payload
     )
     VALUES ($1, $2, $3, 'DOCUMENT_READY', NULL, 'COMPLETED', 'STAGE_COMPLETED', NULL, $4)`,
    [workspaceId, canonicalJobId, jobVersionId, payload]
  );
}

async function assertDocumentInputsInWorkspace(
  client: { query: pg.PoolClient['query'] },
  workspaceId: string,
  input: DocumentProvenanceInput
): Promise<void> {
  const canonicalOk = await client.query(
    `SELECT 1
     FROM canonical_jobs
     WHERE workspace_id = $1 AND id = $2
     LIMIT 1`,
    [workspaceId, input.canonicalJobId]
  );
  if (canonicalOk.rows.length === 0) {
    throw new Error(
      `Unauthorized: canonical_job_id=${input.canonicalJobId} is not in workspace_id=${workspaceId}`
    );
  }

  const versionOk = await client.query(
    `SELECT 1
     FROM job_versions
     WHERE workspace_id = $1
       AND id = $2
       AND canonical_job_id = $3
     LIMIT 1`,
    [workspaceId, input.jobVersionId, input.canonicalJobId]
  );
  if (versionOk.rows.length === 0) {
    throw new Error(
      `Unauthorized: job_version_id=${input.jobVersionId} is not in workspace_id=${workspaceId} for canonical_job_id=${input.canonicalJobId}`
    );
  }

  if (input.matchRunId) {
    const matchOk = await client.query(
      `SELECT 1
       FROM match_runs
       WHERE workspace_id = $1 AND id = $2
       LIMIT 1`,
      [workspaceId, input.matchRunId]
    );
    if (matchOk.rows.length === 0) {
      throw new Error(
        `Unauthorized: match_run_id=${input.matchRunId} is not in workspace_id=${workspaceId}`
      );
    }
  }
}

async function assertDocumentCurrentContext(
  client: { query: pg.PoolClient['query'] },
  workspaceId: string,
  input: DocumentProvenanceInput
): Promise<void> {
  const currentContextFields = [
    input.profileVersionId,
    input.deterministicDecisionId,
    input.contextFingerprint,
  ];
  if (currentContextFields.every((value) => value == null)) return;
  if (currentContextFields.some((value) => !value || value.trim().length === 0)) {
    throw new Error("Document provenance requires the active profile, deterministic decision, and context fingerprint together.");
  }

  const currentness = await validatePersistedDocumentCurrentness(client as pg.PoolClient, workspaceId, {
    canonicalJobId: input.canonicalJobId,
    jobVersionId: input.jobVersionId,
    matchRunId: input.matchRunId ?? null,
    profileVersionId: input.profileVersionId ?? null,
    deterministicDecisionId: input.deterministicDecisionId ?? null,
    contextFingerprint: input.contextFingerprint ?? null,
  });
  if (!currentness.current) {
    throw new Error(`Document generation rejected stale context: ${currentness.reason}.`);
  }
}

export async function persistDocumentProvenance(
  input: DocumentProvenanceInput,
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<DocumentProvenanceResult> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  if (input.applicationRecordId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.applicationRecordId)) {
    throw new Error("applicationRecordId must be a UUID.");
  }
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    await client.query('BEGIN');

    await assertDocumentInputsInWorkspace(client, ctx.workspaceId, input);
    await assertDocumentCurrentContext(client, ctx.workspaceId, input);

    const claimRows = input.claims.filter(
      (claim) => claim.claimText.trim().length > 0 && uniqueStrings(claim.profileFactIds).length > 0
    );

    let runRes: { rows: Array<{ id: string }> };
    try {
      runRes = await client.query<{ id: string }>(
        `INSERT INTO document_runs (
           workspace_id,
           canonical_job_id,
           job_version_id,
           match_run_id,
           profile_version_id,
           deterministic_decision_id,
           context_fingerprint,
           document_type,
           status,
           policy_version,
           generator_version,
           model_route_invocation_id,
           document_template_plugin_revision_id,
           document_template_plugin_key,
           output_manifest,
           claim_count,
           error_message,
           completed_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED', $9, $10, $11, $12, $13, $14, $15, NULL, NOW())
         RETURNING id`,
        [
          ctx.workspaceId,
          input.canonicalJobId,
          input.jobVersionId,
          input.matchRunId || null,
          input.profileVersionId || null,
          input.deterministicDecisionId || null,
          input.contextFingerprint || null,
          input.documentType,
          input.policyVersion,
          input.generatorVersion,
          input.modelRouteInvocationId || null,
          input.documentTemplatePluginRevisionId || null,
          input.documentTemplatePluginKey || null,
          {
            ...input.outputManifest,
            manifest_hash: hashManifest(input.outputManifest),
          },
          claimRows.length,
        ]
      );
    } catch (error: any) {
      if (
        error?.code !== '42703' ||
        input.profileVersionId ||
        input.deterministicDecisionId ||
        input.contextFingerprint
      ) {
        throw error;
      }

      // Backward compatibility for older callers that do not provide V5 context.
      runRes = await client.query<{ id: string }>(
        `INSERT INTO document_runs (
           workspace_id,
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
         VALUES ($1, $2, $3, $4, $5, 'COMPLETED', $6, $7, $8, $9, NULL, NOW())
         RETURNING id`,
        [
          ctx.workspaceId,
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
    }

    const documentRunId = runRes.rows[0].id;
    const documentLinkColumn = input.documentType === 'CV'
      ? 'cv_document_run_id'
      : 'cover_letter_document_run_id';
    const linkedApplications = input.applicationRecordId
      ? await client.query<{ id: string }>(
          `UPDATE application_records
           SET ${documentLinkColumn} = $6,
               last_action_at = NOW(),
               updated_at = NOW()
           WHERE workspace_id = $1
             AND user_id = $2
             AND canonical_job_id = $3
             AND job_version_id = $4
             AND id = $5::uuid
           RETURNING id`,
          [ctx.workspaceId, ctx.userId, input.canonicalJobId, input.jobVersionId, input.applicationRecordId, documentRunId]
        )
      : await client.query<{ id: string }>(
          `UPDATE application_records
           SET ${documentLinkColumn} = $5,
               last_action_at = NOW(),
               updated_at = NOW()
           WHERE workspace_id = $1
             AND user_id = $2
             AND canonical_job_id = $3
             AND job_version_id = $4
           RETURNING id`,
          [ctx.workspaceId, ctx.userId, input.canonicalJobId, input.jobVersionId, documentRunId]
        );
    if (input.applicationRecordId && linkedApplications.rowCount !== 1) {
      throw new Error("The selected application record does not match the document job, version, workspace, and user.");
    }
    for (const application of linkedApplications.rows) {
      await client.query(
        `INSERT INTO application_events (
           workspace_id,
           application_record_id,
           event_type,
           event_payload,
           created_by_user_id
         ) VALUES ($1, $2, 'DOCUMENT_LINKED', $3::jsonb, $4)`,
        [
          ctx.workspaceId,
          application.id,
          JSON.stringify({ document_type: input.documentType, document_run_id: documentRunId }),
          ctx.userId,
        ]
      );
    }

    const allRequirementKeys = uniqueStrings(
      claimRows.flatMap((claim) => claim.requirementKeys || [])
    );
    const requirementMap = new Map<string, string>();

    if (allRequirementKeys.length > 0) {
      const reqRes = await client.query<RequirementRow>(
        `SELECT jr.id, jr.requirement_key
         FROM job_versions jv
         JOIN job_requirements jr
           ON jr.workspace_id = jv.workspace_id
          AND (
            (jv.active_requirement_set_id IS NOT NULL AND jr.requirement_set_id = jv.active_requirement_set_id)
            OR (jv.active_requirement_set_id IS NULL AND jr.job_version_id = jv.id)
          )
         WHERE jv.workspace_id = $1
           AND jv.id = $2
           AND jr.requirement_key = ANY($3::text[])`,
        [ctx.workspaceId, input.jobVersionId, allRequirementKeys]
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
           workspace_id,
           document_run_id,
           section_label,
           claim_text,
           profile_fact_ids,
           requirement_ids,
           unresolved_requirement_keys
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ctx.workspaceId,
          documentRunId,
          claim.sectionLabel,
          claim.claimText,
          uniqueStrings(claim.profileFactIds),
          requirementIds,
          unresolvedKeys,
        ]
      );
    }

    await upsertDocumentReadyStage(client, ctx.workspaceId, input.canonicalJobId, input.jobVersionId, {
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
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
}
