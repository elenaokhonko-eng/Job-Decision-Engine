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
});
