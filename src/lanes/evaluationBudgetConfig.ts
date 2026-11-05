import { LaneFileConfigSchema, type LaneFileConfig } from "./contracts.js";

export function withMaximumAiInterpretationsPerRun(
  content: LaneFileConfig,
  maximum: number,
): LaneFileConfig {
  if (!Number.isInteger(maximum) || maximum < 0 || maximum > 1000) {
    throw new Error("AI lane budget must be an integer from 0 to 1000 per run.");
  }

  return LaneFileConfigSchema.parse({
    ...content,
    budget: {
      ...content.budget,
      maximum_ai_interpretations_per_run: maximum,
    },
  });
}
