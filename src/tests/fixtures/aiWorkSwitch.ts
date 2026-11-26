import { afterAll, beforeAll, vi } from "vitest";

/**
 * The owner's AI switch is closed by default (src/platform/config/aiWorkConfig.ts). Suites that exercise the queue
 * or the evaluation worker open it for their own duration. The cut-off 0 is a test value, not an approved one:
 * their jobs need a recommendation_requirement_score above it.
 */
export function openAiWorkForSuite(): void {
  beforeAll(() => {
    vi.stubEnv("AI_EVALUATION_ENABLED", "true");
    vi.stubEnv("AI_EVALUATION_SCORE_CUTOFF", "0");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
}
