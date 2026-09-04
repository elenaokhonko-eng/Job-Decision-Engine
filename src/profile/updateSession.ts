import pg from 'pg';
import dotenv from 'dotenv';
import { z } from 'zod';
import { pgSslConfig } from '../db/pgSsl.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import { stableStringify, sha256Hex } from '../config/structuredLoader.js';
import {
  SCHEMA_VERSION as PROFILE_SCHEMA_VERSION,
  FactTypeSchema,
  ExperienceClassSchema,
  VerificationStatusSchema,
  ConfidentialitySchema,
} from './contracts.js';

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

type QueryClient = {
  query: pg.PoolClient['query'];
};

const FactKeySchema = z.string().regex(/^[a-z][a-z0-9_.]{1,127}$/);
const EngagementKeySchema = z.string().regex(/^[a-z][a-z0-9_.]{1,127}$/);

const FactRevisionPayloadSchema = z.object({
  fact_type: FactTypeSchema,
  statement: z.string().min(1).max(2048),
  structured_value: z.record(z.unknown()).nullable().optional(),
  evidence_tier: ExperienceClassSchema,
  verification_status: VerificationStatusSchema,
  start_date: z.string().date().nullable().optional(),
  end_date: z.string().date().nullable().optional(),
  is_current: z.boolean(),
  confidentiality: ConfidentialitySchema,
});

const FactOperationPayloadSchema = FactRevisionPayloadSchema.extend({
  fact_key: FactKeySchema,
  engagement_key: EngagementKeySchema.optional().nullable(),
  concept_keys: z.array(z.string().min(1)).optional(),
  evidence_source_keys: z.array(z.string().min(1)).optional(),
});

const FactLinkPayloadSchema = z.object({
  fact_key: FactKeySchema,
  engagement_key: EngagementKeySchema.optional().nullable(),
  concept_keys: z.array(z.string().min(1)).optional(),
  evidence_source_keys: z.array(z.string().min(1)).optional(),
});

const FactRetirePayloadSchema = z.object({
  fact_key: FactKeySchema,
  end_date: z.string().date().nullable().optional(),
});

type ProposedOperationRow = {
  id: string;
  operation_type: 'ADD_FACT' | 'REVISE_FACT' | 'RETIRE_FACT' | 'LINK_FACT';
  target_fact_key: string | null;
  payload: any;
};

type BaseFactRow = {
  id: string;
  engagement_id: string | null;
  fact_key: string;
  fact_identity_id: string | null;
  fact_revision_id: string | null;
  fact_type: string;
  statement: string;
  structured_value: any | null;
  evidence_tier: string;
  verification_status: string;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean;
  confidentiality: string;
};

export type ApplyProfileUpdateSessionResult =
  | { status: 'APPLIED'; appliedProfileVersionId: string; alreadyApplied: boolean }
  | { status: 'CONFLICT'; conflictReason: string }
  | { status: 'NEEDS_CLARIFICATION'; reason: string };

async function ensureFactIdentityId(
  client: QueryClient,
  workspaceId: string,
  candidateProfileId: string,
  factKey: string
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO profile_fact_identities (workspace_id, candidate_profile_id, fact_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, candidate_profile_id, fact_key)
     DO UPDATE SET fact_key = EXCLUDED.fact_key
     RETURNING id`,
    [workspaceId, candidateProfileId, factKey]
  );
  return res.rows[0].id;
}

async function ensureFactRevisionId(
  client: QueryClient,
  workspaceId: string,
  factIdentityId: string,
  revisionPayload: z.infer<typeof FactRevisionPayloadSchema>,
  createdByUserId: string
): Promise<string> {
  const revisionHash = sha256Hex(stableStringify(revisionPayload));

  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM profile_fact_revisions
     WHERE workspace_id = $1
       AND fact_identity_id = $2
       AND content_hash = $3
     LIMIT 1`,
    [workspaceId, factIdentityId, revisionHash]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  const nextRev = await client.query<{ next: number }>(
    `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
     FROM profile_fact_revisions
     WHERE fact_identity_id = $1`,
    [factIdentityId]
  );

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO profile_fact_revisions (
       workspace_id,
       fact_identity_id,
       revision_number,
       schema_version,
       content_hash,
       fact_type,
       statement,
       structured_value,
       evidence_tier,
       verification_status,
       start_date,
       end_date,
       is_current,
       confidentiality,
       created_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      workspaceId,
      factIdentityId,
      nextRev.rows[0].next,
      PROFILE_SCHEMA_VERSION,
      revisionHash,
      revisionPayload.fact_type,
      revisionPayload.statement,
      revisionPayload.structured_value ?? null,
      revisionPayload.evidence_tier,
      revisionPayload.verification_status,
      revisionPayload.start_date ?? null,
      revisionPayload.end_date ?? null,
      revisionPayload.is_current,
      revisionPayload.confidentiality,
      createdByUserId,
    ]
  );

  return inserted.rows[0].id;
}

