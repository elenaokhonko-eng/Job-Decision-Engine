import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEvaluationBudgeter } from '../../pipeline/evaluationBudgeter.js';
import pg from 'pg';

vi.mock('../../pipeline/laneConfigLoader.js', () => ({
  loadGlobalLanesConfig: vi.fn(() => ({
    lanes: {
      CORE_AI_DATA: { ai_evaluation_limit: 3 },
      LEGAL_REGTECH: { ai_evaluation_limit: 3 },
      HEALTH_BIO_PHARMA: { ai_evaluation_limit: 3 },
      INVESTMENT_MARKETS_FINTECH: { ai_evaluation_limit: 3 },
    },
    unclassified_policy: {
      label: 'UNCLASSIFIED',
      fallback_behavior: 'DEFER_ROUTING',
      min_similarity_floor: 0.25,
    },
  }))
}));

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
        { id: 'canon-1', latest_job_version_id: 'ver-1', primary_lane: 'CORE_AI_DATA', semantic_score: 0.9 },
        { id: 'canon-2', latest_job_version_id: 'ver-2', primary_lane: 'CORE_AI_DATA', semantic_score: 0.8 },
        { id: 'canon-3', latest_job_version_id: 'ver-3', primary_lane: 'CORE_AI_DATA', semantic_score: 0.7 },
        { id: 'canon-4', latest_job_version_id: 'ver-4', primary_lane: 'CORE_AI_DATA', semantic_score: 0.6 },
        { id: 'canon-5', latest_job_version_id: 'ver-5', primary_lane: 'LEGAL_REGTECH', semantic_score: 0.85 }
      ]
    });

    await runEvaluationBudgeter();

    expect(mPool.query).toHaveBeenCalledTimes(20);
    
    // Verify canon-4 was deferred as DEFERRED_BUDGET (never rejected)
    const calls = (mPool.query as any).mock.calls;
    const deferCall = calls.find((c: any) => typeof c[0] === 'string' && c[0].includes("UPDATE canonical_jobs") && c[0].includes("DEFERRED_BUDGET"));
    expect(deferCall).toBeDefined();
    expect(deferCall[1][0]).toEqual('canon-4');

    // Verify canon-1 was queued with pinned job_version_id
    const insertCall = calls.find((c: any) => c[0].includes('INSERT INTO evaluation_queue') && c[1][0] === 'canon-1');
    expect(insertCall).toBeDefined();
    expect(insertCall[1][1]).toEqual('ver-1');
    expect(insertCall[1][2]).toEqual('CORE_AI_DATA');
  });

  it('reads mixed lane-level caps from config at runtime', async () => {
    const laneLoader = await import('../../pipeline/laneConfigLoader.js');
    vi.mocked(laneLoader.loadGlobalLanesConfig).mockReturnValue({
      lanes: {
        CORE_AI_DATA: { ai_evaluation_limit: 2 },
        LEGAL_REGTECH: { ai_evaluation_limit: 1 },
        HEALTH_BIO_PHARMA: { ai_evaluation_limit: 3 },
        INVESTMENT_MARKETS_FINTECH: { ai_evaluation_limit: 3 },
      },
      unclassified_policy: {
        label: 'UNCLASSIFIED',
        fallback_behavior: 'DEFER_ROUTING',
        min_similarity_floor: 0.25,
      },
    } as any);

    (mPool.query as any).mockResolvedValueOnce({
      rows: [
        { id: 'c1', latest_job_version_id: 'v1', primary_lane: 'CORE_AI_DATA', semantic_score: 0.95 },
        { id: 'c2', latest_job_version_id: 'v2', primary_lane: 'CORE_AI_DATA', semantic_score: 0.85 },
        { id: 'c3', latest_job_version_id: 'v3', primary_lane: 'CORE_AI_DATA', semantic_score: 0.75 },
        { id: 'l1', latest_job_version_id: 'v4', primary_lane: 'LEGAL_REGTECH', semantic_score: 0.91 },
        { id: 'l2', latest_job_version_id: 'v5', primary_lane: 'LEGAL_REGTECH', semantic_score: 0.81 },
      ],
    });

    const summary = await runEvaluationBudgeter();
    expect(summary.queued).toBe(3);
    expect(summary.deferred).toBe(2);

    const calls = (mPool.query as any).mock.calls;
    const queuedCore = calls.filter(
      (c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO evaluation_queue') && c[1][2] === 'CORE_AI_DATA'
    );
    const queuedLegal = calls.filter(
      (c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO evaluation_queue') && c[1][2] === 'LEGAL_REGTECH'
    );
    expect(queuedCore).toHaveLength(2);
    expect(queuedLegal).toHaveLength(1);

    const deferredIds = calls
      .filter(
        (c: any) =>
          typeof c[0] === 'string' &&
          c[0].includes('UPDATE canonical_jobs') &&
          c[0].includes('DEFERRED_BUDGET')
      )
      .map((c: any) => c[1][0]);

    expect(deferredIds).toContain('c3');
    expect(deferredIds).toContain('l2');
    expect(laneLoader.loadGlobalLanesConfig).toHaveBeenCalledTimes(1);
  });
});
