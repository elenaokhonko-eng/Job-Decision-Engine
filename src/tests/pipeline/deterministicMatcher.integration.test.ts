import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { fileURLToPath } from 'url';
import path from 'path';
import { runMigrations } from '../../db/migrate.js';
import { isLocalPostgresConnectionString, pgConnectionConfig } from '../../db/pgSsl.js';
import { COMPLETE_TEST_POSTING_DESCRIPTION, insertCompletePostingEvidence } from '../fixtures/completePostingEvidence.js';
import { getEmbeddingSpaceRegistryConfiguration, seedEmbeddingSpaces } from '../../embeddings/spaceRegistry.js';
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
     ) VALUES ($1, $2, 1, $3, $4, NOW())
     RETURNING id`,
    [workspaceId, canonicalJobId, `incomplete-embedding-job-${Date.now()}`, COMPLETE_TEST_POSTING_DESCRIPTION]
  );
  const jobVersionId = jobVersion.rows[0].id;
  await insertCompletePostingEvidence(client!, {
    workspaceId,
    jobVersionId,
    companyName: 'Incomplete Embedding Fixture',
    title: 'Machine Learning Engineer',
    sourceUrl: `https://example.test/incomplete-embedding-${Date.now()}`,
    description: COMPLETE_TEST_POSTING_DESCRIPTION,
  });

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

    expect(summary).toEqual({ matchedJobs: 0, skippedJobs: 1, errors: 0, blockedOnRequirementEmbeddings: [] });

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

  it('a re-match with an incomplete embedding cohort keeps the stored scores, outcome and decision pointer', async () => {
    if (!context) throw new Error('Integration test fixture context is not initialized.');
    const stored = `SELECT deterministic_match_score::float AS match_score, deterministic_match_coverage::float AS match_coverage,
                           recommendation_requirement_score::float AS score, recommendation_coverage_score::float AS coverage,
                           recommendation_evidence_completeness::float AS completeness, recommendation_outcome AS outcome,
                           recommendation_eligibility AS eligibility
                      FROM canonical_jobs WHERE id = $1`;
    await query(
      `UPDATE canonical_jobs
          SET processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED', deterministic_match_score = 70,
              deterministic_match_coverage = 55, recommendation_requirement_score = 0.7, recommendation_coverage_score = 0.55,
              recommendation_evidence_completeness = 0.9, recommendation_outcome = 'REVIEW', recommendation_eligibility = 'ELIGIBLE'
        WHERE id = $1`,
      [canonicalJobId]
    );

    const summary = await runDeterministicMatcher(getClient(), { context, canonicalJobIds: [canonicalJobId] });
    expect(summary).toMatchObject({ matchedJobs: 0, skippedJobs: 1, errors: 0 });

    expect((await query(stored, [canonicalJobId])).rows[0]).toEqual({
      match_score: 70, match_coverage: 55, score: 0.7, coverage: 0.55, completeness: 0.9, outcome: 'REVIEW', eligibility: 'ELIGIBLE',
    });
    // Back to a job with no stored result, for the scenarios that follow.
    await query(
      `UPDATE canonical_jobs
          SET deterministic_match_score = NULL, deterministic_match_coverage = NULL, recommendation_requirement_score = NULL,
              recommendation_coverage_score = NULL, recommendation_evidence_completeness = NULL, recommendation_outcome = NULL,
              recommendation_eligibility = NULL
        WHERE id = $1`,
      [canonicalJobId]
    );
  });

  it('keeps the canonical job retryable when no active embedding space is configured', async () => {
    if (!context) throw new Error('Integration test fixture context is not initialized.');

    await query(`UPDATE embedding_spaces SET active = FALSE WHERE workspace_id = $1`, [context.workspaceId]);

    const summary = await runDeterministicMatcher(getClient(), {
      context,
      canonicalJobIds: [canonicalJobId],
    });

    expect(summary).toEqual({ matchedJobs: 0, skippedJobs: 1, errors: 0, blockedOnRequirementEmbeddings: [] });

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

  it('a completed extraction with zero requirements is an unknown, unscored fit: the decider gives TRACK, never SKIP, and the Track view reads NULL', async () => {
    if (!context) throw new Error('Integration test fixture context is not initialized.');
    await query(`UPDATE embedding_spaces SET active = TRUE WHERE workspace_id = $1`, [context.workspaceId]);
    const stamp = `${Date.now()}-zero`;
    const job = await query<{ id: string }>(
      `INSERT INTO canonical_jobs (workspace_id, company_name, normalized_title, canonical_url, location_summary, workplace_type,
                                   employment_type, primary_lane, processing_state, processing_status, gate_decision)
       VALUES ($1, 'Zero Requirement Fixture', 'Data Scientist', $2, 'Remote', 'REMOTE', 'FULL_TIME', 'CORE_AI_DATA', 'LANE_ROUTED', 'LANE_ROUTED', 'PASS')
       RETURNING id`,
      [context.workspaceId, `https://example.test/zero-${stamp}`],
    );
    const jobId = job.rows[0].id;
    const version = await query<{ id: string }>(
      `INSERT INTO job_versions (workspace_id, canonical_job_id, version_number, content_hash, description_text, observed_at)
       VALUES ($1, $2, 1, $3, $4, NOW()) RETURNING id`,
      [context.workspaceId, jobId, `zero-${stamp}`, COMPLETE_TEST_POSTING_DESCRIPTION],
    );
    const versionId = version.rows[0].id;
    await query(`UPDATE canonical_jobs SET latest_job_version_id = $2 WHERE id = $1`, [jobId, versionId]);
    await insertCompletePostingEvidence(client!, {
      workspaceId: context.workspaceId, jobVersionId: versionId, companyName: 'Zero Requirement Fixture', title: 'Data Scientist',
      sourceUrl: `https://example.test/zero-${stamp}`, description: COMPLETE_TEST_POSTING_DESCRIPTION,
    });
    const identity = await query<{ id: string }>(
      `INSERT INTO requirement_set_identities (workspace_id, canonical_job_id, identity_hash, job_content_hash, deterministic_extractor_version,
                                               quoted_extractor_version, quoted_prompt_hash, normalizer_hash, quoted_enabled)
       VALUES ($1, $2, $3, 'h', 'deterministic-v1', 'quoted-v1', 'p', 'n', FALSE) RETURNING id`,
      [context.workspaceId, jobId, `zero-identity-${stamp}`],
    );
    const set = await query<{ id: string }>(
      `INSERT INTO requirement_sets (workspace_id, requirement_identity_id, canonical_job_id, job_version_id, revision_number, source_type)
       VALUES ($1, $2, $3, $4, 1, 'EXTRACTED') RETURNING id`,
      [context.workspaceId, identity.rows[0].id, jobId, versionId],
    );
    await query(`UPDATE job_versions SET active_requirement_set_id = $2 WHERE id = $1`, [versionId, set.rows[0].id]);
    await query(
      `INSERT INTO requirement_extraction_runs (workspace_id, canonical_job_id, job_version_id, requirement_set_id, run_type, status, requirements_extracted, completed_at)
       VALUES ($1, $2, $3, $4, 'DETERMINISTIC', 'COMPLETED', 0, NOW())`,
      [context.workspaceId, jobId, versionId, set.rows[0].id],
    );
    await query(
      `INSERT INTO job_version_pipeline_state (workspace_id, canonical_job_id, job_version_id, current_stage, stage_status)
       VALUES ($1, $2, $3, 'REQUIREMENTS_EXTRACTED', 'COMPLETED')`,
      [context.workspaceId, jobId, versionId],
    );

    const matched = await runDeterministicMatcher(getClient(), { context, canonicalJobIds: [jobId] });
    expect(matched.errors).toBe(0);
    const canonical = await query(
      `SELECT profile_match_status, deterministic_match_score, deterministic_match_coverage FROM canonical_jobs WHERE id = $1`,
      [jobId],
    );
    expect(canonical.rows[0]).toEqual({ profile_match_status: 'UNKNOWN', deterministic_match_score: null, deterministic_match_coverage: null });
    const run = await query(`SELECT status, requirement_count FROM match_runs WHERE canonical_job_id = $1 ORDER BY started_at DESC LIMIT 1`, [jobId]);
    expect(run.rows[0]).toMatchObject({ status: 'COMPLETED', requirement_count: 0 });

    const { runRecommendationDecider } = await import('../../pipeline/recommendationDecider.js');
    expect((await runRecommendationDecider(getClient(), { context, canonicalJobIds: [jobId] })).errors).toBe(0);
    const decided = await query(`SELECT recommendation_outcome, recommendation_requirement_score FROM canonical_jobs WHERE id = $1`, [jobId]);
    expect(decided.rows[0].recommendation_outcome).toBe('TRACK');
    expect(decided.rows[0].recommendation_outcome).not.toBe('SKIP');
    expect(decided.rows[0].recommendation_requirement_score).toBeNull();

    // The read models take the gate status from gate_decisions; record the PASS the gate stage would have written.
    await query(
      `INSERT INTO gate_decisions (workspace_id, canonical_job_id, job_version_id, decision, gate_version)
       VALUES ($1, $2, $3, 'PASS', 'fixture')`,
      [context.workspaceId, jobId, versionId],
    );
    // The Track read model lists the job (so the view test is not vacuous) and reads its NULL score.
    const shortlist = await query(`SELECT gate_status, current_artifact_status, recommendation_outcome FROM v_canonical_shortlist_scoped WHERE canonical_job_id = $1`, [jobId]);
    expect(shortlist.rows).toEqual([expect.objectContaining({ gate_status: 'PASS', recommendation_outcome: 'TRACK' })]);
    const track = await query(`SELECT recommendation_outcome, recommendation_requirement_score FROM v_track_jobs_scoped WHERE canonical_job_id = $1`, [jobId]);
    expect(track.rows).toHaveLength(1);
    expect(track.rows[0].recommendation_outcome).toBe('TRACK');
    expect(track.rows[0].recommendation_requirement_score).toBeNull();
  });

  describe('requirement embeddings guard: never match on partial embeddings', () => {
    async function publishEmbedding(sourceType: 'PROFILE_FACT' | 'JOB_REQUIREMENT', sourceId: string): Promise<void> {
      if (!context) throw new Error('Integration test fixture context is not initialized.');
      const dimensions = getEmbeddingSpaceRegistryConfiguration().primary.dimensions;
      const space = await query<{ id: string }>(
        `SELECT id FROM embedding_spaces WHERE workspace_id = $1 AND active = TRUE AND is_fallback_space = FALSE AND provider = $2 ORDER BY created_at DESC LIMIT 1`,
        [context.workspaceId, getEmbeddingSpaceRegistryConfiguration().primary.provider],
      );
      const input = await query<{ id: string }>(
        `INSERT INTO embedding_inputs (workspace_id, input_key, source_type, source_id, content_text, content_hash)
         VALUES ($1, $2, $3, $4, 'fixture text', $5) RETURNING id`,
        [context.workspaceId, `guard-${sourceType}-${sourceId}`, sourceType, sourceId, `hash-${sourceId}`],
      );
      const batch = await query<{ id: string }>(
        `INSERT INTO embedding_batches (workspace_id, embedding_space_id, batch_key, run_type, status, item_count, success_count, failure_count, completed_at)
         VALUES ($1, $2, $3, 'PRIMARY', 'COMPLETED', 1, 1, 0, NOW()) RETURNING id`,
        [context.workspaceId, space.rows[0].id, `guard-batch-${sourceId}`],
      );
      await query(`INSERT INTO embedding_batch_items (workspace_id, embedding_batch_id, embedding_input_id, status) VALUES ($1, $2, $3, 'COMPLETED')`, [context.workspaceId, batch.rows[0].id, input.rows[0].id]);
      await query(
        `INSERT INTO semantic_embeddings (workspace_id, embedding_space_id, embedding_input_id, embedding_batch_id, vector_dimensions, embedding_values, vector_checksum)
         VALUES ($1, $2, $3, $4, $6, ARRAY(SELECT 0.1::double precision FROM generate_series(1, $6::int)), $5)`,
        [context.workspaceId, space.rows[0].id, input.rows[0].id, batch.rows[0].id, `guard-sum-${sourceId}`, dimensions],
      );
    }

    it('some requirements embedded, some not: no match run, no score, the job waits; once every requirement is embedded it matches', async () => {
      if (!context) throw new Error('Integration test fixture context is not initialized.');
      await query(`UPDATE embedding_spaces SET active = FALSE WHERE workspace_id = $1`, [context.workspaceId]);
      await seedEmbeddingSpaces(getClient(), { context });
      await query(`UPDATE canonical_jobs SET processing_state = 'LANE_ROUTED', processing_status = 'LANE_ROUTED', profile_match_status = NULL WHERE id = $1`, [canonicalJobId]);
      await query(`DELETE FROM requirement_evidence_matches WHERE match_run_id IN (SELECT id FROM match_runs WHERE canonical_job_id = $1)`, [canonicalJobId]);
      await query(`DELETE FROM match_runs WHERE canonical_job_id = $1`, [canonicalJobId]);

      // A second requirement that never gets an embedding makes the set partial once the first is embedded.
      const set = await query<{ job_version_id: string; requirement_set_id: string; id: string }>(
        `SELECT job_version_id, requirement_set_id, id FROM job_requirements WHERE canonical_job_id = $1 ORDER BY requirement_key LIMIT 1`, [canonicalJobId]);
      const first = set.rows[0];
      const second = await query<{ id: string }>(
        `INSERT INTO job_requirements (workspace_id, canonical_job_id, job_version_id, requirement_set_id, requirement_key, requirement_type, importance,
                                       requirement_text, quote_text, extractor_type, extractor_version, confidence, status, structured_value)
         VALUES ($1, $2, $3, $4, 'domain-2', 'DOMAIN', 'MUST', 'Experience with model evaluation', 'model evaluation', 'DETERMINISTIC', 'deterministic-v1', 1, 'VALIDATED', $5::jsonb)
         RETURNING id`,
        [context.workspaceId, canonicalJobId, first.job_version_id, first.requirement_set_id, JSON.stringify({ domain_key: 'MODEL_EVALUATION' })],
      );
      const fact = await query<{ node: string }>(`SELECT COALESCE(fact_revision_id, id)::text AS node FROM profile_facts WHERE fact_key = 'fraud-domain' ORDER BY created_at DESC LIMIT 1`);
      await publishEmbedding('PROFILE_FACT', fact.rows[0].node);
      await publishEmbedding('JOB_REQUIREMENT', first.id); // the second requirement stays unembedded

      const waiting = await runDeterministicMatcher(getClient(), { context, canonicalJobIds: [canonicalJobId] });
      expect(waiting).toMatchObject({ matchedJobs: 0, errors: 0, blockedOnRequirementEmbeddings: [canonicalJobId] });
      const runs = await query(`SELECT id FROM match_runs WHERE canonical_job_id = $1`, [canonicalJobId]);
      expect(runs.rows).toEqual([]); // no match run exists while a requirement has no embedding
      const waitingJob = await query(`SELECT processing_state, deterministic_match_score, deterministic_match_coverage FROM canonical_jobs WHERE id = $1`, [canonicalJobId]);
      expect(waitingJob.rows[0]).toEqual({ processing_state: 'LANE_ROUTED', deterministic_match_score: null, deterministic_match_coverage: null });

      await publishEmbedding('JOB_REQUIREMENT', second.rows[0].id);
      const matched = await runDeterministicMatcher(getClient(), { context, canonicalJobIds: [canonicalJobId] });
      expect(matched).toMatchObject({ matchedJobs: 1, errors: 0, blockedOnRequirementEmbeddings: [] });
      const run = await query(`SELECT status, embedding_space_id, requirement_count FROM match_runs WHERE canonical_job_id = $1`, [canonicalJobId]);
      expect(run.rows).toHaveLength(1);
      expect(run.rows[0]).toMatchObject({ status: 'COMPLETED', requirement_count: 2 });
      expect(run.rows[0].embedding_space_id).not.toBeNull();
    });
  });
});
