import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';
import { SCHEMA_VERSION } from './contracts.js';
import { LoadedProfile, loadProfile, validateProfileCoherence } from './loader.js';
import { stableStringify, sha256Hex } from '../config/structuredLoader.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../workspace/context.js';
import {
  EvidenceSourceInput,
  validateEvidenceSourceReferences,
} from './evidenceValidator.js';

type QueryClient = {
  query: pg.PoolClient['query'];
};

dotenv.config();
dotenv.config({ path: '.env.local' });

const defaultPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: pgSslConfig(process.env.DATABASE_URL),
});

export interface ProfileImportSummary {
  candidateProfileId: string;
  profileVersionId: string;
  sourceHash: string;
  inserted: {
    evidenceSources: number;
    engagements: number;
    facts: number;
    factConceptLinks: number;
    factEvidenceLinks: number;
    credentials: number;
  };
}

export function createProfileSourceHash(
  loaded: LoadedProfile,
  evidenceSources: EvidenceSourceInput[]
): string {
  const canonicalJson = stableStringify({
    profile: loaded.profile,
    engagements: loaded.engagements,
    facts: loaded.facts,
    credentials: loaded.credentials,
    workPreferences: loaded.workPreferences,
    lanePreferences: loaded.lanePreferences,
    evidenceSources,
  });
  return sha256Hex(canonicalJson);
}

async function insertEvidenceSources(
  client: QueryClient,
  workspaceId: string,
  candidateProfileId: string,
  evidenceSources: EvidenceSourceInput[]
): Promise<Map<string, string>> {
  const sourceIdByKey = new Map<string, string>();

  for (const source of evidenceSources) {
    const res = await client.query<{ id: string }>(
      `INSERT INTO evidence_sources (
         workspace_id,
         candidate_profile_id,
         source_key,
         source_type,
         label,
         uri,
         source_date,
         verification_status,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (candidate_profile_id, source_key)
       DO UPDATE SET
         source_type = EXCLUDED.source_type,
         label = EXCLUDED.label,
         uri = EXCLUDED.uri,
         source_date = EXCLUDED.source_date,
         verification_status = EXCLUDED.verification_status,
         metadata = EXCLUDED.metadata
       RETURNING id`,
      [
        workspaceId,
        candidateProfileId,
        source.source_key,
        source.source_type,
        source.label,
        source.uri ?? null,
        source.source_date ?? null,
        source.verification_status,
        source.metadata ?? null,
      ]
    );

    sourceIdByKey.set(source.source_key, res.rows[0].id);
  }

  return sourceIdByKey;
}

