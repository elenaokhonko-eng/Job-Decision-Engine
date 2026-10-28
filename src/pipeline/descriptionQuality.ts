/**
 * Source-quality policy for job descriptions.
 *
 * This is deliberately separate from career gates. A short source record is
 * enrichment debt and must never become HARD_REJECTED merely because the
 * source did not provide enough text.
 */
export const MIN_COMPLETE_DESCRIPTION_CHARS = 1000;

/**
 * Require source evidence for the exact job version before preparing documents.
 * Gmail alerts are discovery records; they count only when the persisted payload
 * explicitly marks the linked content as complete.
 */
export function sourceContentEvidencePredicate(workspaceExpression: string, jobVersionExpression: string): string {
  const trustedExpression = /^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*$/i;
  if (!trustedExpression.test(workspaceExpression) || !trustedExpression.test(jobVersionExpression)) {
    throw new Error("Source-content SQL expressions must be trusted identifiers.");
  }
  return `EXISTS (
    SELECT 1
    FROM raw_job_observations source_content_observation
    WHERE source_content_observation.workspace_id = ${workspaceExpression}
      AND source_content_observation.job_version_id = ${jobVersionExpression}
      AND (
        source_content_observation.source_name <> 'GMAIL_ALERT'
        OR source_content_observation.raw_payload->>'source_content_status' = 'COMPLETE'
      )
  )`;
}

export type DescriptionQualityStatus = "COMPLETE" | "INCOMPLETE" | "UNKNOWN";

export function classifyDescriptionQuality(value: unknown): {
  status: DescriptionQualityStatus;
  reason: string | null;
} {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) {
    return { status: "UNKNOWN", reason: "DESCRIPTION_MISSING" };
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const contentSignals = [
    /\b(responsibilit(?:y|ies)|duties|what you(?:'|’)ll do|you will|accountabilities)\b/i,
    /\b(qualifications|requirements|skills|what you bring|experience required)\b/i,
    /\b(about the role|role overview|position summary|job description|team)\b/i,
  ].filter((pattern) => pattern.test(text)).length;
  const shellOnly = /\b(cookie preferences|accept all cookies|sign in to continue|enable javascript|access denied)\b/i.test(text)
    && contentSignals === 0;

  if (shellOnly || wordCount < 35) {
    return { status: "INCOMPLETE", reason: shellOnly ? "DESCRIPTION_CONSISTS_OF_ACCESS_OR_COOKIE_SHELL" : "DESCRIPTION_HAS_INSUFFICIENT_SUBSTANTIVE_CONTENT" };
  }
  if (text.length < MIN_COMPLETE_DESCRIPTION_CHARS) {
    return contentSignals >= 2
      ? { status: "COMPLETE", reason: null }
      : { status: "INCOMPLETE", reason: "DESCRIPTION_NEEDS_ENRICHMENT_OR_SECTION_EVIDENCE" };
  }
  return { status: "COMPLETE", reason: null };
}
