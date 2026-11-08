/**
 * The OpenAI model for each role, resolved when the call is made (not at import), so a role
 * variable always wins over the shared OPENAI_MODEL default:
 *
 *   evaluation: EVALUATION_FALLBACK_MODEL -> OPENAI_MODEL -> gpt-4o-mini
 *   documents:  DOCUMENT_FALLBACK_MODEL   -> OPENAI_MODEL -> gpt-4o-mini
 *
 * The same chains are checked at startup by src/services/modelIdPreflight.ts. Requirement
 * extraction has its own chain (REQUIREMENTS_OPENAI_MODEL -> EXTRACTION_OPENAI_MODEL).
 * Empty values (an unset GitHub variable passed as '') fall through to the next entry.
 */

export const DEFAULT_OPENAI_FALLBACK_MODEL = "gpt-4o-mini";

export const EVALUATION_OPENAI_MODEL_CHAIN = ["EVALUATION_FALLBACK_MODEL", "OPENAI_MODEL"] as const;
export const DOCUMENT_OPENAI_MODEL_CHAIN = ["DOCUMENT_FALLBACK_MODEL", "OPENAI_MODEL"] as const;

function firstSet(env: NodeJS.ProcessEnv, chain: readonly string[]): string {
  for (const name of chain) {
    const value = String(env[name] ?? "").trim();
    if (value) return value;
  }
  return DEFAULT_OPENAI_FALLBACK_MODEL;
}

/** OpenAI model for evaluations (and the legacy evaluation helpers). */
export function evaluationOpenAiModel(env: NodeJS.ProcessEnv = process.env): string {
  return firstSet(env, EVALUATION_OPENAI_MODEL_CHAIN);
}

/** OpenAI model for document generation (CV summary, cover letter). */
export function documentOpenAiModel(env: NodeJS.ProcessEnv = process.env): string {
  return firstSet(env, DOCUMENT_OPENAI_MODEL_CHAIN);
}
