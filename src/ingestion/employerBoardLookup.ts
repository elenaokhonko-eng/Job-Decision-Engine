/**
 * Employer-board fallback for LinkedIn-discovered jobs.
 *
 * Gmail job alerts (mostly LinkedIn digests) carry only a card: title, employer, location and a
 * LinkedIn /jobs/view/<id> link. LinkedIn serves job pages only to signed-in browsers, so the
 * posting fetch from CI ends BLOCKED. Many employers publish the same job on a public ATS job
 * board with an official, unauthenticated JSON API (Greenhouse, Lever, Ashby). This module finds
 * the employer's board, looks for exactly one posting with the same title at a compatible
 * location, and returns that posting's full description.
 *
 * Nothing is fabricated: no board, no match, or more than one match ends BLOCKED with a specific
 * reason so the job stays recoverable. Network, HTTP and parse failures are retryable
 * operational failures, never job outcomes. Board resolutions (positive and negative) are
 * cached per employer with a TTL so each employer is resolved once, not per job.
 *
 * Workday is deliberately not supported: its public CXS job search is a POST endpoint (the
 * posting fetcher is GET-only by design) and no Workday tenant is configured in
 * config/companies.yml. Guessing Workday tenants is out of scope.
 */
import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { configPath } from "../config/configPaths.js";
import type pg from "pg";
import { MAX_SOURCE_RESPONSE_BYTES } from "./adapters/baseAdapter.js";
import {
  UnsafePostingUrlError,
  companyMatches,
  failureForStatus,
  fetchSafe,
  makeCompleteResult,
  normalizeIdentity,
  parseAshbyPosting,
  parseBoundedJson,
  parseGreenhousePosting,
  parseLeverPosting,
  postingEvidence,
  titleMatches,
  type EmployerBoardFallback,
  type EmployerBoardFallbackInput,
  type EmployerBoardLookupProvenance,
  type ExpectedPostingIdentity,
  type JobContentResult,
  type PostingFetcherDependencies,
  type SafeHttpResponse,
} from "./jobContentFetcher.js";

export type EmployerBoardProvider = "GREENHOUSE" | "LEVER" | "ASHBY";

export const EMPLOYER_BOARD_RESOLVER_VERSION = "employer_board_resolver_v1";
export const FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const NOT_FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Board listings can be several MiB (Ashby boards embed descriptions); same ceiling as source adapters. */
const BOARD_LISTING_MAX_BYTES = MAX_SOURCE_RESPONSE_BYTES;
const DEFAULT_MAX_SLUG_CANDIDATES = 3;
const DEFAULT_MAX_REQUESTS = 20;
// Lever has no content-free listing; 50 postings (~1 MB) per page keeps each request inside the
// fetcher's fixed 10 s per-request ceiling on slow links.
const LEVER_PAGE_SIZE = 50;
const DEFAULT_LEVER_MAX_PAGES = 6;
const BOARD_TOKEN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/i;
/** Registry slugs may also contain dots (Ashby `mistral.ai`); guessed slugs never do. */
const KNOWN_BOARD_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export interface KnownEmployerBoard {
  readonly companyName: string;
  readonly provider: EmployerBoardProvider;
  readonly boardToken: string;
}

export interface EmployerBoardResolution {
  readonly employerKey: string;
  readonly employerName: string;
  readonly status: "FOUND" | "NOT_FOUND";
  readonly provider: EmployerBoardProvider | null;
  readonly boardToken: string | null;
  readonly boardName: string | null;
  readonly resolutionMethod: "CONFIG" | "DERIVED_SLUG" | "NONE";
  /** Provider:token pairs probed, e.g. "GREENHOUSE:acme". Public identifiers only. */
  readonly candidatesTried: readonly string[];
  readonly resolvedAt: string;
  readonly expiresAt: string;
}

export interface EmployerBoardResolutionCache {
  /** Returns the unexpired resolution for the employer, or null. */
  get(employerKey: string, now: Date): Promise<EmployerBoardResolution | null>;
  put(resolution: EmployerBoardResolution): Promise<void>;
}

export class InMemoryEmployerBoardResolutionCache implements EmployerBoardResolutionCache {
  readonly entries = new Map<string, EmployerBoardResolution>();

  async get(employerKey: string, now: Date): Promise<EmployerBoardResolution | null> {
    const entry = this.entries.get(employerKey);
    return entry && Date.parse(entry.expiresAt) > now.getTime() ? entry : null;
  }

