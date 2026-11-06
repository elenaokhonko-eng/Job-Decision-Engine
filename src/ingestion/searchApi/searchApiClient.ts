/**
 * SearchAPI (searchapi.io) client for the LinkedIn Jobs and LinkedIn Job Details engines.
 *
 * Every request reserves one credit in the Postgres ledger first (migration 094). When the
 * daily cap is spent the client returns BUDGET_EXHAUSTED and sends nothing. The API key is
 * sent only as a bearer header, never in a URL, ledger row, log line, or stored payload.
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { readResponseTextBounded } from "../../security/boundedResponse.js";

export const SEARCHAPI_ENDPOINT = "https://www.searchapi.io/api/v1/search";
export const DEFAULT_SEARCHAPI_DAILY_CREDIT_CAP = 60;
const MAX_SEARCHAPI_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_SEARCHAPI_TIMEOUT_MS = 30_000;

export type SearchApiEngine = "linkedin_jobs" | "linkedin_job_details";
export type SearchApiPurpose = "DISCOVERY" | "CONTENT_FETCH";
export type LinkedInTimePeriod = "last_hour" | "last_day" | "last_week" | "last_month";

const LinkedInJobIdSchema = z.union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => /^\d{5,20}$/.test(value), "LinkedIn job_id must be numeric.");

const LinkedInJobSummarySchema = z.object({
  job_id: LinkedInJobIdSchema,
  title: z.string().min(1),
  company_name: z.string().min(1),
  location: z.string().optional(),
  link: z.string().optional(),
  posted_at: z.string().optional(),
  date: z.string().optional(),
}).passthrough();

const LinkedInJobsPageSchema = z.object({
  search_information: z.object({ total_results: z.number().optional() }).passthrough().optional(),
  jobs: z.array(LinkedInJobSummarySchema).max(100).optional(),
}).passthrough().superRefine((page, context) => {
  // A missing jobs array is only accepted when the provider states there are no results;
  // otherwise schema drift would look like an empty search.
  if (page.jobs === undefined && page.search_information?.total_results !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["jobs"], message: "Response has no jobs array and does not report zero results." });
  }
});

const LinkedInJobDetailSchema = z.object({
  job_id: LinkedInJobIdSchema,
  title: z.string().min(1),
  company_name: z.string().min(1),
  description: z.string().min(1),
  link: z.string().optional(),
  location: z.string().optional(),
  posted_at: z.string().optional(),
  salary: z.string().optional(),
  employment_type: z.string().optional(),
  seniority_level: z.string().optional(),
  industries: z.string().optional(),
  is_easy_apply: z.boolean().optional(),
}).passthrough();

const LinkedInJobDetailsResponseSchema = z.object({ job: LinkedInJobDetailSchema }).passthrough();

export type LinkedInJobSummary = z.infer<typeof LinkedInJobSummarySchema>;
export type LinkedInJobDetail = z.infer<typeof LinkedInJobDetailSchema>;

export interface SearchApiResponseEvidence {
  /** Request URL without credentials. */
  readonly requestUrl: string;
  readonly httpStatus: number;
  readonly retrievedAt: string;
  readonly responseHash: string;
  readonly ledgerRequestId: string;
}

export type SearchApiCallResult<T> =
  | { readonly kind: "OK"; readonly data: T; readonly raw: unknown; readonly evidence: SearchApiResponseEvidence }
  | { readonly kind: "BUDGET_EXHAUSTED"; readonly reason: string }
  | {
      readonly kind: "FAILED";
      readonly httpStatus: number | null;
      /** False only when the provider says the requested job does not exist. */
      readonly retryable: boolean;
      readonly reason: string;
    };

export interface SearchApiCreditReservation {
  readonly engine: SearchApiEngine;
  readonly purpose: SearchApiPurpose;
  readonly requestKey: string;
  readonly dailyCreditCap: number;
}

export interface SearchApiCreditLedger {
  /** Returns a ledger request id, or null when the daily cap is already spent. */
  reserve(input: SearchApiCreditReservation): Promise<string | null>;
  complete(requestId: string, outcome: { httpStatus: number | null; succeeded: boolean; errorDetail?: string }): Promise<void>;
}

