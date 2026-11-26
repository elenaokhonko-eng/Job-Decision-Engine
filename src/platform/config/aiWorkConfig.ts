/**
 * Owner switch for AI explanation and evaluation work (owner decision of 25 November 2026). Fail closed: unless
 * AI_EVALUATION_ENABLED is exactly "true" AND AI_EVALUATION_SCORE_CUTOFF holds the owner-approved cut-off, no
 * explanation or evaluation work is queued or run. There is no default cut-off.
 */
export const AI_EVALUATION_ENABLED_ENV = "AI_EVALUATION_ENABLED";
export const AI_EVALUATION_SCORE_CUTOFF_ENV = "AI_EVALUATION_SCORE_CUTOFF";

export type AiWorkHoldReason =
  | "AI_EVALUATION_NOT_ENABLED"
  | "AI_SCORE_CUTOFF_NOT_APPROVED"
  | "AI_SCORE_CUTOFF_INVALID";

export type AiWorkSettings =
  | { readonly mode: "HELD"; readonly reason: AiWorkHoldReason }
  /** Only jobs whose stored ranking score (0 to 1) is strictly above scoreCutoff get AI work. */
  | { readonly mode: "OPEN"; readonly scoreCutoff: number };

export function readAiWorkSettings(env: NodeJS.ProcessEnv = process.env): AiWorkSettings {
  if (env[AI_EVALUATION_ENABLED_ENV] !== "true") return { mode: "HELD", reason: "AI_EVALUATION_NOT_ENABLED" };
  const raw = String(env[AI_EVALUATION_SCORE_CUTOFF_ENV] ?? "").trim();
  if (raw === "") return { mode: "HELD", reason: "AI_SCORE_CUTOFF_NOT_APPROVED" };
  // A plain decimal from 0 up to, not including, 1 (the scale of canonical_jobs.recommendation_requirement_score).
  if (!/^(0(\.\d+)?|\.\d+)$/.test(raw)) return { mode: "HELD", reason: "AI_SCORE_CUTOFF_INVALID" };
  return { mode: "OPEN", scoreCutoff: Number(raw) };
}