  async put(resolution: EmployerBoardResolution): Promise<void> {
    this.entries.set(resolution.employerKey, resolution);
  }
}

type QueryExecutor = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

interface ResolutionRow {
  employer_key: string;
  employer_name: string;
  status: "FOUND" | "NOT_FOUND";
  provider: EmployerBoardProvider | null;
  board_token: string | null;
  board_name: string | null;
  resolution_method: "CONFIG" | "DERIVED_SLUG" | "NONE";
  candidates_tried: string[];
  resolved_at: Date;
  expires_at: Date;
}

/** Durable cache in employer_board_resolutions (migration 100). Public board facts only. */
export class PgEmployerBoardResolutionCache implements EmployerBoardResolutionCache {
  constructor(private readonly executor: QueryExecutor) {}

  async get(employerKey: string, now: Date): Promise<EmployerBoardResolution | null> {
    const { rows } = await this.executor.query<ResolutionRow>(
      `SELECT employer_key, employer_name, status, provider, board_token, board_name,
              resolution_method, candidates_tried, resolved_at, expires_at
       FROM employer_board_resolutions
       WHERE employer_key = $1 AND expires_at > $2::timestamptz`,
      [employerKey, now.toISOString()],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      employerKey: row.employer_key,
      employerName: row.employer_name,
      status: row.status,
      provider: row.provider,
      boardToken: row.board_token,
      boardName: row.board_name,
      resolutionMethod: row.resolution_method,
      candidatesTried: row.candidates_tried,
      resolvedAt: new Date(row.resolved_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  async put(resolution: EmployerBoardResolution): Promise<void> {
    await this.executor.query(
      `INSERT INTO employer_board_resolutions (
         employer_key, employer_name, status, provider, board_token, board_name,
         resolution_method, candidates_tried, resolver_version, resolved_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz, $11::timestamptz)
       ON CONFLICT (employer_key) DO UPDATE SET
         employer_name = EXCLUDED.employer_name,
         status = EXCLUDED.status,
         provider = EXCLUDED.provider,
         board_token = EXCLUDED.board_token,
         board_name = EXCLUDED.board_name,
         resolution_method = EXCLUDED.resolution_method,
         candidates_tried = EXCLUDED.candidates_tried,
         resolver_version = EXCLUDED.resolver_version,
         resolved_at = EXCLUDED.resolved_at,
         expires_at = EXCLUDED.expires_at`,
      [
        resolution.employerKey,
        resolution.employerName.slice(0, 500),
        resolution.status,
        resolution.provider,
        resolution.boardToken,
        resolution.boardName?.slice(0, 500) ?? null,
        resolution.resolutionMethod,
        JSON.stringify(resolution.candidatesTried),
        EMPLOYER_BOARD_RESOLVER_VERSION,
        resolution.resolvedAt,
        resolution.expiresAt,
      ],
    );
  }
}

const LEGAL_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "pte", "plc", "corp", "corporation", "co", "company",
  "gmbh", "ag", "sa", "bv", "nv", "pty", "srl", "sas", "lp", "llp", "sdn", "bhd", "kk", "oy", "ab", "spa",
]);
const DESCRIPTOR_SUFFIXES = new Set([
  "group", "holdings", "holding", "technologies", "technology", "tech", "labs", "lab", "software",
  "systems", "solutions", "international", "global", "ai", "hq",
]);

function asciiTokens(companyName: string): string[] {
  return companyName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function withoutLegalSuffixes(tokens: readonly string[]): string[] {
  const result = [...tokens];
  if (result[0] === "the" && result.length > 1) result.shift();
  while (result.length > 1 && LEGAL_SUFFIXES.has(result[result.length - 1] ?? "")) result.pop();
  return result;
}

/** Cache key for an employer: normalized name without legal-form suffixes ("Acme Pte. Ltd." -> "acme"). */
export function employerKey(companyName: string): string {
  return withoutLegalSuffixes(asciiTokens(companyName)).join(" ");
}

export interface BoardSlugCandidate {
  readonly slug: string;
  /**
   * True when the slug may be tried on providers that expose no employer name (Lever, Ashby):
   * it keeps every name token, or it drops only descriptor suffixes and is still distinctive
   * (at least 6 characters, so "Palantir Technologies" -> "palantir" but not "Scale AI" -> "scale").
   */
  readonly unverifiedProviderSafe: boolean;
}

const MIN_DISTINCTIVE_STRIPPED_SLUG_LENGTH = 6;

/**
 * Deterministic board-token guesses from an employer name: lowercase ASCII, legal-form suffixes
 * removed, then joined and hyphenated forms, with and without descriptor suffixes such as
 * "Group" or "Technologies". At most `limit` candidates, most specific first.
 */
export function deriveBoardSlugCandidates(companyName: string, limit = DEFAULT_MAX_SLUG_CANDIDATES): BoardSlugCandidate[] {
  const base = withoutLegalSuffixes(asciiTokens(companyName));
  if (base.length === 0) return [];
  const stripped = [...base];
  while (stripped.length > 1 && DESCRIPTOR_SUFFIXES.has(stripped[stripped.length - 1] ?? "")) stripped.pop();
  const safe = (slug: string) => stripped.length === base.length || slug.replace(/-/g, "").length >= MIN_DISTINCTIVE_STRIPPED_SLUG_LENGTH;
  const ordered: BoardSlugCandidate[] = [
    { slug: base.join(""), unverifiedProviderSafe: true },
    { slug: stripped.join(""), unverifiedProviderSafe: safe(stripped.join("")) },
    { slug: base.join("-"), unverifiedProviderSafe: true },
    { slug: stripped.join("-"), unverifiedProviderSafe: safe(stripped.join("-")) },
  ];
  const seen = new Set<string>();
  const result: BoardSlugCandidate[] = [];
  for (const candidate of ordered) {
    if (candidate.slug.length < 2 || !BOARD_TOKEN_PATTERN.test(candidate.slug) || seen.has(candidate.slug)) continue;
    seen.add(candidate.slug);
    result.push(candidate);
    if (result.length >= limit) break;
  }
  return result;
}

const WORK_MODE_WORDS = /\b(?:fully remote|remote|hybrid|on ?site|in office|in person)\b/g;
const LOCATION_FILLER = new Set(["greater", "area", "metropolitan", "metro", "region", "the", "of", "city", "and"]);
const LOCATION_ALIASES: Readonly<Record<string, string>> = {
  us: "united states",
  usa: "united states",
  "united states of america": "united states",
  uk: "united kingdom",
  "great britain": "united kingdom",
  uae: "united arab emirates",
  nyc: "new york",
  sf: "san francisco",
};

function locationSegments(value: string | null | undefined): string[] {
  if (!value) return [];
  const segments: string[] = [];
  for (const raw of value.normalize("NFKC").toLowerCase().split(/[,;|/()–—]+|\s-\s/)) {
    const cleaned = raw
      .replace(/[^a-z0-9]+/g, " ")
      .replace(WORK_MODE_WORDS, " ")
      .split(" ")
      .filter((token) => token && !LOCATION_FILLER.has(token))
      .join(" ");
    const aliased = LOCATION_ALIASES[cleaned] ?? cleaned;
    // Two-letter fragments (state or country codes) are too ambiguous to compare on their own.
    if (aliased.length > 2 && aliased !== "unknown") segments.push(aliased);
  }
  return [...new Set(segments)];
}

/**
 * True when the discovery-card location and the posting locations can describe the same job.
 * An unknown location on either side is compatible; title and employer still have to match,
 * and more than one surviving candidate is reported as ambiguous.
 */
export function locationsCompatible(expected: string | null | undefined, postingLocations: readonly (string | null | undefined)[]): boolean {
  const wanted = locationSegments(expected);
  if (wanted.length === 0) return true;
  const offered = postingLocations.flatMap((location) => locationSegments(location));
  if (offered.length === 0) return true;
  return wanted.some((left) => offered.some((right) =>
    ` ${right} `.includes(` ${left} `) || ` ${left} `.includes(` ${right} `)));
}

/** Known boards from config/companies.yml (greenhouse/lever/ashby entries with a board_slug). */
export function loadKnownEmployerBoards(filePath = configPath("companies.yml")): KnownEmployerBoard[] {
  if (!fs.existsSync(filePath)) throw new Error(`Company source registry is missing: ${filePath}`);
  const document: unknown = loadYaml(fs.readFileSync(filePath, "utf8"));
  const companies = document !== null && typeof document === "object" && !Array.isArray(document)
    ? (document as Record<string, unknown>).companies
    : undefined;
  if (!Array.isArray(companies)) throw new Error("Company source registry must contain a companies array.");
  const providers: Readonly<Record<string, EmployerBoardProvider>> = {
    greenhouse: "GREENHOUSE",
    lever: "LEVER",
    ashby: "ASHBY",
  };
  const boards: KnownEmployerBoard[] = [];
  for (const entry of companies) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Company source registry entries must be objects.");
    }
    const company = entry as Record<string, unknown>;
    const provider = typeof company.ats_provider === "string" ? providers[company.ats_provider.trim().toLowerCase()] : undefined;
    const token = typeof company.board_slug === "string" ? company.board_slug.trim() : "";
    const name = typeof company.name === "string" ? company.name.trim() : "";
    if (!provider || !token || !name) continue;
    if (!KNOWN_BOARD_TOKEN_PATTERN.test(token)) throw new Error(`Company ${name} has an invalid board_slug.`);
    boards.push({ companyName: name, provider, boardToken: token });
  }
  return boards;
}

