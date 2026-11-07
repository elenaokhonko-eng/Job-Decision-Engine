import { Buffer } from "node:buffer";
import { simpleParser } from "mailparser";
import { decodeHTML } from "entities";
import { linkedInJobIdFromUrl } from "./searchApi/searchApiClient.js";

const MAX_EMAIL_BYTES = 10 * 1024 * 1024;
const MAX_MIME_PARTS = 256;
const MAX_CONTEXT_CHARS = 3_000;

export interface DecodedEmailBody {
  readonly text: string;
  readonly html: string;
}

export interface EmailJobCard {
  readonly sourceUrl: string;
  readonly title: string;
  readonly companyName: string;
  readonly location: string;
  readonly descriptionRaw: string;
}

export class EmailExtractionError extends Error {
  constructor(
    public readonly code: "INVALID_RAW_EMAIL" | "EMAIL_TOO_LARGE" | "MIME_STRUCTURE_LIMIT" | "MISSING_POSTING_URL",
    message: string,
  ) {
    super(message);
    this.name = "EmailExtractionError";
  }
}

function gmailMessageBytes(raw: string): Buffer {
  const trimmed = raw.trim();
  const hasMimeHeaders = /^(?:[\w-]+):[^\r\n]*(?:\r?\n|$)/.test(trimmed) && /(?:\r?\n){2}/.test(trimmed);
  if (!hasMimeHeaders && /^[A-Za-z0-9_-]+={0,2}$/.test(trimmed.replace(/\s+/g, ""))) {
    const bytes = Buffer.from(trimmed.replace(/\s+/g, ""), "base64url");
    if (bytes.byteLength > MAX_EMAIL_BYTES) {
      throw new EmailExtractionError("EMAIL_TOO_LARGE", "Decoded email exceeds the 10 MiB parsing limit.");
    }
    return bytes;
  }
  const bytes = Buffer.from(raw, "utf8");
  if (bytes.byteLength > MAX_EMAIL_BYTES) {
    throw new EmailExtractionError("EMAIL_TOO_LARGE", "Email exceeds the 10 MiB parsing limit.");
  }
  return bytes;
}

