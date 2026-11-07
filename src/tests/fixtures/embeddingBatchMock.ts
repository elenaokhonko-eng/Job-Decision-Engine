import type { EmbeddingOutcome, EmbeddingProvider } from "../../services/agent.js";

type PerInputEmbedding = (text: string, provider: EmbeddingProvider, model: string) => Promise<number[]> | number[];

/**
 * Adapts a deterministic per-input embedding fake to the batch signature of
 * generateEmbeddingsWithProviderAndModel, so a failure for one input stays that input's outcome.
 */
export function batchEmbeddingFromPerInput(perInput: PerInputEmbedding) {
  return async (texts: readonly string[], provider: EmbeddingProvider, model: string): Promise<EmbeddingOutcome[]> => {
    const outcomes: EmbeddingOutcome[] = [];
    for (const text of texts) {
      try {
        outcomes.push({ ok: true, vector: await perInput(text, provider, model) });
      } catch (error) {
        outcomes.push({ ok: false, error });
      }
    }
    return outcomes;
  };
}
