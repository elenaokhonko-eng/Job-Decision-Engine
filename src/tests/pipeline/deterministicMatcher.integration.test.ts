import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';
import { runMigrations } from '../../db/migrate.js';
import { isLocalPostgresConnectionString, pgConnectionConfig } from '../../db/pgSsl.js';
import { runDeterministicMatcher } from '../../pipeline/deterministicMatcher.js';
import type { WorkspaceContext } from '../../workspace/context.js';

const DB_URL = process.env.DATABASE_URL || '';
const skipReal = !DB_URL || !isLocalPostgresConnectionString(DB_URL);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

let pool: pg.Pool | undefined;
let client: pg.PoolClient | undefined;
let schemaName = '';
let context: WorkspaceContext | undefined;
let canonicalJobId = '';

function getClient(): pg.PoolClient {
  if (!client) throw new Error('Integration test database client is not initialized.');
  return client;
}

async function query<T extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  return getClient().query<T>(sql, params);
}

async function seedFixture(): Promise<void> {
  const workspace = await query<{ id: string }>(
    `SELECT id FROM workspaces WHERE workspace_key = 'default' LIMIT 1`
  );
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new Error('Migration bootstrap did not create the default workspace.');

  const user = await query<{ id: string }>(
    `SELECT id FROM workspace_users WHERE user_key = 'local_user' LIMIT 1`
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('Migration bootstrap did not create the local user.');

  const profile = await query<{ id: string }>(
    `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
     VALUES ($1, $2, 'Incomplete Embedding Integration Profile')
     RETURNING id`,
    [workspaceId, `incomplete_embedding_${Date.now()}`]
  );
  const profileId = profile.rows[0].id;

  const profileVersion = await query<{ id: string }>(
    `INSERT INTO profile_versions (
       workspace_id, candidate_profile_id, version_number, schema_version,
       source_hash, status, effective_at
     ) VALUES ($1, $2, 1, '2.2.0', $3, 'ACTIVE', NOW())
     RETURNING id`,
    [workspaceId, profileId, `incomplete-embedding-profile-${Date.now()}`]
  );
  const profileVersionId = profileVersion.rows[0].id;

  await query(
    `INSERT INTO profile_facts (
       workspace_id, profile_version_id, fact_key, fact_type, statement,
       structured_value, evidence_tier, verification_status
     ) VALUES ($1, $2, 'fraud-domain', 'DOMAIN',
       'Production fraud detection and machine learning systems',
       $3::jsonb, 'PROFESSIONAL_PRODUCTION', 'VERIFIED')`,
    [workspaceId, profileVersionId, JSON.stringify({ domains: ['FRAUD_DETECTION'] })]
  );

  const canonical = await query<{ id: string }>(
    `INSERT INTO canonical_jobs (
       workspace_id, company_name, normalized_title, canonical_url,
       location_summary, workplace_type, employment_type, primary_lane,
       processing_state, processing_status
     ) VALUES ($1, 'Incomplete Embedding Fixture', 'Machine Learning Engineer',
       $2, 'Remote', 'REMOTE', 'FULL_TIME', 'CORE_AI_DATA', 'LANE_ROUTED', 'LANE_ROUTED')
     RETURNING id`,
    [workspaceId, `https://example.test/incomplete-embedding-${Date.now()}`]
  );
  canonicalJobId = canonical.rows[0].id;

  const jobVersion = await query<{ id: string }>(
    `INSERT INTO job_versions (
       workspace_id, canonical_job_id, version_number, content_hash,
       description_text, observed_at
     ) VALUES ($1, $2, 1, $3, 'Build production fraud detection systems.', NOW())
     RETURNING id`,
    [workspaceId, canonicalJobId, `incomplete-embedding-job-${Date.now()}`]
  );
  const jobVersionId = jobVersion.rows[0].id;

  const identity = await query<{ id: string }>(
    `INSERT INTO requirement_set_identities (
       workspace_id, canonical_job_id, identity_hash, job_content_hash,
       deterministic_extractor_version, quoted_extractor_version,
       quoted_prompt_hash, normalizer_hash, quoted_enabled
     ) VALUES ($1, $2, $3, $4, 'deterministic-v1', 'quoted-v1',
       'quoted-prompt-v1', 'normalizer-v1', FALSE)
     RETURNING id`,
    [workspaceId, canonicalJobId, `incomplete-embedding-identity-${Date.now()}`, `incomplete-embedding-content-${Date.now()}`]
  );

  const requirementSet = await query<{ id: string }>(
    `INSERT INTO requirement_sets (
       workspace_id, requirement_identity_id, canonical_job_id, job_version_id,
       revision_number, source_type, created_by_user_id
     ) VALUES ($1, $2, $3, $4, 1, 'EXTRACTED', $5)
     RETURNING id`,
    [workspaceId, identity.rows[0].id, canonicalJobId, jobVersionId, userId]
  );
  const requirementSetId = requirementSet.rows[0].id;

  await query(
    `UPDATE job_versions SET active_requirement_set_id = $2 WHERE workspace_id = $1 AND id = $3`,
    [workspaceId, requirementSetId, jobVersionId]
  );

  const requirement = await query<{ id: string }>(
    `INSERT INTO job_requirements (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       requirement_key, requirement_type, importance, requirement_text,
       quote_text, extractor_type, extractor_version, confidence, status,
       structured_value
     ) VALUES ($1, $2, $3, $4, 'domain-1', 'DOMAIN', 'MUST',
       'Experience in fraud detection and machine learning systems',
       'fraud detection and machine learning systems', 'DETERMINISTIC',
       'deterministic-v1', 1, 'VALIDATED', $5::jsonb)
     RETURNING id`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSetId, JSON.stringify({ domain_key: 'FRAUD_DETECTION' })]
  );

  await query(
    `INSERT INTO requirement_extraction_runs (
       workspace_id, canonical_job_id, job_version_id, requirement_set_id,
       run_type, status, requirements_extracted, completed_at
     ) VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', 1, NOW())`,
    [workspaceId, canonicalJobId, jobVersionId, requirementSetId]
  );

  await query(
    `INSERT INTO job_version_pipeline_state (
       workspace_id, canonical_job_id, job_version_id,
       current_stage, stage_status
     ) VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
    [workspaceId, canonicalJobId, jobVersionId]
  );

  await query(
    `INSERT INTO embedding_spaces (
       workspace_id, space_key, provider, model, dimensions,
       is_fallback_space, active
     ) VALUES ($1, $2, 'fixture', 'fixture-primary', 4, FALSE, TRUE)`,
    [workspaceId, `incomplete-embedding-space-${Date.now()}`]
  );

  context = {
    workspaceId,
    workspaceKey: 'default',
    userId,
    userKey: 'local_user',
    role: 'OWNER',
  };

  expect(requirement.rows[0]?.id).toBeTruthy();
}

describe.skipIf(skipReal)('Pipeline Stage: Deterministic Matcher (real PostgreSQL)', () => {
  beforeAll(async () => {
    pool = new pg.Pool(pgConnectionConfig(DB_URL));
    client = await pool.connect();
    schemaName = `det_match_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}, public`);
    await runMigrations(client);
    await seedFixture();
  }, 60_000);

  afterAll(async () => {
    if (client) {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      client.release();
      client = undefined;
    }
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  });

  it('keeps the canonical job retryable when an active embedding cohort is incomplete', async () => {
    if (!context) throw new Error('Integration test fixture context is not initialized.');

    const summary = await runDeterministicMatcher(getClient(), {
      context,
      canonicalJobIds: [canonicalJobId],
    });

    expect(summary).toEqual({ matchedJobs: 0, skippedJobs: 1, errors: 0 });

    const canonical = await query<{
      processing_state: string;
      processing_status: string;
      profile_match_status: string;
      deterministic_match_score: number | null;
      deterministic_match_coverage: number | null;
    }>(
      `SELECT processing_state, processing_status, profile_match_status,
              deterministic_match_score, deterministic_match_coverage
       FROM canonical_jobs WHERE id = $1`,
      [canonicalJobId]
    );
    expect(canonical.rows[0]).toEqual({
      processing_state: 'LANE_ROUTED',
      processing_status: 'LANE_ROUTED',
      profile_match_status: 'UNKNOWN',
      deterministic_match_score: null,
      deterministic_match_coverage: null,
    });

    const matches = await query<{ match_type: string; semantic_ready: boolean }>(
      `SELECT rem.match_type, (rem.evidence->>'semantic_ready')::boolean AS semantic_ready
       FROM requirement_evidence_matches rem
       JOIN match_runs mr ON mr.id = rem.match_run_id
       WHERE mr.canonical_job_id = $1`,
      [canonicalJobId]
    );
    expect(matches.rows).toEqual([{ match_type: 'UNKNOWN', semantic_ready: false }]);
  });

  it('keeps the canonical job retryable when no active embedding space is configured', async () => {
    if (!context) throw new Error('Integration test fixture context is not initialized.');

    await query(`UPDATE embedding_spaces SET active = FALSE WHERE workspace_id = $1`, [context.workspaceId]);

    const summary = await runDeterministicMatcher(getClient(), {
      context,
      canonicalJobIds: [canonicalJobId],
    });

    expect(summary).toEqual({ matchedJobs: 0, skippedJobs: 1, errors: 0 });

    const canonical = await query<{
      processing_state: string;
      processing_status: string;
      profile_match_status: string;
      deterministic_match_score: number | null;
      deterministic_match_coverage: number | null;
    }>(
      `SELECT processing_state, processing_status, profile_match_status,
              deterministic_match_score, deterministic_match_coverage
       FROM canonical_jobs WHERE id = $1`,
      [canonicalJobId]
    );
    expect(canonical.rows[0]).toEqual({
      processing_state: 'LANE_ROUTED',
      processing_status: 'LANE_ROUTED',
      profile_match_status: 'UNKNOWN',
      deterministic_match_score: null,
      deterministic_match_coverage: null,
    });
  });
});