async function resolveConceptIds(
  client: QueryClient,
  conceptKeys: string[]
): Promise<{ idByKey: Map<string, string>; unknownKeys: string[] }> {
  if (conceptKeys.length === 0) {
    return { idByKey: new Map(), unknownKeys: [] };
  }

  const { rows } = await client.query<{ concept_key: string; id: string }>(
    `SELECT concept_key, id
     FROM taxonomy_concepts
     WHERE active = TRUE
       AND concept_key = ANY($1::text[])`,
    [conceptKeys]
  );

  const idByKey = new Map(rows.map((r) => [r.concept_key, r.id]));
  const unknownKeys = conceptKeys.filter((k) => !idByKey.has(k));
  return { idByKey, unknownKeys };
}

async function resolveEvidenceSourceIds(
  client: QueryClient,
  workspaceId: string,
  candidateProfileId: string,
  sourceKeys: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (sourceKeys.length === 0) {
    return map;
  }

  const { rows } = await client.query<{ source_key: string; id: string }>(
    `SELECT source_key, id
     FROM evidence_sources
     WHERE workspace_id = $1
       AND candidate_profile_id = $2
       AND source_key = ANY($3::text[])`,
    [workspaceId, candidateProfileId, sourceKeys]
  );

  for (const row of rows) {
    map.set(row.source_key, row.id);
  }
  return map;
}

function mergeOperationSets(ops: ProposedOperationRow[]): {
  revise?: z.infer<typeof FactOperationPayloadSchema>;
  retire?: z.infer<typeof FactRetirePayloadSchema>;
  link?: z.infer<typeof FactLinkPayloadSchema>;
} {
  const out: {
    revise?: z.infer<typeof FactOperationPayloadSchema>;
    retire?: z.infer<typeof FactRetirePayloadSchema>;
    link?: z.infer<typeof FactLinkPayloadSchema>;
  } = {};

  for (const op of ops) {
    if (op.operation_type === 'REVISE_FACT') {
      out.revise = FactOperationPayloadSchema.parse(op.payload);
      continue;
    }
    if (op.operation_type === 'RETIRE_FACT') {
      out.retire = FactRetirePayloadSchema.parse(op.payload);
      continue;
    }
    if (op.operation_type === 'LINK_FACT') {
      out.link = FactLinkPayloadSchema.parse(op.payload);
      continue;
    }
  }

  return out;
}

