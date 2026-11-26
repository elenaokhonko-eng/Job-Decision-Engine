/**
 * Pure rules of the blind review set: no database, no clock, no environment. The draw date comes from the caller's clock.
 */
import { isUnknownEmployerName, normalizePostingUrl } from "../ingestion/postingIdentity.js";
import { normalizeJobIdentity } from "../modules/catalog/index.js";

/** "The same day" is the calendar day in this timezone. */
export const BLIND_REVIEW_TIME_ZONE = "Asia/Singapore";

/** The calendar date (YYYY-MM-DD) of an instant in BLIND_REVIEW_TIME_ZONE. */
export function reviewDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BLIND_REVIEW_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function verifiedOnReviewDate(verifiedAt: Date | null, now: Date): boolean {
  return verifiedAt !== null && !Number.isNaN(verifiedAt.getTime()) && reviewDate(verifiedAt) === reviewDate(now);
}

/**
 * Why a scored job is left out. A job is counted once, under the first reason that applies, in this order. Availability and
 * duplicates come last, so NOT_VERIFIED_OPEN_ON_DRAW_DATE counts the postings (not known to be closed) that would be eligible
 * if confirmed open that day. DUPLICATE_POSTING is decided across the pool by the loader, not by blindReviewExclusion.
 */
export const BLIND_REVIEW_EXCLUSIONS = [
  "ARCHIVED", "TEST_FIXTURE", "NOT_GATE_PASSED", "MANUALLY_REMOVED", "SAVED_BY_USER", "HAS_APPLICATION", "ALREADY_LABELLED",
  "SAME_POSTING_AS_SAVED_APPLIED_OR_LABELLED", "LINKEDIN", "AWAITING_CONTENT", "NO_POSTING_LINK", "NO_CURRENT_TOPK_MATCH",
  "AWAITING_RECOMPUTE", "CONFIRMED_CLOSED", "NOT_VERIFIED_OPEN_ON_DRAW_DATE", "DUPLICATE_POSTING",
] as const;
export type BlindReviewExclusion = (typeof BLIND_REVIEW_EXCLUSIONS)[number];

export interface BlindReviewFacts {
  archived: boolean;
  testFixture: boolean;
  gatePassed: boolean;
  manuallyRemoved: boolean;
  savedByUser: boolean;
  hasApplication: boolean;
  labelled: boolean;
  samePostingAsTaken: boolean;
  linkedIn: boolean;
  contentComplete: boolean;
  hasPostingLink: boolean;
  currentTopKMatch: boolean;
  awaitingRecompute: boolean;
  confirmedClosed: boolean;
  availabilityCurrent: boolean;
  availabilityVerifiedAt: Date | null;
}

export function blindReviewExclusion(facts: BlindReviewFacts, now: Date): BlindReviewExclusion | null {
  if (facts.archived) return "ARCHIVED";
  if (facts.testFixture) return "TEST_FIXTURE";
  if (!facts.gatePassed) return "NOT_GATE_PASSED";
  if (facts.manuallyRemoved) return "MANUALLY_REMOVED";
  if (facts.savedByUser) return "SAVED_BY_USER";
  if (facts.hasApplication) return "HAS_APPLICATION";
  if (facts.labelled) return "ALREADY_LABELLED";
  if (facts.samePostingAsTaken) return "SAME_POSTING_AS_SAVED_APPLIED_OR_LABELLED";
  if (facts.linkedIn) return "LINKEDIN";
  if (!facts.contentComplete) return "AWAITING_CONTENT";
  if (!facts.hasPostingLink) return "NO_POSTING_LINK";
  if (!facts.currentTopKMatch) return "NO_CURRENT_TOPK_MATCH";
  if (facts.awaitingRecompute) return "AWAITING_RECOMPUTE";
  if (facts.confirmedClosed) return "CONFIRMED_CLOSED";
  // Never verified, window run out, or verified on another day.
  if (!facts.availabilityCurrent || !verifiedOnReviewDate(facts.availabilityVerifiedAt, now)) return "NOT_VERIFIED_OPEN_ON_DRAW_DATE";
  return null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** The URL, parsed and percent-encoded so it is safe inside a Markdown table cell; null unless it is plain http or https. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw || CONTROL_CHARACTERS.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  return url.href.replace(/[\s|<>()[\]`"'\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** A posting link the reviewer can open: http(s), and not one of the broken Himalayas link shapes. */
export function postingLink(value: string | null | undefined): string | null {
  const url = safeHttpUrl(value);
  return url && !/^https?:\/\/himalayas\.app\/jobs\/([0-9a-f]{16,}|api)/i.test(url) ? url : null;
}

/**
 * Untrusted text as one line of plain text in a Markdown table cell: no line breaks, format characters, Markdown or HTML.
 * Autolink triggers (@, //, www., mailto:, xmpp:) get a zero-width space, so they stay broken after entities are decoded.
 */
export function markdownText(value: string | null | undefined): string {
  const line = (value ?? "")
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\p{Cf}+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return line.replace(/www\.|mailto:|xmpp:|\/(?=\/)|[&<>@\\`*_[\]()|~!]/gi, (match) => {
    if (/^www\.$/i.test(match)) return `${match.slice(0, 3)}&#8203;&#46;`;
    if (match.endsWith(":")) return `${match.slice(0, -1)}&#58;&#8203;`;
    if (match === "/") return "&#47;&#8203;";
    if (match === "&") return "&amp;";
    if (match === "<") return "&lt;";
    if (match === ">") return "&gt;";
    if (match === "@") return "&#64;&#8203;";
    return `\\${match}`;
  });
}

