import { describe, expect, it, vi } from 'vitest';
import { buildEmbeddingInputs } from '../../embeddings/inputBuilder.js';
import type { WorkspaceContext } from '../../workspace/context.js';

describe('buildEmbeddingInputs', () => {
  it('generates embedding inputs from job_requirements and profile_facts', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM job_requirements jr')) {
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              requirement_type: 'EXPERIENCE_YEARS',
              requirement_text: 'At least 5 years of experience',
              quote_text: '5 years of experience',
              structured_value: { minimum_years: 5 },
            },
          ],
        };
      }
      if (sql.includes('FROM profile_facts pf')) {
        return {
          rows: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              fact_type: 'PROJECT',
              statement: 'Built production data pipelines',
              structured_value: { throughput: '2M/day' },
              evidence_tier: 'PROFESSIONAL_PRODUCTION',
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO embedding_inputs')) {
        return { rows: [{ id: 'new-embedding-input' }], rowCount: 1 };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    const summary = await buildEmbeddingInputs(fakePool, 20, { context });

    expect(summary.inserted).toBe(2);
    expect(summary.fromRequirements).toBe(1);
    expect(summary.fromProfileFacts).toBe(1);

    const calls = query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.filter((sql) => sql.includes('INSERT INTO embedding_inputs')).length).toBe(2);
  });

  it('can scope job embedding inputs to a single job version without profile facts', async () => {
    const jobVersionId = '33333333-3333-4333-8333-333333333333';
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM job_requirements jr')) {
        expect(params?.[2]).toEqual([jobVersionId]);
        expect(sql).toContain('jv.id = ANY($3::uuid[])');
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              requirement_type: 'DOMAIN',
              requirement_text: 'Machine learning systems',
              quote_text: null,
              structured_value: { domain_key: 'MACHINE_LEARNING' },
            },
          ],
        };
      }
      if (sql.includes('FROM profile_facts pf')) {
        throw new Error('profile facts should not be queried for scoped job-version builds');
      }
      if (sql.includes('FROM canonical_jobs c')) {
        expect(params?.[2]).toEqual([jobVersionId]);
        expect(sql).toContain('jv.id = ANY($3::uuid[])');
        return {
          rows: [
            {
              id: jobVersionId,
              normalized_title: 'AI Engineer',
              description_text: 'Build AI systems',
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO embedding_inputs')) {
        return { rows: [{ id: 'new-embedding-input' }], rowCount: 1 };
      }
      return { rows: [] };
    });

    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    const summary = await buildEmbeddingInputs({ query } as any, 20, {
      context,
      jobVersionIds: [jobVersionId],
      includeLanePrototypes: false,
    });

    expect(summary.fromRequirements).toBe(1);
    expect(summary.fromProfileFacts).toBe(0);
    expect(summary.fromJobVersions).toBe(1);
  });

  it('can scope a publication batch to profile facts and requirements only', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM job_requirements jr')) {
        return { rows: [{
          id: '11111111-1111-4111-8111-111111111111',
          requirement_type: 'DOMAIN',
          requirement_text: 'Current validated requirement',
          quote_text: null,
          structured_value: null,
        }] };
      }
      if (sql.includes('FROM profile_facts pf')) {
        return { rows: [{
          id: '22222222-2222-4222-8222-222222222222',
          embedding_node_id: '22222222-2222-4222-8222-222222222222',
          fact_type: 'SKILL',
          statement: 'Active v6 profile fact',
          structured_value: null,
          evidence_tier: 'PROFESSIONAL_PRODUCTION',
        }] };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        throw new Error('job-version descriptions are out of scope for this publication');
      }
      if (sql.includes('INSERT INTO embedding_inputs')) return { rows: [{ id: 'embedding-input' }], rowCount: 1 };
      return { rows: [] };
    });

    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };
    const result = await buildEmbeddingInputs({ query } as any, 2000, {
      context,
      jobVersionIds: ['33333333-3333-4333-8333-333333333333'],
      includeProfileFacts: true,
      includeLanePrototypes: false,
      includeJobVersions: false,
    });

    expect(result.fromRequirements).toBe(1);
    expect(result.fromProfileFacts).toBe(1);
    expect(result.fromJobVersions).toBe(0);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM canonical_jobs c'))).toBe(false);
  });

  it('can publish only profile-v6 facts and validated requirements for a scoped cohort', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM job_requirements jr')) {
        return { rows: [{
          id: '11111111-1111-4111-8111-111111111111',
          requirement_type: 'DOMAIN',
          requirement_text: 'Current validated requirement',
          quote_text: null,
          structured_value: null,
        }] };
      }
      if (sql.includes('FROM profile_facts pf')) {
        expect(sql).toContain('pf.profile_version_id = $2::uuid');
        expect(params?.[1]).toBe('77777777-7777-4777-8777-777777777777');
        return { rows: [{
          id: '22222222-2222-4222-8222-222222222222',
          embedding_node_id: '22222222-2222-4222-8222-222222222222',
          fact_type: 'SKILL',
          statement: 'Active profile fact',
          structured_value: null,
          evidence_tier: 'PROFESSIONAL_PRODUCTION',
        }] };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        throw new Error('job-version embedding inputs are outside the selected publication scope');
      }
      if (sql.includes('INSERT INTO embedding_inputs')) {
        return { rows: [{ id: 'embedding-input' }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    const summary = await buildEmbeddingInputs({ query } as any, 2500, {
      context,
      jobVersionIds: ['33333333-3333-4333-8333-333333333333'],
      profileVersionId: '77777777-7777-4777-8777-777777777777',
      includeProfileFacts: true,
      includeLanePrototypes: false,
      includeJobVersions: false,
    });

    expect(summary.fromRequirements).toBe(1);
    expect(summary.fromProfileFacts).toBe(1);
    expect(summary.fromJobVersions).toBe(0);
    expect(query.mock.calls.some(([sql]) => sql.includes('FROM canonical_jobs c'))).toBe(false);
  });

  it('supersedes changed source content without deleting the prior embedding input', async () => {
    const requirementId = '44444444-4444-4444-8444-444444444444';
    const previousHash = 'previous-content-hash';
    const query = vi.fn(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM job_requirements jr')) {
        return {
          rows: [
            {
              id: requirementId,
              requirement_type: 'MUST_HAVE',
              requirement_text: 'TypeScript and PostgreSQL',
              quote_text: null,
              structured_value: null,
            },
          ],
        };
      }
      if (sql.includes('SELECT content_hash')) {
        return { rows: [{ content_hash: previousHash }] };
      }
      if (sql.includes('INSERT INTO embedding_inputs')) {
        return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }], rowCount: 1 };
      }
      return { rows: [] };
    });

    const context: WorkspaceContext = {
      workspaceId: 'workspace-id-1',
      workspaceKey: 'default',
      userId: 'user-id-1',
      userKey: 'local_user',
      role: 'OWNER',
    };

    const summary = await buildEmbeddingInputs({ query } as any, 20, {
      context,
      includeProfileFacts: false,
      includeLanePrototypes: false,
    });

    expect(summary.inserted).toBe(1);
    expect(summary.fromRequirements).toBe(1);

    const calls = query.mock.calls.map((call) => String(call[0]));
    expect(calls.some((sql) => sql.includes('SET is_current = FALSE'))).toBe(true);
    expect(calls.some((sql) => sql.includes('DELETE FROM embedding_inputs'))).toBe(false);
    expect(calls.filter((sql) => sql.includes('INSERT INTO embedding_inputs')).length).toBe(1);
  });
});
