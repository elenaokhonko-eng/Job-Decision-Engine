import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { htmlToPlainText } from "./emailAlertExtractor.js";
import { classifyDescriptionQuality } from "../pipeline/descriptionQuality.js";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_TIME_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const PRODUCTION_HOST_REQUEST_INTERVAL_MS = 1_000;
const hostNextRequestAt = new Map<string, number>();

export type PostingProviderKey = "ASHBY" | "GREENHOUSE" | "LEVER" | "EMPLOYER_WEBSITE";
export type ContentBlockReason =
  | "AUTH_REQUIRED"
  | "BOT_BLOCKED"
  | "UNSUPPORTED_SOURCE"
  | "MISSING_POSTING_URL"
  | "UNSAFE_REDIRECT";

export interface ExpectedPostingIdentity {
  readonly title: string;
  readonly companyName: string;
  readonly requisitionId?: string | null;
}

export interface VerifiedPosting {
  readonly title: string;
  readonly companyName: string;
  readonly description: string;
  readonly requisitionId: string | null;
  readonly canonicalUrl: string;
  readonly applyUrl: string | null;
  readonly location: string | null;
  readonly workplaceType: "REMOTE" | "HYBRID" | "ONSITE" | "UNKNOWN";
  readonly employmentType: string | null;
  readonly compensationRaw: string | null;
  readonly publishedAt: string | null;
  readonly updatedAt: string | null;
  readonly expiresAt: string | null;
  readonly availability: "OPEN" | "CLOSED" | "UNKNOWN";
  readonly rawPayload: unknown;
}

export interface PostingSourceEvidence {
  readonly requestedUrl: string;
  readonly resolvedUrl: string;
  readonly redirectHistory: readonly string[];
  readonly retrievedAt: string;
  readonly httpStatus: number;
  readonly contentType: string | null;
  readonly responseHash: string;
}

export interface ResolvedPostingSource {
  readonly key: PostingProviderKey;
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly requisitionId: string | null;
  readonly providerKey: string | null;
}

export type JobContentResult =
  | {
      readonly kind: "COMPLETE";
      readonly posting: VerifiedPosting;
      readonly provider: ResolvedPostingSource;
      readonly evidence: PostingSourceEvidence;
      readonly contentHash: string;
    }
  | { readonly kind: "RETRYABLE_FAILURE"; readonly reason: string; readonly retryAfter?: string }
  | { readonly kind: "BLOCKED"; readonly reason: ContentBlockReason }
  | { readonly kind: "IDENTITY_CONFLICT"; readonly reason: string }
  | {
      readonly kind: "UNAVAILABLE";
      readonly reason: string;
      readonly evidence: PostingSourceEvidence;
    };

export interface SafeHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly url: string;
}

export interface PublicAddress {
  readonly address: string;
  readonly family: number;
}

export interface PostingFetcherDependencies {
  readonly fetchOnce?: (url: URL, timeoutMs: number, addresses: PublicAddress[], signal: AbortSignal) => Promise<SafeHttpResponse>;
  readonly resolveAddresses?: (hostname: string, signal: AbortSignal) => Promise<PublicAddress[]>;
  readonly now?: () => Date;
  /** Test-only shortening hook. Callers cannot extend the production ceiling. */
  readonly totalTimeoutMs?: number;
}

export class UnsafePostingUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePostingUrlError";
  }
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function companyMatches(expected: string, actual: string, hostname: string): boolean {
  const expectedKey = normalizeIdentity(expected);
  const actualKey = normalizeIdentity(actual);
  if (!expectedKey || expectedKey === "unknown company" || expectedKey === "unknown") return Boolean(actualKey);
  if (actualKey && (expectedKey === actualKey || expectedKey.includes(actualKey) || actualKey.includes(expectedKey))) return true;
  const expectedTokens = expectedKey.split(" ").filter((token) => token.length >= 3);
  const actualHaystack = normalizeIdentity(actualKey + " " + hostname.replace(/\./g, " "));
  return expectedTokens.length > 0 && expectedTokens.every((token) => actualHaystack.includes(token));
}

function titleMatches(expected: string, actual: string): boolean {
  return normalizeIdentity(expected) !== "" && normalizeIdentity(expected) === normalizeIdentity(actual);
}

function isPublicIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b, c, d] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 168 && b === 63 && c === 129 && d === 16) return false;
  if (a === 192 && (b === 168 || (b === 0) || (b === 88 && c === 99))) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;
  return true;
}

function ipv6Bytes(address: string): number[] | null {
  const normalized = address.toLowerCase().split("%", 1)[0];
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const parseWords = (words: string[]): number[] | null => {
    const bytes: number[] = [];
    for (const word of words) {
      if (word.includes(".")) {
        if (!isPublicIPv4(word)) return null;
        const octets = word.split(".").map(Number);
        bytes.push((octets[0] ?? 0), (octets[1] ?? 0), (octets[2] ?? 0), (octets[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(word)) return null;
        const number = parseInt(word, 16);
        bytes.push((number >> 8) & 255, number & 255);
      }
    }
    return bytes;
  };
  const leftBytes = parseWords(left);
  const rightBytes = parseWords(right);
  if (!leftBytes || !rightBytes) return null;
  const missing = 16 - leftBytes.length - rightBytes.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  return halves.length === 1
    ? leftBytes
    : [...leftBytes, ...new Array(missing).fill(0), ...rightBytes];
}

function isPublicIPv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes || bytes.length !== 16) return false;
  if (bytes.every((byte) => byte === 0)) return false;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false;
  if ((bytes[0] ?? 0) === 0xfc || (bytes[0] ?? 0) === 0xfd) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] ?? 0) <= 0x1f) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if ((bytes[0] ?? 0) === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return false;
  if ((bytes[0] ?? 0) === 0xff) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && ((bytes[2] ?? 0) & 0xf0) === 0) return false;
  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff;
  if (ipv4Mapped) {
    const mapped = bytes.slice(12).join(".");
    return isPublicIPv4(mapped);
  }
  // Only globally routed unicast space is accepted. This excludes transition,
  // documentation, unique-local, link-local, multicast, and metadata ranges.
  return (bytes[0] ?? 0) >= 0x20 && (bytes[0] ?? 0) <= 0x3f
    && !((bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8));
}