export interface EmployerBoardLookupOptions {
  readonly cache: EmployerBoardResolutionCache;
  readonly knownBoards: readonly KnownEmployerBoard[];
  readonly maxSlugCandidates?: number;
  /** Hard ceiling on HTTP requests per lookup; structurally the lookup needs at most ~17. */
  readonly maxRequests?: number;
  readonly leverMaxPages?: number;
}

class LookupRetryable extends Error {
  constructor(message: string, readonly retryAfter?: string) {
    super(message);
    this.name = "LookupRetryable";
  }
}

class LookupUnsafe extends Error {}

interface Fetched {
  readonly response: SafeHttpResponse;
  readonly redirects: string[];
}

interface ProbeHit {
  readonly provider: EmployerBoardProvider;
  readonly boardToken: string;
  readonly boardName: string | null;
  /** Listing fetched while probing (Ashby board, first Lever page), reused for the scan. */
  readonly listing: Fetched | null;
}

class LookupSession {
  private requests = 0;

  constructor(
    private readonly dependencies: PostingFetcherDependencies,
    private readonly now: Date,
    private readonly maxRequests: number,
  ) {}

  /** GET with the posting fetcher's protections; null for 404/410 (no such board or posting). */
  async get(url: string, maxBytes?: number): Promise<Fetched | null> {
    if (this.requests >= this.maxRequests) {
      throw new LookupRetryable(`Employer board lookup exceeded its ${this.maxRequests}-request budget.`);
    }
    this.requests += 1;
    let fetched: Fetched;
    try {
      fetched = await fetchSafe(url, this.dependencies, this.now, maxBytes);
    } catch (error) {
      if (error instanceof UnsafePostingUrlError) throw new LookupUnsafe(error.message);
      throw new LookupRetryable(`Employer board request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const status = fetched.response.status;
    if (status === 404 || status === 410) return null;
    if (status >= 200 && status < 300) return fetched;
    const failure = failureForStatus(fetched.response, postingEvidence(url, fetched.response, fetched.redirects, this.now), this.now);
    const retryAfter = failure?.kind === "RETRYABLE_FAILURE" ? failure.retryAfter : undefined;
    throw new LookupRetryable(`Employer board API returned HTTP ${status}.`, retryAfter);
  }

  get requestCount(): number {
    return this.requests;
  }
}

function parseListingJson(fetched: Fetched, what: string): unknown {
  try {
    // Board listings come from fixed official ATS API hosts and are already size-bounded.
    return JSON.parse(fetched.response.body.toString("utf8"));
  } catch (error) {
    throw new LookupRetryable(`${what} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function greenhouseBoardUrl(token: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`;
}

function ashbyBoardUrl(token: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`;
}

function leverPageUrl(token: string, skip: number): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json&skip=${skip}&limit=${LEVER_PAGE_SIZE}`;
}

async function probeBoard(
  session: LookupSession,
  provider: EmployerBoardProvider,
  token: string,
  companyName: string,
  verifyIdentity: boolean,
): Promise<ProbeHit | null> {
  if (provider === "GREENHOUSE") {
    const fetched = await session.get(greenhouseBoardUrl(token));
    if (!fetched) return null;
    const boardName = text(asRecord(parseListingJson(fetched, "Greenhouse board"))?.name);
    // Greenhouse exposes the board's employer name, so a guessed token must name the same employer.
    if (verifyIdentity && (!boardName || !companyMatches(employerKey(companyName), boardName, ""))) return null;
    return { provider, boardToken: token, boardName, listing: null };
  }
  if (provider === "ASHBY") {
    const fetched = await session.get(ashbyBoardUrl(token), BOARD_LISTING_MAX_BYTES);
    if (!fetched) return null;
    if (!Array.isArray(asRecord(parseListingJson(fetched, "Ashby board"))?.jobs)) {
      throw new LookupRetryable("Ashby board response has no jobs array.");
    }
    return { provider, boardToken: token, boardName: null, listing: fetched };
  }
  const fetched = await session.get(leverPageUrl(token, 0), BOARD_LISTING_MAX_BYTES);
  if (!fetched) return null;
  if (!Array.isArray(parseListingJson(fetched, "Lever board"))) {
    throw new LookupRetryable("Lever board response is not a postings array.");
  }
  return { provider, boardToken: token, boardName: null, listing: fetched };
}

interface ResolveOutcome {
  readonly resolution: EmployerBoardResolution;
  readonly cached: boolean;
  readonly hit: ProbeHit | null;
}

async function resolveBoard(
  session: LookupSession,
  options: EmployerBoardLookupOptions,
  companyName: string,
  key: string,
  now: Date,
  bypassCache: boolean,
): Promise<ResolveOutcome> {
  if (!bypassCache) {
    const cached = await options.cache.get(key, now);
    if (cached) return { resolution: cached, cached: true, hit: null };
  }
  const tried: string[] = [];
  const seen = new Set<string>();
  const attempts: Array<{ provider: EmployerBoardProvider; token: string; method: "CONFIG" | "DERIVED_SLUG"; verify: boolean }> = [];
  const push = (provider: EmployerBoardProvider, token: string, method: "CONFIG" | "DERIVED_SLUG", verify: boolean) => {
    const id = `${provider}:${token.toLowerCase()}`;
    if (seen.has(id)) return;
    seen.add(id);
    attempts.push({ provider, token, method, verify });
  };
  for (const board of options.knownBoards) {
    if (employerKey(board.companyName) === key) push(board.provider, board.boardToken, "CONFIG", false);
  }
  const slugs = deriveBoardSlugCandidates(companyName, options.maxSlugCandidates ?? DEFAULT_MAX_SLUG_CANDIDATES);
  // Greenhouse first: it is the only provider whose public API names the employer, so a guess
  // there is verified. Lever and Ashby expose no employer name, so only slugs that keep the
  // full employer name, or a distinctive stem of it, are tried there.
  for (const provider of ["GREENHOUSE", "ASHBY", "LEVER"] as const) {
    for (const candidate of slugs) {
      if (provider !== "GREENHOUSE" && !candidate.unverifiedProviderSafe) continue;
      push(provider, candidate.slug, "DERIVED_SLUG", provider === "GREENHOUSE");
    }
  }

  for (const attempt of attempts) {
    tried.push(`${attempt.provider}:${attempt.token}`);
    const hit = await probeBoard(session, attempt.provider, attempt.token, companyName, attempt.verify);
    if (!hit) continue;
    const resolution: EmployerBoardResolution = {
      employerKey: key,
      employerName: companyName,
      status: "FOUND",
      provider: hit.provider,
      boardToken: hit.boardToken,
      boardName: hit.boardName,
      resolutionMethod: attempt.method,
      candidatesTried: tried,
      resolvedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + FOUND_TTL_MS).toISOString(),
    };
    await options.cache.put(resolution);
    return { resolution, cached: false, hit };
  }
  const resolution: EmployerBoardResolution = {
    employerKey: key,
    employerName: companyName,
    status: "NOT_FOUND",
    provider: null,
    boardToken: null,
    boardName: null,
    resolutionMethod: "NONE",
    candidatesTried: tried,
    resolvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + NOT_FOUND_TTL_MS).toISOString(),
  };
  await options.cache.put(resolution);
  return { resolution, cached: false, hit: null };
}

interface BoardJob {
  readonly id: string;
  readonly title: string;
  readonly locations: readonly (string | null)[];
  readonly record: Record<string, unknown>;
}

type ScanResult =
  | { readonly kind: "MATCH"; readonly job: BoardJob; readonly listing: Fetched; readonly scanned: number }
  | { readonly kind: "NONE"; readonly scanned: number; readonly complete: boolean }
  | { readonly kind: "AMBIGUOUS"; readonly count: number; readonly scanned: number }
  | { readonly kind: "BOARD_GONE" };

function matchingJobs(jobs: readonly BoardJob[], expected: ExpectedPostingIdentity): BoardJob[] {
  return jobs.filter((job) => titleMatches(expected.title, job.title) && locationsCompatible(expected.location, job.locations));
}

function greenhouseJobs(payload: unknown): BoardJob[] {
  const jobs = asRecord(payload)?.jobs;
  if (!Array.isArray(jobs)) throw new LookupRetryable("Greenhouse job list response has no jobs array.");
  return jobs.map(asRecord).filter((job): job is Record<string, unknown> => Boolean(job)).flatMap((job) => {
    const id = job.id === null || job.id === undefined ? null : String(job.id);
    const title = text(job.title);
    if (!id || !/^\d{1,20}$/.test(id) || !title) return [];
    return [{ id, title, locations: [text(asRecord(job.location)?.name)], record: job }];
  });
}

function ashbyJobs(payload: unknown): BoardJob[] {
  const jobs = asRecord(payload)?.jobs;
  if (!Array.isArray(jobs)) throw new LookupRetryable("Ashby board response has no jobs array.");
  return jobs.map(asRecord).filter((job): job is Record<string, unknown> => Boolean(job)).flatMap((job) => {
    const id = text(job.id);
    const title = text(job.title);
    if (!id || !title || job.isListed === false) return [];
    const secondary = Array.isArray(job.secondaryLocations)
      ? job.secondaryLocations.map((item) => text(asRecord(item)?.location))
      : [];
    return [{ id, title, locations: [text(job.location), ...secondary], record: job }];
  });
}

function leverJobs(payload: unknown): BoardJob[] {
  if (!Array.isArray(payload)) throw new LookupRetryable("Lever board response is not a postings array.");
  return payload.map(asRecord).filter((job): job is Record<string, unknown> => Boolean(job)).flatMap((job) => {
    const id = text(job.id);
    const title = text(job.text);
    if (!id || !title) return [];
    const categories = asRecord(job.categories);
    const all = Array.isArray(categories?.allLocations) ? categories.allLocations.map(text) : [];
    return [{ id, title, locations: [text(categories?.location), ...all, text(job.country)], record: job }];
  });
}

async function scanBoard(
  session: LookupSession,
  provider: EmployerBoardProvider,
  token: string,
  listing: Fetched | null,
  expected: ExpectedPostingIdentity,
  leverMaxPages: number,
): Promise<ScanResult> {
  if (provider === "GREENHOUSE") {
    const fetched = await session.get(`${greenhouseBoardUrl(token)}/jobs`, BOARD_LISTING_MAX_BYTES);
    if (!fetched) return { kind: "BOARD_GONE" };
    const jobs = greenhouseJobs(parseListingJson(fetched, "Greenhouse job list"));
    const matches = matchingJobs(jobs, expected);
    if (matches.length > 1) return { kind: "AMBIGUOUS", count: matches.length, scanned: jobs.length };
    const match = matches[0];
    return match
      ? { kind: "MATCH", job: match, listing: fetched, scanned: jobs.length }
      : { kind: "NONE", scanned: jobs.length, complete: true };
  }
  if (provider === "ASHBY") {
    const fetched = listing ?? await session.get(ashbyBoardUrl(token), BOARD_LISTING_MAX_BYTES);
    if (!fetched) return { kind: "BOARD_GONE" };
    const jobs = ashbyJobs(parseListingJson(fetched, "Ashby board"));
    const matches = matchingJobs(jobs, expected);
    if (matches.length > 1) return { kind: "AMBIGUOUS", count: matches.length, scanned: jobs.length };
    const match = matches[0];
    return match
      ? { kind: "MATCH", job: match, listing: fetched, scanned: jobs.length }
      : { kind: "NONE", scanned: jobs.length, complete: true };
  }
  const found: Array<{ job: BoardJob; listing: Fetched }> = [];
  let scanned = 0;
  let page: Fetched | null = listing;
  for (let index = 0; index < leverMaxPages; index += 1) {
    if (index > 0 || !page) page = await session.get(leverPageUrl(token, index * LEVER_PAGE_SIZE), BOARD_LISTING_MAX_BYTES);
    if (!page) return index === 0 ? { kind: "BOARD_GONE" } : { kind: "NONE", scanned, complete: true };
    const jobs = leverJobs(parseListingJson(page, "Lever board"));
    scanned += jobs.length;
    const current = page;
    found.push(...matchingJobs(jobs, expected).map((job) => ({ job, listing: current })));
    if (found.length > 1) return { kind: "AMBIGUOUS", count: found.length, scanned };
    if (jobs.length < LEVER_PAGE_SIZE) {
      const only = found[0];
      return only ? { kind: "MATCH", job: only.job, listing: only.listing, scanned } : { kind: "NONE", scanned, complete: true };
    }
  }
  // The page budget ran out before the end of the board. A single match among the scanned
  // postings is accepted; with none, the board is reported as not matching (partially scanned).
  const only = found[0];
  return only ? { kind: "MATCH", job: only.job, listing: only.listing, scanned } : { kind: "NONE", scanned, complete: false };
}

function blocked(
  reason: "EMPLOYER_BOARD_NOT_FOUND" | "EMPLOYER_BOARD_NO_MATCH" | "EMPLOYER_BOARD_AMBIGUOUS",
  detail: string,
): JobContentResult {
  return { kind: "BLOCKED", reason, detail };
}

async function postingFromMatch(
  session: LookupSession,
  input: EmployerBoardFallbackInput,
  provider: EmployerBoardProvider,
  token: string,
  key: string,
  match: Extract<ScanResult, { kind: "MATCH" }>,
): Promise<JobContentResult> {
  // The LinkedIn id is the discovery identity, not the ATS requisition, so it is not checked
  // here. The parsers re-check the title; for the employer, Greenhouse names it (compared with
  // the suffix-free employer key), while Lever and Ashby name none, so their employer identity
  // is the board resolved for this employer and the parser is given that board token.
  const expected: ExpectedPostingIdentity = {
    title: input.expected.title,
    companyName: provider === "GREENHOUSE" ? key : token,
  };
  if (provider === "GREENHOUSE") {
    const detailUrl = `${greenhouseBoardUrl(token)}/jobs/${encodeURIComponent(match.job.id)}?content=true`;
    const fetched = await session.get(detailUrl);
    if (!fetched) return blocked("EMPLOYER_BOARD_NO_MATCH", `Greenhouse job ${match.job.id} disappeared between listing and detail.`);
    const payload = parseDetailJson(fetched, "Greenhouse job detail");
    const sourceUrl = new URL(text(match.job.record.absolute_url) ?? `https://job-boards.greenhouse.io/${token}/jobs/${match.job.id}`);
    return parseGreenhousePosting(payload, {
      key: "GREENHOUSE",
      boardToken: token,
      requisitionId: match.job.id,
      apiUrl: detailUrl,
    }, sourceUrl, expected, postingEvidence(input.requestedUrl, fetched.response, fetched.redirects, input.now));
  }
  const evidence = postingEvidence(input.requestedUrl, match.listing.response, match.listing.redirects, input.now);
  if (provider === "ASHBY") {
    const sourceUrl = new URL(text(match.job.record.jobUrl) ?? `https://jobs.ashbyhq.com/${token}/${match.job.id}`);
    return parseAshbyPosting({ jobs: [match.job.record] }, {
      key: "ASHBY",
      boardToken: token,
      requisitionId: match.job.id,
      apiUrl: ashbyBoardUrl(token),
    }, sourceUrl, expected, evidence);
  }
  const hosted = text(match.job.record.hostedUrl);
  const sourceUrl = new URL(hosted ?? `https://jobs.lever.co/${token}/${match.job.id}`);
  return parseLeverPosting(match.job.record, sourceUrl, expected, evidence);
}

function parseDetailJson(fetched: Fetched, what: string): unknown {
  try {
    return parseBoundedJson(fetched.response.body.toString("utf8"));
  } catch (error) {
    throw new LookupRetryable(`${what} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Builds the fallback used by fetchJobContent for LinkedIn URLs. Requests go through the
 * fetcher's own transport (SSRF checks, redirects, timeouts, per-host pacing, size limits).
 */
export function createEmployerBoardFallback(options: EmployerBoardLookupOptions): EmployerBoardFallback {
  const maxRequests = Math.max(1, options.maxRequests ?? DEFAULT_MAX_REQUESTS);
  const leverMaxPages = Math.max(1, options.leverMaxPages ?? DEFAULT_LEVER_MAX_PAGES);
  return async (input, dependencies) => {
    const companyName = input.expected.companyName.trim();
    const key = employerKey(companyName);
    if (!key || key === "unknown" || key === "unknown company" || !input.expected.title.trim()) {
      return blocked("EMPLOYER_BOARD_NOT_FOUND", "The discovery card has no usable employer name or title.");
    }
    const session = new LookupSession(dependencies, input.now, maxRequests);
    try {
      let outcome = await resolveBoard(session, options, companyName, key, input.now, false);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const { resolution } = outcome;
        if (resolution.status === "NOT_FOUND" || !resolution.provider || !resolution.boardToken) {
          return blocked("EMPLOYER_BOARD_NOT_FOUND",
            `No public Greenhouse, Lever or Ashby board found for this employer (tried ${resolution.candidatesTried.join(", ") || "none"}${outcome.cached ? `; cached until ${resolution.expiresAt}` : ""}).`);
        }
        const scan = await scanBoard(session, resolution.provider, resolution.boardToken, outcome.hit?.listing ?? null, input.expected, leverMaxPages);
        if (scan.kind === "BOARD_GONE") {
          // A cached board that no longer exists is resolved again once, ignoring the cache.
          if (!outcome.cached) throw new LookupRetryable("Employer board disappeared during the lookup.");
          outcome = await resolveBoard(session, options, companyName, key, input.now, true);
          continue;
        }
        const where = `${resolution.provider} board ${resolution.boardToken}`;
        if (scan.kind === "AMBIGUOUS") {
          return blocked("EMPLOYER_BOARD_AMBIGUOUS", `${scan.count} postings on ${where} match the title and location.`);
        }
        if (scan.kind === "NONE") {
          return blocked("EMPLOYER_BOARD_NO_MATCH",
            `No posting on ${where} matches the title and location (${scan.scanned} postings scanned${scan.complete ? "" : ", board only partially scanned"}).`);
        }
        const result = await postingFromMatch(session, input, resolution.provider, resolution.boardToken, key, scan);
        if (result.kind !== "COMPLETE") {
          return result.kind === "BLOCKED" && !result.detail
            ? { ...result, detail: `Matched posting ${scan.job.id} on ${where} was not a complete posting.` }
            : result;
        }
        const provenance: EmployerBoardLookupProvenance = {
          linkedInJobId: input.linkedInJobId,
          provider: resolution.provider,
          boardToken: resolution.boardToken,
          employerKey: key,
          resolutionMethod: resolution.resolutionMethod === "CONFIG" ? "CONFIG" : "DERIVED_SLUG",
          resolutionCached: outcome.cached,
        };
        // Lever and Ashby name no employer, so their parsers fall back to the board token; the
        // board was resolved from the discovery card's employer name, which is kept instead.
        const posting = result.posting.companyName === resolution.boardToken
          ? { ...result.posting, companyName }
          : result.posting;
        const complete = posting === result.posting
          ? result
          : makeCompleteResult(posting, result.provider, result.evidence);
        if (complete.kind !== "COMPLETE") return complete;
        return { ...complete, employerBoardLookup: provenance };
      }
      throw new LookupRetryable("Employer board resolution did not settle.");
    } catch (error) {
      if (error instanceof LookupUnsafe) return { kind: "BLOCKED", reason: "UNSAFE_REDIRECT", detail: error.message };
      if (error instanceof LookupRetryable) {
        return { kind: "RETRYABLE_FAILURE", reason: error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) };
      }
      throw error;
    }
  };
}

/**
 * Production wiring for the stage worker. Disabled with EMPLOYER_BOARD_LOOKUP_ENABLED=false.
 * Known boards are read once per process from config/companies.yml.
 */
let knownBoardsMemo: KnownEmployerBoard[] | null = null;
export function employerBoardFallbackFromEnv(
  env: NodeJS.ProcessEnv,
  executor: QueryExecutor,
): EmployerBoardFallback | undefined {
  if ((env.EMPLOYER_BOARD_LOOKUP_ENABLED ?? "true").trim().toLowerCase() === "false") return undefined;
  knownBoardsMemo ??= loadKnownEmployerBoards();
  return createEmployerBoardFallback({
    cache: new PgEmployerBoardResolutionCache(executor),
    knownBoards: knownBoardsMemo,
  });
}
