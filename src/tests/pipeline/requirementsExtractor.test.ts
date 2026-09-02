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
  });
});