export async function decodeGmailRawEmail(raw: string): Promise<DecodedEmailBody> {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new EmailExtractionError("INVALID_RAW_EMAIL", "Gmail alert has no raw RFC 5322 message.");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_EMAIL_BYTES) {
    throw new EmailExtractionError("EMAIL_TOO_LARGE", "Encoded email exceeds the parser's bounded input limit.");
  }

  let parsed;
  try {
    parsed = await simpleParser(gmailMessageBytes(raw), {
      maxChildNodes: MAX_MIME_PARTS,
      maxHeadSize: 256 * 1024,
      maxHtmlLengthToParse: MAX_EMAIL_BYTES,
      keepCidLinks: true,
      checksumAlgo: false,
      ignoreEmbedded: true,
    });
  } catch (error) {
    throw new EmailExtractionError(
      "INVALID_RAW_EMAIL",
      "RFC 5322/MIME parsing failed: " + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (parsed.attachments.length > MAX_MIME_PARTS) {
    throw new EmailExtractionError("MIME_STRUCTURE_LIMIT", "Email contains too many MIME attachments.");
  }
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const text = decodeHtmlEntities(parsed.text ?? (html ? htmlToPlainText(html) : ""));
  if (!text.trim() && !html.trim()) {
    throw new EmailExtractionError("INVALID_RAW_EMAIL", "Email contains no readable text or HTML body.");
  }
  return { text, html };
}

export function decodeHtmlEntities(value: string): string {
  return decodeHTML(value);
}

export function htmlToPlainText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(?:br|hr)\b[^>]*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|tr|td|th|li|h[1-6]|section|article|table)\s*>/gi, "\n")
      .replace(/<(?:p|div|tr|td|th|li|h[1-6]|section|article|table)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
  ).replace(/[ \t\f\v]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function safeAbsoluteHttpUrl(value: string): string | null {
  try {
    const url = new URL(decodeHtmlEntities(value.trim()));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function unwrapForClassification(value: string): string {
  try {
    const url = new URL(value);
    if (/(?:^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === "/url") {
      return url.searchParams.get("q") ?? url.searchParams.get("url") ?? value;
    }
    if (/(?:^|\.)outlook\.[a-z.]+$/i.test(url.hostname)) {
      return url.searchParams.get("url") ?? url.searchParams.get("redirect") ?? value;
    }
    // Amazon SES click tracking: https://<id>.r.<region>.awstrack.me/L0/<encoded destination>/<n>/<signature>
    if (/(?:^|\.)awstrack\.me$/i.test(url.hostname)) {
      const encoded = url.pathname.match(/^\/L0\/([^/]+)/)?.[1];
      return encoded ? decodeURIComponent(encoded) : value;
    }
  } catch {
    return value;
  }
  return value;
}

/**
 * Whole path segments that identify site navigation rather than a single
 * posting (help centre, account settings, saved searches, alert management,
 * upsell pages). Matched against complete `/`-separated segments only, so a
 * posting slug such as `customer-support-lead` or `research-scientist` is kept.
 */
const NON_JOB_PATH_SEGMENTS = new Set([
  "help", "support", "settings", "email-settings", "preferences", "account", "accounts",
  "search", "alerts", "alert", "job-alerts", "jobalerts", "saved-searches", "premium",
  "login", "signin", "sign-in", "signup", "sign-up", "unsubscribe", "privacy", "privacy-policy",
  "terms", "terms-of-use", "legal", "feed", "notifications", "messaging", "mynetwork",
  "jobalert", "feedback", "contact", "contact-us",
]);

function isNavigationOrTrackingLink(urlValue: string, text: string): boolean {
  const textValue = text.toLowerCase().replace(/\s+/g, " ").trim();
  const urlLower = urlValue.toLowerCase();
  if (/\b(unsubscribe|manage preferences|email preferences|view in browser|privacy policy|terms of use)\b/.test(textValue)) {
    return true;
  }
  if (/(?:^|[\/?&=_-])(unsubscribe|preferences|email-settings|privacy-policy|terms-of-use|tracking-pixel)(?:[\/?&=_-]|$)/i.test(urlLower)
    || /\.(?:png|jpe?g|gif|svg|webp)(?:[?#]|$)/i.test(urlLower)) {
    return true;
  }
  try {
    const segments = new URL(unwrapForClassification(urlValue)).pathname.toLowerCase().split("/").filter(Boolean);
    return segments.some((segment) => NON_JOB_PATH_SEGMENTS.has(segment));
  } catch {
    return false;
  }
}

function isMyCareersFutureHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "mycareersfuture.gov.sg" || host.endsWith(".mycareersfuture.gov.sg");
}

function isLinkedInHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

/** Query parameters that only carry campaign attribution and never select a posting. */
function withoutCampaignParameters(urlValue: string): string {
  const url = new URL(urlValue);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

type LinkClassification =
  | { readonly kind: "JOB"; readonly key: string; readonly canonicalUrl: string }
  | { readonly kind: "NON_JOB" };

/**
 * A LinkedIn link is a job card only when its path names one posting
 * (`/jobs/view/<numeric id>`, with or without `/comm`); every other LinkedIn
 * link (search, alerts, Job Alert Manager, help, premium, profile) is
 * navigation. Its identity is the job id, so the title link, logo link, "View
 * job" button and every tracking-parameter variant collapse into one card with
 * the canonical `https://www.linkedin.com/jobs/view/<id>` URL. Other senders
 * keep their existing vacancy rules minus clear navigation.
 */
function classifyLink(url: string, text: string, context: string): LinkClassification {
  let parsed: URL;
  try {
    parsed = new URL(unwrapForClassification(url));
  } catch {
    return { kind: "NON_JOB" };
  }
  if (isLinkedInHost(parsed.hostname)) {
    const jobId = /\/(?:comm\/)?jobs\/view\//i.test(parsed.pathname) ? linkedInJobIdFromUrl(parsed.toString()) : null;
    if (!jobId) return { kind: "NON_JOB" };
    return { kind: "JOB", key: "linkedin:" + jobId, canonicalUrl: "https://www.linkedin.com/jobs/view/" + jobId };
  }
  // MyCareersFuture alerts also link the home page, search results, "Remove this
  // job alert" and feedback; only /job/<category>/<slug> names one posting.
  if (isMyCareersFutureHost(parsed.hostname)) {
    if (!/^\/job\/[^/]+\/[^/]+\/?$/i.test(parsed.pathname)) return { kind: "NON_JOB" };
    const canonicalUrl = "https://www.mycareersfuture.gov.sg" + parsed.pathname.replace(/\/$/, "");
    return { kind: "JOB", key: "url:" + canonicalUrl, canonicalUrl };
  }
  if (isNavigationOrTrackingLink(url, text) || !isLikelyVacancyLink(url, text, context)) return { kind: "NON_JOB" };
  // A click-tracking wrapper is not the posting's identity; stage the destination.
  const canonicalUrl = withoutCampaignParameters(/(?:^|\.)awstrack\.me$/i.test(new URL(url).hostname) ? parsed.toString() : url);
  return { kind: "JOB", key: "url:" + canonicalUrl, canonicalUrl };
}

function isLikelyVacancyLink(urlValue: string, text: string, context: string): boolean {
  const candidate = unwrapForClassification(urlValue);
  try {
    const url = new URL(candidate);
    const signal = /(?:^|\/)(?:job|jobs|position|positions|career|careers|opportunit(?:y|ies)|role|roles|opening|openings)(?:[\/?._-]|$)/i.test(url.pathname)
      || /(?:^|\.)jobs\.lever\.co$/i.test(url.hostname)
      || /(?:^|\.)greenhouse\.io$/i.test(url.hostname)
      || /(?:^|\.)ashbyhq\.com$/i.test(url.hostname)
      || /(?:^|\.)myworkdayjobs\.com$/i.test(url.hostname)
      || /(?:^|\.)workday\.com$/i.test(url.hostname);
    return signal || /\b(job|role|position|apply|vacancy|opening)\b/i.test(text + " " + context);
  } catch {
    return false;
  }
}

function anchorAttribute(attributes: string, name: string): string | null {
  const pattern = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const match = attributes.match(pattern);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function nearestMarkupBlock(html: string, index: number): string {
  let best: { start: number; end: number; length: number } | null = null;
  const lower = html.toLowerCase();
  for (const tag of ["tr", "article", "li", "section", "div"]) {
    const start = lower.lastIndexOf("<" + tag, index);
    const close = lower.indexOf("</" + tag + ">", index);
    if (start < 0 || close < 0) continue;
    const end = close + tag.length + 3;
    const length = end - start;
    if (length <= MAX_CONTEXT_CHARS && (!best || length < best.length)) best = { start, end, length };
  }
  if (best) return html.slice(best.start, best.end);
  return html.slice(Math.max(0, index - 900), Math.min(html.length, index + 1_400));
}

function textFromPlainAround(text: string, index: number, length: number): string {
  return text.slice(Math.max(0, index - 600), Math.min(text.length, index + length + 600));
}

function genericAnchorText(value: string): boolean {
  return /^(?:apply(?: now)?|view (?:job|role|posting|details)?|learn more|see details|click here|read more|open position)$/i.test(value.trim());
}

function extractTitle(anchorText: string, context: string): string {
  const compact = anchorText.replace(/\s+/g, " ").trim();
  if (compact && !genericAnchorText(compact) && compact.length <= 180) return compact;
  const explicit = context.match(/(?:job title|position|role)\s*[:\-]\s*([^\n|]{4,180})/i)?.[1]?.trim();
  if (explicit && !genericAnchorText(explicit)) return explicit;
  const heading = [...context.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi)]
    .map((match) => htmlToPlainText(match[1] ?? ""))
    .find((value) => value.length >= 4 && value.length <= 180 && !genericAnchorText(value));
  if (heading) return heading;
  const titleElement = context.match(/<(?:span|div|p)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:job|position|role)[-_ ]?title[^"']*["'][^>]*>([\s\S]*?)<\/(?:span|div|p)\s*>/i)?.[1];
  const markedTitle = titleElement ? htmlToPlainText(titleElement) : "";
  if (markedTitle.length >= 4 && markedTitle.length <= 180 && !genericAnchorText(markedTitle)) return markedTitle;
  const lines = htmlToPlainText(context).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidate = lines.find((line) =>
    line.length >= 8
    && line.length <= 180
    && line.split(/\s+/).length >= 2
    && !genericAnchorText(line)
    && !/^(?:company|employer|location|responsibilities|qualifications|requirements)\s*:/i.test(line)
  );
  return candidate ?? "Unknown Title";
}

function extractCompany(context: string): string {
  return context.match(/(?:company|employer)\s*[:\-]\s*([^\n|,]{2,120})/i)?.[1]?.trim() ?? "Unknown Company";
}

function extractLocation(context: string): string {
  return context.match(/(?:location|based in)\s*[:\-]\s*([^\n|]{2,100})/i)?.[1]?.trim() ?? "Unknown";
}

interface LinkOccurrence {
  readonly text: string;
  readonly context: string;
}

interface CardGroup {
  readonly canonicalUrl: string;
  readonly occurrences: LinkOccurrence[];
}

/** Per-email link accounting: `linksSeen = jobCards + nonJobLinksSkipped + duplicateLinksCollapsed`. */
export interface EmailLinkSummary {
  readonly linksSeen: number;
  readonly jobCards: number;
  readonly nonJobLinksSkipped: number;
  readonly duplicateLinksCollapsed: number;
}

export interface CollapsedEmailJobCard extends EmailJobCard {
  /** How many links in the email pointed at this job (1 when it was linked once). */
  readonly linkCount: number;
}

function isKnownTitle(title: string): boolean {
  return title !== "Unknown Title" && !genericAnchorText(title);
}

/**
 * Picks the richest facts across every link to one job: a title taken from a
 * real anchor text beats one inferred from surrounding markup, a known company
 * or location beats "Unknown", and the longest context is kept as evidence.
 * Ties keep document order, so the result is deterministic.
 */
function mergeCardGroup(group: CardGroup): CollapsedEmailJobCard {
  const scored = group.occurrences.map((occurrence) => {
    const anchorText = occurrence.text.replace(/\s+/g, " ").trim();
    const title = extractTitle(occurrence.text, occurrence.context);
    const fromAnchor = anchorText !== "" && title === anchorText && isKnownTitle(title);
    return {
      occurrence,
      title,
      titleRank: fromAnchor ? 2 : isKnownTitle(title) ? 1 : 0,
      company: extractCompany(occurrence.context),
      location: extractLocation(occurrence.context),
    };
  });
  const best = <T>(values: readonly T[], rank: (value: T) => number): T =>
    values.reduce((chosen, value) => (rank(value) > rank(chosen) ? value : chosen));
  const titled = best(scored, (entry) => entry.titleRank);
  const company = best(scored, (entry) => (entry.company === "Unknown Company" ? 0 : 1)).company;
  const location = best(scored, (entry) => (entry.location === "Unknown" ? 0 : 1)).location;
  const evidence = best(scored, (entry) => entry.occurrence.context.length).occurrence;
  return {
    sourceUrl: group.canonicalUrl,
    title: titled.title,
    companyName: company,
    location,
    descriptionRaw: evidence.context || evidence.text || "Posting link discovered in Gmail alert; employer content retrieval is pending.",
    linkCount: group.occurrences.length,
  };
}

/**
 * Extracts one card per job posting linked from the email, and accounts for
 * every link it saw so nothing is dropped silently.
 */
export async function extractEmailJobCardsWithLinkSummary(
  raw: string,
): Promise<{ readonly cards: CollapsedEmailJobCard[]; readonly links: EmailLinkSummary }> {
  const bodies = await decodeGmailRawEmail(raw);
  const groups = new Map<string, CardGroup>();
  let linksSeen = 0;
  let nonJobLinksSkipped = 0;
  let duplicateLinksCollapsed = 0;

  const addLink = (urlValue: string, visibleText: string, context: string): void => {
    linksSeen += 1;
    const url = safeAbsoluteHttpUrl(urlValue);
    const classification: LinkClassification = url ? classifyLink(url, visibleText, context) : { kind: "NON_JOB" };
    if (classification.kind === "NON_JOB") {
      nonJobLinksSkipped += 1;
      return;
    }
    const existing = groups.get(classification.key);
    if (existing) {
      duplicateLinksCollapsed += 1;
      existing.occurrences.push({ text: visibleText, context });
      return;
    }
    groups.set(classification.key, { canonicalUrl: classification.canonicalUrl, occurrences: [{ text: visibleText, context }] });
  };

  for (const match of bodies.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const rawHref = anchorAttribute(match[1] ?? "", "href");
    if (!rawHref) continue;
    const index = match.index ?? 0;
    const context = htmlToPlainText(nearestMarkupBlock(bodies.html, index));
    addLink(rawHref, htmlToPlainText(match[2] ?? ""), context);
  }

  const plain = bodies.text || htmlToPlainText(bodies.html);
  for (const match of plain.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const rawUrl = (match[0] ?? "").replace(/[.,;:!?]+$/, "");
    const index = match.index ?? 0;
    addLink(rawUrl, "", textFromPlainAround(plain, index, rawUrl.length));
  }

  const cards = [...groups.values()].map(mergeCardGroup);
  return {
    cards,
    links: { linksSeen, jobCards: cards.length, nonJobLinksSkipped, duplicateLinksCollapsed },
  };
}

export async function extractEmailJobCards(raw: string): Promise<EmailJobCard[]> {
  const { cards } = await extractEmailJobCardsWithLinkSummary(raw);
  return cards.map(({ linkCount: _linkCount, ...card }) => card);
}
