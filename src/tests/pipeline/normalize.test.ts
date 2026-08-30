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

// Since the pool is instantiated in the file scope, we get a reference to the mocked query function
const mPool = new pg.Pool();

describe('Pipeline Stage: Normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process pending observations and create new canonical jobs', async () => {
    // 1. Mock finding pending observations
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          source_name: 'test-source',
          source_external_id: '123',
          company_name: 'Test Corp',
          title: 'AI Engineer',
          source_url: 'https://test.com',
          location_raw: 'Singapore',
          workplace_type_raw: 'HYBRID',
          employment_type_raw: 'FULL_TIME',
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

    // 7. Mock COMMIT
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });

    await runNormalization();

    // Verify all queries were called in order: Total = 8
    expect(mPool.query).toHaveBeenCalledTimes(8);
    
    // Check canonical job insertion logic
    const insertCanonCall = (mPool.query as any).mock.calls[4];
    expect(insertCanonCall[0]).toContain('INSERT INTO canonical_jobs');
    expect(insertCanonCall[1]).toEqual([
      'Test Corp',
      'ai engineer',
      'https://test.com',
      'Singapore',
      'HYBRID',
      'FULL_TIME',
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
  });
});
