/**
 * Source-quality policy for job descriptions.
 *
 * This is deliberately separate from career gates. A short source record is
 * enrichment debt and must never become HARD_REJECTED merely because the
 * source did not provide enough text.
 */
export const MIN_COMPLETE_DESCRIPTION_CHARS = 1000;

export type DescriptionQualityStatus = "COMPLETE" | "INCOMPLETE" | "UNKNOWN";

export function classifyDescriptionQuality(value: unknown): {
  status: DescriptionQualityStatus;
  reason: string | null;
} {
  const text = String(value ?? "").trim();
  if (text.length === 0) {
    return { status: "UNKNOWN", reason: "DESCRIPTION_MISSING" };
  }
  if (text.length < MIN_COMPLETE_DESCRIPTION_CHARS) {
    return {
      status: "INCOMPLETE",
      reason: "DESCRIPTION_BELOW_1000_CHAR_COMPLETENESS_FLOOR",
    };
  }
  return { status: "COMPLETE", reason: null };
}