export async function applyApprovedProfileUpdateSession(
  sessionId: string,
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ApplyProfileUpdateSessionResult> {
  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const ctx = options?.context ?? (await resolveWorkspaceContext(client as any));

    await client.query('BEGIN');

    const sessionRes = await client.query<{
      workspace_id: string;
      candidate_profile_id: string;
      base_profile_version_id: string;
      status: string;
      applied_profile_version_id: string | null;
    }>(
      `SELECT workspace_id, candidate_profile_id, base_profile_version_id, status, applied_profile_version_id
       FROM profile_update_sessions
       WHERE id = $1
       FOR UPDATE`,
      [sessionId]
    );

    if (sessionRes.rows.length === 0) {
      throw new Error(`profile_update_session not found: ${sessionId}`);
    }
    const session = sessionRes.rows[0];
    if (session.workspace_id !== ctx.workspaceId) {
      throw new Error(`Session workspace mismatch: expected ${ctx.workspaceId} got ${session.workspace_id}`);
    }

    if (session.status === 'APPLIED' && session.applied_profile_version_id) {
      await client.query('COMMIT');
      return {
        status: 'APPLIED',
        appliedProfileVersionId: session.applied_profile_version_id,
        alreadyApplied: true,
      };
    }

    const openClarifications = await client.query(
      `SELECT 1
       FROM profile_update_clarifications
       WHERE session_id = $1
         AND status = 'OPEN'
       LIMIT 1`,
      [sessionId]
    );
    if (openClarifications.rows.length > 0) {
      await client.query(
        `UPDATE profile_update_sessions
         SET status = 'NEEDS_CLARIFICATION', updated_at = NOW()
         WHERE id = $1`,
        [sessionId]
      );
      await client.query('COMMIT');
      return { status: 'NEEDS_CLARIFICATION', reason: 'Open clarifications exist.' };
    }

    const activeRes = await client.query<{ id: string }>(
      `SELECT id
       FROM profile_versions
       WHERE workspace_id = $1
         AND candidate_profile_id = $2
         AND status = 'ACTIVE'
       ORDER BY created_at DESC
       LIMIT 1`,
      [ctx.workspaceId, session.candidate_profile_id]
    );
    if (activeRes.rows.length === 0) {
      await client.query(
        `UPDATE profile_update_sessions
         SET status = 'CONFLICT',
             conflict_reason = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [sessionId, 'No ACTIVE profile version exists for candidate profile.']
      );
      await client.query('COMMIT');
      return { status: 'CONFLICT', conflictReason: 'No ACTIVE profile version exists for candidate profile.' };
    }

    const activeProfileVersionId = activeRes.rows[0].id;
    if (activeProfileVersionId !== session.base_profile_version_id) {
      const reason = `Base profile version is stale. base=${session.base_profile_version_id} active=${activeProfileVersionId}`;
      await client.query(
        `UPDATE profile_update_sessions
         SET status = 'CONFLICT',
             conflict_reason = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [sessionId, reason]
      );
      await client.query('COMMIT');
      return { status: 'CONFLICT', conflictReason: reason };
    }

    const approvedOps = await client.query<ProposedOperationRow>(
      `SELECT po.id, po.operation_type, po.target_fact_key, po.payload
       FROM profile_update_proposed_operations po
       JOIN profile_update_operation_approvals a ON a.operation_id = po.id
       WHERE po.workspace_id = $1
         AND po.session_id = $2
         AND a.decision = 'APPROVED'
       ORDER BY po.created_at ASC, po.id ASC`,
      [ctx.workspaceId, sessionId]
    );

    if (approvedOps.rows.length === 0) {
      await client.query(
        `UPDATE profile_update_sessions
         SET status = 'NEEDS_CLARIFICATION', updated_at = NOW()
         WHERE id = $1`,
        [sessionId]
      );
      await client.query('COMMIT');
      return { status: 'NEEDS_CLARIFICATION', reason: 'No approved operations to apply.' };
    }

    const addOps = approvedOps.rows.filter((op) => op.operation_type === 'ADD_FACT');
    const opsByFactKey = new Map<string, ProposedOperationRow[]>();
    for (const op of approvedOps.rows) {
      if (op.operation_type === 'ADD_FACT') {
        continue;
      }
      const key = (op.target_fact_key || '').trim();
      if (!key) {
        continue;
      }
      const list = opsByFactKey.get(key) || [];
      list.push(op);
      opsByFactKey.set(key, list);
    }

    const baseEngagements = await client.query<{ id: string; engagement_key: string }>(
      `SELECT id, engagement_key
       FROM profile_engagements
       WHERE workspace_id = $1
         AND profile_version_id = $2`,
      [ctx.workspaceId, session.base_profile_version_id]
    );
    const baseEngagementKeys = new Set(baseEngagements.rows.map((row) => row.engagement_key));

    const baseFacts = await client.query<BaseFactRow>(
      `SELECT
         id,
         engagement_id,
         fact_key,
         fact_identity_id,
         fact_revision_id,
         fact_type,
         statement,
         structured_value,
         evidence_tier,
         verification_status,
         start_date,
         end_date,
         is_current,
         confidentiality
       FROM profile_facts
       WHERE workspace_id = $1
         AND profile_version_id = $2
       ORDER BY created_at ASC, id ASC`,
      [ctx.workspaceId, session.base_profile_version_id]
    );
    const baseFactByKey = new Map(baseFacts.rows.map((row) => [row.fact_key, row]));

    const conceptRows = await client.query<{ profile_fact_id: string; concept_key: string }>(
      `SELECT pfc.profile_fact_id, tc.concept_key
       FROM profile_fact_concepts pfc
       JOIN taxonomy_concepts tc ON tc.id = pfc.concept_id
       JOIN profile_facts pf ON pf.id = pfc.profile_fact_id
       WHERE pfc.workspace_id = $1
         AND pf.profile_version_id = $2`,
      [ctx.workspaceId, session.base_profile_version_id]
    );
    const conceptKeysByFactId = new Map<string, string[]>();
    for (const row of conceptRows.rows) {
      const list = conceptKeysByFactId.get(row.profile_fact_id) || [];
      list.push(row.concept_key);
      conceptKeysByFactId.set(row.profile_fact_id, list);
    }

    const evidenceRows = await client.query<{ profile_fact_id: string; source_key: string }>(
      `SELECT pfes.profile_fact_id, es.source_key
       FROM profile_fact_evidence_sources pfes
       JOIN evidence_sources es ON es.id = pfes.evidence_source_id
       JOIN profile_facts pf ON pf.id = pfes.profile_fact_id
       WHERE pfes.workspace_id = $1
         AND pf.profile_version_id = $2`,
      [ctx.workspaceId, session.base_profile_version_id]
    );
    const sourceKeysByFactId = new Map<string, string[]>();
    for (const row of evidenceRows.rows) {
      const list = sourceKeysByFactId.get(row.profile_fact_id) || [];
      list.push(row.source_key);
      sourceKeysByFactId.set(row.profile_fact_id, list);
    }

    const mergedByFactKey = new Map<string, ReturnType<typeof mergeOperationSets>>();
    for (const [factKey, ops] of opsByFactKey.entries()) {
      mergedByFactKey.set(factKey, mergeOperationSets(ops));
    }
    const parsedAddOps = addOps.map((op) => ({
      opId: op.id,
      payload: FactOperationPayloadSchema.parse(op.payload),
    }));

    const missingTargets = Array.from(mergedByFactKey.keys()).filter((factKey) => !baseFactByKey.has(factKey));
    if (missingTargets.length > 0) {
      await client.query(
        `INSERT INTO profile_update_clarifications (workspace_id, session_id, operation_id, question, status)
         VALUES ($1, $2, NULL, $3, 'OPEN')`,
        [
          ctx.workspaceId,
          sessionId,
          `Profile update targets unknown fact_key(s): ${missingTargets.join(', ')}`,
        ]
      );
      await client.query(
        `UPDATE profile_update_sessions
         SET status = 'NEEDS_CLARIFICATION', updated_at = NOW()
         WHERE id = $1`,
        [sessionId]
      );
      await client.query('COMMIT');
      return { status: 'NEEDS_CLARIFICATION', reason: 'Unknown target fact_key(s) require clarification.' };
    }

    const referencedEngagementKeys = new Set<string>();
    for (const merged of mergedByFactKey.values()) {
      const override = merged.link || merged.revise;
      if (typeof override?.engagement_key === 'string') {
        referencedEngagementKeys.add(override.engagement_key);
      }
    }
    for (const add of parsedAddOps) {
      if (typeof add.payload.engagement_key === 'string') {
        referencedEngagementKeys.add(add.payload.engagement_key);
      }
    }
    const unknownEngagementKeys = Array.from(referencedEngagementKeys).filter((k) => !baseEngagementKeys.has(k));
    if (unknownEngagementKeys.length > 0) {
      await client.query(
        `INSERT INTO profile_update_clarifications (workspace_id, session_id, operation_id, question, status)
         VALUES ($1, $2, NULL, $3, 'OPEN')`,
        [
          ctx.workspaceId,
          sessionId,
          `Profile update references unknown engagement_key(s): ${unknownEngagementKeys.join(', ')}`,
        ]
      );
      await client.query(
        `UPDATE profile_update_sessions
         SET status = 'NEEDS_CLARIFICATION', updated_at = NOW()
         WHERE id = $1`,
        [sessionId]
      );
      await client.query('COMMIT');
      return { status: 'NEEDS_CLARIFICATION', reason: 'Unknown engagement_key(s) require clarification.' };
    }

    const allConceptKeys = new Set<string>();
    const allEvidenceSourceKeys = new Set<string>();

    for (const baseFact of baseFacts.rows) {
      const merged = mergedByFactKey.get(baseFact.fact_key);
      if (merged?.retire && merged?.revise) {
        throw new Error(`Conflicting operations for fact_key=${baseFact.fact_key}: retire + revise`);
      }

      const relationshipOverride = merged?.link || merged?.revise;
      const conceptKeysOverride = relationshipOverride?.concept_keys;
      const evidenceKeysOverride = relationshipOverride?.evidence_source_keys;

      const baseConceptKeys = conceptKeysByFactId.get(baseFact.id) || [];
      const baseEvidenceKeys = sourceKeysByFactId.get(baseFact.id) || [];
      const conceptKeys = conceptKeysOverride ?? baseConceptKeys;
      const evidenceKeys = evidenceKeysOverride ?? baseEvidenceKeys;

      for (const key of conceptKeys) {
        allConceptKeys.add(key);
      }
      for (const key of evidenceKeys) {
        allEvidenceSourceKeys.add(key);
      }
    }

    for (const add of parsedAddOps) {
      for (const key of add.payload.concept_keys ?? []) {
        allConceptKeys.add(key);
      }
      for (const key of add.payload.evidence_source_keys ?? []) {
        allEvidenceSourceKeys.add(key);
      }
    }

    const conceptResolution = await resolveConceptIds(client, Array.from(allConceptKeys));
    const conceptIdByKey = conceptResolution.idByKey;
    if (conceptResolution.unknownKeys.length > 0) {
      for (const unknown of conceptResolution.unknownKeys) {
        await client.query(
          `INSERT INTO taxonomy_concept_candidates (workspace_id, proposed_key, proposed_payload, status, created_by_user_id)
           VALUES ($1, $2, $3, 'PENDING', $4)
           ON CONFLICT (workspace_id, proposed_key) DO NOTHING`,
          [ctx.workspaceId, unknown, JSON.stringify({ proposed_key: unknown }), ctx.userId]
        );
      }

      await client.query(
        `INSERT INTO profile_update_clarifications (workspace_id, session_id, operation_id, question, status)
         VALUES ($1, $2, NULL, $3, 'OPEN')`,
        [
          ctx.workspaceId,
          sessionId,
          `Unknown taxonomy concept_key(s) referenced by profile update: ${conceptResolution.unknownKeys.join(', ')}`,
        ]
      );
      await client.query(
        `UPDATE profile_update_sessions
         SET status = 'NEEDS_CLARIFICATION', updated_at = NOW()
         WHERE id = $1`,
        [sessionId]
      );
      await client.query('COMMIT');
      return { status: 'NEEDS_CLARIFICATION', reason: 'Unknown taxonomy concept keys require clarification.' };
    }

    const evidenceSourceIdByKey = await resolveEvidenceSourceIds(
      client,
      ctx.workspaceId,
      session.candidate_profile_id,
      Array.from(allEvidenceSourceKeys)
    );
    const missingEvidenceKeys = Array.from(allEvidenceSourceKeys).filter((k) => !evidenceSourceIdByKey.has(k));
    if (missingEvidenceKeys.length > 0) {
      await client.query(
        `INSERT INTO profile_update_clarifications (workspace_id, session_id, operation_id, question, status)
         VALUES ($1, $2, NULL, $3, 'OPEN')`,
        [
          ctx.workspaceId,
          sessionId,
          `Unknown evidence_source_keys referenced by profile update: ${missingEvidenceKeys.join(', ')}`,
        ]
      );
      await client.query(
        `UPDATE profile_update_sessions
         SET status = 'NEEDS_CLARIFICATION', updated_at = NOW()
         WHERE id = $1`,
        [sessionId]
      );
      await client.query('COMMIT');
      return { status: 'NEEDS_CLARIFICATION', reason: 'Unknown evidence sources require clarification.' };
    }

    const nextVersionRes = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next
       FROM profile_versions
       WHERE workspace_id = $1
         AND candidate_profile_id = $2`,
      [ctx.workspaceId, session.candidate_profile_id]
    );
    const nextVersionNumber = nextVersionRes.rows[0].next;

    const sourceHash = sha256Hex(
      stableStringify({
        base_profile_version_id: session.base_profile_version_id,
        session_id: sessionId,
        approved_operation_ids: approvedOps.rows.map((r) => r.id),
      })
    );

    const newProfileVersion = await client.query<{ id: string }>(
      `INSERT INTO profile_versions (
         workspace_id,
         candidate_profile_id,
         version_number,
         schema_version,
         source_hash,
         status
       )
       VALUES ($1, $2, $3, $4, $5, 'DRAFT')
       RETURNING id`,
      [ctx.workspaceId, session.candidate_profile_id, nextVersionNumber, PROFILE_SCHEMA_VERSION, sourceHash]
    );
    const newProfileVersionId = newProfileVersion.rows[0].id;

    await client.query(
      `INSERT INTO profile_engagements (
         workspace_id,
         profile_version_id,
         engagement_key,
         organization_legal_name,
         brand_or_program_name,
         role_title,
         engagement_type,
         experience_class,
         operating_model,
         start_date,
         end_date,
         is_current,
         production_start_date,
         first_external_user_date,
         hours_per_week_band,
         summary,
         verification_status
       )
       SELECT
         workspace_id,
         $2,
         engagement_key,
         organization_legal_name,
         brand_or_program_name,
         role_title,
         engagement_type,
         experience_class,
         operating_model,
         start_date,
         end_date,
         is_current,
         production_start_date,
         first_external_user_date,
         hours_per_week_band,
         summary,
         verification_status
       FROM profile_engagements
       WHERE workspace_id = $1
         AND profile_version_id = $3`,
      [ctx.workspaceId, newProfileVersionId, session.base_profile_version_id]
    );

    const newEngagements = await client.query<{ id: string; engagement_key: string }>(
      `SELECT id, engagement_key
       FROM profile_engagements
       WHERE workspace_id = $1
         AND profile_version_id = $2`,
      [ctx.workspaceId, newProfileVersionId]
    );
    const newEngagementIdByKey = new Map(newEngagements.rows.map((r) => [r.engagement_key, r.id]));
    const newEngagementIdByOldId = new Map<string, string>();
    for (const base of baseEngagements.rows) {
      const mapped = newEngagementIdByKey.get(base.engagement_key);
      if (mapped) {
        newEngagementIdByOldId.set(base.id, mapped);
      }
    }

    await client.query(
      `INSERT INTO profile_credentials (
         workspace_id,
         profile_version_id,
         credential_key,
         credential_name,
         issuer,
         credential_type,
         level,
         issued_on,
         expires_on,
         status,
         verification_status,
         evidence_source_id
       )
       SELECT
         workspace_id,
         $2,
         credential_key,
         credential_name,
         issuer,
         credential_type,
         level,
         issued_on,
         expires_on,
         status,
         verification_status,
         evidence_source_id
       FROM profile_credentials
       WHERE workspace_id = $1
         AND profile_version_id = $3`,
      [ctx.workspaceId, newProfileVersionId, session.base_profile_version_id]
    );

    for (const baseFact of baseFacts.rows) {
      const merged = mergedByFactKey.get(baseFact.fact_key);

      if (merged?.retire && merged?.revise) {
        throw new Error(`Conflicting operations for fact_key=${baseFact.fact_key}: retire + revise`);
      }

      const relationshipOverride = merged?.link || merged?.revise;
      const engagementKeyOverride = relationshipOverride?.engagement_key;
      const conceptKeysOverride = relationshipOverride?.concept_keys;
      const evidenceKeysOverride = relationshipOverride?.evidence_source_keys;

      const baseConceptKeys = conceptKeysByFactId.get(baseFact.id) || [];
      const baseEvidenceKeys = sourceKeysByFactId.get(baseFact.id) || [];
      const conceptKeys = conceptKeysOverride ?? baseConceptKeys;
      const evidenceKeys = evidenceKeysOverride ?? baseEvidenceKeys;

      const conceptIds = conceptKeys
        .map((key) => conceptIdByKey.get(key))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      let engagementId: string | null = null;
      if (engagementKeyOverride === null) {
        engagementId = null;
      } else if (typeof engagementKeyOverride === 'string') {
        engagementId = newEngagementIdByKey.get(engagementKeyOverride) || null;
      } else if (baseFact.engagement_id) {
        engagementId = newEngagementIdByOldId.get(baseFact.engagement_id) || null;
      } else {
        engagementId = null;
      }

      const identityId =
        baseFact.fact_identity_id ||
        (await ensureFactIdentityId(client, ctx.workspaceId, session.candidate_profile_id, baseFact.fact_key));

      let revisionId = baseFact.fact_revision_id;
      if (merged?.revise) {
        const revisionPayload = FactRevisionPayloadSchema.parse(merged.revise);
        revisionId = await ensureFactRevisionId(client, ctx.workspaceId, identityId, revisionPayload, ctx.userId);
      } else if (merged?.retire) {
        const retire = merged.retire;
        const revisionPayload = FactRevisionPayloadSchema.parse({
          fact_type: baseFact.fact_type,
          statement: baseFact.statement,
          structured_value: baseFact.structured_value,
          evidence_tier: baseFact.evidence_tier,
          verification_status: baseFact.verification_status,
          start_date: baseFact.start_date,
          end_date: retire.end_date ?? baseFact.end_date,
          is_current: false,
          confidentiality: baseFact.confidentiality,
        });
        revisionId = await ensureFactRevisionId(client, ctx.workspaceId, identityId, revisionPayload, ctx.userId);
      }

      const factRes = await client.query<{ id: string }>(
        `INSERT INTO profile_facts (
           workspace_id,
           profile_version_id,
           engagement_id,
           fact_key,
           fact_type,
           statement,
           structured_value,
           evidence_tier,
           verification_status,
           start_date,
           end_date,
           is_current,
           confidentiality,
           fact_identity_id,
           fact_revision_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          ctx.workspaceId,
          newProfileVersionId,
          engagementId,
          baseFact.fact_key,
          merged?.revise ? merged.revise.fact_type : baseFact.fact_type,
          merged?.revise ? merged.revise.statement : baseFact.statement,
          merged?.revise ? (merged.revise.structured_value ?? null) : baseFact.structured_value,
          merged?.revise ? merged.revise.evidence_tier : baseFact.evidence_tier,
          merged?.revise ? merged.revise.verification_status : baseFact.verification_status,
          merged?.revise ? (merged.revise.start_date ?? null) : baseFact.start_date,
          merged?.revise
            ? (merged.revise.end_date ?? null)
            : merged?.retire
              ? (merged.retire.end_date ?? baseFact.end_date)
              : baseFact.end_date,
          merged?.revise ? merged.revise.is_current : merged?.retire ? false : baseFact.is_current,
          merged?.revise ? merged.revise.confidentiality : baseFact.confidentiality,
          identityId,
          revisionId,
        ]
      );
      const newFactId = factRes.rows[0].id;

      if (revisionId) {
        await client.query(
          `INSERT INTO profile_version_fact_snapshots (
             workspace_id,
             profile_version_id,
             fact_identity_id,
             fact_revision_id
           )
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (profile_version_id, fact_identity_id) DO NOTHING`,
          [ctx.workspaceId, newProfileVersionId, identityId, revisionId]
        );
      }

      for (const conceptId of conceptIds) {
        await client.query(
          `INSERT INTO profile_fact_concepts (workspace_id, profile_fact_id, concept_id, evidence_relationship)
           VALUES ($1, $2, $3, 'SUPPORTS')
           ON CONFLICT (profile_fact_id, concept_id) DO NOTHING`,
          [ctx.workspaceId, newFactId, conceptId]
        );
      }

      for (const key of evidenceKeys) {
        const evidenceId = evidenceSourceIdByKey.get(key);
        if (!evidenceId) {
          continue;
        }
        await client.query(
          `INSERT INTO profile_fact_evidence_sources (workspace_id, profile_fact_id, evidence_source_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (profile_fact_id, evidence_source_id) DO NOTHING`,
          [ctx.workspaceId, newFactId, evidenceId]
        );
      }

      if (revisionId) {
        const prev = await client.query<{ fact_revision_id: string }>(
          `SELECT fact_revision_id
           FROM profile_fact_active_revisions
           WHERE fact_identity_id = $1
           LIMIT 1`,
          [identityId]
        );
        const prevRevisionId = prev.rows[0]?.fact_revision_id ?? null;

        await client.query(
          `INSERT INTO profile_fact_active_revisions (
             workspace_id,
             fact_identity_id,
             fact_revision_id,
             activated_by_user_id,
             activated_at
           )
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (fact_identity_id)
           DO UPDATE SET
             fact_revision_id = EXCLUDED.fact_revision_id,
             activated_by_user_id = EXCLUDED.activated_by_user_id,
             activated_at = NOW()`,
          [ctx.workspaceId, identityId, revisionId, ctx.userId]
        );

        if (prevRevisionId !== revisionId) {
          await client.query(
            `INSERT INTO profile_fact_activation_events (
               workspace_id,
               fact_identity_id,
               from_revision_id,
               to_revision_id,
               activated_by_user_id,
               activated_at,
               note
             )
             VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
            [
              ctx.workspaceId,
              identityId,
              prevRevisionId,
              revisionId,
              ctx.userId,
              `Activated via profile update session ${sessionId}`,
            ]
          );
        }
      }
    }

    for (const add of parsedAddOps) {
      const payload = add.payload;

      const evidenceKeys = payload.evidence_source_keys ?? [];
      const conceptIds = (payload.concept_keys ?? [])
        .map((key) => conceptIdByKey.get(key))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      const engagementId =
        payload.engagement_key != null ? newEngagementIdByKey.get(payload.engagement_key) || null : null;

      const identityId = await ensureFactIdentityId(
        client,
        ctx.workspaceId,
        session.candidate_profile_id,
        payload.fact_key
      );
      const revisionPayload = FactRevisionPayloadSchema.parse(payload);
      const revisionId = await ensureFactRevisionId(client, ctx.workspaceId, identityId, revisionPayload, ctx.userId);

      const factRes = await client.query<{ id: string }>(
        `INSERT INTO profile_facts (
           workspace_id,
           profile_version_id,
           engagement_id,
           fact_key,
           fact_type,
           statement,
           structured_value,
           evidence_tier,
           verification_status,
           start_date,
           end_date,
           is_current,
           confidentiality,
           fact_identity_id,
           fact_revision_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          ctx.workspaceId,
          newProfileVersionId,
          engagementId,
          payload.fact_key,
          payload.fact_type,
          payload.statement,
          payload.structured_value ?? null,
          payload.evidence_tier,
          payload.verification_status,
          payload.start_date ?? null,
          payload.end_date ?? null,
          payload.is_current,
          payload.confidentiality,
          identityId,
          revisionId,
        ]
      );
      const newFactId = factRes.rows[0].id;

      await client.query(
        `INSERT INTO profile_version_fact_snapshots (
           workspace_id,
           profile_version_id,
           fact_identity_id,
           fact_revision_id
         )
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (profile_version_id, fact_identity_id) DO NOTHING`,
        [ctx.workspaceId, newProfileVersionId, identityId, revisionId]
      );

      for (const conceptId of conceptIds) {
        await client.query(
          `INSERT INTO profile_fact_concepts (workspace_id, profile_fact_id, concept_id, evidence_relationship)
           VALUES ($1, $2, $3, 'SUPPORTS')
           ON CONFLICT (profile_fact_id, concept_id) DO NOTHING`,
          [ctx.workspaceId, newFactId, conceptId]
        );
      }

      for (const key of evidenceKeys) {
        const evidenceId = evidenceSourceIdByKey.get(key);
        if (!evidenceId) {
          continue;
        }
        await client.query(
          `INSERT INTO profile_fact_evidence_sources (workspace_id, profile_fact_id, evidence_source_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (profile_fact_id, evidence_source_id) DO NOTHING`,
          [ctx.workspaceId, newFactId, evidenceId]
        );
      }

      const prev = await client.query<{ fact_revision_id: string }>(
        `SELECT fact_revision_id
         FROM profile_fact_active_revisions
         WHERE fact_identity_id = $1
         LIMIT 1`,
        [identityId]
      );
      const prevRevisionId = prev.rows[0]?.fact_revision_id ?? null;

      await client.query(
        `INSERT INTO profile_fact_active_revisions (
           workspace_id,
           fact_identity_id,
           fact_revision_id,
           activated_by_user_id,
           activated_at
         )
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (fact_identity_id)
         DO UPDATE SET
           fact_revision_id = EXCLUDED.fact_revision_id,
           activated_by_user_id = EXCLUDED.activated_by_user_id,
           activated_at = NOW()`,
        [ctx.workspaceId, identityId, revisionId, ctx.userId]
      );

      if (prevRevisionId !== revisionId) {
        await client.query(
          `INSERT INTO profile_fact_activation_events (
             workspace_id,
             fact_identity_id,
             from_revision_id,
             to_revision_id,
             activated_by_user_id,
             activated_at,
             note
           )
           VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
          [
            ctx.workspaceId,
            identityId,
            prevRevisionId,
            revisionId,
            ctx.userId,
            `Activated via profile update session ${sessionId}`,
          ]
        );
      }
    }

    await client.query(
      `UPDATE profile_versions
       SET status = 'RETIRED'
       WHERE workspace_id = $1
         AND candidate_profile_id = $2
         AND status = 'ACTIVE'
         AND id <> $3`,
      [ctx.workspaceId, session.candidate_profile_id, newProfileVersionId]
    );
    await client.query(
      `UPDATE profile_versions
       SET status = 'ACTIVE', effective_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1
         AND id = $2`,
      [ctx.workspaceId, newProfileVersionId]
    );

    await client.query(
      `UPDATE profile_update_sessions
       SET status = 'APPLIED',
           applied_profile_version_id = $2,
           applied_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [sessionId, newProfileVersionId]
    );

    await client.query('COMMIT');

    return { status: 'APPLIED', appliedProfileVersionId: newProfileVersionId, alreadyApplied: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsClient && typeof client.release === 'function') {
      client.release();
    }
  }
}