type QueryExecutor = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export class PgSearchApiCreditLedger implements SearchApiCreditLedger {
  constructor(private readonly executor: QueryExecutor) {}

  async reserve(input: SearchApiCreditReservation): Promise<string | null> {
    if (!Number.isInteger(input.dailyCreditCap) || input.dailyCreditCap < 1) return null;
    // The conditional upsert takes the day row lock, so concurrent reservations serialize and
    // the counter can never pass the cap.
    const { rows } = await this.executor.query<{ id: string }>(
      `WITH consumed AS (
         INSERT INTO searchapi_credit_days (usage_day, credits_used)
         VALUES ((NOW() AT TIME ZONE 'UTC')::date, 1)
         ON CONFLICT (usage_day) DO UPDATE
           SET credits_used = searchapi_credit_days.credits_used + 1, updated_at = NOW()
           WHERE searchapi_credit_days.credits_used < $1
         RETURNING usage_day
       )
       INSERT INTO searchapi_requests (usage_day, engine, purpose, request_key)
       SELECT usage_day, $2, $3, $4 FROM consumed
       RETURNING id::text AS id`,
      [input.dailyCreditCap, input.engine, input.purpose, input.requestKey.slice(0, 800)],
    );
    return rows[0]?.id ?? null;
  }

  async complete(requestId: string, outcome: { httpStatus: number | null; succeeded: boolean; errorDetail?: string }): Promise<void> {
    await this.executor.query(
      `UPDATE searchapi_requests
       SET completed_at = NOW(), http_status = $2, outcome = $3, error_detail = $4
       WHERE id = $1::uuid AND completed_at IS NULL`,
      [requestId, outcome.httpStatus, outcome.succeeded ? "SUCCEEDED" : "FAILED", outcome.errorDetail?.slice(0, 1000) ?? null],
    );
  }
}

export interface SearchApiClientOptions {
  readonly apiKey: string;
  readonly ledger: SearchApiCreditLedger;
  readonly dailyCreditCap: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export interface LinkedInJobsSearchParams {
  readonly q: string;
  readonly location: string;
  readonly timePeriod: LinkedInTimePeriod;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function providerErrorMessage(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const error = (payload as Record<string, unknown>).error;
  return typeof error === "string" && error.trim() ? error.trim().slice(0, 300) : null;
}

function redact(value: string, secret: string): string {
  return secret ? value.split(secret).join("[redacted]") : value;
}

export function parseSearchApiDailyCreditCap(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_SEARCHAPI_DAILY_CREDIT_CAP;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error("SEARCHAPI_DAILY_CREDIT_CAP must be an integer between 1 and 10000.");
  }
  return parsed;
}

export class SearchApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: SearchApiClientOptions) {
    if (!options.apiKey.trim()) throw new Error("SearchAPI key is required.");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SEARCHAPI_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  searchLinkedInJobs(params: LinkedInJobsSearchParams, purpose: SearchApiPurpose): Promise<SearchApiCallResult<{ jobs: LinkedInJobSummary[] }>> {
    return this.call(
      "linkedin_jobs",
      purpose,
      { q: params.q, location: params.location, time_period: params.timePeriod },
      `${params.timePeriod}|${params.location}|${params.q}`,
      (raw) => {
        const parsed = LinkedInJobsPageSchema.safeParse(raw);
        return parsed.success ? { ok: true, data: { jobs: parsed.data.jobs ?? [] } } : { ok: false, issues: parsed.error.issues };
      },
    );
  }

