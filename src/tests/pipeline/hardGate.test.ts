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

const makePassResult = (): criteria.GateResult => ({
  passed: true,
  status: 'PASS',
  rejection_codes: [],
  evidence_quotes: [],
  workability_facts: {
    office_days_min: null,
    office_days_max: null,
    travel_pct_max: null,
    employment_type: 'UNKNOWN',
    location_restriction: null
  }
});

const makeRejectResult = (code: string): criteria.GateResult => ({
  passed: false,
  status: 'HARD_REJECT',
  rejection_code: code,
  rejection_codes: [code],
  evidence_quotes: [`Matched: "${code}"`],
  workability_facts: {
    office_days_min: null,
    office_days_max: null,
    travel_pct_max: null,
    employment_type: 'UNKNOWN',
    location_restriction: null
  }
});

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
          description_text: 'Good job',
          job_version_id: 'ver-1'
        }
      ]
    });

    (criteria.applyGlobalGates as any).mockReturnValueOnce(makePassResult());

    // BEGIN, UPDATE canonical_jobs, INSERT gate_decisions, COMMIT
    (mPool.query as any).mockResolvedValue({ rows: [], rowCount: 1 });

    await runHardGates();

    expect(mPool.query).toHaveBeenCalledTimes(5); // SELECT + BEGIN + UPDATE canonical_jobs + INSERT gate_decisions + COMMIT

    const updateCall = (mPool.query as any).mock.calls[2];
    expect(updateCall[0]).toContain('UPDATE canonical_jobs');
    expect(updateCall[1][0]).toBe('PASS');
    expect(updateCall[1][1]).toBe('PREQUALIFIED');
    expect(updateCall[1][5]).toBe('canon-1');
  });

  it('should mark HARD_REJECTED on fail with rejection reason and evidence', async () => {
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: 'canon-2',
          normalized_title: 'AI Eng',
          company_name: 'Test Corp 2',
          description_text: 'Missing remote keywords',
          canonical_url: 'http://test.com/2',
          job_version_id: 'ver-2'
        }
      ]
    });

    vi.spyOn(criteria, 'applyGlobalGates').mockReturnValueOnce(makeRejectResult('GATE_LOCATION_RESTRICTED'));

    (mPool.query as any).mockResolvedValue({ rows: [], rowCount: 1 });

    await runHardGates();

    expect(mPool.query).toHaveBeenCalledTimes(5);
    const updateCall = (mPool.query as any).mock.calls[2];
    expect(updateCall[1][0]).toBe('HARD_REJECT');
    expect(updateCall[1][1]).toBe('HARD_REJECTED');
    expect(updateCall[1][2]).toBe('GATE_LOCATION_RESTRICTED');
  });
});
