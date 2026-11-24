/**
 * Measurement runs compare models. A result is a measurement of the requested model only if that
 * model answered; an answer from a fallback model is a different measurement and must fail the run.
 * Production evaluation is unaffected: there a fallback answer is a valid answer.
 */

export interface PrimaryAnsweredCheck {
  /** The model the run asked for. */
  expectedModel: string;
  /** The model that actually answered. */
  servedModel: string;
  /** True when the gateway moved to a fallback provider or model. */
  fallbackUsed?: boolean;
}

export class PrimaryNotServedError extends Error {
  readonly code = "PRIMARY_NOT_SERVED";
  constructor(readonly expectedModel: string, readonly servedModel: string) {
    super(`measurement requires ${expectedModel} but ${servedModel} answered`);
    this.name = "PrimaryNotServedError";
  }
}

/** Returns an error when the requested model did not answer, otherwise null. */
export function checkPrimaryAnswered(check: PrimaryAnsweredCheck): PrimaryNotServedError | null {
  if (check.servedModel !== check.expectedModel || check.fallbackUsed === true) {
    return new PrimaryNotServedError(check.expectedModel, check.servedModel);
  }
  return null;
}
