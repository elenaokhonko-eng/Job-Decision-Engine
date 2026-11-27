/**
 * Extra caution for the MANUAL same-day check only. The shared page reader is not changed: this pure rule looks at
 * what it returned (and the page it read) and can only turn a verdict into "cannot tell". It never makes anything
 * open or closed.
 *
 *   would be OPEN   -> cannot tell, when any closure-like wording is on the page, or a validThrough is not clearly a
 *                      future ISO date.
 *   would be CLOSED -> cannot tell, when the page speaks of maintenance. A closure the reader took from wording alone
 *                      that stays CLOSED is flagged for a check by hand.
 *   challenge page  -> bot blocked.
 *
 * Linear in the size of the page: markup is removed by htmlToPlainText (the email extractor's linear remover), and
 * every other look is one pass or a bounded window.
 */
import { htmlToPlainText } from "./emailAlertExtractor.js";
import type { JobContentResult } from "./jobContentFetcher.js";

export type ManualDowngradeReason = "CLOSURE_WORDING" | "VALID_THROUGH_NOT_CLEARLY_FUTURE" | "MAINTENANCE_WORDING" | "CHALLENGE_PAGE";

export interface ManualPage {
  readonly status: number;
  /** The page's HTML; null for a JSON API response. */
  readonly html: string | null;
}

export interface ManualDowngrade {
  readonly result: JobContentResult;
  readonly reason: ManualDowngradeReason | null;
  /** CLOSED from page wording alone (no 404, 410 or status field): the owner should look. */
  readonly checkByHand: boolean;
}

/** Wide on purpose: the only effect of a match is "cannot tell". */
const CLOSURE_WORDING: readonly RegExp[] = [
  /\bno longer (?:be(?:ing)? )?(?:accept(?:s|ing|ed)?|taking|receiving)\b/,
  /\bno longer (?:active|available|open|live|hiring|recruiting|vacant)\b/,
  /\bapplications? (?:(?:are|is|have|has|were|was) )?(?:now )?(?:been )?(?:now )?closed\b/,
  /\b(?:job|position|posting|vacancy|role|opportunity|requisition|advert|advertisement|opening)(?: (?:posting|listing|ad))?(?: (?:is|has|was))?(?: (?:now|already))?(?: been)?(?: (?:now|already))? (?:filled|closed|expired|removed|withdrawn|cancelled|canceled)\b/,
  /\bclosed (?:to|for) (?:new |further )?applications\b/,
  /\b(?:deadline|closing date)(?: for applications)? has (?:now )?passed\b/,
];

const MAINTENANCE_WORDING: readonly RegExp[] = [
  /\bmaintenance\b/,
  /\btemporarily (?:un)?(?:available|offline|down)\b/,
  /\bnot available at this time\b/,
  /\btry again (?:later|shortly|soon|in a )\b/,
  /\b(?:service|site|system) (?:is )?(?:currently )?unavailable\b/,
  /\btechnical (?:difficulties|difficulty|issues?|problems?)\b/,
  /\bsomething went wrong\b/,
  /\bcheck back (?:later|soon|shortly)\b/,
];

/** Marks of an interstitial bot challenge (not of an ordinary page behind the same provider). */
const CHALLENGE_MARKS: readonly RegExp[] = [
  /<title>\s{0,20}(?:just a moment|attention required)/i,
  /\bcf[-_]chl[-_]/i,
  /\bpx-captcha\b/i,
  /geo\.captcha-delivery\.com/i,
  /request unsuccessful\. incapsula incident/i,
  /\bverify (?:that )?you(?: are|'re) (?:a )?human\b/i,
  /\bare you a robot\b/i,
];

export function isChallengePage(page: ManualPage): boolean {
  return (page.status === 200 || page.status === 503) && page.html !== null && CHALLENGE_MARKS.some((mark) => mark.test(page.html!));
}

function plain(value: string): string {
  return value.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
}

/** The <title> text, found without a pattern that can rescan: the plain-text pass drops the head. */
function documentTitle(html: string): string {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<title");
  if (open < 0) return "";
  const start = lower.indexOf(">", open);
  const end = start < 0 ? -1 : lower.indexOf("</title", start);
  return end < 0 ? "" : html.slice(start + 1, end);
}

function pageText(result: JobContentResult, page: ManualPage | null): string {
  const parts: string[] = [];
  if (page?.html) parts.push(documentTitle(page.html), htmlToPlainText(page.html));
  if (result.kind === "COMPLETE") parts.push(result.posting.title, htmlToPlainText(result.posting.description));
  return plain(parts.join(" \n "));
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A real ISO date that is after now in every time zone it could mean. */
export function isClearlyFutureIsoDate(value: string, now: Date): boolean {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return false;
  const [, year, month, day, hour, , zone] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)) return false;
  const margin = 14 * 3_600_000;
  if (hour === undefined) return calendar.getTime() - margin > now.getTime();
  const time = new Date(zone === undefined ? `${value.trim().replace(" ", "T")}Z` : value.trim().replace(" ", "T")).getTime();
  return !Number.isNaN(time) && time - (zone === undefined ? margin : 0) > now.getTime();
}

