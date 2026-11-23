/** Token usage and cost accounting. Pure: prices are passed in, nothing is read from the environment. */

export interface ModelTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Reasoning/thinking tokens, when the provider reports them. */
  reasoningTokens?: number;
  /**
   * True when completionTokens already includes the reasoning tokens (OpenAI); false when they
   * are reported separately (Gemini thoughtsTokenCount).
   */
  reasoningIncludedInCompletion?: boolean;
}

/** Token usage of a successful call. */
export interface ModelCallUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  reasoningIncludedInCompletion?: boolean;
}

/** The part of an attempt record that usage summarising reads. */
export interface UsageAttempt extends ModelTokenUsage {
  provider: string;
  model: string;
  status: "COMPLETED" | "FAILED";
}

export function finiteUsageNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

export function finiteMoneyNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function extractTokenUsage(value: any): ModelTokenUsage {
  const usage = value?.usage || value?.usageMetadata || value?.response_metadata?.token_usage || {};
  const promptTokens = finiteUsageNumber(
    usage.prompt_tokens ?? usage.promptTokenCount ?? usage.input_tokens ?? usage.inputTokenCount
  );
  const completionTokens = finiteUsageNumber(
    usage.completion_tokens ?? usage.candidatesTokenCount ?? usage.output_tokens ?? usage.outputTokenCount
  );
  const totalTokens = finiteUsageNumber(
    usage.total_tokens ?? usage.totalTokenCount ?? usage.total_tokens_count
  );
  // OpenAI counts reasoning inside completion/output tokens; Gemini reports thoughts separately.
  const openAiReasoning = finiteUsageNumber(
    usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens
  );
  const geminiThoughts = finiteUsageNumber(usage.thoughtsTokenCount);
  if (openAiReasoning !== undefined) {
    return { promptTokens, completionTokens, totalTokens, reasoningTokens: openAiReasoning, reasoningIncludedInCompletion: true };
  }
  if (geminiThoughts !== undefined) {
    return { promptTokens, completionTokens, totalTokens, reasoningTokens: geminiThoughts, reasoningIncludedInCompletion: false };
  }
  return { promptTokens, completionTokens, totalTokens };
}

export function summarizeSuccessfulUsage(
  attempts: readonly UsageAttempt[],
  provider: string,
  model: string
): ModelCallUsage | null {
  const success = [...attempts]
    .reverse()
    .find((attempt) =>
      attempt.status === "COMPLETED" &&
      attempt.provider === provider &&
      attempt.model === model
    );
  if (!success) return null;
  const promptTokens = success.promptTokens ?? 0;
  const completionTokens = success.completionTokens ?? 0;
  const totalTokens = success.totalTokens ?? promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(success.reasoningTokens !== undefined
      ? { reasoningTokens: success.reasoningTokens, reasoningIncludedInCompletion: success.reasoningIncludedInCompletion === true }
      : {}),
  };
}

export function configuredModelPricing(
  provider: string,
  model: string,
  raw: string | undefined,
): { inputPer1M: number; outputPer1M: number } | null {
  if (!raw || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    const keys = [
      `${provider}:${model}`,
      model,
      provider,
    ];
    for (const key of keys) {
      const pricing = parsed[key];
      const inputPer1M = finiteMoneyNumber(
        pricing?.input_per_1m ?? pricing?.inputPer1M ?? pricing?.prompt_per_1m ?? pricing?.promptPer1M
      );
      const outputPer1M = finiteMoneyNumber(
        pricing?.output_per_1m ?? pricing?.outputPer1M ?? pricing?.completion_per_1m ?? pricing?.completionPer1M
      );
      if (inputPer1M !== undefined && outputPer1M !== undefined) {
        return { inputPer1M, outputPer1M };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function estimateCostUsd(
  provider: string,
  model: string,
  usage: ModelCallUsage | null,
  pricingJson: string | undefined,
): number | null {
  if (!usage) return null;
  const pricing = configuredModelPricing(provider, model, pricingJson);
  if (!pricing) return null;
  const cost =
    (usage.promptTokens / 1_000_000) * pricing.inputPer1M +
    (usage.completionTokens / 1_000_000) * pricing.outputPer1M;
  return Number(cost.toFixed(6));
}
