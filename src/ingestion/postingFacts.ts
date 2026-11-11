/**
 * Posting dates and open/closed status captured when a posting page was read
 * (a saved-jobs export made in the user's own browser, or a provider response).
 *
 * The helpers turn what the source showed into root raw-payload fields that
 * `buildJobSourceEvidence` and `extractFreshnessEvidence` already read
 * (`posted_at`, `reposted_at`, `source_expires_at`, `status`) plus the check
 * time (`availability_checked_at`) and a `date_derivations` record that says how
 * each date was obtained. Nothing is invented:
 *
 * - an absolute source date is kept as given, with its precision (EXACT or DAY);
 * - relative text such as "2 weeks ago" is converted only against the time the
 *   text was read, and is recorded as RELATIVE_SOURCE_TEXT with the unit as
 *   precision (the source rounds, so the true date may be up to one unit older);
 * - text that only gives a lower bound ("30+ days ago") or cannot be read stays
 *   unknown, and so does any fact without a valid check time.
 */

export const POSTING_FACTS_SCHEMA = "posting_facts_v1" as const;

export type PostingDatePrecision = "EXACT" | "DAY" | "MINUTE" | "HOUR" | "WEEK" | "MONTH" | "YEAR";
export type PostingDateBasis = "ABSOLUTE_SOURCE_DATE" | "RELATIVE_SOURCE_TEXT";

export interface PostingDateDerivation {
  readonly basis: PostingDateBasis;
  readonly precision: PostingDatePrecision;
  /** The text or value exactly as the source showed it. */
  readonly source_text: string;
  /** For relative text: the time the text was read, used as the anchor. */
  readonly anchor_at: string | null;
}

export interface DerivedPostingDate {
  readonly iso: string;
  /** "REPOSTED" when the source labels the age as a repost ("Reposted 3 days ago"). */
  readonly kind: "POSTED" | "REPOSTED";
  readonly derivation: PostingDateDerivation;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UNIT_MS: Record<Exclude<PostingDatePrecision, "EXACT" | "DAY">, number> & { DAY: number } = {
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: DAY_MS,
  WEEK: 7 * DAY_MS,
  // The source does not say how it rounds months and years; these are the
  // conventional lengths, and the precision field records that coarseness.
  MONTH: 30 * DAY_MS,
  YEAR: 365 * DAY_MS,
};

const LONG_UNITS: Record<string, keyof typeof UNIT_MS> = {
  minute: "MINUTE", min: "MINUTE", mins: "MINUTE",
  hour: "HOUR", hr: "HOUR", hrs: "HOUR",
  day: "DAY",
  week: "WEEK", wk: "WEEK", wks: "WEEK",
  month: "MONTH", mo: "MONTH", mos: "MONTH",
  year: "YEAR", yr: "YEAR", yrs: "YEAR",
};
const SHORT_UNITS: Record<string, keyof typeof UNIT_MS> = { m: "MINUTE", h: "HOUR", d: "DAY", w: "WEEK", mo: "MONTH", y: "YEAR" };

/** A strict timestamp: ISO-8601 with a date part, parseable, as an ISO string. */
export function parseCheckTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value.trim())) return null;
  const date = new Date(value.trim());
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * An absolute source date ("2026-10-28", "2026-10-28T09:12:00.000Z"). A bare
 * calendar date is DAY precision at 00:00 UTC; anything that is not an ISO date
 * (including relative text) returns null.
 */
export function parseAbsoluteSourceDate(value: unknown): { iso: string; precision: "EXACT" | "DAY"; sourceText: string } | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(text)) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  return { iso: date.toISOString(), precision: text.length === 10 ? "DAY" : "EXACT", sourceText: text };
}

/**
 * Relative posting-age text ("2 weeks ago", "Reposted 3 days ago", "Posted 2w ago",
 * "an hour ago", "yesterday", "just now") converted against the time it was read.
 * Lower-bound text ("30+ days ago"), future text and anything else returns null.
 */
