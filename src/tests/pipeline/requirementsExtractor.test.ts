import { describe, expect, it, vi } from 'vitest';
import { runRequirementsExtraction } from '../../pipeline/requirementsExtractor.js';
import type { WorkspaceContext } from '../../workspace/context.js';

const context: WorkspaceContext = {
  workspaceId: 'workspace-id-1',
  workspaceKey: 'default',
  userId: 'user-id-1',
  userKey: 'local_user',
  role: 'OWNER',
};

describe('runRequirementsExtraction', () => {
  it('persists deterministic requirements and completes stage state', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM canonical_jobs c') && sql.includes('latest_job_version_id')) {
        return {
          rows: [
            {
              workspace_id: context.workspaceId,
              canonical_job_id: '11111111-1111-4111-8111-111111111111',
              job_version_id: '22222222-2222-4222-8222-222222222222',
              content_hash: 'content-hash-1',
              description_text:
                'Mandatory 5 days per week in office. Must have at least 6 years of experience.',
            },
          ],
        };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_set_identities')) {
        return { rows: [{ id: 'req-ident-1' }] };
      }
      if (sql.includes('SELECT active_requirement_set_id') && sql.includes('FROM job_versions')) {
        return { rows: [{ active_requirement_set_id: null }] };
      }
      if (sql.includes('SELECT (COALESCE(MAX(revision_number)')) {
        return { rows: [{ next_revision: 1 }] };
      }
      if (sql.includes('INSERT INTO requirement_sets')) {
        return { rows: [{ id: 'req-set-1' }] };
      }
      if (sql.includes('UPDATE job_versions') && sql.includes('active_requirement_set_id')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: 'det-run-id-1' }] };
      }
      if (sql.includes('SELECT rs.id') && sql.includes('FROM requirement_sets rs')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO job_requirements')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE requirement_extraction_runs') && Array.isArray(params) && params[0] === 'det-run-id-1') {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { query, connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const summary = await runRequirementsExtraction(fakePool, { context });

    expect(summary.discovered).toBe(1);
    expect(summary.processed).toBe(1);
    expect(summary.errors).toBe(0);
    expect(summary.deterministicInserted).toBeGreaterThanOrEqual(2);

    const calls = query.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
    expect(calls.some((sql) => sql.includes('INSERT INTO job_requirements'))).toBe(true);
    expect(calls.some((sql) => sql.includes('INSERT INTO pipeline_stage_events'))).toBe(true);
  });

  it('accepts an already-connected pg client without calling connect() or releasing it', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM canonical_jobs c') && sql.includes('latest_job_version_id')) {
        return {
          rows: [
            {
              workspace_id: context.workspaceId,
              canonical_job_id: '11111111-1111-4111-8111-111111111111',
              job_version_id: '22222222-2222-4222-8222-222222222222',
              content_hash: 'content-hash-2',
              description_text: 'Must have work rights.',
            },
          ],
        };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_set_identities')) {
        return { rows: [{ id: 'req-ident-2' }] };
      }
      if (sql.includes('SELECT active_requirement_set_id') && sql.includes('FROM job_versions')) {
        return { rows: [{ active_requirement_set_id: null }] };
      }
      if (sql.includes('SELECT (COALESCE(MAX(revision_number)')) {
        return { rows: [{ next_revision: 1 }] };
      }
      if (sql.includes('INSERT INTO requirement_sets')) {
        return { rows: [{ id: 'req-set-2' }] };
      }
      if (sql.includes('UPDATE job_versions') && sql.includes('active_requirement_set_id')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: 'det-run-id-client' }] };
      }
      if (sql.includes('SELECT rs.id') && sql.includes('FROM requirement_sets rs')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO job_requirements')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE requirement_extraction_runs') && Array.isArray(params) && params[0] === 'det-run-id-client') {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const connect = vi.fn(() => {
      throw new Error('should not call connect on an already-connected client');
    });
    const release = vi.fn(() => undefined);
    const fakeClient = { query, connect, release } as any;

    const summary = await runRequirementsExtraction(fakeClient, { context });

    expect(summary.discovered).toBe(1);
    expect(summary.processed).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('records quoted extraction failures without failing deterministic completion', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM canonical_jobs c') && sql.includes('latest_job_version_id')) {
        return {
          rows: [
            {
              workspace_id: context.workspaceId,
              canonical_job_id: '11111111-1111-4111-8111-111111111111',
              job_version_id: '22222222-2222-4222-8222-222222222222',
              content_hash: 'content-hash-3',
              description_text: 'Hybrid role with regular team collaboration.',
            },
          ],
        };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_set_identities')) {
        return { rows: [{ id: 'req-ident-3' }] };
      }
      if (sql.includes('SELECT active_requirement_set_id') && sql.includes('FROM job_versions')) {
        return { rows: [{ active_requirement_set_id: null }] };
      }
      if (sql.includes('SELECT (COALESCE(MAX(revision_number)')) {
        return { rows: [{ next_revision: 1 }] };
      }
      if (sql.includes('INSERT INTO requirement_sets')) {
        return { rows: [{ id: 'req-set-3' }] };
      }
      if (sql.includes('UPDATE job_versions') && sql.includes('active_requirement_set_id')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: 'det-run-id-2' }] };
      }
      if (sql.includes('SELECT rs.id') && sql.includes('FROM requirement_sets rs')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO job_requirements')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'LLM_QUOTED'")) {
        return { rows: [{ id: 'quoted-run-id-2' }] };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { query, connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const summary = await runRequirementsExtraction(fakePool, {
      context,
      quotedExtractor: async () => ({
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        payload: {
          schema_version: '2.0',
          requirements: [
            {
              requirement_key: 'R-001',
              requirement_type: 'TRAVEL',
              importance: 'MUST',
              requirement_text: 'Role requires up to 25% travel.',
              quote_text: 'up to 25% travel',
              confidence: 0.8,
            },
          ],
        },
      }),
    });

    expect(summary.processed).toBe(1);
    expect(summary.errors).toBe(0);
    expect(summary.quotedFailed).toBe(1);
    expect(summary.details[0].warning).toContain('Quote not found');
    expect(summary.metrics.quotedAttempted).toBe(1);
    expect(summary.metrics.quotedValidationFailures).toBe(1);
    expect(summary.metrics.quotedSucceeded).toBe(0);
    expect(summary.metrics.quotedPassRate).toBe(0);
  });

  it('tracks quoted provider/model retry metrics and pass-rate', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM canonical_jobs c') && sql.includes('latest_job_version_id')) {
        return {
          rows: [
            {
              workspace_id: context.workspaceId,
              canonical_job_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
              job_version_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
              content_hash: 'content-hash-4',
              description_text:
                'Hybrid role. Work rights required. Machine learning engineer for platform systems.',
            },
          ],
        };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_set_identities')) {
        return { rows: [{ id: 'req-ident-4' }] };
      }
      if (sql.includes('SELECT active_requirement_set_id') && sql.includes('FROM job_versions')) {
        return { rows: [{ active_requirement_set_id: null }] };
      }
      if (sql.includes('SELECT (COALESCE(MAX(revision_number)')) {
        return { rows: [{ next_revision: 1 }] };
      }
      if (sql.includes('INSERT INTO requirement_sets')) {
        return { rows: [{ id: 'req-set-4' }] };
      }
      if (sql.includes('UPDATE job_versions') && sql.includes('active_requirement_set_id')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: 'det-run-id-3' }] };
      }
      if (sql.includes('SELECT rs.id') && sql.includes('FROM requirement_sets rs')) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO job_requirements')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'LLM_QUOTED'")) {
        return { rows: [{ id: 'quoted-run-id-3' }] };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { query, connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const summary = await runRequirementsExtraction(fakePool, {
      context,
      quotedExtractor: async () => ({
        provider: 'openai',
        model: 'gpt-4o-mini',
        attempts: 2,
        errors: [{ provider: 'gemini', model: 'gemini-2.0-flash', error: '429' }],
        payload: {
          schema_version: '2.0',
          requirements: [
            {
              requirement_key: 'R-001',
              requirement_type: 'WORK_AUTH',
              importance: 'MUST',
              requirement_text: 'Work rights required.',
              quote_text: 'Work rights required',
              confidence: 0.91,
            },
          ],
        },
      }),
    });

    expect(summary.metrics.quotedAttempted).toBe(1);
    expect(summary.metrics.quotedSucceeded).toBe(1);
    expect(summary.metrics.quotedPassRate).toBe(1);
    expect(summary.metrics.byProviderModel['openai:gpt-4o-mini'].attempts).toBe(1);
    expect(summary.metrics.byProviderModel['openai:gpt-4o-mini'].retries).toBe(1);
  });

  it('reuses cached requirement sets for identical job text without repeat quoted model calls', async () => {
    let jobQueryCount = 0;
    let requirementSetSeq = 0;
    const templateSets: string[] = [];
    const activeSetsByVersion = new Map<string, string | null>();

    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM canonical_jobs c') && sql.includes('latest_job_version_id')) {
        jobQueryCount += 1;
        const canonicalJobId = '77777777-7777-4777-8777-777777777777';
        const versionId =
          jobQueryCount === 1
            ? '88888888-8888-4888-8888-888888888888'
            : '99999999-9999-4999-8999-999999999999';

        return {
          rows: [
            {
              workspace_id: context.workspaceId,
              canonical_job_id: canonicalJobId,
              job_version_id: versionId,
              content_hash: 'same-content-hash',
              description_text: 'Hybrid role. Work rights required.',
            },
          ],
        };
      }

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO requirement_set_identities')) {
        return { rows: [{ id: 'req-ident-cache-1' }] };
      }

      if (sql.includes('SELECT active_requirement_set_id') && sql.includes('FROM job_versions')) {
        const versionId = String(params?.[1] ?? '');
        return { rows: [{ active_requirement_set_id: activeSetsByVersion.get(versionId) ?? null }] };
      }

      if (sql.includes('SELECT (COALESCE(MAX(revision_number)')) {
        return { rows: [{ next_revision: 1 }] };
      }

      if (sql.includes('INSERT INTO requirement_sets')) {
        requirementSetSeq += 1;
        const id = `req-set-cache-${requirementSetSeq}`;
        if (templateSets.length === 0) {
          templateSets.push(id);
        }
        return { rows: [{ id }] };
      }

      if (sql.includes('UPDATE job_versions') && sql.includes('active_requirement_set_id')) {
        const versionId = String(params?.[1] ?? '');
        const setId = String(params?.[2] ?? '');
        activeSetsByVersion.set(versionId, setId);
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: `det-run-${jobQueryCount}` }] };
      }

      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'LLM_QUOTED'")) {
        return { rows: [{ id: `quoted-run-${jobQueryCount}` }] };
      }

      if (sql.includes('SELECT rs.id') && sql.includes('FROM requirement_sets rs')) {
        if (jobQueryCount >= 2 && templateSets.length > 0) {
          return { rows: [{ id: templateSets[0] }] };
        }
        return { rows: [] };
      }

      if (sql.includes('SELECT extractor_type, COUNT(*)') && sql.includes('FROM job_requirements')) {
        return {
          rows: [
            { extractor_type: 'DETERMINISTIC', n: 2 },
            { extractor_type: 'LLM_QUOTED', n: 1 },
          ],
        };
      }

      if (sql.includes('INSERT INTO job_requirements')) {
        return { rows: [], rowCount: 1 };
      }

      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { query, connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const quotedExtractor = vi.fn(async () => ({
      provider: 'openai',
      model: 'gpt-4o-mini',
      attempts: 1,
      errors: [],
      payload: {
        schema_version: '2.0',
        requirements: [
          {
            requirement_key: 'R-001',
            requirement_type: 'WORK_AUTH',
            importance: 'MUST',
            requirement_text: 'Work rights required.',
            quote_text: 'Work rights required',
            confidence: 0.91,
          },
        ],
      },
    }));

    await runRequirementsExtraction(fakePool, { context, quotedExtractor });
    await runRequirementsExtraction(fakePool, { context, quotedExtractor });

    expect(quotedExtractor).toHaveBeenCalledTimes(1);
  });
});