function isPublicAddress(address: string, family: number): boolean {
  return family === 4 ? isPublicIPv4(address) : family === 6 && isPublicIPv6(address);
}

async function resolvePublicAddresses(hostname: string, signal: AbortSignal): Promise<PublicAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(host);
  if (literalFamily) return [{ address: host, family: literalFamily }];
  if (signal.aborted) throw new Error("Posting fetch exceeded its total request time limit.");
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  let addresses: PublicAddress[] = [];
  try {
    const [ipv4Records, ipv6Records] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    if (signal.aborted) throw new Error("Posting fetch exceeded its total request time limit.");
    if (ipv4Records.status === "fulfilled") addresses.push(...ipv4Records.value.map((address) => ({ address, family: 4 })));
    if (ipv6Records.status === "fulfilled") addresses.push(...ipv6Records.value.map((address) => ({ address, family: 6 })));
    if (addresses.length === 0) {
      const failures = [ipv4Records, ipv6Records].filter((record): record is PromiseRejectedResult => record.status === "rejected");
      const detail = failures[0]?.reason instanceof Error ? failures[0].reason.message : "No DNS records were returned.";
      throw new Error(`Posting host DNS resolution failed: ${detail}`);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address, item.family))) {
    throw new UnsafePostingUrlError("Posting URL resolves to a private, reserved, or non-routable address.");
  }
  return addresses;
}

function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Posting fetch exceeded its total request time limit."));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(new Error("Posting fetch exceeded its total request time limit."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function waitForProductionHostSlot(hostname: string, signal: AbortSignal): Promise<void> {
  const now = Date.now();
  for (const [host, nextAt] of hostNextRequestAt) {
    if (nextAt <= now) hostNextRequestAt.delete(host);
  }
  const key = hostname.toLowerCase();
  const availableAt = Math.max(now, hostNextRequestAt.get(key) ?? now);
  hostNextRequestAt.set(key, availableAt + PRODUCTION_HOST_REQUEST_INTERVAL_MS);
  const waitMs = availableAt - now;
  if (waitMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("Posting fetch exceeded its total request time limit."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, waitMs);
  });
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafePostingUrlError("Posting URL is not an absolute HTTP(S) URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new UnsafePostingUrlError("Posting URL must use HTTP(S) without embedded credentials.");
  }
  const expectedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== expectedPort) {
    throw new UnsafePostingUrlError("Posting URL must use the default HTTP or HTTPS port.");
  }
  url.hash = "";
  return url;
}

function decodeTrackingWrapper(input: string): string {
  const url = parseHttpUrl(input);
  const hostname = url.hostname.toLowerCase();
  if ((hostname === "google.com" || hostname.endsWith(".google.com") || hostname === "google.co.uk") && url.pathname === "/url") {
    const target = url.searchParams.get("q") ?? url.searchParams.get("url");
    if (target) return target;
  }
  if (hostname === "outlook.office.com" || hostname === "safelinks.protection.outlook.com") {
    const target = url.searchParams.get("url");
    if (target) return target;
  }
  return input;
}

function header(headers: Readonly<Record<string, string>>, key: string): string | null {
  const lowered = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === lowered) return value;
  return null;
}

function retryAfter(headers: Readonly<Record<string, string>>, now: Date): string | undefined {
  const value = header(headers, "retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return new Date(now.getTime() + Number(value) * 1000).toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

async function requestOnce(url: URL, timeoutMs: number, resolved: PublicAddress[], signal: AbortSignal): Promise<SafeHttpResponse> {
  if (resolved.length === 0 || resolved.some((item) => !isPublicAddress(item.address, item.family))) {
    throw new UnsafePostingUrlError("Posting host did not resolve exclusively to public addresses.");
  }
  const pinned = resolved[0];
  if (!pinned) throw new UnsafePostingUrlError("Posting host has no public address.");
  const secure = url.protocol === "https:";
  const requestImpl = secure ? httpsRequest : httpRequest;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const defaultPort = secure ? 443 : 80;
  const requestPath = url.pathname + url.search;

  return await new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Posting fetch exceeded its total request time limit."));
      return;
    }
    const request = requestImpl({
      protocol: url.protocol,
      hostname,
      port: url.port ? Number(url.port) : defaultPort,
      path: requestPath,
      method: "GET",
      agent: false,
      ...(secure && isIP(hostname) === 0 ? { servername: hostname } : {}),
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, resolved);
        else callback(null, pinned.address, pinned.family);
      },
      signal,
      headers: {
        Accept: "text/html,application/json,application/ld+json;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "identity",
        "User-Agent": "JobDecisionEngine/1.0 (public job posting retrieval)",
        Connection: "close",
        Host: url.host,
      },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === "string") headers[key] = value;
        else if (Array.isArray(value)) headers[key] = value.join(", ");
      }
      const lengthValue = header(headers, "content-length");
      if (lengthValue && Number(lengthValue) > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error("Posting response exceeds the 3 MiB decoded-body limit."));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Posting response exceeds the 3 MiB decoded-body limit."));
          return;
        }
        chunks.push(bytes);
      });
      response.on("end", () => {
        resolve({ status, headers, body: Buffer.concat(chunks, total), url: url.toString() });
      });
      response.on("error", reject);
    });
    request.setTimeout(Math.max(1, timeoutMs), () => request.destroy(new Error("Posting fetch timed out.")));
    request.on("error", reject);
    request.end();
  });
}

