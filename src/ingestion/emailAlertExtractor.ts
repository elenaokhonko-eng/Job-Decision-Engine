import { Buffer } from "node:buffer";
import { simpleParser } from "mailparser";
import { decodeHTML } from "entities";
import { isUnknownEmployerName } from "./postingIdentity.js";
import { linkedInJobIdFromUrl } from "./searchApi/searchApiClient.js";

const MAX_EMAIL_BYTES = 10 * 1024 * 1024;
const MAX_MIME_PARTS = 256;
const MAX_CONTEXT_CHARS = 3_000;

export interface DecodedEmailBody {
  readonly text: string;
  readonly html: string;
  /** Display name of the first From address, or "" when the message has none. */
  readonly senderName: string;
}

export interface EmailJobCard {
  readonly sourceUrl: string;
  readonly title: string;
  /**
   * The employer as the email states it, or "" when the email does not name one.
   * Never a placeholder: an unknown employer is resolved from the posting page.
   */
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
  const senderName = (parsed.from?.value?.[0]?.name ?? "").replace(/\s+/g, " ").trim();
  return { text, html, senderName };
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
  "stories", "employee-stories", "our-employee-stories", "blog", "news",
]);

/**
 * Anchor texts that name site navigation in employer career-site alerts
 * ("here", "Careers website", "Employee Stories", "Manage your Job Alerts").
 * They only mark a link as navigation when its URL carries no posting id.
 */
const NAVIGATION_LINK_TEXT = new RegExp(
  "^(?:here|click here|careers? (?:website|site|page|home(?: ?page)?)|(?:our )?employee stories"
    + "|manage (?:your )?(?:job )?alerts?|(?:view|see|browse) (?:all )?(?:jobs|openings|vacancies)|all jobs)$",
  "i",
);

function isSuccessFactorsHost(hostname: string): boolean {
  return /(?:^|\.)(?:successfactors|sapsf)\.(?:com|eu)$/i.test(hostname);
}

/** SAP SuccessFactors Career Site Builder posting path: `/<site>/job/<slug>/<numeric id>/`. */
function isCareerSitePostingPath(pathname: string): boolean {
  return /\/job\/[^/]+\/\d{4,}\/?$/i.test(pathname);
}

/** A path segment with a run of digits or an explicit job/requisition id query parameter. */
function hasPostingIdentifier(url: URL): boolean {
  if (url.pathname.split("/").some((segment) => /\d{3,}/.test(segment))) return true;
  return [...url.searchParams.keys()].some((key) =>
    /^(?:career_job_req_id|(?:job|req|requisition|posting|vacancy|position)[_-]?id|gh_jid|jobid|reqid)$/i.test(key));
}

/** Every path segment is a locale code or a careers/jobs landing name, e.g. `/`, `/en/global-careers/`. */
function isCareersLandingPath(pathname: string): boolean {
  return pathname.split("/").filter(Boolean).every((segment) =>
    /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i.test(segment)
    || /^(?:[a-z0-9]+-)*(?:careers?|jobs?|job-search|opportunities|vacancies)$/i.test(segment));
}

/**
 * Employer career-site alert navigation: the careers home page, landing pages,
 * SuccessFactors portal links (`/careers?...navBarLevel=...`, alert management)
 * and links whose text is navigation ("here", "Careers website"). A link that
 * names one posting (`/job/<slug>/<id>/`, a numeric id, a requisition-id
 * parameter) is never dropped here.
 */
function isCareerSiteNavigation(url: URL, text: string): boolean {
  if (isSuccessFactorsHost(url.hostname)) return !url.searchParams.has("career_job_req_id");
  if ([...url.searchParams.keys()].some((key) => key.toLowerCase() === "navbarlevel")) return true;
  if (hasPostingIdentifier(url)) return false;
  if (NAVIGATION_LINK_TEXT.test(text.replace(/\s+/g, " ").trim())) return true;
  return isCareersLandingPath(url.pathname);
}

