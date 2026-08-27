import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHardGates } from '../../pipeline/hardGate.js';
import pg from 'pg';
import * as criteria from '../../services/criteria.js';

vi.mock('pg', () => {
  const mPool = {
    query: vi.fn(),
    end: vi.fn(),
  };
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

    expect(mPool.query).toHaveBeenCalledTimes(2);
    
    const updateCall = (mPool.query as any).mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE canonical_jobs');
    expect(updateCall[1]).toEqual(['PASS', 'PREQUALIFIED', null, 'canon-1']);
  });

  it('should mark HARD_REJECTED on fail with rejection reason', async () => {
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: 'canon-2',
          company_name: 'Test Corp 2',
          normalized_title: 'AI Eng',
          description_text: 'Bad job'
        }
      ]
    });

    // Mock criteria fail
    (criteria.applyGlobalGates as any).mockReturnValueOnce({
      passed: false,
      rejection_code: 'NO_LOCATION_MATCH'
    });

    await runHardGates();

    expect(mPool.query).toHaveBeenCalledTimes(2);
    const updateCall = (mPool.query as any).mock.calls[1];
    expect(updateCall[1]).toEqual(['FAIL', 'HARD_REJECTED', 'NO_LOCATION_MATCH', 'canon-2']);
  });
});
