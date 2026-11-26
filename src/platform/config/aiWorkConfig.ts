/**
 * Owner switch for AI explanation and evaluation work (owner decision of 25 November 2026). Fail closed: unless
 * AI_EVALUATION_ENABLED is exactly "true" AND AI_EVALUATION_SCORE_CUTOFF holds the owner-approved cut-off AND
 * AI_EVALUATION_SCORE_POLICY names the score scale it was approved on, no explanation or evaluation work is queued
 * or run. There are no defaults. A value that is set but cannot be read also holds, and makes the run fail.
 */
export const AI_EVALUATION_ENABLED_ENV = "AI_EVALUATION_ENABLED";
export const AI_EVALUATION_SCORE_CUTOFF_ENV = "AI_EVALUATION_SCORE_CUTOFF";
export const AI_EVALUATION_SCORE_POLICY_ENV = "AI_EVALUATION_SCORE_POLICY";

export type AiWorkHoldReason =
  | "AI_EVALUATION_NOT_ENABLED"
  | "AI_SCORE_CUTOFF_NOT_APPROVED"
  | "AI_SCORE_POLICY_NOT_APPROVED"
  | "AI_EVALUATION_ENABLED_INVALID"
  | "AI_SCORE_CUTOFF_INVALID"
  | "AI_SCORE_POLICY_INVALID";

/** The approved cut-off and the score scale it belongs to. */
export interface AiScoreApproval {
  /** A job qualifies only when its stored ranking score (0 to 1) is strictly above this. */
  readonly scoreCutoff: number;
  /** The job's canonical_jobs.recommendation_score_policy must equal this exactly. */
  readonly scorePolicy: string;
}

export type AiWorkSettings =
  | { readonly mode: "HELD"; readonly reason: AiWorkHoldReason }
  | ({ readonly mode: "OPEN" } & AiScoreApproval);

const INVALID_REASONS: Partial<Record<AiWorkHoldReason, string>> = {
  AI_EVALUATION_ENABLED_INVALID: `${AI_EVALUATION_ENABLED_ENV} must be exactly "true" or "false"`,
  AI_SCORE_CUTOFF_INVALID: `${AI_EVALUATION_SCORE_CUTOFF_ENV} must be a decimal from 0 up to, not including, 1`,
  AI_SCORE_POLICY_INVALID: `${AI_EVALUATION_SCORE_POLICY_ENV} must have the form <match policy>|<role-shape policy>`,
};

export function readAiWorkSettings(env: NodeJS.ProcessEnv = process.env): AiWorkSettings {
  const value = (name: string): string => {
    const raw = env[name] ?? "";
    return raw.trim() === "" ? "" : raw;
  };
  const enabled = value(AI_EVALUATION_ENABLED_ENV);
  const cutoff = value(AI_EVALUATION_SCORE_CUTOFF_ENV).trim();
  const scorePolicy = value(AI_EVALUATION_SCORE_POLICY_ENV).trim();
  // Unreadable values are reported whether or not the switch is on.
  if (enabled !== "" && enabled !== "true" && enabled !== "false") {
    return { mode: "HELD", reason: "AI_EVALUATION_ENABLED_INVALID" };
  }
  if (cutoff !== "" && !/^(0(\.\d+)?|\.\d+)$/.test(cutoff)) return { mode: "HELD", reason: "AI_SCORE_CUTOFF_INVALID" };
  if (scorePolicy !== "" && !/^[A-Za-z0-9_.+-]+\|[A-Za-z0-9_.+-]+$/.test(scorePolicy)) {
    return { mode: "HELD", reason: "AI_SCORE_POLICY_INVALID" };
  }
  if (enabled !== "true") return { mode: "HELD", reason: "AI_EVALUATION_NOT_ENABLED" };
  if (cutoff === "") return { mode: "HELD", reason: "AI_SCORE_CUTOFF_NOT_APPROVED" };
  if (scorePolicy === "") return { mode: "HELD", reason: "AI_SCORE_POLICY_NOT_APPROVED" };
  return { mode: "OPEN", scoreCutoff: Number(cutoff), scorePolicy };
}

/** Throws for a value that is set but unreadable, so an entry point exits non-zero instead of holding quietly. */
export function assertAiWorkSettingsValid(settings: AiWorkSettings): void {
  if (settings.mode !== "HELD") return;
  const problem = INVALID_REASONS[settings.reason];
  if (problem) throw new Error(`Invalid AI switch setting (${settings.reason}): ${problem}. AI work stays held.`);
}
