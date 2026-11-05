/** Gate facts that are safe to verify after deterministic matching. */
export const ROUTABLE_WORKABILITY_VERIFICATION_CODES = [
  "GATE_UNKNOWN_WORK_MODE",
  "NEEDS_VERIFICATION",
  "NEEDS_VERIFICATION_LOCATION_DETAIL",
  "NEEDS_VERIFICATION_OFFICE_DAYS",
  "NEEDS_VERIFICATION_TRAVEL",
] as const;

const ROUTABLE_CODE_SET = new Set<string>(ROUTABLE_WORKABILITY_VERIFICATION_CODES);
const REQUIRED_OPEN_FACT_CODES = new Set<string>([
  "GATE_UNKNOWN_WORK_MODE",
  "NEEDS_VERIFICATION_LOCATION_DETAIL",
  "NEEDS_VERIFICATION_OFFICE_DAYS",
  "NEEDS_VERIFICATION_TRAVEL",
]);

export function isRoutableWorkabilityVerification(
  gateDecision: string | null | undefined,
  codes: readonly string[] | null | undefined,
): boolean {
  if (gateDecision !== "NEEDS_VERIFICATION" || !codes || codes.length === 0) return false;
  const normalizedCodes = codes.map((code) => code.trim()).filter(Boolean);
  return normalizedCodes.length > 0 &&
    normalizedCodes.every((code) => ROUTABLE_CODE_SET.has(code)) &&
    normalizedCodes.some((code) => REQUIRED_OPEN_FACT_CODES.has(code));
}

/**
 * SQL predicate matching the same allow-list for stage seed and lane-router queries.
 * The alias is an internal SQL identifier supplied by the caller.
 */
export function routableWorkabilityVerificationSql(alias = "c"): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error(`Invalid SQL alias for workability verification filter: ${alias}`);
  }
  const codes = `regexp_split_to_array(COALESCE(${alias}.rejection_reason, ''), E'\\\\s*,\\\\s*')`;
  const allowed = ROUTABLE_WORKABILITY_VERIFICATION_CODES.map((code) => `'${code}'`).join(", ");
  const required = [...REQUIRED_OPEN_FACT_CODES].map((code) => `'${code}'`).join(", ");
  return `(
    ${alias}.gate_decision = 'NEEDS_VERIFICATION'
    AND ${codes} <@ ARRAY[${allowed}]::text[]
    AND ${codes} && ARRAY[${required}]::text[]
  )`;
}
