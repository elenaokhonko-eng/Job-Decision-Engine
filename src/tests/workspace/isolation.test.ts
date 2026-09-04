import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../db/migrate.js';
import { resolveWorkspaceContext, type WorkspaceContext } from '../../workspace/context.js';
import { runDeterministicMatcher } from '../../pipeline/deterministicMatcher.js';

const DB_URL = process.env.DATABASE_URL || '';
const isCI = DB_URL.includes('localhost') || DB_URL.includes('127.0.0.1');
const skipReal = !DB_URL || !isCI;

let pool: pg.Pool;
let client: pg.PoolClient;
let schemaName: string;

async function q(sql: string, params?: any[]) {
  return client.query(sql, params);
}

describe.skipIf(skipReal)('P2: workspace authorization + isolation', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    client = await pool.connect();

    schemaName = `p2_ws_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    await q(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await q(`SET search_path TO ${schemaName}`);

    await runMigrations(client);
  });

  afterAll(async () => {
    try {
      await q(`SET search_path TO public`);
      await q(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('rejects resolving context without an ACTIVE membership', async () => {
    await q(`INSERT INTO workspaces (workspace_key, display_name) VALUES ('alpha', 'Alpha') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO workspaces (workspace_key, display_name) VALUES ('beta', 'Beta') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO workspace_users (user_key, display_name) VALUES ('alice', 'Alice') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO workspace_users (user_key, display_name) VALUES ('bob', 'Bob') ON CONFLICT DO NOTHING`);

    const alphaId = (await q(`SELECT id FROM workspaces WHERE workspace_key = 'alpha' LIMIT 1`)).rows[0].id as string;
    const betaId = (await q(`SELECT id FROM workspaces WHERE workspace_key = 'beta' LIMIT 1`)).rows[0].id as string;
    const aliceId = (await q(`SELECT id FROM workspace_users WHERE user_key = 'alice' LIMIT 1`)).rows[0].id as string;
    const bobId = (await q(`SELECT id FROM workspace_users WHERE user_key = 'bob' LIMIT 1`)).rows[0].id as string;

    await q(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'OWNER', 'ACTIVE')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [alphaId, aliceId]
    );
    await q(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'OWNER', 'ACTIVE')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [betaId, bobId]
    );

    const ok = await resolveWorkspaceContext(client as any, { workspaceKey: 'alpha', userKey: 'alice' });
    expect(ok.workspaceId).toBe(alphaId);
    expect(ok.userId).toBe(aliceId);

    await expect(
      resolveWorkspaceContext(client as any, { workspaceKey: 'alpha', userKey: 'bob' })
    ).rejects.toThrow(/Unauthorized/);

    await expect(
      resolveWorkspaceContext(client as any, { workspaceKey: 'beta', userKey: 'alice' })
    ).rejects.toThrow(/Unauthorized/);
  });

  it('does not match facts/jobs across workspaces', async () => {
    const alphaId = (await q(`SELECT id FROM workspaces WHERE workspace_key = 'alpha' LIMIT 1`)).rows[0].id as string;
    const betaId = (await q(`SELECT id FROM workspaces WHERE workspace_key = 'beta' LIMIT 1`)).rows[0].id as string;
    const aliceId = (await q(`SELECT id FROM workspace_users WHERE user_key = 'alice' LIMIT 1`)).rows[0].id as string;
    const bobId = (await q(`SELECT id FROM workspace_users WHERE user_key = 'bob' LIMIT 1`)).rows[0].id as string;

    const alphaCtx: WorkspaceContext = {
      workspaceId: alphaId,
      workspaceKey: 'alpha',
      userId: aliceId,
      userKey: 'alice',
      role: 'OWNER',
    };

    const betaCtx: WorkspaceContext = {
      workspaceId: betaId,
      workspaceKey: 'beta',
      userId: bobId,
      userKey: 'bob',
      role: 'OWNER',
    };

    const makeProfile = async (workspaceId: string, profileKey: string) => {
      const cpId = (
        await q(
          `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [workspaceId, profileKey, profileKey]
        )
      ).rows[0].id as string;

      const pvId = (
        await q(
          `INSERT INTO profile_versions (workspace_id, candidate_profile_id, version_number, source_hash, status)
           VALUES ($1, $2, 1, 'test-hash', 'ACTIVE')
           RETURNING id`,
          [workspaceId, cpId]
        )
      ).rows[0].id as string;

      await q(
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
           confidentiality
         )
         VALUES ($1, $2, NULL, 'fact_python', 'SKILL', 'Python', NULL, 'PROFESSIONAL_PRODUCTION', 'SELF_ATTESTED', NULL, NULL, TRUE, 'PRIVATE_REUSABLE')`,
        [workspaceId, pvId]
      );

      return { cpId, pvId };
    };

    const makeJob = async (workspaceId: string, company: string) => {
      const canonicalId = (
        await q(
          `INSERT INTO canonical_jobs (
             workspace_id,
             company_name,
             normalized_title,
             canonical_url,
             processing_state,
             processing_status,
             primary_lane
           )
           VALUES ($1, $2, 'data engineer', $3, 'LANE_ROUTED', 'LANE_ROUTED', 'CORE_AI_DATA')
           RETURNING id`,
          [workspaceId, company, `https://example.com/${company}`]
        )
      ).rows[0].id as string;

      const versionId = (
        await q(
          `INSERT INTO job_versions (workspace_id, canonical_job_id, content_hash, description_text)
           VALUES ($1, $2, $3, 'desc')
           RETURNING id`,
          [workspaceId, canonicalId, `hash-${company}-${Math.random()}`]
        )
      ).rows[0].id as string;

      await q(
        `INSERT INTO job_requirements (
           workspace_id,
           canonical_job_id,
           job_version_id,
           requirement_key,
           requirement_type,
           importance,
           requirement_text,
           quote_text,
           quote_start_offset,
           quote_end_offset,
           structured_value,
           extractor_type,
           extractor_version,
           confidence,
           status
         )
         VALUES ($1, $2, $3, 'REQ-1', 'DOMAIN', 'MUST', 'Python', NULL, NULL, NULL, NULL, 'DETERMINISTIC', 'test', 1.0, 'VALIDATED')`,
        [workspaceId, canonicalId, versionId]
      );

      return { canonicalId, versionId };
    };

    await makeProfile(alphaId, 'p_alpha');
    await makeProfile(betaId, 'p_beta');
    const alphaJob = await makeJob(alphaId, 'AlphaCo');
    const betaJob = await makeJob(betaId, 'BetaCo');

    await runDeterministicMatcher(client, { context: alphaCtx });

    const betaAfterAlpha = await q(
      `SELECT COALESCE(processing_state, processing_status) AS st, latest_match_run_id
       FROM canonical_jobs
       WHERE id = $1`,
      [betaJob.canonicalId]
    );
    expect(betaAfterAlpha.rows[0].st).toBe('LANE_ROUTED');
    expect(betaAfterAlpha.rows[0].latest_match_run_id).toBeNull();

    const alphaAfterAlpha = await q(
      `SELECT COALESCE(processing_state, processing_status) AS st, latest_match_run_id
       FROM canonical_jobs
       WHERE id = $1`,
      [alphaJob.canonicalId]
    );
    expect(alphaAfterAlpha.rows[0].st).toBe('MATCHED');
    expect(alphaAfterAlpha.rows[0].latest_match_run_id).not.toBeNull();

    await runDeterministicMatcher(client, { context: betaCtx });

    const betaAfterBeta = await q(
      `SELECT COALESCE(processing_state, processing_status) AS st, latest_match_run_id
       FROM canonical_jobs
       WHERE id = $1`,
      [betaJob.canonicalId]
    );
    expect(betaAfterBeta.rows[0].st).toBe('MATCHED');
    expect(betaAfterBeta.rows[0].latest_match_run_id).not.toBeNull();
  });

  it('prevents updates to immutable revision tables', async () => {
    const alphaId = (await q(`SELECT id FROM workspaces WHERE workspace_key = 'alpha' LIMIT 1`)).rows[0].id as string;
    const aliceId = (await q(`SELECT id FROM workspace_users WHERE user_key = 'alice' LIMIT 1`)).rows[0].id as string;

    const defId = (
      await q(
        `INSERT INTO config_definitions (workspace_id, config_key, config_type, description, created_by_user_id)
         VALUES ($1, 'sources', 'SOURCES', 'test', $2)
         RETURNING id`,
        [alphaId, aliceId]
      )
    ).rows[0].id as string;

    const revId = (
      await q(
        `INSERT INTO config_revisions (config_definition_id, revision_number, content_hash, content, created_by_user_id)
         VALUES ($1, 1, 'hash', '{}'::jsonb, $2)
         RETURNING id`,
        [defId, aliceId]
      )
    ).rows[0].id as string;

    await expect(q(`UPDATE config_revisions SET content = '{"x":1}'::jsonb WHERE id = $1`, [revId])).rejects.toThrow();

    const cpId = (
      await q(
        `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
         VALUES ($1, 'p_alpha_2', 'p_alpha_2')
         RETURNING id`,
        [alphaId]
      )
    ).rows[0].id as string;

    const identityId = (
      await q(
        `INSERT INTO profile_fact_identities (workspace_id, candidate_profile_id, fact_key)
         VALUES ($1, $2, 'fact_1')
         RETURNING id`,
        [alphaId, cpId]
      )
    ).rows[0].id as string;

    const factRevId = (
      await q(
        `INSERT INTO profile_fact_revisions (
           workspace_id,
           fact_identity_id,
           revision_number,
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
         VALUES ($1, $2, 1, 'hash', 'SKILL', 'Python', NULL, 'PROFESSIONAL_PRODUCTION', 'SELF_ATTESTED', NULL, NULL, TRUE, 'PRIVATE_REUSABLE', $3)
         RETURNING id`,
        [alphaId, identityId, aliceId]
      )
    ).rows[0].id as string;

    await expect(q(`UPDATE profile_fact_revisions SET statement = 'Java' WHERE id = $1`, [factRevId])).rejects.toThrow();
  });
});
