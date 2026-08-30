import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runNormalization } from '../../pipeline/normalize.js';
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

    // 1b. Mock BEGIN
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });

    // 2. Mock checkExt (no existing job by source/external id)
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });

    // 3. Mock checkTitle (no existing job by title/company)
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });

    // 4. Mock insert into canonical_jobs
    (mPool.query as any).mockResolvedValueOnce({
      rows: [{ id: 'canon-uuid-1' }]
    });

    // 5. Mock insert into job_versions returning id
    (mPool.query as any).mockResolvedValueOnce({
      rows: [{ id: 'ver-uuid-1' }]
    });
    
    // 6. Mock UPDATE canonical_jobs with latest version pointer
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });

    // 7. Mock UPDATE raw_job_observations SET processing_status = 'PROCESSED'
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });

    // 8. Mock COMMIT
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });

    const summary = await runNormalization();

    expect(summary.totalDiscovered).toBe(1);
    expect(summary.totalProcessed).toBe(1);
    expect(summary.totalErrors).toBe(0);

    // Check canonical job insertion logic used 'Unknown' and 'UNKNOWN'
    const insertCanonCall = (mPool.query as any).mock.calls[4];
    expect(insertCanonCall[0]).toContain('INSERT INTO canonical_jobs');
    expect(insertCanonCall[1]).toEqual([
      'Test Corp',
      'ai engineer',
      'https://test.com',
      'Unknown',
      'UNKNOWN',
      'UNKNOWN',
      'RAW_STAGED'
    ]);
    
    // Check job_versions insertion
    const insertVersionCall = (mPool.query as any).mock.calls[5];
    expect(insertVersionCall[0]).toContain('INSERT INTO job_versions');
    expect(insertVersionCall[1]).toEqual(['canon-uuid-1', 'hash123', 'Test description']);

    // Check latest_job_version_id update on canonical job
    const updateCanonCall = (mPool.query as any).mock.calls[6];
    expect(updateCanonCall[0]).toContain('UPDATE canonical_jobs');
    expect(updateCanonCall[1][0]).toEqual('ver-uuid-1');

    // Check observation marked as PROCESSED
    const updateObsCall = (mPool.query as any).mock.calls[7];
    expect(updateObsCall[0]).toContain("UPDATE raw_job_observations SET processing_status = 'PROCESSED'");
    expect(updateObsCall[1][0]).toEqual('obs-uuid-1');
  });
});
