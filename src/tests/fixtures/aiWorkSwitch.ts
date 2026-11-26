import { afterAll, beforeAll, vi } from "vitest";
import { DETERMINISTIC_MATCHER_POLICY_VERSION } from "../../pipeline/profileMatchCurrency.js";
import { ROLE_SHAPE_POLICY_VERSION } from "../../pipeline/roleShape.js";

/** The score policy the decider stamps under the default scoring policy. */
export const TEST_SCORE_POLICY = `${DETERMINISTIC_MATCHER_POLICY_VERSION}|${ROLE_SHAPE_POLICY_VERSION}`;

/**
 * The owner's AI switch is closed by default (src/platform/config/aiWorkConfig.ts). Suites that exercise the queue
 * or the evaluation worker open it for their own duration. The cut-off 0 is a test value, not an approved one:
 * their jobs need a recommendation_requirement_score above it and recommendation_score_policy = TEST_SCORE_POLICY.
 */
export function openAiWorkForSuite(): void {
  beforeAll(() => {
    vi.stubEnv("AI_EVALUATION_ENABLED", "true");
    vi.stubEnv("AI_EVALUATION_SCORE_CUTOFF", "0");
    vi.stubEnv("AI_EVALUATION_SCORE_POLICY", TEST_SCORE_POLICY);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
}
