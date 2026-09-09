export type EvaluationQueueBlockReason = "CONSENT_NOT_GRANTED";

export interface EvaluationQueueStats {
  processed: number;
  failed: number;
  manualReview: number;
  eligible: number;
  blockedReason?: EvaluationQueueBlockReason;
}

export function shouldFailOnConsentMissing(value = process.env.EVALUATION_FAIL_ON_CONSENT_MISSING): boolean {
  return value === "true";
}
