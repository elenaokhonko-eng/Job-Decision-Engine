import { z } from "zod";

/**
 * Root raw-payload posting facts written by src/ingestion/postingFacts.ts
 * (saved-jobs exports) and the date derivations a fetched posting may carry.
 * The source-evidence builder parses these before reading them; a payload that
 * declares `posting_facts_schema` but does not match is quarantined (its
 * normalized evidence fails and the error is recorded on the observation).
 */
export const POSTING_FACTS_SCHEMA_VERSION = "posting_facts_v1" as const;

export const PostingDatePrecisionSchema = z.enum(["EXACT", "DAY", "MINUTE", "HOUR", "WEEK", "MONTH", "YEAR"]);
export type PostingDatePrecision = z.infer<typeof PostingDatePrecisionSchema>;

/** Units whose dates are approximate: relative text such as "2 weeks ago" rounds down by up to one unit. */
export const APPROXIMATE_DATE_UNITS = ["MINUTE", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const;

export const PostingDateDerivationSchema = z.object({
  basis: z.enum(["ABSOLUTE_SOURCE_DATE", "RELATIVE_SOURCE_TEXT"]),
  precision: PostingDatePrecisionSchema,
  source_text: z.string().min(1).max(200),
  anchor_at: z.string().datetime().nullable(),
}).strict().superRefine((derivation, context) => {
  if (derivation.basis === "RELATIVE_SOURCE_TEXT" && (derivation.anchor_at === null || derivation.precision === "EXACT")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "A relative-text date needs its anchor time and a unit precision." });
  }
});
export type PostingDateDerivation = z.infer<typeof PostingDateDerivationSchema>;

export const PostingDateDerivationsSchema = z.object({
  posted_at: PostingDateDerivationSchema.optional(),
  reposted_at: PostingDateDerivationSchema.optional(),
  source_expires_at: PostingDateDerivationSchema.optional(),
  /** A fetched posting's field name (VerifiedPosting.publishedAt). */
  publishedAt: PostingDateDerivationSchema.optional(),
}).strict();

export const PostingFactsPayloadSchema = z.object({
  posting_facts_schema: z.literal(POSTING_FACTS_SCHEMA_VERSION),
  posted_at: z.string().datetime().optional(),
  reposted_at: z.string().datetime().optional(),
  source_expires_at: z.string().datetime().optional(),
  status: z.enum(["open", "closed"]).optional(),
  availability_checked_at: z.string().datetime().optional(),
  availability_check_method: z.string().min(1).max(80).optional(),
  availability_evidence_text: z.string().min(1).max(300).optional(),
  date_derivations: PostingDateDerivationsSchema.optional(),
}).strict().superRefine((facts, context) => {
  if (facts.status !== undefined && facts.availability_checked_at === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "A posting status needs availability_checked_at." });
  }
  for (const key of ["posted_at", "reposted_at", "source_expires_at"] as const) {
    if (facts[key] !== undefined && facts.date_derivations?.[key] === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} needs its date derivation.` });
    }
  }
});
export type PostingFactsPayload = z.infer<typeof PostingFactsPayloadSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;
export type ApproximateDateUnit = (typeof APPROXIMATE_DATE_UNITS)[number];

/** Length of one approximate-date unit. Months and years use 30 and 365 days (the source does not say how it rounds). */
export const APPROXIMATE_DATE_UNIT_MS: Readonly<Record<ApproximateDateUnit, number>> = {
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: DAY_MS,
  WEEK: 7 * DAY_MS,
  MONTH: 30 * DAY_MS,
  YEAR: 365 * DAY_MS,
};

/**
 * `job_versions.freshness_basis` for a date converted from relative text, e.g.
 * POSTED_AT_APPROXIMATE_WEEK. The stored date is the newest possible date; the
 * true date may be up to one unit (minus a millisecond) older.
 */
export function approximateFreshnessBasis(kind: "POSTED_AT" | "REPOSTED_AT", unit: ApproximateDateUnit): string {
  return `${kind}_APPROXIMATE_${unit}`;
}

/**
 * The documented `job_versions.freshness_basis` values (the column is free text
 * with a non-blank CHECK, migration 075). Normalization writes POSTED_AT,
 * REPOSTED_AT, NEW_POSTING_ID and the approximate forms; the hard gate may
 * write NO_DATE / UNKNOWN when no age is known. Anything else is unrecognized
 * and is never read as an authoritative date.
 */
export const FRESHNESS_BASIS_PATTERN = /^(?:NEW_POSTING_ID|NO_DATE|UNKNOWN|(?:POSTED_AT|REPOSTED_AT)(?:_APPROXIMATE_(?:MINUTE|HOUR|DAY|WEEK|MONTH|YEAR))?)$/;

export interface ParsedFreshnessBasis {
  /**
   * POSTED_AT / REPOSTED_AT (exact or approximate), NEW_POSTING_ID, NO_DATE
   * (also UNKNOWN), or UNRECOGNIZED for any value outside the documented set,
   * including a malformed approximate value. Null when absent (legacy rows).
   */
  readonly kind: "POSTED_AT" | "REPOSTED_AT" | "NEW_POSTING_ID" | "NO_DATE" | "UNRECOGNIZED" | null;
  /** Set for an approximate (relative-text) date; null for an authoritative one. */
  readonly approximateUnit: ApproximateDateUnit | null;
}

/** Fail-safe: a value it cannot recognize is UNRECOGNIZED, which consumers treat as unknown age. */
export function parseFreshnessBasis(basis: string | null | undefined): ParsedFreshnessBasis {
  if (basis === null || basis === undefined || basis.trim() === "") return { kind: null, approximateUnit: null };
  if (!FRESHNESS_BASIS_PATTERN.test(basis)) return { kind: "UNRECOGNIZED", approximateUnit: null };
  if (basis === "NO_DATE" || basis === "UNKNOWN") return { kind: "NO_DATE", approximateUnit: null };
  if (basis === "POSTED_AT" || basis === "REPOSTED_AT" || basis === "NEW_POSTING_ID") return { kind: basis, approximateUnit: null };
  const [kind, unit] = basis.split("_APPROXIMATE_") as ["POSTED_AT" | "REPOSTED_AT", ApproximateDateUnit];
  return { kind, approximateUnit: unit };
}

/** Exact or approximate genuine-repost basis. */
export function isRepostFreshnessBasis(basis: string | null | undefined): boolean {
  return parseFreshnessBasis(basis).kind === "REPOSTED_AT";
}