export function parseRelativePostedText(value: unknown, anchorAt: unknown): DerivedPostingDate | null {
  if (typeof value !== "string") return null;
  const sourceText = value.replace(/\s+/g, " ").trim();
  const anchor = parseCheckTime(anchorAt);
  if (!sourceText || !anchor || sourceText.length > 100 || sourceText.includes("+")) return null;
  const prefix = sourceText.match(/^(re)?posted\s+(?:on\s+)?/i);
  const kind = prefix?.[1] ? "REPOSTED" : "POSTED";
  const rest = sourceText.slice(prefix?.[0].length ?? 0).toLowerCase();

  let amount: number | null = null;
  let unit: keyof typeof UNIT_MS | null = null;
  const long = rest.match(/^(\d{1,4}|an?|one)\s+([a-z]+?)s?\s+ago$/);
  const short = rest.match(/^(\d{1,4})\s*(mo|m|h|d|w|y)\s+ago$/);
  if (long) {
    amount = /^\d/.test(long[1]) ? Number(long[1]) : 1;
    unit = LONG_UNITS[long[2]] ?? null;
  } else if (short) {
    amount = Number(short[1]);
    unit = SHORT_UNITS[short[2]] ?? null;
  } else if (rest === "just now" || rest === "today") {
    amount = 0;
    unit = rest === "today" ? "DAY" : "MINUTE";
  } else if (rest === "yesterday") {
    amount = 1;
    unit = "DAY";
  }
  if (amount === null || unit === null || !Number.isFinite(amount)) return null;
  const iso = new Date(new Date(anchor).getTime() - amount * UNIT_MS[unit]).toISOString();
  return {
    iso,
    kind,
    derivation: { basis: "RELATIVE_SOURCE_TEXT", precision: unit, source_text: sourceText, anchor_at: anchor },
  };
}

export interface PostingFactsInput {
  /** Absolute publication date shown by the source (JSON-LD datePosted, <time datetime>, API date). */
  readonly postedAt?: string | null;
  /** Relative age text shown by the source ("2 weeks ago", "Reposted 3 days ago"). */
  readonly postedAtText?: string | null;
  /** Absolute repost date given by the source (for example MCF's newPostingDate). */
  readonly repostedAt?: string | null;
  /** Absolute end of the application window (JSON-LD validThrough, MCF expiryDate). */
  readonly expiresAt?: string | null;
  readonly availabilityStatus?: "OPEN" | "CLOSED" | "UNKNOWN" | null;
  /** The short page/API text the status was read from. */
  readonly availabilityEvidence?: string | null;
  /** How the status was read, e.g. LINKEDIN_GUEST_POSTING_PAGE. */
  readonly checkMethod: string;
  /** When the posting page or API response was read. */
  readonly checkedAt?: string | null;
}

export interface PostingFactsResult {
  /** Root raw-payload fields; empty when nothing is known. */
  readonly payload: Record<string, unknown>;
  readonly publishedAt: string | null;
  readonly repostedAt: string | null;
  readonly expiresAt: string | null;
  readonly availability: "OPEN" | "CLOSED" | "UNKNOWN";
  /** Supplied values that could not be used (kept in the exported item, never as facts). */
  readonly ignored: string[];
}

/**
 * Root raw-payload fields for the posting facts that are actually known. A date
 * later than the check time, or a status without a valid check time, is ignored
 * and reported rather than stored as a fact.
 */