/** A LinkedIn host followed by a path, with or without a scheme, anywhere in a decoded path, query or fragment. */
const CARRIED_LINKEDIN_URL = /(?:^|[/=?&#:,;|\s])(?:[a-z0-9-]+\.)*(?:linkedin\.com|lnkd\.in)\.?(?::\d+)?\//i;

function percentDecoded(value: string): string {
  let text = value;
  // Redirect wrappers may encode more than once.
  for (let i = 0; i < 3; i += 1) text = text.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return text;
}

/** True when the link is on LinkedIn, or is a redirect wrapper that carries a LinkedIn URL in its path, query or fragment. */
export function isLinkedInLink(value: string | null | undefined, depth = 0): boolean {
  const raw = (value ?? "").trim();
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "linkedin.com" || host.endsWith(".linkedin.com") || host === "lnkd.in") return true;
  if (CARRIED_LINKEDIN_URL.test(percentDecoded(`${url.pathname}${url.search}${url.hash}`))) return true;
  return depth < 2 && [...url.searchParams.values()].some((v) => /^https?:\/\//i.test(v) && isLinkedInLink(v, depth + 1));
}

export function isLinkedInSource(sourceName: string | null | undefined, sourcePluginKey: string | null | undefined): boolean {
  return /linkedin/i.test(sourceName ?? "") || /linkedin/i.test(sourcePluginKey ?? "");
}

export interface PostingRecord {
  company: string | null;
  title: string | null;
  location: string | null;
  urls: ReadonlyArray<string | null>;
  identityHashes: ReadonlyArray<string | null>;
}

const words = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The keys under which two canonical records are one posting. They follow the identity rules of src/pipeline/normalize.ts
 * (source posting identity + company; URL + company + location, or + title; company + title + location), comparing employer
 * and location through normalizeJobIdentity, so legal suffixes and the ways of writing Singapore do not matter. Every key
 * needs a known company name. Used to compare only; no stored key changes.
 */
export function postingKeys(record: PostingRecord): string[] {
  const names = normalizeJobIdentity(record);
  const company = isUnknownEmployerName(record.company) ? "" : names.employer;
  if (!company) return [];
  const title = words(record.title);
  const location = names.location;
  const keys: string[] = [];
  for (const hash of record.identityHashes) if (hash?.trim()) keys.push(JSON.stringify(["id", company, hash.trim()]));
  for (const value of record.urls) {
    const url = value ? normalizePostingUrl(value) : null;
    if (!url) continue;
    keys.push(JSON.stringify(["url-location", company, url, location]));
    if (title) keys.push(JSON.stringify(["url-title", company, url, title]));
  }
  if (title) keys.push(JSON.stringify(["company-title-location", company, title, location]));
  return keys;
}