async function fetchSafe(
  input: string,
  dependencies: PostingFetcherDependencies,
  now: Date,
): Promise<{ response: SafeHttpResponse; redirects: string[] }> {
  const resolver = dependencies.resolveAddresses ?? resolvePublicAddresses;
  const fetchOnce = dependencies.fetchOnce ?? requestOnce;
  let current = parseHttpUrl(decodeTrackingWrapper(input));
  const redirects: string[] = [];
  const totalTimeoutMs = Math.min(MAX_TOTAL_TIME_MS, Math.max(1, dependencies.totalTimeoutMs ?? MAX_TOTAL_TIME_MS));
  const deadline = Date.now() + totalTimeoutMs;
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), totalTimeoutMs);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const remainingMs = Math.min(DEFAULT_REQUEST_TIMEOUT_MS, deadline - Date.now());
      if (remainingMs <= 0) throw new Error("Posting fetch exceeded its total request time limit.");
      if (!dependencies.fetchOnce) {
        await waitForProductionHostSlot(current.hostname, controller.signal);
      }
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw new Error("Posting fetch exceeded its total request time limit.");
      }
      const addresses = await awaitWithAbort(resolver(current.hostname, controller.signal), controller.signal);
      if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address, item.family))) {
        throw new UnsafePostingUrlError("Posting URL or redirect resolves to a private, reserved, or non-routable address.");
      }
      const requestRemainingMs = Math.min(DEFAULT_REQUEST_TIMEOUT_MS, deadline - Date.now());
      if (requestRemainingMs <= 0) throw new Error("Posting fetch exceeded its total request time limit.");
      const response = await awaitWithAbort(fetchOnce(current, requestRemainingMs, addresses, controller.signal), controller.signal);
      if (response.body.byteLength > MAX_RESPONSE_BYTES) throw new Error("Posting response exceeds the 3 MiB decoded-body limit.");
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { response, redirects };
      }
      const location = header(response.headers, "location");
      if (!location) return { response, redirects };
      if (hop === MAX_REDIRECTS) {
        throw new UnsafePostingUrlError("Posting URL exceeded the five-redirect limit.");
      }
      const next = parseHttpUrl(new URL(location, current).toString());
      redirects.push(next.toString());
      current = next;
    }
    throw new UnsafePostingUrlError("Posting URL exceeded the five-redirect limit.");
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseBoundedJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value);
  const pending: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    visited += 1;
    if (visited > 50_000 || current.depth > 64) {
      throw new Error("Posting JSON exceeds the 50,000-node or 64-level container limit.");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value as Record<string, unknown>)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return parsed;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return record(record(value)?.[key]);
}

function walkJobPosting(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(walkJobPosting);
  const current = record(value);
  if (!current) return [];
  const type = current["@type"];
  const types = Array.isArray(type) ? type : [type];
  const found = types.some((item) => typeof item === "string" && item.toLowerCase() === "jobposting");
  const nested = ["@graph", "mainEntity", "itemListElement"].flatMap((key) => walkJobPosting(current[key]));
  return found ? [current, ...nested] : nested;
}

function jsonLdJobPostings(html: string): Record<string, unknown>[] {
  const postings: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    try {
      postings.push(...walkJobPosting(parseBoundedJson(match[1] ?? "")));
    } catch {
      continue;
    }
  }
  return postings;
}

function htmlAttribute(attributes: string, name: string): string | null {
  const regex = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i");
  const match = attributes.match(regex);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : null;
}

function findH1(html: string): string | null {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  return match ? htmlToPlainText(match[1] ?? "") : null;
}

function cleanJobRegion(html: string): string {
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1]
    ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1]
    ?? html;
  return main
    .replace(/<(script|style|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(?:button|input|select|textarea)\b[^>]*>[\s\S]*?<\/(?:button|select|textarea)\s*>/gi, " ")
    .replace(/<div\b[^>]*(?:cookie|search|alert|navigation)[^>]*>[\s\S]*?<\/div\s*>/gi, " ");
}

