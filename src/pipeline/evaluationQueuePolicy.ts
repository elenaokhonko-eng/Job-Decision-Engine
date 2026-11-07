export interface EvaluationQueueStats {
  processed: number;
  failed: number;
  manualReview: number;
  eligible: number;
  /** Items rescheduled because the model call was rate limited (429); not failures. */
  rateLimited?: number;
  /** Model calls made by this run, with 429/timeout/retry counts per model. */
  providerCalls?: import("../services/modelCallResilience.js").ProviderCallSummary;
}
