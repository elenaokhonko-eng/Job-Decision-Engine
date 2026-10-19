import { describe, expect, it } from 'vitest';

import { runEvaluationQueueWithExitPolicy } from '../../pipeline/evaluationQueueExitPolicy.js';
import type { EvaluationQueueStats } from '../../pipeline/evaluationQueuePolicy.js';

const retryStats: EvaluationQueueStats = {
  processed: 0,
  failed: 1,
  manualReview: 0,
  eligible: 1,
};

describe('evaluation queue workflow exit policy', () => {
  it('keeps a recoverable RETRY_WAIT green in scheduled retry-drain mode', async () => {
    const outcome = await runEvaluationQueueWithExitPolicy(
      async () => retryStats,
      false
    );

    expect(outcome).toMatchObject({ ok: true, exitCode: 0, stats: retryStats });
  });

  it('allows a later retry run to complete green after the item becomes available', async () => {
    const outcome = await runEvaluationQueueWithExitPolicy(async () => ({
      processed: 1,
      failed: 0,
      manualReview: 0,
      eligible: 1,
    }), false);

    expect(outcome).toMatchObject({ ok: true, exitCode: 0, stats: { processed: 1, failed: 0 } });
  });

  it('keeps strict retry failure mode and systemic failures red', async () => {
    const retryFailure = await runEvaluationQueueWithExitPolicy(async () => retryStats, true);
    const fatalFailure = await runEvaluationQueueWithExitPolicy(async () => {
      throw new Error('Database connection failed');
    }, false);

    expect(retryFailure).toMatchObject({ ok: true, exitCode: 1 });
    expect(fatalFailure).toMatchObject({ ok: false, exitCode: 1 });
  });
});