/** Email tracking parameters SuccessFactors career sites append to alert links; the path id selects the posting. */
const CAREER_SITE_TRACKING_PARAMETERS = new Set(["from", "refid", "source", "eid"]);

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

/**
 * Query parameters that only carry campaign attribution and never select a
 * posting. On a career-site posting path the numeric path id selects the
 * posting, so the per-recipient email tracking parameters are dropped too.
 */
function withoutCampaignParameters(urlValue: string): string {
  const url = new URL(urlValue);
  const careerSitePosting = isCareerSitePostingPath(url.pathname);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || (careerSitePosting && CAREER_SITE_TRACKING_PARAMETERS.has(key.toLowerCase()))) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

/**
 * An image or media asset, never a posting: LinkedIn's media CDN (licdn.com),
 * a `/dms/image/` or `company-logo_<w>_<h>` path, or an image file extension.
 * HTML-only alerts get a generated text part that spells out every image URL.
 */
function isImageAssetUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "licdn.com" || host.endsWith(".licdn.com")
    || /\.(?:png|jpe?g|gif|svg|webp|ico|bmp)$/i.test(url.pathname)
    || /\/dms\/image\//i.test(url.pathname)
    || url.pathname.split("/").some((segment) => /^company-logo_\d+_\d+$/i.test(segment));
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
  if (isImageAssetUrl(parsed)) return { kind: "NON_JOB" };
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
  if (isCareerSiteNavigation(parsed, text)) return { kind: "NON_JOB" };
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
  return withoutPartialTags(html.slice(Math.max(0, index - 900), Math.min(html.length, index + 1_400)));
}

/**
 * Drops a tag cut in half at either end of a fixed-width HTML window, so an
 * attribute tail such as `.../company-logo_100_100/...?e=1" alt="Ex` never
 * survives tag stripping as visible text.
 */
function withoutPartialTags(fragment: string): string {
  let result = fragment;
  const firstClose = result.indexOf(">");
  const firstOpen = result.indexOf("<");
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) result = result.slice(firstClose + 1);
  const lastOpen = result.lastIndexOf("<");
  if (lastOpen >= 0 && result.indexOf(">", lastOpen) < 0) result = result.slice(0, lastOpen);
  return result;
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

/**
 * The employer the card's context names ("Company: X"), or "" when it names
 * none. The label must be a whole word, so `company-logo_100_100/...` in a
 * logo URL is not a label, and a URL-, logo- or markup-like value is never an
 * employer.
 */
function extractCompany(context: string): string {
  const value = context.match(/(?:^|[^\w/.-])(?:company|employer)\s*[:\-]\s*([^\n|,]{2,120})/i)?.[1]?.trim() ?? "";
  return isUnknownEmployerName(value) ? "" : value;
}

/** LinkedIn's card subtitle "Company · Location" (U+00B7 middle dot). */
const LINKEDIN_CARD_SUBTITLE = /^(.{2,120}?)\s+·\s+\S/;

/**
 * The employer of a LinkedIn job-alert card. A card is a logo link, a title
 * link and a "Company · Location" subtitle line; the subtitle is read from the
 * first lines of the card's markup (the title line is skipped). Without a
 * subtitle the company-logo image's alt text is used. A URL-, logo- or
 * markup-like value is never an employer, so the result may be "" (unknown).
 */
function linkedInCardEmployer(cardLines: readonly string[], title: string, imageAlts: readonly string[]): string {
  const titleKey = title.replace(/\s+/g, " ").trim().toLowerCase();
  for (const line of cardLines.slice(0, 6)) {
    if (line.toLowerCase() === titleKey) continue;
    const company = line.match(LINKEDIN_CARD_SUBTITLE)?.[1]?.trim() ?? "";
    if (company && !isUnknownEmployerName(company)) return company;
  }
  return imageAlts.find((alt) => !isUnknownEmployerName(alt) && !/^(?:company )?logo$/i.test(alt)) ?? "";
}