function isoDate(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const parsed = /^\d{10,13}$/.test(trimmed) ? new Date(Number(trimmed)) : new Date(Date.parse(trimmed));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeWorkplaceType(value: unknown): VerifiedPosting["workplaceType"] {
  if (typeof value !== "string") return "UNKNOWN";
  const normalized = value.trim().toLowerCase().replace(/[ _]+/g, "-");
  if (normalized === "remote" || normalized === "fully-remote") return "REMOTE";
  if (normalized === "hybrid") return "HYBRID";
  if (["on-site", "onsite", "in-person", "office"].includes(normalized)) return "ONSITE";
  return "UNKNOWN";
}

function leverSalaryRange(value: unknown, description: unknown): string | null {
  const range = record(value);
  const descriptionText = stringValue(description) ? htmlToPlainText(stringValue(description) ?? "") : null;
  if (!range) return stringValue(value) ?? descriptionText;
  const currency = stringValue(range.currency)?.toUpperCase() ?? null;
  const minimum = typeof range.min === "number" || typeof range.min === "string" ? String(range.min) : null;
  const maximum = typeof range.max === "number" || typeof range.max === "string" ? String(range.max) : null;
  const interval = stringValue(range.interval)?.toLowerCase() ?? null;
  const bounds = minimum && maximum && minimum !== maximum
    ? `${minimum}-${maximum}`
    : minimum ?? maximum;
  if (!bounds) return descriptionText;
  const period = interval
    ? ({
      hour: "hour", hourly: "hour", "per-hour-wage": "hour",
      "1 hour": "hour", "per-hour": "hour",
      day: "day", daily: "day", "per-day": "day", "1 day": "day",
      month: "month", monthly: "month", "per-month": "month", "1 month": "month",
      year: "year", yearly: "year", annual: "year", annually: "year", "per-year-salary": "year", "1 year": "year",
      week: "week", weekly: "week", "per-week": "week",
    } as Record<string, string>)[interval] ?? interval
    : null;
  const frequency = interval === "one-time" || interval === "one_time" ? "one-time" : period ? `per ${period}` : null;
  return [currency, bounds, frequency].filter(Boolean).join(" ");
}

function ashbyCompensation(value: unknown): string | null {
  const compensation = record(value);
  if (!compensation) return stringValue(value);
  const summary = stringValue(compensation.compensationTierSummary)
    ?? stringValue(compensation.scrapeableCompensationSalarySummary);
  if (summary) return summary;
  const tiers = Array.isArray(compensation.compensationTiers)
    ? compensation.compensationTiers.map(record).filter(Boolean)
    : [];
  const components = [
    ...(Array.isArray(compensation.summaryComponents) ? compensation.summaryComponents.map(record).filter(Boolean) : []),
    ...tiers.flatMap((tier) => Array.isArray(tier?.components) ? tier.components.map(record).filter(Boolean) : []),
  ];
  const formatted = components.map((component) => {
    const existingSummary = stringValue(component?.summary);
    if (existingSummary) return existingSummary;
    const kind = stringValue(component?.compensationType);
    const amount = leverSalaryRange({
      currency: component?.currencyCode,
      interval: component?.interval,
      min: component?.minValue,
      max: component?.maxValue,
    }, null);
    return [kind, amount].filter(Boolean).join(": ");
  }).filter(Boolean);
  return formatted.length > 0 ? [...new Set(formatted)].join("; ") : null;
}

function ashbyLocation(item: Record<string, unknown>): string | null {
  const locations = [
    stringValue(item.location),
    ...(
      Array.isArray(item.secondaryLocations)
        ? item.secondaryLocations.map((value) => stringValue(record(value)?.location))
        : []
    ),
  ].filter((value): value is string => Boolean(value));
  if (locations.length === 0) {
    const address = record(item.address);
    const postal = record(address?.postalAddress);
    locations.push(...[postal?.addressLocality, postal?.addressRegion, postal?.addressCountry]
      .map((value) => stringValue(value)).filter((value): value is string => Boolean(value)));
  }
  return locations.length ? [...new Set(locations)].join("; ") : null;
}

function jsonLdSalary(value: unknown): string | null {
  const baseSalary = record(value);
  if (!baseSalary) return stringValue(value);
  const amount = record(baseSalary.value);
  const interval = stringValue(amount?.unitText) ?? stringValue(baseSalary.unitText);
  const range = amount ?? baseSalary;
  return leverSalaryRange({
    currency: baseSalary.currency ?? range.currency,
    interval,
    min: range.minValue ?? range.min,
    max: range.maxValue ?? range.max,
  }, null) ?? stringValue(amount?.value);
}

function explicitAvailability(...values: unknown[]): VerifiedPosting["availability"] {
  for (const value of values) {
    if (typeof value === "boolean") return value ? "OPEN" : "CLOSED";
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (["open", "active", "published", "listed"].includes(normalized)) return "OPEN";
    if (["closed", "inactive", "archived", "expired", "unlisted"].includes(normalized)) return "CLOSED";
  }
  return "UNKNOWN";
}

function stringOrNestedName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  const nested = record(value);
  return stringValue(nested?.name);
}

function jsonLocation(value: unknown): string | null {
  const locations = Array.isArray(value) ? value : [value];
  const formatted = locations.map((location) => {
    const address = nestedRecord(location, "address");
    if (!address) return null;
    const parts = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }).filter((item): item is string => Boolean(item));
  return formatted.length ? [...new Set(formatted)].join("; ") : null;
}

function extractApplyUrl(html: string, base: URL): string | null {
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const text = htmlToPlainText(match[2] ?? "");
    if (!/\bapply(?: now)?\b/i.test(text)) continue;
    const href = htmlAttribute(match[1] ?? "", "href");
    if (!href) continue;
    try {
      const url = new URL(href, base);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.toString();
    } catch {
      continue;
    }
  }
  return null;
}

