import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runNormalization } from '../../pipeline/normalize.js';
import { generateContentHash } from '../../services/criteria.js';
import pg from 'pg';

// Mock the entire pg module
vi.mock('pg', () => {
  const mPool: any = {
    query: vi.fn(),
    end: vi.fn(),
    release: vi.fn(),
  };
  mPool.connect = vi.fn().mockResolvedValue(mPool);
  return {
    default: {
      Pool: class { constructor() { return mPool; } }
    }
  };
});

const mPool = new pg.Pool();

describe('Pipeline Stage: Normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process pending observations and create new canonical jobs with Unknown defaults', async () => {
    // 1. Mock finding pending observations with missing location & employment type
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: 'obs-uuid-1',
          source_name: 'test-source',
          source_external_id: '123',
          company_name: 'Test Corp',
          title: 'AI Engineer',
          source_url: 'https://test.com',
          location_raw: null,
          workplace_type_raw: null,
          employment_type_raw: null,
          raw_payload_hash: 'hash123',
          description_raw: 'Test description'
        }
      ]
    });

    (mPool.query as any).mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO canonical_jobs')) return { rows: [{ id: 'canon-uuid-1' }] };
      if (sql.includes('INSERT INTO job_versions')) return { rows: [{ id: 'ver-uuid-1' }] };
      return { rows: [] };
    });

    const summary = await runNormalization();

    expect(summary.totalDiscovered).toBe(1);
    expect(summary.totalProcessed).toBe(1);
    expect(summary.totalErrors).toBe(0);

    // Check canonical job insertion logic used 'Unknown' and 'UNKNOWN'
    const calls = (mPool.query as any).mock.calls;
    const insertCanonCall = calls.find((call: any[]) => call[0].includes('INSERT INTO canonical_jobs'));
    expect(insertCanonCall[0]).toContain('INSERT INTO canonical_jobs');
    expect(insertCanonCall[1]).toEqual([
      'Test Corp',
      'ai engineer',
      'https://test.com',
      'Unknown',
      'UNKNOWN',
      'UNKNOWN',
      'RAW_STAGED',
      'RAW_STAGED'
    ]);
    
    // Check job_versions insertion
    const insertVersionCall = calls.find((call: any[]) => call[0].includes('INSERT INTO job_versions'));
    expect(insertVersionCall[0]).toContain('INSERT INTO job_versions');
    expect(insertVersionCall[1]).toEqual([
      'canon-uuid-1',
      generateContentHash('Test Corp', 'AI Engineer', 'Test description'),
      'Test description'
    ]);

    // Check latest_job_version_id update on canonical job
    const updateCanonCall = calls.find((call: any[]) => call[0].includes('UPDATE canonical_jobs'));
    expect(updateCanonCall[0]).toContain('UPDATE canonical_jobs');
    expect(updateCanonCall[1][0]).toEqual('ver-uuid-1');

    // Check observation marked as PROCESSED
    const updateObsCall = calls.find((call: any[]) => call[0].includes('UPDATE raw_job_observations'));
    expect(updateObsCall[0]).toContain("job_version_id = $1, processing_status = 'PROCESSED'");
    expect(updateObsCall[1]).toEqual(['ver-uuid-1', 'obs-uuid-1']);
  });

  it('links a duplicate observation to its existing version without creating another version', async () => {
    (mPool.query as any).mockResolvedValueOnce({
      rows: [{
        id: 'obs-uuid-2',
        source_name: 'test-source',
        source_external_id: '456',
        company_name: 'Test Corp',
        title: 'AI Engineer',
        source_url: 'https://test.com/jobs/456',
        canonical_apply_url: 'https://test.com/jobs/456',
        location_raw: 'Singapore',
        workplace_type_raw: 'HYBRID',
        employment_type_raw: 'PERMANENT',
        raw_payload_hash: 'existing-hash',
        description_raw: 'Duplicate description'
      }]
    });

    (mPool.query as any)
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ canonical_job_id: 'canon-uuid-2' }] }) // source/external-id lookup
      .mockResolvedValueOnce({ rows: [{ id: 'existing-version-uuid' }] }) // content hash lookup
      .mockResolvedValueOnce({ rows: [] }) // observation mapping update
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const summary = await runNormalization();
    const calls = (mPool.query as any).mock.calls;

    expect(summary.totalProcessed).toBe(1);
    expect(calls.some((call: any[]) => call[0].includes('INSERT INTO job_versions'))).toBe(false);
    const updateObsCall = calls.find((call: any[]) => call[0].includes('UPDATE raw_job_observations'));
    expect(updateObsCall[1]).toEqual(['existing-version-uuid', 'obs-uuid-2']);
  });
});
