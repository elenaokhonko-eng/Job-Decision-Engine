/**
 * Source-quality policy for job descriptions.
 *
 * This is deliberately separate from career gates. A short source record is
 * enrichment debt and must never become HARD_REJECTED merely because the
 * source did not provide enough text.
 */
export const MIN_COMPLETE_DESCRIPTION_CHARS = 1000;

/**
 * SQL predicate requiring authoritative source evidence for this job version.
 * Gmail alerts are discovery records only; they satisfy this predicate only
 * after a retrieved posting observation explicitly records COMPLETE content.
 * Expressions are limited to trusted SQL identifiers supplied by call sites.
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

/** SQL predicate for a persisted, identity-matched retrieved posting snapshot. */
export function completeRetrievedPostingPredicate(observationAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(observationAlias)) {
    throw new Error("Retrieved-posting SQL aliases must be trusted identifiers.");
  }
  return `
    ${observationAlias}.source_name IN ('LEVER', 'EMPLOYER_WEBSITE', 'ASHBY', 'GREENHOUSE')
    AND ${observationAlias}.raw_payload->>'source_content_status' = 'COMPLETE'
    AND ${observationAlias}.raw_payload->>'content_hash' ~ '^[a-f0-9]{64}$'
    AND ${observationAlias}.raw_payload#>>'{source_evidence,responseHash}' ~ '^[a-f0-9]{64}$'
    AND NULLIF(BTRIM(${observationAlias}.raw_payload#>>'{source_evidence,requestedUrl}'), '') IS NOT NULL
    AND NULLIF(BTRIM(${observationAlias}.raw_payload#>>'{source_evidence,resolvedUrl}'), '') IS NOT NULL
    AND ${observationAlias}.raw_payload#>>'{posting,title}' = ${observationAlias}.title
    AND ${observationAlias}.raw_payload#>>'{posting,companyName}' = ${observationAlias}.company_name
    AND ${observationAlias}.job_version_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM job_versions retrieved_version
      WHERE retrieved_version.workspace_id = ${observationAlias}.workspace_id
        AND retrieved_version.id = ${observationAlias}.job_version_id
        AND retrieved_version.canonical_job_id IS NOT NULL
        AND retrieved_version.description_text = ${observationAlias}.description_raw
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

  if (shellOnly || wordCount < 20) {
    return { status: "INCOMPLETE", reason: shellOnly ? "DESCRIPTION_CONSISTS_OF_ACCESS_OR_COOKIE_SHELL" : "DESCRIPTION_HAS_INSUFFICIENT_SUBSTANTIVE_CONTENT" };
  }
  if (text.length < MIN_COMPLETE_DESCRIPTION_CHARS) {
    return contentSignals >= 2
      ? { status: "COMPLETE", reason: null }
      : { status: "INCOMPLETE", reason: "DESCRIPTION_NEEDS_ENRICHMENT_OR_SECTION_EVIDENCE" };
  }
  return { status: "COMPLETE", reason: null };
}