function words(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function isCompletePostingText(value: string): boolean {
  return classifyDescriptionQuality(value).status === "COMPLETE";
}

function requisitionFromUrl(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last && /^[a-z0-9-]{4,}$/i.test(last) ? last : null;
}

function contentHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function postingEvidence(
  requestedUrl: string,
  response: SafeHttpResponse,
  redirects: string[],
  retrievedAt: Date,
): PostingSourceEvidence {
  return {
    requestedUrl,
    resolvedUrl: response.url,
    redirectHistory: redirects,
    retrievedAt: retrievedAt.toISOString(),
    httpStatus: response.status,
    contentType: header(response.headers, "content-type"),
    responseHash: contentHash(response.body.toString("utf8")),
  };
}

function makeCompleteResult(
  posting: VerifiedPosting,
  provider: ResolvedPostingSource,
  evidence: PostingSourceEvidence,
): JobContentResult {
  return {
    kind: "COMPLETE",
    posting,
    provider,
    evidence,
    contentHash: contentHash(JSON.stringify({
      title: posting.title,
      company: posting.companyName,
      description: posting.description,
      requisitionId: posting.requisitionId,
      canonicalUrl: posting.canonicalUrl,
      applyUrl: posting.applyUrl,
      location: posting.location,
      workplace: posting.workplaceType,
      employmentType: posting.employmentType,
      compensation: posting.compensationRaw,
      publishedAt: posting.publishedAt,
      updatedAt: posting.updatedAt,
      expiresAt: posting.expiresAt,
      availability: posting.availability,
    })),
  };
}

function parseLeverPosting(
  payload: Record<string, unknown>,
  sourceUrl: URL,
  expected: ExpectedPostingIdentity,
  evidence: PostingSourceEvidence,
): JobContentResult {
  const apiId = stringValue(payload.id);
  const siteToken = sourceUrl.pathname.split("/").filter(Boolean)[0] ?? "";
  const title = stringValue(payload.text);
  const categories = record(payload.categories);
  const companyName = stringValue(payload.companyName) ?? siteToken;
  const lists = Array.isArray(payload.lists) ? payload.lists.map((item) => record(item)).filter(Boolean) : [];
  const sections = lists.map((item) => {
    const heading = stringValue(item?.text);
    const content = stringValue(item?.content);
    return [heading, content ? htmlToPlainText(content) : null].filter(Boolean).join("\n");
  }).filter(Boolean);
  const description = [
    stringValue(payload.descriptionPlain) ?? (stringValue(payload.description) ? htmlToPlainText(stringValue(payload.description) ?? "") : null),
    ...sections,
    stringValue(payload.additionalPlain),
    stringValue(payload.additional) ? htmlToPlainText(stringValue(payload.additional) ?? "") : null,
  ].filter(Boolean).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();

  if (!title || !titleMatches(expected.title, title) || !companyMatches(expected.companyName, companyName, sourceUrl.hostname)) {
    return { kind: "IDENTITY_CONFLICT", reason: "Lever response title or employer did not match the discovered posting identity." };
  }
  if (expected.requisitionId && apiId && expected.requisitionId !== apiId) {
    return { kind: "IDENTITY_CONFLICT", reason: "Lever requisition ID did not match the discovered posting identity." };
  }
  if (!isCompletePostingText(description)) {
    return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
  }

  const hostedUrl = stringValue(payload.hostedUrl);
  const applyUrl = stringValue(payload.applyUrl);
  const canonicalUrl = hostedUrl ?? sourceUrl.toString();
  const posting: VerifiedPosting = {
    title,
    companyName,
    description,
    requisitionId: apiId,
    canonicalUrl,
    applyUrl,
    location: stringValue(categories?.location),
    workplaceType: normalizeWorkplaceType(payload.workplaceType ?? categories?.workplaceType),
    employmentType: stringValue(categories?.commitment),
    compensationRaw: leverSalaryRange(payload.salaryRange, payload.salaryDescriptionPlain ?? payload.salaryDescription),
    publishedAt: isoDate(payload.createdAt),
    updatedAt: isoDate(payload.updatedAt),
    expiresAt: null,
    availability: explicitAvailability(payload.state, payload.status),
    rawPayload: payload,
  };
  const provider: ResolvedPostingSource = {
    key: "LEVER",
    sourceUrl: sourceUrl.toString(),
    canonicalUrl,
    requisitionId: apiId,
    providerKey: siteToken,
  };
  return makeCompleteResult(posting, provider, evidence);
}

interface AtsPostingAddress {
  readonly key: "ASHBY" | "GREENHOUSE";
  readonly boardToken: string;
  readonly requisitionId: string;
  readonly apiUrl: string;
}

function atsPostingAddress(url: URL): AtsPostingAddress | null {
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const hostname = url.hostname.toLowerCase();
  if (hostname === "jobs.ashbyhq.com" && parts.length >= 2) {
    const boardToken = parts[0] ?? "";
    const requisitionId = parts[1] ?? "";
    if (!/^[a-z0-9_-]{1,80}$/i.test(boardToken) || !/^[a-z0-9-]{6,100}$/i.test(requisitionId)) return null;
    return {
      key: "ASHBY",
      boardToken,
      requisitionId,
      apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardToken)}?includeCompensation=true`,
    };
  }
  if ((hostname === "boards.greenhouse.io" || hostname === "job-boards.greenhouse.io") && parts.length >= 3) {
    const boardToken = parts[0] ?? "";
    const jobSegment = parts.findIndex((part) => part.toLowerCase() === "jobs");
    const requisitionId = jobSegment >= 0 ? parts[jobSegment + 1] : "";
    if (!/^[a-z0-9_-]{1,80}$/i.test(boardToken) || !/^\d{1,20}$/.test(requisitionId)) return null;
    return {
      key: "GREENHOUSE",
      boardToken,
      requisitionId,
      apiUrl: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(requisitionId)}?content=true`,
    };
  }
  return null;
}

const fetchIdentityIds = new WeakMap<Function, number>();
let nextFetchIdentityId = 1;
const ashbyBoardCache = new Map<string, { expiresAt: number; value: { response: SafeHttpResponse; redirects: string[] } }>();

function cacheIdentity(dependencies: PostingFetcherDependencies): string {
  const functionIdentity = dependencies.fetchOnce ?? dependencies.resolveAddresses;
  if (!functionIdentity) return "default";
  let id = fetchIdentityIds.get(functionIdentity);
  if (!id) {
    id = nextFetchIdentityId++;
    fetchIdentityIds.set(functionIdentity, id);
  }
  return String(id);
}

