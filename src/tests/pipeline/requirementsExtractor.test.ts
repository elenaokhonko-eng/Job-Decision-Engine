import { describe, expect, it, vi } from 'vitest';
import { runRequirementsExtraction } from '../../pipeline/requirementsExtractor.js';

describe('runRequirementsExtraction', () => {
  it('persists deterministic requirements and completes stage state', async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM canonical_jobs c') && sql.includes('latest_job_version_id')) {
        return {
          rows: [
            {
              canonical_job_id: '11111111-1111-4111-8111-111111111111',
              job_version_id: '22222222-2222-4222-8222-222222222222',
              description_text:
                'Mandatory 5 days per week in office. Must have at least 6 years of experience.',
            },
          ],
        };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: 'det-run-id-1' }] };
      }
      if (sql.includes('UPDATE requirement_extraction_runs') && Array.isArray(params) && params[0] === 'det-run-id-1') {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { query, connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const summary = await runRequirementsExtraction(fakePool);

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

  it('records quoted extraction failures without failing deterministic completion', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM canonical_jobs c') && sql.includes('latest_job_version_id')) {
        return {
          rows: [
            {
              canonical_job_id: '11111111-1111-4111-8111-111111111111',
              job_version_id: '22222222-2222-4222-8222-222222222222',
              description_text: 'Hybrid role with regular team collaboration.',
            },
          ],
        };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: 'det-run-id-2' }] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'LLM_QUOTED'")) {
        return { rows: [{ id: 'quoted-run-id-2' }] };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { query, connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const summary = await runRequirementsExtraction(fakePool, {
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
              canonical_job_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
              job_version_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
              description_text:
                'Hybrid role. Work rights required. Machine learning engineer for platform systems.',
            },
          ],
        };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: 'det-run-id-3' }] };
      }
      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'LLM_QUOTED'")) {
        return { rows: [{ id: 'quoted-run-id-3' }] };
      }
      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { query, connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const summary = await runRequirementsExtraction(fakePool, {
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

  it('is idempotent across reruns for the same job_version with stable requirement keys', async () => {
    const insertedKeysByVersion = new Map<string, Set<string>>();

    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM canonical_jobs c') && sql.includes('latest_job_version_id')) {
        return {
          rows: [
            {
              canonical_job_id: '77777777-7777-4777-8777-777777777777',
              job_version_id: '88888888-8888-4888-8888-888888888888',
              description_text:
                'Mandatory 4 days per week in office and at least 7 years of experience. Full-time role.',
            },
          ],
        };
      }

      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }

      if (sql.includes('INSERT INTO requirement_extraction_runs') && sql.includes("'DETERMINISTIC'")) {
        return { rows: [{ id: 'det-run-id-idempotent' }] };
      }

      if (sql.includes('INSERT INTO job_requirements') && Array.isArray(params)) {
        const versionId = String(params[1]);
        const key = String(params[2]);
        const existing = insertedKeysByVersion.get(versionId) || new Set<string>();
        existing.add(key);
        insertedKeysByVersion.set(versionId, existing);
        return { rows: [] };
      }

      return { rows: [] };
    });

    const fakeClient = { query, release: vi.fn() } as any;
    const fakePool = { query, connect: vi.fn().mockResolvedValue(fakeClient) } as any;

    const first = await runRequirementsExtraction(fakePool);
    const firstKeySet = new Set(insertedKeysByVersion.get('88888888-8888-4888-8888-888888888888') || []);

    const second = await runRequirementsExtraction(fakePool);
    const secondKeySet = new Set(insertedKeysByVersion.get('88888888-8888-4888-8888-888888888888') || []);

    expect(first.processed).toBe(1);
    expect(second.processed).toBe(1);
    expect([...firstKeySet]).toEqual([...secondKeySet]);

    const requirementInsertSqlCalls = query.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((sqlText) => sqlText.includes('INSERT INTO job_requirements'));
    expect(requirementInsertSqlCalls.length).toBeGreaterThan(0);
    for (const sqlText of requirementInsertSqlCalls) {
      expect(sqlText).toContain('ON CONFLICT (job_version_id, requirement_key)');
    }
  });
});