export function postingFactsPayload(input: PostingFactsInput): PostingFactsResult {
  const ignored: string[] = [];
  const checkedAt = parseCheckTime(input.checkedAt);
  if (input.checkedAt && !checkedAt) ignored.push("checkedAt is not an ISO timestamp");
  const checkedMs = checkedAt ? new Date(checkedAt).getTime() : null;
  const notAfterCheck = (iso: string) => checkedMs === null || new Date(iso).getTime() <= checkedMs;

  const derivations: Record<string, PostingDateDerivation> = {};
  let publishedAt: string | null = null;
  let repostedAt: string | null = null;

  const absolutePosted = parseAbsoluteSourceDate(input.postedAt);
  if (input.postedAt && !absolutePosted) {
    // An older export may carry the age text in postedAt; read it as relative text.
    const relative = parseRelativePostedText(input.postedAt, checkedAt);
    if (relative && !input.postedAtText) {
      if (relative.kind === "REPOSTED") repostedAt = relative.iso;
      else publishedAt = relative.iso;
      derivations[relative.kind === "REPOSTED" ? "reposted_at" : "posted_at"] = relative.derivation;
    } else if (!relative) {
      ignored.push("postedAt is neither an ISO date nor readable relative text with a check time");
    }
  } else if (absolutePosted) {
    if (notAfterCheck(absolutePosted.iso)) {
      publishedAt = absolutePosted.iso;
      derivations.posted_at = { basis: "ABSOLUTE_SOURCE_DATE", precision: absolutePosted.precision, source_text: absolutePosted.sourceText, anchor_at: null };
    } else {
      ignored.push("postedAt is later than the check time");
    }
  }

  if (input.postedAtText) {
    const relative = parseRelativePostedText(input.postedAtText, checkedAt);
    if (!relative) {
      ignored.push("postedAtText is not readable relative text with a check time");
    } else if (relative.kind === "REPOSTED" && repostedAt === null) {
      repostedAt = relative.iso;
      derivations.reposted_at = relative.derivation;
    } else if (relative.kind === "POSTED" && publishedAt === null) {
      // An absolute date, when present, is more precise than the age text and wins.
      publishedAt = relative.iso;
      derivations.posted_at = relative.derivation;
    }
  }

  const absoluteRepost = parseAbsoluteSourceDate(input.repostedAt);
  if (input.repostedAt && !absoluteRepost) ignored.push("repostedAt is not an ISO date");
  if (absoluteRepost) {
    if (!notAfterCheck(absoluteRepost.iso)) {
      ignored.push("repostedAt is later than the check time");
    } else if (publishedAt !== null && new Date(absoluteRepost.iso).getTime() <= new Date(publishedAt).getTime()) {
      // Same as (or before) the publication date: not a repost.
    } else {
      repostedAt = absoluteRepost.iso;
      derivations.reposted_at = { basis: "ABSOLUTE_SOURCE_DATE", precision: absoluteRepost.precision, source_text: absoluteRepost.sourceText, anchor_at: null };
    }
  }

  const absoluteExpiry = parseAbsoluteSourceDate(input.expiresAt);
  if (input.expiresAt && !absoluteExpiry) ignored.push("expiresAt is not an ISO date");
  const expiresAt = absoluteExpiry?.iso ?? null;
  if (absoluteExpiry) {
    derivations.source_expires_at = { basis: "ABSOLUTE_SOURCE_DATE", precision: absoluteExpiry.precision, source_text: absoluteExpiry.sourceText, anchor_at: null };
  }

  let availability: PostingFactsResult["availability"] = "UNKNOWN";
  if (input.availabilityStatus === "OPEN" || input.availabilityStatus === "CLOSED") {
    if (checkedAt) availability = input.availabilityStatus;
    else ignored.push("availabilityStatus has no valid check time");
  }

  const payload: Record<string, unknown> = {};
  if (publishedAt) payload.posted_at = publishedAt;
  if (repostedAt) payload.reposted_at = repostedAt;
  if (expiresAt) payload.source_expires_at = expiresAt;
  if (availability !== "UNKNOWN" && checkedAt) {
    payload.status = availability === "OPEN" ? "open" : "closed";
    payload.availability_checked_at = checkedAt;
    payload.availability_check_method = input.checkMethod;
    const evidence = (input.availabilityEvidence ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (evidence) payload.availability_evidence_text = evidence;
  }
  if (Object.keys(derivations).length > 0) payload.date_derivations = derivations;
  if (Object.keys(payload).length > 0) payload.posting_facts_schema = POSTING_FACTS_SCHEMA;
  return { payload, publishedAt, repostedAt, expiresAt, availability, ignored };
}

/** The posting-fact root fields of a stored raw payload (used to carry them to a derived observation). */
export const POSTING_FACT_PAYLOAD_KEYS = [
  "posted_at",
  "reposted_at",
  "source_expires_at",
  "status",
  "availability_checked_at",
  "availability_check_method",
  "availability_evidence_text",
  "date_derivations",
  "posting_facts_schema",
] as const;

export function pickPostingFactPayload(rawPayload: unknown): Record<string, unknown> {
  if (rawPayload === null || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return {};
  const record = rawPayload as Record<string, unknown>;
  if (record.posting_facts_schema !== POSTING_FACTS_SCHEMA) return {};
  const picked: Record<string, unknown> = {};
  for (const key of POSTING_FACT_PAYLOAD_KEYS) {
    if (record[key] !== undefined && record[key] !== null) picked[key] = record[key];
  }
  return picked;
}