async function fetchAshbyBoard(
  address: AtsPostingAddress,
  requestedUrl: string,
  dependencies: PostingFetcherDependencies,
  now: Date,
): Promise<{ response: SafeHttpResponse; redirects: string[] }> {
  const cacheKey = cacheIdentity(dependencies) + ":" + address.boardToken.toLowerCase();
  const cached = ashbyBoardCache.get(cacheKey);
  if (cached && cached.expiresAt > now.getTime()) return cached.value;
  if (cached) ashbyBoardCache.delete(cacheKey);

  const fetched = await fetchSafe(address.apiUrl, dependencies, now);
  if (fetched.response.status < 200 || fetched.response.status >= 300) return fetched;
  const cacheEntry = { expiresAt: now.getTime() + 60_000, value: fetched };
  ashbyBoardCache.set(cacheKey, cacheEntry);
  while (ashbyBoardCache.size > 12) {
    const oldestKey = ashbyBoardCache.keys().next().value;
    if (oldestKey === undefined) break;
    ashbyBoardCache.delete(oldestKey);
  }
  return fetched;
}

function htmlOrText(value: unknown): string {
  if (typeof value !== "string") return "";
  return /<\/?[a-z][\s\S]*>/i.test(value) ? htmlToPlainText(value) : value.trim();
}

function parseAshbyPosting(
  payload: unknown,
  address: AtsPostingAddress,
  sourceUrl: URL,
  expected: ExpectedPostingIdentity,
  evidence: PostingSourceEvidence,
): JobContentResult {
  const root = record(payload);
  const jobs = Array.isArray(root?.jobs) ? root.jobs.map(record).filter(Boolean) : [];
  const item = jobs.find((job) => String(job?.id ?? "") === address.requisitionId)
    ?? jobs.find((job) => {
      const jobUrl = stringValue(job?.jobUrl);
      return jobUrl ? new URL(jobUrl).pathname.split("/").filter(Boolean).includes(address.requisitionId) : false;
    });
  if (!item) {
    return { kind: "IDENTITY_CONFLICT", reason: "Ashby board did not return the exact requisition referenced by the posting URL." };
  }
  const id = stringValue(item.id);
  const title = stringValue(item.title) ?? "";
  const companyName = stringValue(item.organizationName) ?? stringValue(item.companyName) ?? address.boardToken;
  if (!id || id !== address.requisitionId || !titleMatches(expected.title, title)
      || !companyMatches(expected.companyName, companyName, address.boardToken)) {
    return { kind: "IDENTITY_CONFLICT", reason: "Ashby requisition ID, title, or employer did not match the discovered posting." };
  }
  if (expected.requisitionId && expected.requisitionId !== id) {
    return { kind: "IDENTITY_CONFLICT", reason: "Ashby requisition ID did not match the expected posting identity." };
  }
  const description = htmlOrText(item.descriptionText ?? item.descriptionHtml ?? item.description);
  if (!isCompletePostingText(description)) return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
  const compensation = item.compensation ?? root?.compensation;
  const canonicalUrl = stringValue(item.jobUrl) ?? sourceUrl.toString();
  const posting: VerifiedPosting = {
    title,
    companyName,
    description,
    requisitionId: id,
    canonicalUrl,
    applyUrl: stringValue(item.applyUrl) ?? canonicalUrl,
    location: ashbyLocation(item),
    workplaceType: normalizeWorkplaceType(item.workplaceType),
    employmentType: stringValue(item.employmentType),
    compensationRaw: ashbyCompensation(compensation),
    publishedAt: isoDate(item.publishedAt),
    updatedAt: isoDate(item.updatedAt),
    expiresAt: isoDate(item.expiresAt),
    availability: explicitAvailability(item.status),
    rawPayload: item,
  };
  return makeCompleteResult(posting, {
    key: "ASHBY",
    sourceUrl: sourceUrl.toString(),
    canonicalUrl,
    requisitionId: id,
    providerKey: address.boardToken,
  }, evidence);
}

function parseGreenhousePosting(
  payload: unknown,
  address: AtsPostingAddress,
  sourceUrl: URL,
  expected: ExpectedPostingIdentity,
  evidence: PostingSourceEvidence,
): JobContentResult {
  const item = record(payload);
  const id = item?.id === null || item?.id === undefined ? null : String(item.id);
  const title = stringValue(item?.title) ?? "";
  const companyName = stringValue(item?.company) ?? address.boardToken;
  if (!item || !id || id !== address.requisitionId || !titleMatches(expected.title, title)
      || !companyMatches(expected.companyName, companyName, address.boardToken)) {
    return { kind: "IDENTITY_CONFLICT", reason: "Greenhouse requisition ID, title, or employer did not match the discovered posting." };
  }
  if (expected.requisitionId && expected.requisitionId !== id) {
    return { kind: "IDENTITY_CONFLICT", reason: "Greenhouse requisition ID did not match the expected posting identity." };
  }
  const description = htmlOrText(item.content);
  if (!isCompletePostingText(description)) return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
  const location = record(item.location);
  const canonicalUrl = stringValue(item.absolute_url) ?? sourceUrl.toString();
  const metadata = Array.isArray(item.metadata) ? item.metadata.map(record).filter(Boolean) : [];
  const metadataValue = (...names: string[]): unknown => {
    const normalizedNames = names.map((name) => normalizeIdentity(name));
    return metadata.find((entry) => {
      const name = normalizeIdentity(stringValue(entry?.name) ?? stringValue(entry?.key) ?? "");
      return normalizedNames.includes(name);
    })?.value;
  };
  const posting: VerifiedPosting = {
    title,
    companyName,
    description,
    requisitionId: id,
    canonicalUrl,
    applyUrl: canonicalUrl,
    location: stringValue(location?.name),
    workplaceType: normalizeWorkplaceType(metadataValue("workplace type", "workplace", "work arrangement")),
    employmentType: stringValue(metadataValue("employment type", "commitment")),
    compensationRaw: leverSalaryRange(metadataValue("salary range", "salary", "compensation"), null),
    publishedAt: isoDate(item.first_published),
    updatedAt: isoDate(item.updated_at),
    expiresAt: null,
    availability: explicitAvailability(item.status, item.active, item.is_open),
    rawPayload: item,
  };
  return makeCompleteResult(posting, {
    key: "GREENHOUSE",
    sourceUrl: sourceUrl.toString(),
    canonicalUrl,
    requisitionId: id,
    providerKey: address.boardToken,
  }, evidence);
}

