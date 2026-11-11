/**
 * Precise hard-gate reason codes and their user-facing labels.
 *
 * Gate decisions store reason codes as free strings (`gate_decisions.rejection_codes`
 * is JSONB, `canonical_jobs.rejection_reason` is text), so new codes are additive.
 * Legacy codes stay here so stored rows keep rendering after the rename.
 */
export const GATE_TRAVEL_ABOVE_LIMIT = "GATE_TRAVEL_ABOVE_LIMIT";
export const GATE_ON_CALL_REQUIRED = "GATE_ON_CALL_REQUIRED";
export const GATE_SHIFT_WORK_REQUIRED = "GATE_SHIFT_WORK_REQUIRED";
export const GATE_JOB_LOCATION_MISMATCH = "GATE_JOB_LOCATION_MISMATCH";
/** Legacy umbrella code for travel, on-call and shift work. No longer emitted. */
export const LEGACY_GATE_LIFESTYLE_INCOMPATIBLE = "GATE_LIFESTYLE_INCOMPATIBLE";

/** Codes that replace the legacy lifestyle code. Readers of the legacy code should also accept these. */
export const LIFESTYLE_GATE_CODES: readonly string[] = [
  GATE_TRAVEL_ABOVE_LIMIT,
  GATE_ON_CALL_REQUIRED,
  GATE_SHIFT_WORK_REQUIRED,
  LEGACY_GATE_LIFESTYLE_INCOMPATIBLE,
];

export const GATE_REASON_LABELS: Readonly<Record<string, string>> = {
  [GATE_TRAVEL_ABOVE_LIMIT]: "Travel above the accepted limit",
  [GATE_ON_CALL_REQUIRED]: "Regular on-call required",
  [GATE_SHIFT_WORK_REQUIRED]: "Shift work required",
  [GATE_JOB_LOCATION_MISMATCH]: "Job located outside the authorized region",
  [LEGACY_GATE_LIFESTYLE_INCOMPATIBLE]: "Travel, on-call or shift work (legacy code)",
  UNWORKABLE_LOCATION_MODEL: "Unworkable location or work model",
  GATE_HIGH_OFFICE_DAYS: "Too many office days (on-site)",
  WORK_AUTHORIZATION_INCOMPATIBLE: "Explicit work-authorization restriction",
  GATE_REMOTE_TERRITORY_RESTRICTED: "Remote hiring limited to another territory",
  GATE_HIGH_INTERACTION: "High client interaction / presales",
  GATE_EXCLUDED_EMPLOYER: "Excluded employer",
  NON_TECHNICAL_FUNCTION: "Non-technical function (legacy hard gate)",
  GATE_NOT_AI_DATA: "No AI/data domain signal (legacy hard gate)",
  GATE_OUT_OF_SCOPE_DOMAIN: "Out-of-scope role family",
};

/** The label for a stored reason code; unknown codes render as themselves. */
export function gateReasonLabel(code: string): string {
  return GATE_REASON_LABELS[code] ?? code;
}

/** Evidence line for a travel rejection that names the configured limit. */
export function travelAboveLimitEvidence(maxTravelPct: number, travelPct: number | null): string {
  return travelPct === null
    ? `Travel above ${maxTravelPct}%: frequent or extensive travel is stated without a percentage`
    : `Travel above ${maxTravelPct}%: the posting states up to ${travelPct}%`;
}