export async function importLoadedProfile(
  loaded: LoadedProfile,
  evidenceSources: EvidenceSourceInput[],
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ProfileImportSummary> {
  const coherence = await validateProfileCoherence(loaded);
  if (!coherence.valid) {
    throw new Error(`Profile coherence validation failed:\n${coherence.issues.join('\n')}`);
  }

  const evidenceRefValidation = validateEvidenceSourceReferences(loaded, evidenceSources);
  if (!evidenceRefValidation.valid) {
    throw new Error(
      `Evidence source validation failed:\n${evidenceRefValidation.issues.join('\n')}`
    );
  }

  const pool = clientOrPool || defaultPool;
  const isPool = (value: pg.Pool | pg.PoolClient): value is pg.Pool =>
    typeof (value as pg.Pool).connect === 'function' && !('release' in value);
  const ownsClient = isPool(pool);
  const client = ownsClient ? await pool.connect() : pool;

  try {
    const context = options?.context ?? (await resolveWorkspaceContext(client as any));

    await client.query('BEGIN');

    const profile = loaded.profile;
    const sourceHash = createProfileSourceHash(loaded, evidenceSources);

    const candidateProfileRes = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, profile_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [context.workspaceId, profile.profile_key, profile.display_name]
    );
    const candidateProfileId = candidateProfileRes.rows[0].id;

    const insertedSourceMap = await insertEvidenceSources(
      client,
      context.workspaceId,
      candidateProfileId,
      evidenceSources
    );

    const profileVersionRes = await client.query<{ id: string }>(
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
      [
        context.workspaceId,
        candidateProfileId,
        profile.profile_version,
        profile.schema_version || SCHEMA_VERSION,
        sourceHash,
      ]
    );
    const profileVersionId = profileVersionRes.rows[0].id;

    const engagementIdByKey = new Map<string, string>();

    for (const engagement of loaded.engagements.engagements) {
      const res = await client.query<{ id: string }>(
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING id`,
        [
          context.workspaceId,
          profileVersionId,
          engagement.engagement_key,
          engagement.organization_legal_name,
          engagement.brand_or_program_name ?? null,
          engagement.role_title,
          engagement.engagement_type,
          engagement.experience_class,
          engagement.operating_model ?? null,
          engagement.start_date,
          engagement.end_date ?? null,
          engagement.is_current,
          engagement.production_start_date ?? null,
          engagement.first_external_user_date ?? null,
          engagement.hours_per_week_band ?? null,
          engagement.summary,
          engagement.verification_status,
        ]
      );

      engagementIdByKey.set(engagement.engagement_key, res.rows[0].id);
    }

    let insertedFactConceptLinks = 0;
    let insertedFactEvidenceLinks = 0;

    for (const fact of loaded.facts.facts) {
      const engagementId = fact.engagement_key
        ? engagementIdByKey.get(fact.engagement_key) || null
        : null;

      const identityRes = await client.query<{ id: string }>(
        `INSERT INTO profile_fact_identities (workspace_id, candidate_profile_id, fact_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, candidate_profile_id, fact_key)
         DO UPDATE SET fact_key = EXCLUDED.fact_key
         RETURNING id`,
        [context.workspaceId, candidateProfileId, fact.fact_key]
      );
      const factIdentityId = identityRes.rows[0].id;

      const revisionPayload = {
        fact_type: fact.fact_type,
        statement: fact.statement,
        structured_value: fact.structured_value ?? null,
        evidence_tier: fact.evidence_tier,
        verification_status: fact.verification_status,
        start_date: fact.start_date ?? null,
        end_date: fact.end_date ?? null,
        is_current: fact.is_current,
        confidentiality: fact.confidentiality,
      };
      const revisionHash = sha256Hex(stableStringify(revisionPayload));

      let factRevisionId: string;
      const existingRevision = await client.query<{ id: string }>(
        `SELECT id
         FROM profile_fact_revisions
         WHERE workspace_id = $1
           AND fact_identity_id = $2
           AND content_hash = $3
         LIMIT 1`,
        [context.workspaceId, factIdentityId, revisionHash]
      );
      if (existingRevision.rows.length > 0) {
        factRevisionId = existingRevision.rows[0].id;
      } else {
        const nextRev = await client.query<{ next: number }>(
          `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
           FROM profile_fact_revisions
           WHERE fact_identity_id = $1`,
          [factIdentityId]
        );

        const insertedRevision = await client.query<{ id: string }>(
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
            context.workspaceId,
            factIdentityId,
            nextRev.rows[0].next,
            profile.schema_version || SCHEMA_VERSION,
            revisionHash,
            fact.fact_type,
            fact.statement,
            fact.structured_value ?? null,
            fact.evidence_tier,
            fact.verification_status,
            fact.start_date ?? null,
            fact.end_date ?? null,
            fact.is_current,
            fact.confidentiality,
            context.userId,
          ]
        );
        factRevisionId = insertedRevision.rows[0].id;
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
          context.workspaceId,
          profileVersionId,
          engagementId,
          fact.fact_key,
          fact.fact_type,
          fact.statement,
          fact.structured_value ?? null,
          fact.evidence_tier,
          fact.verification_status,
          fact.start_date ?? null,
          fact.end_date ?? null,
          fact.is_current,
          fact.confidentiality,
          factIdentityId,
          factRevisionId,
        ]
      );

      const profileFactId = factRes.rows[0].id;

      await client.query(
        `INSERT INTO profile_version_fact_snapshots (
           workspace_id,
           profile_version_id,
           fact_identity_id,
           fact_revision_id
         )
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (profile_version_id, fact_identity_id) DO NOTHING`,
        [context.workspaceId, profileVersionId, factIdentityId, factRevisionId]
      );

      if (profile.status === 'ACTIVE') {
        const prev = await client.query<{ fact_revision_id: string }>(
          `SELECT fact_revision_id
           FROM profile_fact_active_revisions
           WHERE fact_identity_id = $1
           LIMIT 1`,
          [factIdentityId]
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
          [context.workspaceId, factIdentityId, factRevisionId, context.userId]
        );

        if (prevRevisionId !== factRevisionId) {
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
              context.workspaceId,
              factIdentityId,
              prevRevisionId,
              factRevisionId,
              context.userId,
              'Activated during profile import of ACTIVE profile version',
            ]
          );
        }
      }

      for (const conceptKey of fact.concept_keys || []) {
        const conceptRes = await client.query<{ id: string }>(
          `SELECT id
           FROM taxonomy_concepts
           WHERE concept_key = $1 AND active = TRUE
           LIMIT 1`,
          [conceptKey]
        );

        if (conceptRes.rows.length === 0) {
          throw new Error(`Unknown concept_key referenced by fact ${fact.fact_key}: ${conceptKey}`);
        }

        await client.query(
          `INSERT INTO profile_fact_concepts (
             workspace_id,
             profile_fact_id,
             concept_id,
             evidence_relationship
           )
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (profile_fact_id, concept_id) DO NOTHING`,
          [context.workspaceId, profileFactId, conceptRes.rows[0].id, 'SUPPORTS']
        );
        insertedFactConceptLinks += 1;
      }

      for (const sourceKey of fact.evidence_source_keys || []) {
        const sourceId = insertedSourceMap.get(sourceKey);
        if (!sourceId) {
          throw new Error(
            `Fact ${fact.fact_key} references unknown evidence source key: ${sourceKey}`
          );
        }

        await client.query(
          `INSERT INTO profile_fact_evidence_sources (workspace_id, profile_fact_id, evidence_source_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (profile_fact_id, evidence_source_id) DO NOTHING`,
          [context.workspaceId, profileFactId, sourceId]
        );
        insertedFactEvidenceLinks += 1;
      }
    }

    for (const credential of loaded.credentials.credentials) {
      const evidenceSourceId = credential.evidence_source_key
        ? insertedSourceMap.get(credential.evidence_source_key) || null
        : null;

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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          context.workspaceId,
          profileVersionId,
          credential.credential_key,
          credential.credential_name,
          credential.issuer,
          credential.credential_type,
          credential.level ?? null,
          credential.issued_on ?? null,
          credential.expires_on ?? null,
          credential.status,
          credential.verification_status,
          evidenceSourceId,
        ]
      );
    }

    if (profile.status === 'ACTIVE') {
      await client.query(
        `UPDATE profile_versions
         SET status = 'RETIRED'
         WHERE workspace_id = $1
           AND candidate_profile_id = $2
           AND status = 'ACTIVE'
           AND id <> $3`,
        [context.workspaceId, candidateProfileId, profileVersionId]
      );
      await client.query(
        `UPDATE profile_versions
         SET status = 'ACTIVE', effective_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1
           AND id = $2`,
        [context.workspaceId, profileVersionId]
      );
    } else {
      await client.query(
        `UPDATE profile_versions
         SET status = $2, effective_at = CASE WHEN $2 = 'ACTIVE' THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE workspace_id = $3
           AND id = $1`,
        [profileVersionId, profile.status, context.workspaceId]
      );
    }

    await client.query('COMMIT');

    return {
      candidateProfileId,
      profileVersionId,
      sourceHash,
      inserted: {
        evidenceSources: evidenceSources.length,
        engagements: loaded.engagements.engagements.length,
        facts: loaded.facts.facts.length,
        factConceptLinks: insertedFactConceptLinks,
        factEvidenceLinks: insertedFactEvidenceLinks,
        credentials: loaded.credentials.credentials.length,
      },
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

export async function importProfileFromFiles(
  evidenceSources: EvidenceSourceInput[],
  clientOrPool?: pg.Pool | pg.PoolClient,
  options?: { context?: WorkspaceContext }
): Promise<ProfileImportSummary> {
  const loaded = await loadProfile();
  return importLoadedProfile(loaded, evidenceSources, clientOrPool, options);
}
