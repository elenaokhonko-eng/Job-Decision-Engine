import type { EvaluationQueueStats } from './evaluationQueuePolicy.js';

export type EvaluationQueueRunOutcome =
  | { readonly ok: true; readonly stats: EvaluationQueueStats; readonly exitCode: 0 | 1 }
  | { readonly ok: false; readonly error: unknown; readonly exitCode: 1 };

export async function runEvaluationQueueWithExitPolicy(
  run: () => Promise<EvaluationQueueStats>,
  exitOnRetryWait: boolean
): Promise<EvaluationQueueRunOutcome> {
  try {
    const stats = await run();
    const exitCode = stats.failed > 0 && exitOnRetryWait ? 1 : 0;
    return { ok: true, stats, exitCode };
  } catch (error) {
    return { ok: false, error, exitCode: 1 };
  }
}
