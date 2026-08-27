import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEvaluationBudgeter } from '../../pipeline/evaluationBudgeter.js';
import pg from 'pg';

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

const mPool = new pg.Pool();

describe('Pipeline Stage: Evaluation Budgeter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should take top 3 jobs per lane and reject the rest', async () => {
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

    // 1 initial query
    // CORE_AI_DATA: 3 enqueued (6 queries: 3 INSERT, 3 UPDATE), 1 rejected (1 UPDATE)
    // LEGAL_REGTECH: 1 enqueued (2 queries: 1 INSERT, 1 UPDATE)
    // Total queries expected: 1 + 6 + 1 + 2 = 10 queries
    
    expect(mPool.query).toHaveBeenCalledTimes(10);
    
    // Let's verify canon-4 was rejected
    const calls = (mPool.query as any).mock.calls;
    const rejectCall = calls.find((c: any) => c[0].includes('REJECTED_AFTER_EVALUATION'));
    expect(rejectCall).toBeDefined();
    expect(rejectCall[1][0]).toEqual('canon-4');

    // Verify canon-1 was queued
    const insertCall = calls.find((c: any) => c[0].includes('INSERT INTO evaluation_queue') && c[1][0] === 'canon-1');
    expect(insertCall).toBeDefined();
    expect(insertCall[1][1]).toEqual('CORE_AI_DATA');
  });
});
