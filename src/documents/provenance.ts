import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { pgPoolConfig } from '../db/pgSsl.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { validateDocumentCurrentContext } from './currentContext.js';

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
  if (currentContextFields.every((value) => value == null)) {
    return;
  }
  if (currentContextFields.some((value) => !value || value.trim().length === 0)) {
    throw new Error("Document provenance requires the active profile, deterministic decision, and context fingerprint together.");
  }

  const { rows } = await client.query(
    `SELECT
       COALESCE(job.latest_job_version_id, current_job_version.id) AS current_job_version_id,
       job.latest_match_run_id,
       job.latest_deterministic_decision_id,
       profile.id AS active_profile_version_id,
       match_run.id AS match_run_id,
       match_run.job_version_id AS match_run_job_version_id,
       match_run.profile_version_id AS match_run_profile_version_id,
       match_run.status AS match_run_status,
       match_run.requirement_set_id AS match_run_requirement_set_id,
       current_job_version.active_requirement_set_id,
       match_run.job_content_hash AS match_run_job_content_hash,
       current_job_version.content_hash AS current_job_content_hash,
       match_run.context_fingerprint AS match_run_context_fingerprint,
       decision.id AS deterministic_decision_id,
       decision.job_version_id AS decision_job_version_id,
       decision.match_run_id AS decision_match_run_id,
       decision.context_fingerprint AS decision_context_fingerprint,
       decision.recommendation_eligibility AS decision_recommendation_eligibility,
       decision.recommendation_outcome AS decision_recommendation_outcome,
       current_shortlist.gate_status,
       current_shortlist.recommendation_eligibility,
       job.recommendation_outcome
     FROM canonical_jobs AS job
     LEFT JOIN job_versions AS current_job_version
       ON current_job_version.workspace_id = job.workspace_id
      AND current_job_version.canonical_job_id = job.id
      AND current_job_version.id = COALESCE(job.latest_job_version_id, (
        SELECT version.id
        FROM job_versions AS version
        WHERE version.workspace_id = job.workspace_id
          AND version.canonical_job_id = job.id
        ORDER BY version.observed_at DESC, version.id DESC
        LIMIT 1
      ))
     LEFT JOIN v_canonical_shortlist_scoped AS current_shortlist
       ON current_shortlist.workspace_id = job.workspace_id
      AND current_shortlist.canonical_job_id = job.id
      AND current_shortlist.job_version_id = current_job_version.id
     LEFT JOIN LATERAL (
       SELECT profile_version.id
       FROM profile_versions AS profile_version
       WHERE profile_version.workspace_id = job.workspace_id
         AND profile_version.status = 'ACTIVE'
       ORDER BY profile_version.created_at DESC, profile_version.id DESC
       LIMIT 1
     ) AS profile ON TRUE
     LEFT JOIN match_runs AS match_run
       ON match_run.workspace_id = job.workspace_id
      AND match_run.id = job.latest_match_run_id
      AND match_run.canonical_job_id = job.id
     LEFT JOIN deterministic_decisions AS decision
       ON decision.workspace_id = job.workspace_id
      AND decision.id = job.latest_deterministic_decision_id
      AND decision.canonical_job_id = job.id
     WHERE job.workspace_id = $1 AND job.id = $2
     LIMIT 1`,
    [workspaceId, input.canonicalJobId]
  );
  const current = rows[0];
  if (!current) {
    throw new Error("Document generation rejected stale context: canonical job is no longer available.");
  }
  const currentness = validateDocumentCurrentContext({
    ...current,
    selected_job_version_id: input.jobVersionId,
    selected_profile_version_id: input.profileVersionId!,
  });
  if (!currentness.ok) {
    throw new Error(`Document generation rejected stale context: ${currentness.reason}.`);
  }
  if (input.matchRunId !== current.match_run_id || input.deterministicDecisionId !== current.deterministic_decision_id) {
    throw new Error("Document generation rejected stale context: selected match or decision changed during rendering.");
  }
  if (input.contextFingerprint !== current.decision_context_fingerprint) {
    throw new Error("Document generation rejected stale context: decision fingerprint changed during rendering.");
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
    const linkedApplications = await client.query<{ id: string }>(
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
