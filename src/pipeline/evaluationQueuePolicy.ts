export interface EvaluationQueueStats {
  processed: number;
  failed: number;
  manualReview: number;
  eligible: number;
  /** Items rescheduled because the model call was rate limited (429); not failures. */
  rateLimited?: number;
  /** Set when the owner's AI switch is closed: no queue item was read or changed. */
  heldReason?: import("../platform/config/index.js").AiWorkHoldReason;
  /** Model calls made by this run, with 429/timeout/retry counts per model. */
  providerCalls?: import("../services/modelCallResilience.js").ProviderCallSummary;
  /** Eligible items left queued because the run's time budget was reached. */
  notStarted?: number;
  /** Logical AI calls by served path (FLEX/STANDARD/OPENAI/OPENAI_FALLBACK) with the go-live stop rules. */
  providerMix?: import("../services/modelCallResilience.js").ProviderMixSummary;
}
