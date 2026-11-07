/**
 * Workday career-site adapter (CXS JSON endpoints).
 *
 * Every Workday-hosted career site is served by two unauthenticated JSON endpoints:
 *   POST https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs      (search)
 *   GET  https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{externalPath} (detail)
 * The endpoints are public but undocumented, and sit behind bot management, so this adapter:
 *   - issues one request at a time with a polite delay between requests;
 *   - searches with the source plan's role terms instead of enumerating every job;
 *   - restricts results to Singapore with the tenant's own location facet (or the
 *     location text when the tenant exposes no Singapore facet);
 *   - bounds search terms, pages and detail calls per run and resumes through a cursor;
 *   - treats 403/429, redirects and HTML bot pages as retryable source failures, never
 *     as an empty success.
 */
import { BaseSourceAdapter, type AdapterFetchOptions, type AdapterResult } from "./baseAdapter.js";
import { ExtractedJob, SCHEMA_VERSION } from "../../contracts/index.js";
import { normalizeWorkMode } from "../../pipeline/workModeNormalizer.js";
import { stripHtmlToText } from "../../security/sanitize.js";

/** Workday returns zero rows when `limit` exceeds 20. */
export const WORKDAY_MAX_PAGE_SIZE = 20;
export const WORKDAY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const WORKDAY_HOST_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}\.wd\d{1,3}\.myworkdayjobs\.com$/;
export const WORKDAY_TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const WORKDAY_SITE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EXTERNAL_PATH_PATTERN = /^\/job\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]{1,400}$/;
const CURSOR_PATTERN = /^wd:v1:(\d{1,4}):(\d{1,4})$/;
const SINGAPORE_PATTERN = /\bsingapore\b/i;
const MULTI_LOCATION_PATTERN = /^\s*\d+\s+locations?\s*$/i;

export interface WorkdayTenantConfig {
  readonly companyName: string;
  readonly host: string;
  readonly tenant: string;
  readonly site: string;
}

export interface WorkdayRunLimits {
  /** Search terms processed per run; remaining terms resume from the cursor next run. */
  readonly searchTermsPerRun: number;
  /** Search pages (of at most 20 rows) read per term. */
  readonly maxPagesPerTerm: number;
  /** Minimum delay between two requests to the tenant. */
  readonly requestDelayMs: number;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export const DEFAULT_WORKDAY_RUN_LIMITS: WorkdayRunLimits = {
  searchTermsPerRun: 2,
  maxPagesPerTerm: 2,
  requestDelayMs: 1_100,
  timeoutMs: 15_000,
  maxResponseBytes: WORKDAY_MAX_RESPONSE_BYTES,
};

/** Shared wall-clock budget so many tenants cannot exhaust the adapter step's timeout. */
export interface WorkdayRunBudget {
  exhausted(): boolean;
}

export function workdayDeadlineBudget(budgetMs: number, now: () => number = Date.now): WorkdayRunBudget {
  const deadline = now() + budgetMs;
  return { exhausted: () => now() >= deadline };
}

export interface WorkdayLocationFacet {
  readonly parameter: string;
  readonly valueIds: readonly string[];
  readonly descriptors: readonly string[];
}

export interface WorkdayRunStats {
  facet: WorkdayLocationFacet | null;
  searchRequests: number;
  detailRequests: number;
  termsCompleted: number;
  truncatedTerms: string[];
  hitsSeen: number;
  notSingapore: number;
  detailsGone: number;
  stoppedForBudget: boolean;
}

interface WorkdayHit {
  readonly externalPath: string;
  readonly raw: Record<string, unknown>;
  readonly ambiguousLocation: boolean;
}

/** A failure of the source itself: never converted into an empty result or a rejection. */
export class WorkdaySourceError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly rateLimited: boolean) {
    super(message);
    this.name = "WorkdaySourceError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  // Workday's public CXS JSON is narrowed at the external API boundary.
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Converts Workday's job description HTML into plain text with paragraph breaks preserved. */
export function workdayHtmlToText(html: unknown): string {
  return stripHtmlToText(html)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}

/** Lower-cased, de-duplicated, sorted search terms so the cursor's term index stays stable. */
export function workdaySearchTerms(terms: readonly string[]): string[] {
  return [...new Set(terms.map((term) => term.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean))].sort();
}

/**
 * Picks the tenant's Singapore location facet. A country-level facet whose value is exactly
 * "Singapore" is preferred; otherwise every Singapore value of the location facet with the
 * most matching postings is used. Returns null when the tenant exposes no Singapore facet.
 */
export function selectSingaporeFacet(facets: unknown): WorkdayLocationFacet | null {
  const byParameter = new Map<string, { ids: string[]; descriptors: string[]; count: number; exactCountry: boolean }>();
  const visit = (nodes: unknown, inheritedParameter: string | null): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const facet = asRecord(node);
      if (!facet) continue;
      const parameter = text(facet.facetParameter) ?? inheritedParameter;
      if (!Array.isArray(facet.values) || !parameter) continue;
      for (const valueNode of facet.values) {
        const value = asRecord(valueNode);
        if (!value) continue;
        if (Array.isArray(value.values)) {
          visit([value], parameter);
          continue;
        }
        const descriptor = text(value.descriptor);
        const id = text(value.id);
        if (!descriptor || !id || !SINGAPORE_PATTERN.test(descriptor)) continue;
        if (!/locat|country|territor|jurisdiction|region|hierarchy/i.test(parameter)) continue;
        const entry = byParameter.get(parameter) ?? { ids: [], descriptors: [], count: 0, exactCountry: false };
        if (!entry.ids.includes(id)) {
          entry.ids.push(id);
          entry.descriptors.push(descriptor);
          entry.count += typeof value.count === "number" && Number.isFinite(value.count) ? value.count : 0;
        }
        if (/country|territor|jurisdiction/i.test(parameter) && /^singapore$/i.test(descriptor)) entry.exactCountry = true;
        byParameter.set(parameter, entry);
      }
    }
  };
  visit(facets, null);
  const ranked = [...byParameter.entries()].sort(([leftKey, left], [rightKey, right]) =>
    Number(right.exactCountry) - Number(left.exactCountry) || right.count - left.count || leftKey.localeCompare(rightKey));
  const best = ranked[0];
  if (!best) return null;
  const [parameter, entry] = best;
  if (entry.exactCountry) {
    const index = entry.descriptors.findIndex((descriptor) => /^singapore$/i.test(descriptor));
    return { parameter, valueIds: [entry.ids[index]], descriptors: [entry.descriptors[index]] };
  }
  return { parameter, valueIds: entry.ids, descriptors: entry.descriptors };
}

