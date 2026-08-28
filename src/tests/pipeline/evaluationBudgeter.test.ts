import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEvaluationBudgeter } from '../../pipeline/evaluationBudgeter.js';
import pg from 'pg';

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

describe('Pipeline Stage: Evaluation Budgeter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should take top 3 jobs per lane and defer the rest as DEFERRED_BUDGET', async () => {
    // 1. Mock DB query to return 4 jobs in CORE_AI_DATA and 1 in LEGAL_REGTECH
    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        { id: 'canon-1', primary_lane: 'CORE_AI_DATA', semantic_score: 0.9 },
        { id: 'canon-2', primary_lane: 'CORE_AI_DATA', semantic_score: 0.8 },
        { id: 'canon-3', primary_lane: 'CORE_AI_DATA', semantic_score: 0.7 },
        { id: 'canon-4', primary_lane: 'CORE_AI_DATA', semantic_score: 0.6 },
        { id: 'canon-5', primary_lane: 'LEGAL_REGTECH', semantic_score: 0.85 }
      ]
    });

    await runEvaluationBudgeter();

    expect(mPool.query).toHaveBeenCalledTimes(20);
    
    // Let's verify canon-4 was deferred as DEFERRED_BUDGET (never rejected)
    const calls = (mPool.query as any).mock.calls;
    const deferCall = calls.find((c: any) => typeof c[0] === 'string' && c[0].includes("UPDATE canonical_jobs") && c[0].includes("DEFERRED_BUDGET"));
    expect(deferCall).toBeDefined();
    expect(deferCall[1][0]).toEqual('canon-4');

    // Verify canon-1 was queued
    const insertCall = calls.find((c: any) => c[0].includes('INSERT INTO evaluation_queue') && c[1][0] === 'canon-1');
    expect(insertCall).toBeDefined();
    expect(insertCall[1][1]).toEqual('CORE_AI_DATA');
  });
});
