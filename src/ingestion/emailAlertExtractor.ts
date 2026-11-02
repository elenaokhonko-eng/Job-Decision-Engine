import { Buffer } from "node:buffer";
import { simpleParser } from "mailparser";
import { decodeHTML } from "entities";

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
  } catch {
    return value;
  }
  return value;
}

function isNavigationOrTrackingLink(urlValue: string, text: string): boolean {
  const textValue = text.toLowerCase().replace(/\s+/g, " ").trim();
  const urlLower = urlValue.toLowerCase();
  if (/\b(unsubscribe|manage preferences|email preferences|view in browser|privacy policy|terms of use)\b/.test(textValue)) {
    return true;
  }
  return /(?:^|[\/?&=_-])(unsubscribe|preferences|email-settings|privacy-policy|terms-of-use|tracking-pixel)(?:[\/?&=_-]|$)/i.test(urlLower)
    || /\.(?:png|jpe?g|gif|svg|webp)(?:[?#]|$)/i.test(urlLower);
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

interface LinkCandidate {
  readonly url: string;
  readonly text: string;
  readonly context: string;
}

export async function extractEmailJobCards(raw: string): Promise<EmailJobCard[]> {
  const bodies = await decodeGmailRawEmail(raw);
  const candidates: LinkCandidate[] = [];
  const seen = new Set<string>();

  const addCandidate = (urlValue: string, visibleText: string, context: string): void => {
    const url = safeAbsoluteHttpUrl(urlValue);
    if (!url || seen.has(url) || isNavigationOrTrackingLink(url, visibleText)) return;
    if (!isLikelyVacancyLink(url, visibleText, context)) return;
    seen.add(url);
    candidates.push({ url, text: visibleText, context });
  };

  for (const match of bodies.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const rawHref = anchorAttribute(match[1] ?? "", "href");
    if (!rawHref) continue;
    const index = match.index ?? 0;
    const context = htmlToPlainText(nearestMarkupBlock(bodies.html, index));
    addCandidate(rawHref, htmlToPlainText(match[2] ?? ""), context);
  }

  const plain = bodies.text || htmlToPlainText(bodies.html);
  for (const match of plain.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const rawUrl = (match[0] ?? "").replace(/[.,;:!?]+$/, "");
    const index = match.index ?? 0;
    addCandidate(rawUrl, "", textFromPlainAround(plain, index, rawUrl.length));
  }

  return candidates.map(({ url, text, context }) => ({
    sourceUrl: url,
    title: extractTitle(text, context),
    companyName: extractCompany(context),
    location: extractLocation(context),
    descriptionRaw: context || text || "Posting link discovered in Gmail alert; employer content retrieval is pending.",
  }));
}
