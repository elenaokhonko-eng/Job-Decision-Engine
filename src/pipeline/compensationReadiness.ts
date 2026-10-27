import type { MaterialReadinessCheck } from "../contracts/applicationReadiness.js";
import type { CompensationEvaluationResult } from "../policy/stage3PolicyEngine.js";

export type CompensationResolutionKind = "UNDISCLOSED" | "SUPPORTED" | "UNRESOLVED";

export interface BuildCompensationReadinessCheckInput {
  readonly floorConfigured: boolean;
  readonly resolutionKind: CompensationResolutionKind;
  readonly assessment: CompensationEvaluationResult | null;
  readonly resolutionReason?: string | null;
  readonly basisConfigured: boolean;
  readonly fxRateFailure: string | null;
  readonly fxRateObservationId: string | null;
  readonly preferenceRevisionId: string | null;
  readonly assessedAt: string;
}

export function buildCompensationReadinessCheck(
  input: BuildCompensationReadinessCheckInput,
): MaterialReadinessCheck {
  const status: MaterialReadinessCheck["status"] = !input.floorConfigured
    ? "NOT_APPLICABLE"
    : input.resolutionKind === "UNDISCLOSED" || input.assessment === null || input.assessment.status === "UNKNOWN"
      ? "NEEDS_VERIFICATION"
      : input.assessment.status === "BELOW_FLOOR" ? "BLOCKED" : "MET";
  const undisclosed = input.floorConfigured && input.resolutionKind === "UNDISCLOSED";
  const importance: MaterialReadinessCheck["importance"] = !input.floorConfigured || undisclosed
    ? "PREFERRED"
    : "MUST";
  const reasonCode = status === "BLOCKED"
    ? "COMPENSATION_BELOW_USER_FLOOR"
    : undisclosed
      ? "COMPENSATION_UNDISCLOSED"
      : status === "NEEDS_VERIFICATION"
        ? !input.basisConfigured ? "COMPENSATION_TARGET_BASIS_UNCONFIGURED" : "COMPENSATION_UNKNOWN"
        : null;
  const rationale = status === "NOT_APPLICABLE"
    ? "No active compensation floor is configured."
    : undisclosed
      ? "Salary undisclosed—confirm with recruiter."
      : status === "NEEDS_VERIFICATION"
        ? input.fxRateFailure
          ? "Compensation conversion or source evidence is unavailable and requires verification."
          : !input.basisConfigured
            ? "The active compensation policy does not define whether the salary target is gross or net; no advertised basis is assumed."
            : input.resolutionKind === "UNRESOLVED" && input.resolutionReason
              ? input.resolutionReason
              : input.assessment?.evidence ?? "Guaranteed base compensation, salary basis, period, currency, or category is unresolved."
        : status === "BLOCKED"
          ? input.assessment?.evidence ?? "Guaranteed base compensation is below the active floor."
          : input.assessment?.evidence ?? "Guaranteed base compensation meets the active floor.";

  return {
    key: "COMPENSATION",
    status,
    importance,
    reason_code: reasonCode,
    rationale,
    evidence_keys: input.fxRateObservationId ? [`fx_rate_observation:${input.fxRateObservationId}`] : [],
    policy_reference: status === "NOT_APPLICABLE"
      ? `stage3_compensation:${input.preferenceRevisionId ?? "unconfigured"}`
      : null,
    assessed_at: input.assessedAt,
    expires_at: null,
  };
}
