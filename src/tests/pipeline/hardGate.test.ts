import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHardGates } from '../../pipeline/hardGate.js';
import pg from 'pg';
import * as criteria from '../../services/criteria.js';

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

vi.mock('../../services/criteria.js', () => ({
  applyGlobalGates: vi.fn()
}));

const mPool = new pg.Pool();

describe('Pipeline Stage: Hard Gates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should process RAW_STAGED jobs and mark PREQUALIFIED on pass', async () => {
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: 'canon-1',
          company_name: 'Test Corp',
          normalized_title: 'AI Eng',
          canonical_url: 'https://test.com',
          description_text: 'Good job'
        }
      ]
    });

    // Mock criteria pass
    (criteria.applyGlobalGates as any).mockReturnValueOnce({
      passed: true
    });

    await runHardGates();

    expect(mPool.query).toHaveBeenCalledTimes(4); // SELECT + BEGIN + UPDATE + COMMIT
    
    const updateCall = (mPool.query as any).mock.calls[2];
    expect(updateCall[0]).toContain('UPDATE canonical_jobs');
    expect(updateCall[1]).toEqual(['PASS', 'PREQUALIFIED', null, 'canon-1']);
  });

  it('should mark HARD_REJECTED on fail with rejection reason', async () => {
    // 1. Mock jobs
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        { id: 'canon-2', normalized_title: 'AI Eng', company_name: 'Test Corp 2', description_text: 'Missing remote keywords', canonical_url: 'http://test.com/2' }
      ]
    });

    // 2. Mock criteria to fail
    vi.spyOn(criteria, 'applyGlobalGates').mockReturnValueOnce({
      passed: false,
      rejection_code: 'NO_LOCATION_MATCH'
    });

    await runHardGates();

    expect(mPool.query).toHaveBeenCalledTimes(4); // SELECT + BEGIN + UPDATE + COMMIT
    const updateCall = (mPool.query as any).mock.calls[2];
    expect(updateCall[1]).toEqual(['FAIL', 'HARD_REJECTED', 'NO_LOCATION_MATCH', 'canon-2']);
  });
});