  linkedInJobDetails(jobId: string, purpose: SearchApiPurpose): Promise<SearchApiCallResult<LinkedInJobDetail>> {
    return this.call(
      "linkedin_job_details",
      purpose,
      { job_id: jobId },
      jobId,
      (raw) => {
        const parsed = LinkedInJobDetailsResponseSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, issues: parsed.error.issues };
        if (parsed.data.job.job_id !== jobId) {
          return { ok: false, issues: [{ path: ["job", "job_id"], message: "Returned job_id does not match the requested job." }] };
        }
        return { ok: true, data: parsed.data.job };
      },
    );
  }

  private async call<T>(
    engine: SearchApiEngine,
    purpose: SearchApiPurpose,
    params: Record<string, string>,
    requestKey: string,
    parse: (raw: unknown) => { ok: true; data: T } | { ok: false; issues: readonly { path: readonly PropertyKey[]; message: string }[] },
  ): Promise<SearchApiCallResult<T>> {
    const ledgerRequestId = await this.options.ledger.reserve({
      engine,
      purpose,
      requestKey: `${engine}:${requestKey}`,
      dailyCreditCap: this.options.dailyCreditCap,
    });
    if (!ledgerRequestId) {
      return { kind: "BUDGET_EXHAUSTED", reason: `SearchAPI daily credit cap of ${this.options.dailyCreditCap} is spent.` };
    }

    const url = new URL(SEARCHAPI_ENDPOINT);
    url.searchParams.set("engine", engine);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let httpStatus: number | null = null;
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, Accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      httpStatus = response.status;
      const text = await readResponseTextBounded(response, MAX_SEARCHAPI_RESPONSE_BYTES, "SearchAPI response");
      let raw: unknown = null;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null;
      }
      if (!response.ok) {
        const detail = providerErrorMessage(raw) ?? `HTTP ${response.status}`;
        const reason = redact(`SearchAPI ${engine} returned HTTP ${response.status}: ${detail}`, this.options.apiKey);
        await this.options.ledger.complete(ledgerRequestId, { httpStatus, succeeded: false, errorDetail: reason });
        const notFound = engine === "linkedin_job_details" && (response.status === 404 || response.status === 410);
        return { kind: "FAILED", httpStatus, retryable: !notFound, reason };
      }
      const providerError = providerErrorMessage(raw);
      const parsed = raw === null
        ? { ok: false as const, issues: [{ path: [], message: "Response is not JSON." }] }
        : providerError
          ? { ok: false as const, issues: [{ path: ["error"], message: providerError }] }
          : parse(raw);
      if (!parsed.ok) {
        const reason = redact(
          `SearchAPI ${engine} response failed validation: ${parsed.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`.slice(0, 1000),
          this.options.apiKey,
        );
        await this.options.ledger.complete(ledgerRequestId, { httpStatus, succeeded: false, errorDetail: reason });
        return { kind: "FAILED", httpStatus, retryable: true, reason };
      }
      await this.options.ledger.complete(ledgerRequestId, { httpStatus, succeeded: true });
      return {
        kind: "OK",
        data: parsed.data,
        raw,
        evidence: {
          requestUrl: url.toString(),
          httpStatus: response.status,
          retrievedAt: this.now().toISOString(),
          responseHash: sha256(text),
          ledgerRequestId,
        },
      };
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? `SearchAPI ${engine} timed out after ${this.timeoutMs}ms.`
        : `SearchAPI ${engine} request failed: ${error instanceof Error ? error.message : String(error)}`;
      const reason = redact(message, this.options.apiKey);
      await this.options.ledger.complete(ledgerRequestId, { httpStatus, succeeded: false, errorDetail: reason });
      return { kind: "FAILED", httpStatus, retryable: true, reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * LinkedIn job-details lookup for content fetches, or undefined when SearchAPI is not enabled
 * (SEARCHAPI_LINKEDIN_ENABLED=true and SEARCHAPI_API_KEY set). Callers then keep the generic
 * fetch path, which reports LinkedIn as sign-in blocked.
 */
export function searchApiLinkedInDetailsFromEnv(
  env: NodeJS.ProcessEnv,
  executor: QueryExecutor,
): ((jobId: string) => Promise<SearchApiCallResult<LinkedInJobDetail>>) | undefined {
  if ((env.SEARCHAPI_LINKEDIN_ENABLED ?? "").trim().toLowerCase() !== "true") return undefined;
  const apiKey = (env.SEARCHAPI_API_KEY ?? "").trim();
  if (!apiKey) return undefined;
  const client = new SearchApiClient({
    apiKey,
    ledger: new PgSearchApiCreditLedger(executor),
    dailyCreditCap: parseSearchApiDailyCreditCap(env.SEARCHAPI_DAILY_CREDIT_CAP),
  });
  return (jobId) => client.linkedInJobDetails(jobId, "CONTENT_FETCH");
}

/** Canonical public LinkedIn posting URL for a numeric job id. */
export function linkedInJobUrl(jobId: string): string {
  return `https://www.linkedin.com/jobs/view/${jobId}`;
}

/** Numeric LinkedIn job id from a LinkedIn posting URL, or null. */
export function linkedInJobIdFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) return null;
    const pathId = url.pathname.match(/\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d{5,20})(?:\/|$)/i)?.[1];
    if (pathId) return pathId;
    const queryId = url.searchParams.get("currentJobId");
    return queryId && /^\d{5,20}$/.test(queryId) ? queryId : null;
  } catch {
    return null;
  }
}
