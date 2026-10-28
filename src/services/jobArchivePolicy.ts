import type { ArchiveAgeBasis } from "../contracts/archive.js";

export type JobArchiveInvalidDateReason =
  | "SOURCE_DATE_INVALID"
  | "SOURCE_DATE_BASIS_MISMATCH"
  | "SOURCE_DATE_EVIDENCE_MISSING"
  | "FUTURE_SOURCE_DATE"
  | "CONTRADICTORY_SOURCE_DATES"
  | "OBSERVATION_DATE_INVALID"
  | "OBSERVATION_DATE_MISSING";

export interface JobArchiveVersionEvidence {
  readonly job_version_id?: unknown;
  readonly source_posting_identity_hash?: unknown;
  readonly source_published_at?: unknown;
  readonly reposted_at?: unknown;
  readonly first_seen_at?: unknown;
  readonly observation_first_seen_at?: unknown;
  readonly date_evidence?: unknown;
}

export type JobArchiveAgeAssessment =
  | {
      readonly status: "REFERENCE_FOUND";
      readonly referenceAt: Date;
      readonly ageBasis: ArchiveAgeBasis;
      readonly publicationDateUnknown: boolean;
    }
  | {
      readonly status: "INVALID_DATE";
      readonly reasonCode: JobArchiveInvalidDateReason;
    };

interface DateEvidenceRecord extends Record<string, unknown> {
  readonly status?: unknown;
  readonly value?: unknown;
  readonly basis?: unknown;
  readonly raw_value?: unknown;
  readonly evidence?: unknown;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Source evidence is parsed from JSONB, so narrow the external object boundary here.
  return value as Record<string, unknown>;
}

function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function dateEvidenceFor(version: JobArchiveVersionEvidence, key: "published_at" | "reposted_at"): DateEvidenceRecord | null {
  const sourceEvidence = objectRecord(version.date_evidence);
  const dates = objectRecord(sourceEvidence?.dates) ?? sourceEvidence;
  return objectRecord(dates?.[key]);
}

function supportedDateFromEvidence(
  evidence: DateEvidenceRecord | null,
  expectedBasis: "PUBLISHED_AT" | "GENUINE_REPOST_AT",
  runStartedAt: Date,
): { readonly date: Date | null; readonly reasonCode: JobArchiveInvalidDateReason | null } {
  if (!evidence) return { date: null, reasonCode: null };
  const status = evidence.status;
  if (status === "CONFLICTING" || status === "INVALID") {
    return { date: null, reasonCode: "SOURCE_DATE_INVALID" };
  }
  if (status !== "SUPPORTED") {
    return evidence.raw_value === null || evidence.raw_value === undefined
      ? evidence.value === null || evidence.value === undefined
        ? { date: null, reasonCode: null }
        : { date: null, reasonCode: "SOURCE_DATE_INVALID" }
      : { date: null, reasonCode: "SOURCE_DATE_INVALID" };
  }
  if (expectedBasis === "GENUINE_REPOST_AT" && evidence.basis === "SOURCE_UPDATED_AT") {
    return { date: null, reasonCode: null };
  }
  if (evidence.basis !== expectedBasis) {
    return { date: null, reasonCode: "SOURCE_DATE_BASIS_MISMATCH" };
  }
  const date = parseTimestamp(evidence.value);
  if (!date) return { date: null, reasonCode: "SOURCE_DATE_INVALID" };
  if (!Array.isArray(evidence.evidence) || evidence.evidence.length === 0) {
    return { date: null, reasonCode: "SOURCE_DATE_EVIDENCE_MISSING" };
  }
  if (date.getTime() > runStartedAt.getTime()) {
    return { date: null, reasonCode: "FUTURE_SOURCE_DATE" };
  }
  return { date, reasonCode: null };
}

function invalid(reasonCode: JobArchiveInvalidDateReason): JobArchiveAgeAssessment {
  return { status: "INVALID_DATE", reasonCode };
}