function findMatchingJsonLd(
  html: string,
  expected: ExpectedPostingIdentity,
  hostname: string,
): { posting: Record<string, unknown>; employer: string; title: string; description: string } | JobContentResult | null {
  const postings = jsonLdJobPostings(html);
  if (!postings.length) return null;
  const matching = postings.filter((posting) => {
    const title = stringValue(posting.title) ?? "";
    const employer = stringOrNestedName(posting.hiringOrganization) ?? "";
    return titleMatches(expected.title, title) && companyMatches(expected.companyName, employer, hostname);
  });
  if (matching.length !== 1) {
    return { kind: "IDENTITY_CONFLICT", reason: matching.length === 0
      ? "No JobPosting JSON-LD record matched both title and employer."
      : "More than one JobPosting JSON-LD record matched the expected title and employer." };
  }
  const posting = matching[0];
  if (!posting) return null;
  const employer = stringOrNestedName(posting.hiringOrganization) ?? "";
  const title = stringValue(posting.title) ?? "";
  const description = stringValue(posting.description) ? htmlToPlainText(stringValue(posting.description) ?? "") : "";
  const structuredId = record(posting.identifier);
  const providerId = stringValue(structuredId?.value);
  if (expected.requisitionId && providerId && expected.requisitionId !== providerId) {
    return { kind: "IDENTITY_CONFLICT", reason: "Structured requisition ID did not match the discovered posting identity." };
  }
  return { posting, employer, title, description };
}

function parseEmployerHtml(
  html: string,
  sourceUrl: URL,
  expected: ExpectedPostingIdentity,
  evidence: PostingSourceEvidence,
): JobContentResult {
  const matchedJsonLd = findMatchingJsonLd(html, expected, sourceUrl.hostname);
  if (matchedJsonLd && "kind" in matchedJsonLd) return matchedJsonLd;

  const h1 = findH1(html) ?? "";
  const main = cleanJobRegion(html);
  const pageText = htmlToPlainText(main);
  const title = matchedJsonLd?.title ?? h1;
  const employer = matchedJsonLd?.employer ?? "";
  const employerVerified = companyMatches(expected.companyName, employer, sourceUrl.hostname)
    || companyMatches(expected.companyName, pageText, sourceUrl.hostname);
  if (!titleMatches(expected.title, title) || !employerVerified) {
    return { kind: "IDENTITY_CONFLICT", reason: "Employer page title or employer identity did not match the discovered posting." };
  }

  const description = matchedJsonLd?.description || pageText;
  if (!isCompletePostingText(description)) {
    if (/\b(captcha|robot check|access denied|verify you are human)\b/i.test(pageText)) {
      return { kind: "BLOCKED", reason: "BOT_BLOCKED" };
    }
    if (/\b(sign in|log in|create an account)\b/i.test(pageText) && words(pageText) < 100) {
      return { kind: "BLOCKED", reason: "AUTH_REQUIRED" };
    }
    return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
  }

  const location = matchedJsonLd
    ? jsonLocation(matchedJsonLd.posting.jobLocation)
    : pageText.match(/\bLocation\s*:\s*([^\n]{2,100})/i)?.[1]?.trim() ?? null;
  const sourceUrlId = requisitionFromUrl(sourceUrl);
  const structuredId = matchedJsonLd ? record(matchedJsonLd.posting.identifier) : null;
  const requisitionId = stringValue(structuredId?.value) ?? sourceUrlId;
  if (expected.requisitionId && requisitionId && expected.requisitionId !== requisitionId) {
    return { kind: "IDENTITY_CONFLICT", reason: "Employer page requisition ID did not match the discovered posting identity." };
  }

  const workText = description.toLowerCase();
  const structuredWorkplace = stringValue(matchedJsonLd?.posting.jobLocationType);
  const workplaceType = structuredWorkplace?.toUpperCase() === "TELECOMMUTE"
    ? "REMOTE"
    : structuredWorkplace
      ? normalizeWorkplaceType(structuredWorkplace)
      : /\bfully remote|remote-first|work from anywhere\b/.test(workText)
        ? "REMOTE"
        : /\bhybrid\b/.test(workText) ? "HYBRID"
          : /\bon[- ]site\b/.test(workText) ? "ONSITE" : "UNKNOWN";
  const jsonLdEmploymentType = matchedJsonLd?.posting.employmentType;
  const employmentType = Array.isArray(jsonLdEmploymentType)
    ? jsonLdEmploymentType.map(stringValue).filter((item): item is string => Boolean(item)).join(", ") || null
    : stringValue(jsonLdEmploymentType);
  const posting: VerifiedPosting = {
    title,
    companyName: employer || expected.companyName,
    description,
    requisitionId,
    canonicalUrl: stringValue(matchedJsonLd?.posting.url) ?? sourceUrl.toString(),
    applyUrl: extractApplyUrl(html, sourceUrl) ?? stringValue(matchedJsonLd?.posting.url),
    location,
    workplaceType,
    employmentType,
    compensationRaw: matchedJsonLd ? jsonLdSalary(matchedJsonLd.posting.baseSalary) : null,
    publishedAt: matchedJsonLd ? isoDate(matchedJsonLd.posting.datePosted) : null,
    updatedAt: matchedJsonLd ? isoDate(matchedJsonLd.posting.dateModified) : null,
    expiresAt: matchedJsonLd ? isoDate(matchedJsonLd.posting.validThrough) : null,
    availability: "UNKNOWN",
    rawPayload: {
      title,
      companyName: employer || expected.companyName,
      requisitionId,
      sourceUrl: sourceUrl.toString(),
      responseHash: evidence.responseHash,
      description,
      structuredJobPosting: matchedJsonLd?.posting ?? null,
    },
  };
  return makeCompleteResult(posting, {
    key: "EMPLOYER_WEBSITE",
    sourceUrl: sourceUrl.toString(),
    canonicalUrl: posting.canonicalUrl,
    requisitionId,
    providerKey: sourceUrl.hostname,
  }, evidence);
}

