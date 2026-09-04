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
  applyGlobalGates: vi.fn(),
  GLOBAL_TITLE_EXCLUSIONS: [],
  isTechnicalRole: vi.fn(() => ({ isTechnical: true, hasBuildingEvidence: true }))
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

  it('should always evaluate hard gates using structured evidence even when deterministic requirements exist', async () => {
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

    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // BEGIN
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          requirement_key: 'R-001',
          requirement_type: 'OFFICE_DAYS',
          requirement_text: 'Requires 2 days in office.',
          quote_text: '2 days per week in office',
          structured_value: { office_days_per_week: 2 }
        }
      ]
    });

    (criteria.applyGlobalGates as any).mockReturnValueOnce(makePassResult());

    (mPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE canonical_jobs
    (mPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT gate_decisions
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // COMMIT

    await runHardGates();

    expect(criteria.applyGlobalGates).toHaveBeenCalledTimes(1);
    const gateCallArg = (criteria.applyGlobalGates as any).mock.calls[0]?.[0];
    expect(String(gateCallArg?.raw_description || "")).toContain("Extracted requirements");
    expect(String(gateCallArg?.raw_description || "")).toContain("2 days per week in office");
    expect(mPool.query).toHaveBeenCalledTimes(6); // SELECT + BEGIN + SELECT requirements + UPDATE + INSERT + COMMIT

    const updateCall = (mPool.query as any).mock.calls[3];
    expect(updateCall[0]).toContain('UPDATE canonical_jobs');
    expect(updateCall[1][0]).toBe('PASS');
    expect(updateCall[1][1]).toBe('PREQUALIFIED');
    expect(updateCall[1][5]).toBe('canon-1');
  });

  it('gates via applyGlobalGates when no persisted requirements exist', async () => {
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

    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // BEGIN
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // SELECT requirements empty

    (criteria.applyGlobalGates as any).mockReturnValueOnce(makeRejectResult('GATE_LOCATION_RESTRICTED'));

    (mPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE canonical_jobs
    (mPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT gate_decisions
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // COMMIT

    await runHardGates();

    expect(criteria.applyGlobalGates).toHaveBeenCalledTimes(1);
    expect(mPool.query).toHaveBeenCalledTimes(6);
    const updateCall = (mPool.query as any).mock.calls[3];
    expect(updateCall[1][0]).toBe('HARD_REJECT');
    expect(updateCall[1][1]).toBe('HARD_REJECTED');
    expect(updateCall[1][2]).toBe('GATE_LOCATION_RESTRICTED');
  });
});
