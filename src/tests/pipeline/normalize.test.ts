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

    // 5. Mock insert into job_versions
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });
    
    // 6. Mock COMMIT
    (mPool.query as any).mockResolvedValueOnce({ rows: [] });

    await runNormalization();

    // Verify all queries were called in order
    // 1 SELECT pending observations
    // 1 BEGIN
    // 1 SELECT existing external ID
    // 1 SELECT existing title
    // 1 INSERT canonical job
    // 1 INSERT job version
    // 1 COMMIT
    // Total = 7
    expect(mPool.query).toHaveBeenCalledTimes(7);
    
    // Check canonical job insertion logic
    const insertCanonCall = (mPool.query as any).mock.calls[4];
    expect(insertCanonCall[0]).toContain('INSERT INTO canonical_jobs');
    expect(insertCanonCall[1]).toEqual(['Test Corp', 'ai engineer', 'https://test.com', 'RAW_STAGED']);
    
    // Check job_versions insertion
    const insertVersionCall = (mPool.query as any).mock.calls[5];
    expect(insertVersionCall[0]).toContain('INSERT INTO job_versions');
    expect(insertVersionCall[1]).toEqual(['canon-uuid-1', 'hash123', 'Test description']);
  });
});