const GENERIC_SENDER_NAME = /^(?:no[- ]?reply|do[- ]?not[- ]?reply|notifications?|alerts?|job alerts?|jobs?|careers?|recruit(?:ing|ment|er)?|talent(?: acquisition)?|hr|team|support|info|admin|mailer|linkedin|indeed|glassdoor|jobstreet|mycareersfuture)$/i;

/**
 * The employer named by the sender of an employer career-site alert, accepted
 * only when the link's own host corroborates it: after removing "Careers",
 * "Jobs", "Talent Acquisition" and similar wording, every word of the name must
 * appear in the posting host (sender "Example Bank Careers" with host
 * careers.examplebank.com gives "Example Bank"). Anything else returns "".
 */
export function employerFromSender(senderName: string, postingUrl: string): string {
  let host: string;
  try {
    host = new URL(unwrapForClassification(postingUrl)).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (isLinkedInHost(host) || isMyCareersFutureHost(host)) return "";
  const name = senderName
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^(?:careers?|jobs?|job alerts?)\s+(?:at|@|with)\s+/i, "")
    .replace(/\s*[-|:–—]\s*(?:careers?|jobs?|job alerts?|talent(?: acquisition)?|recruit(?:ing|ment)?|hr)\b.*$/i, "")
    .replace(/(?:\s+(?:careers?|jobs?|job alerts?|talent acquisition|talent|recruiting|recruitment|hr|team))+$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 2 || name.length > 120 || GENERIC_SENDER_NAME.test(name)) return "";
  const tokens = name.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  const compactHost = host.replace(/[^a-z0-9]+/g, "");
  if (tokens.length === 0 || !tokens.every((token) => token.length >= 2 && compactHost.includes(token))) return "";
  return name;
}

/**
 * Whether a stored Gmail discovery link names one posting under the alert
 * rules. Recovery tooling uses it to leave navigation observations (career
 * home pages, alert management, "here" links) blocked.
 */
export function isEmailAlertPostingLink(urlValue: string, linkText: string): boolean {
  const url = safeAbsoluteHttpUrl(urlValue);
  return url !== null && classifyLink(url, linkText, "").kind === "JOB";
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
  /** True for a LinkedIn `/jobs/view/<id>` card. */
  readonly linkedIn: boolean;
  /** Offset of the job's first HTML anchor, or null when it was only linked from plain text. */
  htmlStart: number | null;
  /** Decoded alt texts of images inside the job's anchors (the LinkedIn company logo). */
  readonly imageAlts: string[];
  /** Plain-text lines of the card's markup, from its first anchor to the next job's (LinkedIn only). */
  cardLines: readonly string[];
}

/** Upper bound on one LinkedIn card's markup; real cards carry long tracking URLs. */
const LINKEDIN_CARD_MAX_CHARS = 20_000;

