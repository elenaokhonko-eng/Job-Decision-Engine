import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { runMigrations } from '../../db/migrate.js';
import { applyApprovedProfileUpdateSession } from '../../profile/updateSession.js';
import type { WorkspaceContext } from '../../workspace/context.js';

const DB_URL = process.env.DATABASE_URL || '';
const isCI = DB_URL.includes('localhost') || DB_URL.includes('127.0.0.1');
const skipReal = !DB_URL || !isCI;

let pool: pg.Pool;
let client: pg.PoolClient;
let schemaName: string;

async function q(sql: string, params?: any[]) {
  return client.query(sql, params);
}

describe.skipIf(skipReal)('P3: profile update sessions (optimistic + idempotent apply)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL });
    client = await pool.connect();

    schemaName = `p3_profile_update_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
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

  it('applies approved operations exactly once and returns CONFLICT for stale base profile versions', async () => {
    await q(
      `INSERT INTO workspaces (workspace_key, display_name)
       VALUES ('alpha', 'Alpha')
       ON CONFLICT (workspace_key) DO NOTHING`
    );
    await q(
      `INSERT INTO workspace_users (user_key, display_name)
       VALUES ('alice', 'Alice')
       ON CONFLICT (user_key) DO NOTHING`
    );

    const workspaceId = (await q(`SELECT id FROM workspaces WHERE workspace_key = 'alpha' LIMIT 1`))
      .rows[0].id as string;
    const userId = (await q(`SELECT id FROM workspace_users WHERE user_key = 'alice' LIMIT 1`)).rows[0]
      .id as string;

    await q(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
       VALUES ($1, $2, 'OWNER', 'ACTIVE')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId]
    );

    const ctx: WorkspaceContext = {
      workspaceId,
      workspaceKey: 'alpha',
      userId,
      userKey: 'alice',
      role: 'OWNER',
    };

    const candidateProfileId = (
      await q(
        `INSERT INTO candidate_profiles (workspace_id, profile_key, display_name)
         VALUES ($1, 'p_alpha', 'Alpha Profile')
         RETURNING id`,
        [workspaceId]
      )
    ).rows[0].id as string;

    const baseProfileVersionId = (
      await q(
        `INSERT INTO profile_versions (
           workspace_id,
           candidate_profile_id,
           version_number,
           schema_version,
           source_hash,
           status
         )
         VALUES ($1, $2, 1, '2.2.0', 'hash_base', 'ACTIVE')
         RETURNING id`,
        [workspaceId, candidateProfileId]
      )
    ).rows[0].id as string;

    const engagementId = (
      await q(
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
         VALUES (
           $1, $2, 'e1', 'Alpha Org', NULL, 'Engineer', 'EMPLOYEE', 'PROFESSIONAL_PRODUCTION', NULL,
           '2024-01-01', NULL, TRUE, NULL, NULL, NULL, 'Did things', 'SELF_ATTESTED'
         )
         RETURNING id`,
        [workspaceId, baseProfileVersionId]
      )
    ).rows[0].id as string;

    const identityId = (
      await q(
        `INSERT INTO profile_fact_identities (workspace_id, candidate_profile_id, fact_key)
         VALUES ($1, $2, 'skill_python')
         RETURNING id`,
        [workspaceId, candidateProfileId]
      )
    ).rows[0].id as string;

    const revisionId = (
      await q(
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
         VALUES (
           $1, $2, 1, '2.2.0', 'hash_r1', 'SKILL', 'Python',
           NULL, 'PROFESSIONAL_PRODUCTION', 'SELF_ATTESTED', NULL, NULL, TRUE, 'PRIVATE_REUSABLE', $3
         )
         RETURNING id`,
        [workspaceId, identityId, userId]
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
         confidentiality,
         fact_identity_id,
         fact_revision_id
       )
       VALUES (
         $1, $2, $3, 'skill_python', 'SKILL', 'Python', NULL,
         'PROFESSIONAL_PRODUCTION', 'SELF_ATTESTED', NULL, NULL, TRUE, 'PRIVATE_REUSABLE', $4, $5
       )`,
      [workspaceId, baseProfileVersionId, engagementId, identityId, revisionId]
    );

    const sessionId = (
      await q(
        `INSERT INTO profile_update_sessions (
           workspace_id,
           candidate_profile_id,
           base_profile_version_id,
           status,
           created_by_user_id
         )
         VALUES ($1, $2, $3, 'OPEN', $4)
         RETURNING id`,
        [workspaceId, candidateProfileId, baseProfileVersionId, userId]
      )
    ).rows[0].id as string;

    const reviseOpId = (
      await q(
        `INSERT INTO profile_update_proposed_operations (
           workspace_id,
           session_id,
           operation_type,
           operation_key,
           target_fact_key,
           payload
         )
         VALUES ($1, $2, 'REVISE_FACT', 'revise-1', 'skill_python', $3::jsonb)
         RETURNING id`,
        [
          workspaceId,
          sessionId,
          JSON.stringify({
            fact_key: 'skill_python',
            fact_type: 'SKILL',
            statement: 'Python + SQL',
            structured_value: null,
            evidence_tier: 'PROFESSIONAL_PRODUCTION',
            verification_status: 'SELF_ATTESTED',
            start_date: null,
            end_date: null,
            is_current: true,
            confidentiality: 'PRIVATE_REUSABLE',
          }),
        ]
      )
    ).rows[0].id as string;

    const addOpId = (
      await q(
        `INSERT INTO profile_update_proposed_operations (
           workspace_id,
           session_id,
           operation_type,
           operation_key,
           target_fact_key,
           payload
         )
         VALUES ($1, $2, 'ADD_FACT', 'add-1', NULL, $3::jsonb)
         RETURNING id`,
        [
          workspaceId,
          sessionId,
          JSON.stringify({
            fact_key: 'project_alpha',
            fact_type: 'PROJECT',
            statement: 'Built alpha system',
            structured_value: null,
            evidence_tier: 'PROFESSIONAL_PRODUCTION',
            verification_status: 'SELF_ATTESTED',
            start_date: null,
            end_date: null,
            is_current: true,
            confidentiality: 'PRIVATE_REUSABLE',
            engagement_key: 'e1',
          }),
        ]
      )
    ).rows[0].id as string;

    await q(
      `INSERT INTO profile_update_operation_approvals (
         workspace_id,
         session_id,
         operation_id,
         approved_by_user_id,
         decision
       )
       VALUES ($1, $2, $3, $4, 'APPROVED')
       ON CONFLICT (operation_id) DO NOTHING`,
      [workspaceId, sessionId, reviseOpId, userId]
    );
    await q(
      `INSERT INTO profile_update_operation_approvals (
         workspace_id,
         session_id,
         operation_id,
         approved_by_user_id,
         decision
       )
       VALUES ($1, $2, $3, $4, 'APPROVED')
       ON CONFLICT (operation_id) DO NOTHING`,
      [workspaceId, sessionId, addOpId, userId]
    );

    const applied = await applyApprovedProfileUpdateSession(sessionId, client, { context: ctx });
    expect(applied.status).toBe('APPLIED');
    if (applied.status !== 'APPLIED') {
      throw new Error('Expected APPLIED');
    }

    expect(applied.appliedProfileVersionId).not.toBe(baseProfileVersionId);
    expect(applied.alreadyApplied).toBe(false);

    const versions = await q(
      `SELECT version_number, status
       FROM profile_versions
       WHERE workspace_id = $1 AND candidate_profile_id = $2
       ORDER BY version_number ASC`,
      [workspaceId, candidateProfileId]
    );
    expect(versions.rows.map((r) => r.status)).toEqual(['RETIRED', 'ACTIVE']);

    const facts = await q(
      `SELECT fact_key, statement
       FROM profile_facts
       WHERE workspace_id = $1 AND profile_version_id = $2
       ORDER BY fact_key ASC`,
      [workspaceId, applied.appliedProfileVersionId]
    );
    expect(facts.rows).toHaveLength(2);
    expect(facts.rows.find((r) => r.fact_key === 'skill_python')?.statement).toBe('Python + SQL');
    expect(facts.rows.find((r) => r.fact_key === 'project_alpha')?.statement).toBe('Built alpha system');

    const appliedAgain = await applyApprovedProfileUpdateSession(sessionId, client, { context: ctx });
    expect(appliedAgain.status).toBe('APPLIED');
    if (appliedAgain.status !== 'APPLIED') {
      throw new Error('Expected APPLIED');
    }
    expect(appliedAgain.alreadyApplied).toBe(true);
    expect(appliedAgain.appliedProfileVersionId).toBe(applied.appliedProfileVersionId);

    const versionCount = await q(
      `SELECT COUNT(*)::int AS n
       FROM profile_versions
       WHERE workspace_id = $1 AND candidate_profile_id = $2`,
      [workspaceId, candidateProfileId]
    );
    expect(versionCount.rows[0].n).toBe(2);

    const staleSessionId = (
      await q(
        `INSERT INTO profile_update_sessions (
           workspace_id,
           candidate_profile_id,
           base_profile_version_id,
           status,
           created_by_user_id
         )
         VALUES ($1, $2, $3, 'OPEN', $4)
         RETURNING id`,
        [workspaceId, candidateProfileId, baseProfileVersionId, userId]
      )
    ).rows[0].id as string;

    const conflict = await applyApprovedProfileUpdateSession(staleSessionId, client, { context: ctx });
    expect(conflict.status).toBe('CONFLICT');
  });
});