export function assessJobArchiveAge(
  versions: readonly JobArchiveVersionEvidence[],
  latestPostingIdentityHash: string | null,
  runStartedAt: Date,
): JobArchiveAgeAssessment {
  if (!Number.isFinite(runStartedAt.getTime())) return invalid("SOURCE_DATE_INVALID");
  const postingVersions = latestPostingIdentityHash
    ? versions.filter((version) => version.source_posting_identity_hash === latestPostingIdentityHash)
    : versions;
  const relevantVersions = postingVersions.length > 0 ? postingVersions : versions;
  const publicationDates = new Map<number, Date>();
  const repostDates = new Map<number, Date>();
  const observedDates: Date[] = [];

  for (const version of relevantVersions) {
    const publicationEvidence = supportedDateFromEvidence(
      dateEvidenceFor(version, "published_at"),
      "PUBLISHED_AT",
      runStartedAt,
    );
    if (publicationEvidence.reasonCode) return invalid(publicationEvidence.reasonCode);
    const publicationColumn = version.source_published_at === null || version.source_published_at === undefined
      ? null
      : parseTimestamp(version.source_published_at);
    if (version.source_published_at !== null && version.source_published_at !== undefined && !publicationColumn) {
      return invalid("SOURCE_DATE_INVALID");
    }
    if (publicationColumn && publicationColumn.getTime() > runStartedAt.getTime()) {
      return invalid("FUTURE_SOURCE_DATE");
    }
    if (publicationColumn && publicationEvidence.date && publicationColumn.getTime() !== publicationEvidence.date.getTime()) {
      return invalid("CONTRADICTORY_SOURCE_DATES");
    }
    const publicationDate = publicationColumn ?? publicationEvidence.date;
    if (publicationDate) publicationDates.set(publicationDate.getTime(), publicationDate);

    const repostEvidence = supportedDateFromEvidence(
      dateEvidenceFor(version, "reposted_at"),
      "GENUINE_REPOST_AT",
      runStartedAt,
    );
    if (repostEvidence.reasonCode) return invalid(repostEvidence.reasonCode);
    const repostColumn = version.reposted_at === null || version.reposted_at === undefined
      ? null
      : parseTimestamp(version.reposted_at);
    if (version.reposted_at !== null && version.reposted_at !== undefined && !repostColumn) {
      return invalid("SOURCE_DATE_INVALID");
    }
    if (repostColumn && repostColumn.getTime() > runStartedAt.getTime()) {
      return invalid("FUTURE_SOURCE_DATE");
    }
    if (repostColumn && repostEvidence.date && repostColumn.getTime() !== repostEvidence.date.getTime()) {
      return invalid("CONTRADICTORY_SOURCE_DATES");
    }
    if (repostEvidence.date) repostDates.set(repostEvidence.date.getTime(), repostEvidence.date);

    for (const value of [version.first_seen_at, version.observation_first_seen_at]) {
      if (value === null || value === undefined) continue;
      const date = parseTimestamp(value);
      if (!date) return invalid("OBSERVATION_DATE_INVALID");
      if (date.getTime() > runStartedAt.getTime()) return invalid("FUTURE_SOURCE_DATE");
      observedDates.push(date);
    }
  }

  if (publicationDates.size > 1) return invalid("CONTRADICTORY_SOURCE_DATES");
  const publicationDate = [...publicationDates.values()][0] ?? null;
  const repostDate = [...repostDates.values()].sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
  if (publicationDate && repostDate && repostDate.getTime() < publicationDate.getTime()) {
    return invalid("CONTRADICTORY_SOURCE_DATES");
  }
  if (repostDate) {
    return {
      status: "REFERENCE_FOUND",
      referenceAt: repostDate,
      ageBasis: "GENUINE_REPOST_DATE",
      publicationDateUnknown: publicationDate === null,
    };
  }
  if (publicationDate) {
    return {
      status: "REFERENCE_FOUND",
      referenceAt: publicationDate,
      ageBasis: "AUTHORITATIVE_PUBLICATION_DATE",
      publicationDateUnknown: false,
    };
  }
  const earliestObservation = observedDates.sort((left, right) => left.getTime() - right.getTime())[0];
  if (!earliestObservation) return invalid("OBSERVATION_DATE_MISSING");
  return {
    status: "REFERENCE_FOUND",
    referenceAt: earliestObservation,
    ageBasis: "OBSERVED_AGE_PUBLICATION_UNKNOWN",
    publicationDateUnknown: true,
  };
}

export function subtractCalendarMonths(date: Date, months: number): Date {
  if (!Number.isInteger(months) || months < 0) {
    throw new RangeError("Calendar-month subtraction requires a non-negative integer.");
  }
  const result = new Date(date.getTime());
  const originalDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return result;
}

export function referenceIsOlderThanCutoff(referenceAt: Date, cutoffAt: Date): boolean {
  return referenceAt.getTime() < cutoffAt.getTime();
}