function failureForStatus(response: SafeHttpResponse, evidence: PostingSourceEvidence, now: Date): JobContentResult | null {
  if (response.status === 401) return { kind: "BLOCKED", reason: "AUTH_REQUIRED" };
  if (response.status === 403) {
    const body = response.body.toString("utf8");
    return { kind: "BLOCKED", reason: /\b(captcha|robot|bot detection|verify you are human)\b/i.test(body) ? "BOT_BLOCKED" : "AUTH_REQUIRED" };
  }
  if (response.status === 404 || response.status === 410) {
    return { kind: "UNAVAILABLE", reason: "The exact posting URL returned HTTP " + response.status + ".", evidence };
  }
  if (response.status === 429) {
    return { kind: "RETRYABLE_FAILURE", reason: "Posting provider rate limited the request.", retryAfter: retryAfter(response.headers, now) };
  }
  if (response.status >= 500 || response.status === 408) {
    return { kind: "RETRYABLE_FAILURE", reason: "Posting provider returned HTTP " + response.status + "." };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
  }
  return null;
}

export async function fetchJobContent(
  requestedUrl: string | null | undefined,
  expected: ExpectedPostingIdentity,
  dependencies: PostingFetcherDependencies = {},
): Promise<JobContentResult> {
  if (!requestedUrl || !requestedUrl.trim()) return { kind: "BLOCKED", reason: "MISSING_POSTING_URL" };

  const now = dependencies.now?.() ?? new Date();
  let sourceUrl: URL;
  let atsAddress: AtsPostingAddress | null;
  let fetched: { response: SafeHttpResponse; redirects: string[] };
  try {
    sourceUrl = parseHttpUrl(decodeTrackingWrapper(requestedUrl));
    atsAddress = atsPostingAddress(sourceUrl);
    const directLever = /(?:^|\.)jobs\.lever\.co$/i.test(sourceUrl.hostname);
    if (directLever) {
      fetched = { response: { status: 200, headers: {}, body: Buffer.alloc(0), url: sourceUrl.toString() }, redirects: [] };
    } else if (atsAddress?.key === "ASHBY") {
      fetched = await fetchAshbyBoard(atsAddress, requestedUrl, dependencies, now);
    } else {
      fetched = await fetchSafe(atsAddress?.apiUrl ?? requestedUrl, dependencies, now);
    }
  } catch (error) {
    if (error instanceof UnsafePostingUrlError) {
      return { kind: "BLOCKED", reason: "UNSAFE_REDIRECT" };
    }
    return { kind: "RETRYABLE_FAILURE", reason: error instanceof Error ? error.message : String(error) };
  }

  const { response, redirects } = fetched;
  const evidence = postingEvidence(requestedUrl, response, redirects, now);
  const contentType = (header(response.headers, "content-type") ?? "").toLowerCase();
  const isLever = /(?:^|\.)jobs\.lever\.co$/i.test(sourceUrl.hostname);
  if (!isLever) {
    const statusFailure = failureForStatus(response, evidence, now);
    if (statusFailure) return statusFailure;
  }
  const bodyText = response.body.toString("utf8");
  if (atsAddress) {
    const apiFailure = failureForStatus(response, evidence, now);
    if (apiFailure) return apiFailure;
    try {
      const payload = parseBoundedJson(bodyText);
      return atsAddress.key === "ASHBY"
        ? parseAshbyPosting(payload, atsAddress, sourceUrl, expected, evidence)
        : parseGreenhousePosting(payload, atsAddress, sourceUrl, expected, evidence);
    } catch {
      return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
    }
  }
  if (isLever) {
    const path = sourceUrl.pathname.split("/").filter(Boolean);
    if (path.length < 2) return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
    const apiUrl = new URL(
      "https://api.lever.co/v0/postings/" + encodeURIComponent(path[0] ?? "") + "/" + encodeURIComponent(path[1] ?? ""),
    );
    apiUrl.searchParams.set("mode", "json");
    let apiFetched: { response: SafeHttpResponse; redirects: string[] };
    try {
      apiFetched = await fetchSafe(apiUrl.toString(), dependencies, now);
    } catch (error) {
      if (error instanceof UnsafePostingUrlError) return { kind: "BLOCKED", reason: "UNSAFE_REDIRECT" };
      return { kind: "RETRYABLE_FAILURE", reason: error instanceof Error ? error.message : String(error) };
    }
    const apiEvidence = postingEvidence(requestedUrl, apiFetched.response, [...redirects, ...apiFetched.redirects], now);
    const apiFailure = failureForStatus(apiFetched.response, apiEvidence, now);
    if (apiFailure) return apiFailure;
    try {
      const payload = record(parseBoundedJson(apiFetched.response.body.toString("utf8")));
      if (!payload) return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
      return parseLeverPosting(payload, sourceUrl, expected, apiEvidence);
    } catch {
      return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
    }
  }

  if (!contentType.includes("text/html") && !contentType.includes("application/ld+json")) {
    return { kind: "BLOCKED", reason: "UNSUPPORTED_SOURCE" };
  }
  return parseEmployerHtml(bodyText, new URL(response.url), expected, evidence);
}
