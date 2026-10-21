import pg from 'pg';

import { CompanyPolicyObservationSchema, type CompanyPolicyObservation } from './stage3Contracts.js';
import type { WorkspaceContext } from '../workspace/context.js';

export interface StoredCompanyPolicyObservation {
  readonly observationId: string;
  readonly workspaceCompanyId: string;
  readonly policyDomain: string;
  readonly revisionNumber: number;
  readonly confidenceScore: number;
  readonly duplicate: boolean;
}

function confidenceScore(confidence: CompanyPolicyObservation['confidence']): number {
  switch (confidence) {
    case 'HIGH': return 90;
    case 'MEDIUM': return 60;
    case 'LOW': return 25;
  }
}

function normalizeCompanyName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function databaseSourceType(sourceType: CompanyPolicyObservation['source_type']): 'JOB_VERSION' | 'COMPANY_SOURCE' | 'USER_REPORTED' | 'OTHER' {
  if (sourceType === 'JOB_DESCRIPTION') return 'JOB_VERSION';
  if (sourceType === 'USER_REPORTED') return 'USER_REPORTED';
  if (sourceType === 'ANECDOTAL_REVIEW' || sourceType === 'MEDIA_REPORTING') return 'OTHER';
  return 'COMPANY_SOURCE';
}

export async function appendCompanyPolicyObservation(
  client: pg.PoolClient,
  context: WorkspaceContext,
  rawObservation: CompanyPolicyObservation,
  source?: {
    readonly jobVersionId?: string;
    readonly contentHash?: string;
  }
): Promise<StoredCompanyPolicyObservation> {
  const observation = CompanyPolicyObservationSchema.parse(rawObservation);
  const sourceType = databaseSourceType(observation.source_type);
  const quote = observation.evidence_quote?.trim() || null;
  const sourceUrl = observation.source_url?.trim() || null;
  const jobVersionId = source?.jobVersionId ?? null;
  const contentHash = source?.contentHash ?? null;

  if (!quote && !sourceUrl) {
    throw new Error('Company policy evidence requires a direct quote or source URL.');
  }
  if (sourceType === 'JOB_VERSION' && !jobVersionId) {
    throw new Error('Job-description policy evidence must be linked to a job version.');
  }
  if (sourceType === 'COMPANY_SOURCE' && !sourceUrl) {
    throw new Error('Company-source policy evidence must include its source URL.');
  }

  if (sourceType === 'JOB_VERSION' && jobVersionId && quote) {
    const version = await client.query<{ description_text: string }>(
      `SELECT description_text
       FROM job_versions
       WHERE workspace_id = $1 AND id = $2
       LIMIT 1`,
      [context.workspaceId, jobVersionId]
    );
    const description = version.rows[0]?.description_text;
    if (!description || !description.includes(quote)) {
      throw new Error('Job-description policy evidence quote must be a verbatim substring of its linked job version.');
    }
  }

  const normalizedCompanyName = normalizeCompanyName(observation.company_name);
  const company = await client.query<{ id: string }>(
    `INSERT INTO workspace_companies (workspace_id, company_name, normalized_company_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, normalized_company_name)
     DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [context.workspaceId, observation.company_name.trim(), normalizedCompanyName]
  );
  const workspaceCompanyId = company.rows[0]?.id;
  if (!workspaceCompanyId) throw new Error('Could not resolve workspace company for policy observation.');

  const policyDomain = observation.policy_type.toLowerCase();
  const confidence = confidenceScore(observation.confidence);
  const policyValue = observation.value !== null && typeof observation.value === 'object'
    ? observation.value
    : { value: observation.value };
  const evidence = {
    quote,
    source_url: sourceUrl,
    source_type: observation.source_type,
    confidence: observation.confidence,
    observed_at: observation.observed_at,
    ...(observation.effective_date ? { effective_date: observation.effective_date } : {}),
  };

  const prior = await client.query<{
    id: string;
    revision_number: number;
    policy_value: unknown;
    evidence: unknown;
    source_url: string | null;
    source_job_version_id: string | null;
  }>(
    `SELECT id, revision_number, policy_value, evidence, source_url, source_job_version_id
     FROM workspace_company_policy_observations
     WHERE workspace_id = $1
       AND workspace_company_id = $2
       AND policy_domain = $3
     ORDER BY revision_number DESC
     LIMIT 1`,
    [context.workspaceId, workspaceCompanyId, policyDomain]
  );
  const latest = prior.rows[0];
  if (
    latest &&
    JSON.stringify(latest.policy_value) === JSON.stringify(policyValue) &&
    JSON.stringify(latest.evidence) === JSON.stringify(evidence) &&
    latest.source_url === sourceUrl &&
    latest.source_job_version_id === jobVersionId
  ) {
    return {
      observationId: latest.id,
      workspaceCompanyId,
      policyDomain,
      revisionNumber: latest.revision_number,
      confidenceScore: confidence,
      duplicate: true,
    };
  }

  const revisionNumber = (latest?.revision_number ?? 0) + 1;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO workspace_company_policy_observations (
       workspace_id, workspace_company_id, policy_domain, revision_number,
       supersedes_revision_number, supersedes_observation_id, schema_version,
       policy_value, source_type, source_url, source_job_version_id,
       source_content_hash, source_published_at, evidence, confidence, created_by_user_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, '3.0.0', $7::jsonb, $8, $9, $10, $11, $12, $13::jsonb, $14, $15
     ) RETURNING id`,
    [
      context.workspaceId,
      workspaceCompanyId,
      policyDomain,
      revisionNumber,
      latest?.revision_number ?? null,
      latest?.id ?? null,
      JSON.stringify(policyValue),
      sourceType,
      sourceUrl,
      jobVersionId,
      contentHash,
      null,
      JSON.stringify(evidence),
      confidence,
      context.userId,
    ]
  );
  const observationId = inserted.rows[0]?.id;
  if (!observationId) throw new Error('Company policy observation insert returned no ID.');

  return {
    observationId,
    workspaceCompanyId,
    policyDomain,
    revisionNumber,
    confidenceScore: confidence,
    duplicate: false,
  };
}
