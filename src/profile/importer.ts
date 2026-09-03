import crypto from 'crypto';
import pg from 'pg';
import dotenv from 'dotenv';
import { pgSslConfig } from '../db/pgSsl.js';
import { SCHEMA_VERSION } from './contracts.js';
import { LoadedProfile, loadProfile, validateProfileCoherence } from './loader.js';
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

export function createProfileSourceHash(profileKey: string, versionNumber: number): string {
  return crypto
    .createHash('sha256')
    .update(`${profileKey}:${versionNumber}`)
    .digest('hex');
}

async function insertEvidenceSources(
  client: QueryClient,
  candidateProfileId: string,
  evidenceSources: EvidenceSourceInput[]
): Promise<Map<string, string>> {
  const sourceIdByKey = new Map<string, string>();

  for (const source of evidenceSources) {
    const res = await client.query<{ id: string }>(
      `INSERT INTO evidence_sources (
         candidate_profile_id,
         source_key,
         source_type,
         label,
         uri,
         source_date,
         verification_status,
         metadata
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
  clientOrPool?: pg.Pool | pg.PoolClient
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
    await client.query('BEGIN');

    const profile = loaded.profile;
    const sourceHash = createProfileSourceHash(profile.profile_key, profile.profile_version);

    const candidateProfileRes = await client.query<{ id: string }>(
      `INSERT INTO candidate_profiles (profile_key, display_name)
       VALUES ($1, $2)
       ON CONFLICT (profile_key)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [profile.profile_key, profile.display_name]
    );
    const candidateProfileId = candidateProfileRes.rows[0].id;

    const insertedSourceMap = await insertEvidenceSources(
      client,
      candidateProfileId,
      evidenceSources
    );

    const profileVersionRes = await client.query<{ id: string }>(
      `INSERT INTO profile_versions (
         candidate_profile_id,
         version_number,
         schema_version,
         source_hash,
         status
       )
       VALUES ($1, $2, $3, $4, 'DRAFT')
       RETURNING id`,
      [
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id`,
        [
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

      const factRes = await client.query<{ id: string }>(
        `INSERT INTO profile_facts (
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
           confidentiality
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
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
        ]
      );

      const profileFactId = factRes.rows[0].id;

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
             profile_fact_id,
             concept_id,
             evidence_relationship
           )
           VALUES ($1, $2, $3)
           ON CONFLICT (profile_fact_id, concept_id) DO NOTHING`,
          [profileFactId, conceptRes.rows[0].id, 'SUPPORTS']
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
          `INSERT INTO profile_fact_evidence_sources (profile_fact_id, evidence_source_id)
           VALUES ($1, $2)
           ON CONFLICT (profile_fact_id, evidence_source_id) DO NOTHING`,
          [profileFactId, sourceId]
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
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
         WHERE candidate_profile_id = $1
           AND status = 'ACTIVE'
           AND id <> $2`,
        [candidateProfileId, profileVersionId]
      );
      await client.query(
        `UPDATE profile_versions
         SET status = 'ACTIVE', effective_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [profileVersionId]
      );
    } else {
      await client.query(
        `UPDATE profile_versions
         SET status = $2, effective_at = CASE WHEN $2 = 'ACTIVE' THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE id = $1`,
        [profileVersionId, profile.status]
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
  clientOrPool?: pg.Pool | pg.PoolClient
): Promise<ProfileImportSummary> {
  const loaded = await loadProfile();
  return importLoadedProfile(loaded, evidenceSources, clientOrPool);
}