const WINDOW = 300;

/** The value written for one `validThrough` mention (JSON-LD or microdata), or null when it cannot be read. */
function validThroughValue(html: string, index: number): string | null {
  const before = html.slice(Math.max(0, index - WINDOW), index);
  const after = html.slice(index + "validThrough".length, index + "validThrough".length + WINDOW);
  const json = /^"\s{0,20}:\s{0,20}"([^"]{0,80})"/.exec(after);
  if (json) return json[1]!;
  if (!/itemprop\s{0,5}=\s{0,5}["']?$/i.test(before)) return null;
  const tagStart = before.lastIndexOf("<");
  const tagEnd = after.indexOf(">");
  if (tagStart < 0 || tagEnd < 0) return null;
  const tag = `${before.slice(tagStart)} ${after.slice(0, tagEnd)}`;
  const attribute = /\s(?:content|datetime)\s{0,5}=\s{0,5}["']([^"']{0,80})["']/i.exec(tag);
  if (attribute) return attribute[1]!;
  const text = after.slice(tagEnd + 1);
  const close = text.indexOf("<");
  return close < 0 ? null : text.slice(0, close).trim();
}

function validThroughUnclear(result: JobContentResult, page: ManualPage | null, now: Date): boolean {
  if (result.kind === "COMPLETE" && result.posting.expiresAt !== null && !isClearlyFutureIsoDate(result.posting.expiresAt, now)) return true;
  if (!page?.html) return false;
  for (const mention of page.html.matchAll(/validThrough/gi)) {
    const value = validThroughValue(page.html, mention.index);
    if (value === null || !isClearlyFutureIsoDate(value, now)) return true;
  }
  return false;
}

export function downgradeForManualCheck(result: JobContentResult, page: ManualPage | null, now: Date): ManualDowngrade {
  const cannotTell = (reason: ManualDowngradeReason): ManualDowngrade => ({
    result: { kind: "BLOCKED", reason: reason === "CHALLENGE_PAGE" ? "BOT_BLOCKED" : "UNSUPPORTED_SOURCE" },
    reason,
    checkByHand: false,
  });
  if (result.kind !== "COMPLETE" && page && isChallengePage(page)) return cannotTell("CHALLENGE_PAGE");
  const open = result.kind === "COMPLETE" && result.posting.availability !== "CLOSED";
  const closed = result.kind === "UNAVAILABLE" || (result.kind === "COMPLETE" && result.posting.availability === "CLOSED");
  if (open) {
    const text = pageText(result, page);
    if (CLOSURE_WORDING.some((wording) => wording.test(text))) return cannotTell("CLOSURE_WORDING");
    if (validThroughUnclear(result, page, now)) return cannotTell("VALID_THROUGH_NOT_CLEARLY_FUTURE");
  }
  if (closed) {
    const text = pageText(result, page);
    if (MAINTENANCE_WORDING.some((wording) => wording.test(text))) return cannotTell("MAINTENANCE_WORDING");
  }
  return { result, reason: null, checkByHand: result.kind === "UNAVAILABLE" && !/HTTP (404|410)\b/.test(result.reason) };
}