function anchorImageAlts(innerHtml: string): string[] {
  return [...innerHtml.matchAll(/<img\b([^>]*)>/gi)]
    .map((image) => decodeHtmlEntities(anchorAttribute(image[1] ?? "", "alt") ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Per-email link accounting: `linksSeen = jobCards + nonJobLinksSkipped + duplicateLinksCollapsed`. */
export interface EmailLinkSummary {
  readonly linksSeen: number;
  readonly jobCards: number;
  readonly nonJobLinksSkipped: number;
  readonly duplicateLinksCollapsed: number;
}

export type DiscoveredCompanySource = "EMAIL_CARD" | "EMAIL_SENDER";

export interface CollapsedEmailJobCard extends EmailJobCard {
  /** How many links in the email pointed at this job (1 when it was linked once). */
  readonly linkCount: number;
  /** Where `companyName` came from; null when it is "" (unknown). */
  readonly companySource: DiscoveredCompanySource | null;
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
function mergeCardGroup(group: CardGroup, senderName: string): CollapsedEmailJobCard {
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
  const linkedInCompany = group.linkedIn ? linkedInCardEmployer(group.cardLines, titled.title, group.imageAlts) : "";
  const cardCompany = linkedInCompany || best(scored, (entry) => (entry.company === "" ? 0 : 1)).company;
  const senderCompany = cardCompany ? "" : employerFromSender(senderName, group.canonicalUrl);
  const location = best(scored, (entry) => (entry.location === "Unknown" ? 0 : 1)).location;
  const evidence = best(scored, (entry) => entry.occurrence.context.length).occurrence;
  return {
    sourceUrl: group.canonicalUrl,
    title: titled.title,
    companyName: cardCompany || senderCompany,
    location,
    descriptionRaw: evidence.context || evidence.text || "Posting link discovered in Gmail alert; employer content retrieval is pending.",
    linkCount: group.occurrences.length,
    companySource: cardCompany ? "EMAIL_CARD" : senderCompany ? "EMAIL_SENDER" : null,
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

  const addLink = (
    urlValue: string,
    visibleText: string,
    context: string,
    anchor?: { readonly index: number; readonly innerHtml: string },
  ): void => {
    linksSeen += 1;
    const url = safeAbsoluteHttpUrl(urlValue);
    const classification: LinkClassification = url ? classifyLink(url, visibleText, context) : { kind: "NON_JOB" };
    if (classification.kind === "NON_JOB") {
      nonJobLinksSkipped += 1;
      return;
    }
    const imageAlts = anchor ? anchorImageAlts(anchor.innerHtml) : [];
    const existing = groups.get(classification.key);
    if (existing) {
      duplicateLinksCollapsed += 1;
      existing.occurrences.push({ text: visibleText, context });
      existing.imageAlts.push(...imageAlts);
      if (anchor && existing.htmlStart === null) existing.htmlStart = anchor.index;
      return;
    }
    groups.set(classification.key, {
      canonicalUrl: classification.canonicalUrl,
      occurrences: [{ text: visibleText, context }],
      linkedIn: classification.key.startsWith("linkedin:"),
      htmlStart: anchor ? anchor.index : null,
      imageAlts,
      cardLines: [],
    });
  };

  for (const match of bodies.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const rawHref = anchorAttribute(match[1] ?? "", "href");
    if (!rawHref) continue;
    const index = match.index ?? 0;
    const context = htmlToPlainText(nearestMarkupBlock(bodies.html, index));
    addLink(rawHref, htmlToPlainText(match[2] ?? ""), context, { index, innerHtml: match[2] ?? "" });
  }

  // A LinkedIn card's markup runs from its first anchor to the next job's first anchor.
  const cardStarts = [...groups.values()]
    .map((group) => group.htmlStart)
    .filter((start): start is number => start !== null)
    .sort((left, right) => left - right);
  for (const group of groups.values()) {
    const start = group.htmlStart;
    if (!group.linkedIn || start === null) continue;
    const next = cardStarts.find((candidate) => candidate > start) ?? bodies.html.length;
    const markup = withoutPartialTags(bodies.html.slice(start, Math.min(next, start + LINKEDIN_CARD_MAX_CHARS)));
    group.cardLines = htmlToPlainText(markup).split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  const plain = bodies.text || htmlToPlainText(bodies.html);
  for (const match of plain.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const rawUrl = (match[0] ?? "").replace(/[.,;:!?]+$/, "");
    const index = match.index ?? 0;
    addLink(rawUrl, "", textFromPlainAround(plain, index, rawUrl.length));
  }

  const cards = [...groups.values()].map((group) => mergeCardGroup(group, bodies.senderName));
  return {
    cards,
    links: { linksSeen, jobCards: cards.length, nonJobLinksSkipped, duplicateLinksCollapsed },
  };
}

export async function extractEmailJobCards(raw: string): Promise<EmailJobCard[]> {
  const { cards } = await extractEmailJobCardsWithLinkSummary(raw);
  return cards.map(({ linkCount: _linkCount, companySource: _companySource, ...card }) => card);
}