/** Cursor = the next search term and how many of its hits (in Workday's relevance order) are done. */
function parseCursor(cursor: string | null | undefined, termCount: number): { termIndex: number; position: number } {
  const match = cursor ? CURSOR_PATTERN.exec(cursor) : null;
  if (!match) return { termIndex: 0, position: 0 };
  const termIndex = Number(match[1]);
  if (termIndex >= termCount) return { termIndex: 0, position: 0 };
  return { termIndex, position: Number(match[2]) };
}

function formatCursor(termIndex: number, position: number): string {
  return `wd:v1:${termIndex}:${position}`;
}

function employmentType(timeType: string | null): string {
  if (!timeType) return "UNKNOWN";
  if (/full[\s_-]*time/i.test(timeType)) return "FULL_TIME";
  if (/part[\s_-]*time/i.test(timeType)) return "PART_TIME";
  return timeType;
}

function publishedAt(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  const parsed = new Date(raw);
  return /^\d{4}-\d{2}-\d{2}T/.test(raw) && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export class WorkdayAdapter extends BaseSourceAdapter {
  sourceName = "WORKDAY" as const;
  lastRunStats: WorkdayRunStats | null = null;
  private readonly config: WorkdayTenantConfig;
  private readonly terms: string[];
  private readonly limits: WorkdayRunLimits;
  private readonly budget: WorkdayRunBudget | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestAt: number | null = null;

  constructor(input: {
    readonly config: WorkdayTenantConfig;
    readonly searchTerms: readonly string[];
    readonly limits?: Partial<WorkdayRunLimits>;
    readonly budget?: WorkdayRunBudget | null;
    readonly sleep?: (ms: number) => Promise<void>;
  }) {
    super();
    const { host, tenant, site, companyName } = input.config;
    if (!WORKDAY_HOST_PATTERN.test(host)) throw new Error(`Invalid Workday host: ${host}`);
    if (!host.startsWith(`${tenant.toLowerCase()}.`)) throw new Error(`Workday host ${host} does not belong to tenant ${tenant}.`);
    if (!WORKDAY_TENANT_PATTERN.test(tenant)) throw new Error(`Invalid Workday tenant: ${tenant}`);
    if (!WORKDAY_SITE_PATTERN.test(site)) throw new Error(`Invalid Workday site: ${site}`);
    if (!companyName.trim()) throw new Error("Workday tenant needs a company name.");
    this.config = input.config;
    this.terms = workdaySearchTerms(input.searchTerms);
    if (this.terms.length === 0) throw new Error(`Workday tenant ${tenant} has no search terms.`);
    const limits = { ...DEFAULT_WORKDAY_RUN_LIMITS, ...input.limits };
    if (limits.searchTermsPerRun < 1 || limits.maxPagesPerTerm < 1 || limits.requestDelayMs < 0) {
      throw new Error("Workday run limits must be positive.");
    }
    this.limits = limits;
    this.timeoutMs = limits.timeoutMs;
    this.budget = input.budget ?? null;
    this.sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get apiBase(): string {
    return `https://${this.config.host}/wday/cxs/${this.config.tenant}/${this.config.site}`;
  }

  private async pace(): Promise<void> {
    if (this.lastRequestAt !== null) {
      const wait = this.lastRequestAt + this.limits.requestDelayMs - Date.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastRequestAt = Date.now();
  }

  /** Issues one request (GET or JSON POST) to the configured tenant host and returns parsed JSON. */
  private async requestJson(url: string, label: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== this.config.host || parsed.username || parsed.password) {
      throw new WorkdaySourceError(`Refusing ${label} request outside the configured Workday host.`, false, false);
    }
    await this.pace();
    let response: Response;
    try {
      response = await this.fetchWithTimeout(parsed.toString(), {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          Accept: "application/json",
          "Accept-Language": "en-US",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new WorkdaySourceError(
        timedOut ? `Workday ${label} timed out after ${this.timeoutMs}ms.` : `Workday ${label} network error: ${error instanceof Error ? error.message : String(error)}`,
        true,
        false,
      );
    }
    const status = response.status;
    if (status === 403 || status === 429) {
      await response.body?.cancel();
      throw new WorkdaySourceError(`Workday ${label} blocked or rate limited (HTTP ${status}).`, true, true);
    }
    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      throw new WorkdaySourceError(`Workday ${label} redirected (HTTP ${status}); treated as a bot challenge.`, true, true);
    }
    if (status === 404 || status === 410) {
      await response.body?.cancel();
      return { status, json: null };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkdaySourceError(`Workday ${label} failed with HTTP ${status}.`, status >= 500, false);
    }
    const contentType = response.headers.get("content-type") ?? "";
    const bodyText = await this.readResponseText(response, this.limits.maxResponseBytes);
    if (!/json/i.test(contentType) || /^\s*</.test(bodyText)) {
      throw new WorkdaySourceError(`Workday ${label} returned a non-JSON page (likely a bot challenge).`, true, true);
    }
    try {
      return { status, json: JSON.parse(bodyText) as unknown };
    } catch {
      throw new WorkdaySourceError(`Workday ${label} returned malformed JSON.`, false, false);
    }
  }

  private async search(searchText: string, offset: number, limit: number, facet: WorkdayLocationFacet | null): Promise<{ total: number; postings: unknown[]; facets: unknown }> {
    const appliedFacets = facet ? { [facet.parameter]: [...facet.valueIds] } : {};
    const pageSize = Math.min(WORKDAY_MAX_PAGE_SIZE, Math.max(1, limit));
    const { status, json } = await this.requestJson(`${this.apiBase}/jobs`, "search", { appliedFacets, limit: pageSize, offset, searchText });
    if (status === 404 || status === 410) {
      throw new WorkdaySourceError(`Workday search endpoint not found (HTTP ${status}); the tenant or site may have moved.`, false, false);
    }
    const data = asRecord(json);
    if (!data || !Array.isArray(data.jobPostings)) {
      throw new WorkdaySourceError("Workday search response has no jobPostings array.", false, false);
    }
    this.assertRecordCount(data.jobPostings, WORKDAY_MAX_PAGE_SIZE);
    const total = typeof data.total === "number" && Number.isFinite(data.total) ? data.total : 0;
    return { total, postings: data.jobPostings, facets: data.facets };
  }

  /** Reads up to maxPagesPerTerm pages for one term; Workday reports `total` reliably only on the first page. */
  private async searchTerm(term: string, facet: WorkdayLocationFacet | null, stats: WorkdayRunStats): Promise<WorkdayHit[]> {
    const hits = new Map<string, WorkdayHit>();
    let total = 0;
    for (let page = 0; page < this.limits.maxPagesPerTerm; page += 1) {
      const offset = page * WORKDAY_MAX_PAGE_SIZE;
      const result = await this.search(term, offset, WORKDAY_MAX_PAGE_SIZE, facet);
      stats.searchRequests += 1;
      if (page === 0) total = result.total;
      for (const posting of result.postings) {
        const record = asRecord(posting);
        const externalPath = text(record?.externalPath);
        if (!record || !externalPath || !EXTERNAL_PATH_PATTERN.test(externalPath) || externalPath.includes("..")) {
          throw new WorkdaySourceError("Workday search returned a posting without a valid externalPath.", false, false);
        }
        stats.hitsSeen += 1;
        const locationsText = text(record.locationsText) ?? "";
        if (!facet && !SINGAPORE_PATTERN.test(locationsText) && !MULTI_LOCATION_PATTERN.test(locationsText)) {
          stats.notSingapore += 1;
          continue;
        }
        hits.set(externalPath, {
          externalPath,
          raw: record,
          ambiguousLocation: !facet && !SINGAPORE_PATTERN.test(locationsText),
        });
      }
      const exhausted = result.postings.length < WORKDAY_MAX_PAGE_SIZE || offset + WORKDAY_MAX_PAGE_SIZE >= total;
      if (exhausted) return [...hits.values()];
    }
    stats.truncatedTerms.push(term);
    return [...hits.values()];
  }

  private async detail(hit: WorkdayHit): Promise<Record<string, unknown> | null> {
    const { status, json } = await this.requestJson(`${this.apiBase}${hit.externalPath}`, "detail");
    if (status === 404 || status === 410) return null;
    const data = asRecord(json);
    if (!data || !asRecord(data.jobPostingInfo)) {
      throw new WorkdaySourceError("Workday detail response has no jobPostingInfo.", false, false);
    }
    return data;
  }

  /** Maps a detail payload; returns the validated job, or null when it was quarantined. */
  private mapDetail(hit: WorkdayHit, detail: Record<string, unknown>): ExtractedJob | null {
    const info = asRecord(detail.jobPostingInfo) ?? {};
    const organization = asRecord(detail.hiringOrganization);
    const title = text(info.title) ?? text(hit.raw.title);
    const locations = [text(info.location), ...(Array.isArray(info.additionalLocations) ? info.additionalLocations.map(text) : [])]
      .filter((value): value is string => Boolean(value));
    const fallbackUrl = `https://${this.config.host}/${this.config.site}${hit.externalPath}`;
    const externalUrl = text(info.externalUrl);
    let postingUrl = fallbackUrl;
    let identityError: string | null = null;
    if (externalUrl) {
      try {
        const parsed = new URL(externalUrl);
        if (parsed.protocol === "https:" && parsed.hostname === this.config.host && parsed.pathname.endsWith(hit.externalPath)) {
          postingUrl = parsed.toString();
        } else {
          identityError = "jobPostingInfo.externalUrl does not match the searched posting.";
        }
      } catch {
        identityError = "jobPostingInfo.externalUrl is not a URL.";
      }
    }
    const description = workdayHtmlToText(info.jobDescription);
    const remoteType = text(info.remoteType);
    const sourceRef = `${this.config.tenant}${hit.externalPath}`;
    const candidate = {
      schema_version: SCHEMA_VERSION,
      source_external_id: `workday:${this.config.tenant}:${this.config.site}${hit.externalPath}`,
      company_name: this.config.companyName,
      title: title ?? "",
      location_raw: locations.length > 0 ? [...new Set(locations)].join("; ") : text(hit.raw.locationsText) ?? "Unknown",
      workplace_type_raw: remoteType ? normalizeWorkMode(remoteType) : "UNKNOWN",
      employment_type_raw: employmentType(text(info.timeType)),
      compensation_raw: "UNKNOWN",
      employer_posting_url: postingUrl,
      application_url: postingUrl,
      canonical_apply_url: postingUrl,
      description_raw: description,
      ...(publishedAt(info.startDate) ? { published_at: publishedAt(info.startDate) } : {}),
      source_attribution: `${this.config.companyName} careers (Workday)`,
      raw_payload: {
        workday: { host: this.config.host, tenant: this.config.tenant, site: this.config.site, external_path: hit.externalPath },
        job_req_id: text(info.jobReqId),
        hiring_organization: text(organization?.name),
        search_hit: hit.raw,
        detail,
      },
    };
    if (identityError) {
      // Job-identity validation failure: quarantine with the raw payload rather than staging it.
      return this.quarantineCandidate(candidate, sourceRef, identityError);
    }
    return this.validateJob(candidate, sourceRef);
  }

  async fetchJobs(options: AdapterFetchOptions = {}): Promise<AdapterResult> {
    this.beginFetch();
    const detailLimit = Math.min(200, Math.max(1, options.limit ?? 8));
    const stats: WorkdayRunStats = {
      facet: null,
      searchRequests: 0,
      detailRequests: 0,
      termsCompleted: 0,
      truncatedTerms: [],
      hitsSeen: 0,
      notSingapore: 0,
      detailsGone: 0,
      stoppedForBudget: false,
    };
    this.lastRunStats = stats;
    const jobs: ExtractedJob[] = [];
    let quarantined = 0;
    let totalFetched = 0;
    const start = parseCursor(options.cursor, this.terms.length);
    let termIndex = start.termIndex;
    let position = start.position;
    const seen = new Set<string>();

    try {
      // One small request discovers the tenant's Singapore location facet.
      const discovery = await this.search("", 0, 1, null);
      stats.searchRequests += 1;
      const facet = selectSingaporeFacet(discovery.facets);
      stats.facet = facet;

      let termsThisRun = 0;
      let stop = false;
      while (!stop && termIndex < this.terms.length && termsThisRun < this.limits.searchTermsPerRun) {
        if (this.budget?.exhausted()) {
          stats.stoppedForBudget = true;
          break;
        }
        const term = this.terms[termIndex];
        // Hits stay in Workday's relevance order; `position` resumes a term part-way through.
        const hits = await this.searchTerm(term, facet, stats);
        termsThisRun += 1;
        for (const hit of hits.slice(position)) {
          if (seen.has(hit.externalPath)) {
            position += 1;
            continue;
          }
          // Detail calls (including withdrawn or non-Singapore postings) are what the limit bounds.
          if (stats.detailRequests >= detailLimit || this.budget?.exhausted()) {
            stats.stoppedForBudget = this.budget?.exhausted() ?? false;
            stop = true;
            break;
          }
          seen.add(hit.externalPath);
          const detail = await this.detail(hit);
          stats.detailRequests += 1;
          position += 1;
          if (!detail) {
            stats.detailsGone += 1;
            continue;
          }
          if (hit.ambiguousLocation) {
            const info = asRecord(detail.jobPostingInfo) ?? {};
            const locationText = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])].map(String).join(" ");
            if (!SINGAPORE_PATTERN.test(locationText)) {
              stats.notSingapore += 1;
              continue;
            }
          }
          totalFetched += 1;
          const job = this.mapDetail(hit, detail);
          if (job) jobs.push(job);
          else quarantined += 1;
        }
        if (!stop) {
          stats.termsCompleted += 1;
          termIndex += 1;
          position = 0;
        }
      }
    } catch (error) {
      const sourceError = error instanceof WorkdaySourceError ? error : null;
      const detail = error instanceof Error ? error.message : String(error);
      // Postings fetched before the failure are still returned so they are staged, but the
      // run is a failure and the checkpoint does not advance.
      return {
        sourceName: this.sourceName,
        success: false,
        jobs,
        totalFetched,
        error: `${this.config.tenant}: ${detail}`,
        isRateLimited: sourceError?.rateLimited ?? false,
        quarantined,
        quarantinedCandidates: this.getQuarantinedCandidates(),
        nextCursor: options.cursor ?? null,
        hasMore: true,
      };
    }

    const cycleComplete = termIndex >= this.terms.length;
    const nextCursor = cycleComplete ? null : formatCursor(termIndex, position);
    return {
      sourceName: this.sourceName,
      success: true,
      jobs,
      totalFetched,
      quarantined,
      quarantinedCandidates: this.getQuarantinedCandidates(),
      nextCursor,
      hasMore: !cycleComplete,
    };
  }
}
