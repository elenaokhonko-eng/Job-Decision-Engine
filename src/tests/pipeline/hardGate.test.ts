import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHardGates } from '../../pipeline/hardGate.js';
import pg from 'pg';
import * as criteria from '../../services/criteria.js';
import type { WorkspaceContext } from '../../workspace/context.js';

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
  extractHybridAttendance: vi.fn(() => null),
  extractTravelRequirement: vi.fn(() => null),
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
    const context: WorkspaceContext = {
      workspaceId: 'cd3f21ff-11b7-440f-b708-1a32b2a0c9f8',
      workspaceKey: 'default',
      userId: '7d96e708-dde3-4fd2-8f72-1e22f6607c74',
      userKey: 'local_user',
      role: 'OWNER',
    };

    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // SELECT active preference mode
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: '1b58ad5d-5806-4245-8ee9-8a9f8705d499',
          company_name: 'Test Corp',
          normalized_title: 'AI Eng',
          canonical_url: 'https://test.com',
          description_text: 'Good job',
          job_version_id: 'aeb6feb4-aaed-4602-bb58-5efff54e5bcf'
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

    const globalPass = makePassResult();
    globalPass.workability_facts.employment_type = 'PERMANENT';
    (criteria.applyGlobalGates as any).mockReturnValueOnce(globalPass);

    (mPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE canonical_jobs
    (mPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT gate_decisions
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // COMMIT

    await runHardGates(undefined, { context });

    expect(criteria.applyGlobalGates).toHaveBeenCalledTimes(1);
    const gateCallArg = (criteria.applyGlobalGates as any).mock.calls[0]?.[0];
    expect(String(gateCallArg?.raw_description || "")).toContain("Extracted requirements");
    expect(String(gateCallArg?.raw_description || "")).toContain("2 days per week in office");
    expect(mPool.query).toHaveBeenCalledTimes(7); // policy SELECT + jobs SELECT + BEGIN + requirements + UPDATE + INSERT + COMMIT

    const updateCall = (mPool.query as any).mock.calls[4];
    expect(updateCall[0]).toContain('UPDATE canonical_jobs');
    expect(updateCall[1][0]).toBe('PASS');
    expect(updateCall[1][1]).toBe('PREQUALIFIED');
    expect(JSON.parse(updateCall[1][4]).employment_type).toBe('PERMANENT');
    expect(updateCall[1][6]).toBe('1b58ad5d-5806-4245-8ee9-8a9f8705d499');

    const insertCall = (mPool.query as any).mock.calls[5];
    expect(insertCall[0]).toContain('pipeline_run_id');
    expect(insertCall[1][3]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('gates via applyGlobalGates when no persisted requirements exist', async () => {
    const context: WorkspaceContext = {
      workspaceId: 'cd3f21ff-11b7-440f-b708-1a32b2a0c9f8',
      workspaceKey: 'default',
      userId: '7d96e708-dde3-4fd2-8f72-1e22f6607c74',
      userKey: 'local_user',
      role: 'OWNER',
    };

    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // SELECT active preference mode
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        {
          id: '4cdafe74-6b33-480f-b0d5-e3609b2306bc',
          normalized_title: 'AI Eng',
          company_name: 'Test Corp 2',
          description_text: 'Missing remote keywords',
          canonical_url: 'http://test.com/2',
          job_version_id: '0d90b7bf-039b-4c12-9d41-11513e75c990'
        }
      ]
    });

    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // BEGIN
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // SELECT requirements empty

    (criteria.applyGlobalGates as any).mockReturnValueOnce(makeRejectResult('GATE_LOCATION_RESTRICTED'));

    (mPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE canonical_jobs
    (mPool.query as any).mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT gate_decisions
    (mPool.query as any).mockResolvedValueOnce({ rows: [] }); // COMMIT

    await runHardGates(undefined, { context });

    expect(criteria.applyGlobalGates).toHaveBeenCalledTimes(1);
    expect(mPool.query).toHaveBeenCalledTimes(7);
    const updateCall = (mPool.query as any).mock.calls[4];
    expect(updateCall[1][0]).toBe('HARD_REJECT');
    expect(updateCall[1][1]).toBe('HARD_REJECTED');
    expect(updateCall[1][2]).toBe('GATE_LOCATION_RESTRICTED');
  });

  it('reports hard-gate technical failures instead of hiding them', async () => {
    const context: WorkspaceContext = {
      workspaceId: 'cd3f21ff-11b7-440f-b708-1a32b2a0c9f8',
      workspaceKey: 'default',
      userId: '7d96e708-dde3-4fd2-8f72-1e22f6607c74',
      userKey: 'local_user',
      role: 'OWNER',
    };

    (mPool.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('workspace_user_preference_modes')) {
        return { rows: [] };
      }
      if (sql.includes('FROM canonical_jobs c')) {
        return {
          rows: [
            {
              id: '7c43500c-bcf8-4f2d-a5f8-cecb9bfb5291',
              normalized_title: 'AI Eng',
              company_name: 'Broken Corp',
              description_text: 'Good job',
              canonical_url: 'https://test.com/error',
              job_version_id: '87a221a2-06d6-4643-a60d-22f7f9dc38f8',
            },
          ],
        };
      }
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM job_versions jv') && sql.includes('JOIN job_requirements')) {
        throw new Error('requirements table unavailable');
      }
      return { rows: [] };
    });

    const result = await runHardGates(undefined, { context });

    expect(result).toEqual({
      passed: 0,
      hardRejected: 0,
      needsVerification: 0,
      errors: 1,
    });
    expect((mPool.query as any).mock.calls.some((call: any[]) => call[0] === 'ROLLBACK')).toBe(true);
  });
});
