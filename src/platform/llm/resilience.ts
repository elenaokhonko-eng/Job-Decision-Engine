/**
 * Rate-limit resilience for model calls: typed failures, server-suggested retry delays,
 * truncated exponential backoff with full jitter, per-call deadlines, a process-wide per-model
 * limiter (requests/min, tokens/min, concurrency) and per-run call statistics.
 *
 * None of this records or logs prompt text; only provider, model, counts and timings.
 */

export type ModelFailureKind =
  | "RATE_LIMITED"
  | "DAILY_QUOTA"
  | "TIMEOUT"
  | "SERVER_ERROR"
  | "DEADLINE"
  | "OTHER";

export interface ModelRateLimitedDetails {
  provider: string;
  model: string | null;
  /** The delay the provider suggested (RetryInfo/Retry-After) or our backoff, when known. */
  retryAfterMs: number | null;
  attempts: number;
}

/** A model call that failed only because of rate limiting (HTTP 429 / RESOURCE_EXHAUSTED). */
export class ModelRateLimitedError extends Error {
  readonly rateLimited = true;
  constructor(message: string, readonly details: ModelRateLimitedDetails) {
    super(message);
    this.name = "ModelRateLimitedError";
  }
}

export interface ModelCallDeadlineDetails {
  model: string | null;
  deadlineMs: number;
  /** True when the time went on rate-limit waits (429 backoff or the local limiter). */
  rateLimited: boolean;
  retryAfterMs: number | null;
}

/** The per-call deadline would be passed by the next attempt or wait; the call stops cleanly. */
export class ModelCallDeadlineError extends Error {
  readonly rateLimited: boolean;
  constructor(message: string, readonly details: ModelCallDeadlineDetails) {
    super(message);
    this.name = "ModelCallDeadlineError";
    this.rateLimited = details.rateLimited;
  }
}

/** True for a failure caused by rate limiting rather than by the request or the job. */
export function isRateLimitedFailure(error: unknown): boolean {
  if (error instanceof ModelRateLimitedError) return true;
  if (error instanceof ModelCallDeadlineError) return error.rateLimited;
  return Boolean(error && typeof error === "object" && (error as { rateLimited?: unknown }).rateLimited === true);
}

/** The suggested wait carried by a rate-limited failure, when known. */
export function rateLimitRetryAfterMs(error: unknown): number | null {
  if (error instanceof ModelRateLimitedError || error instanceof ModelCallDeadlineError) {
    return error.details.retryAfterMs;
  }
  const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const MAX_SERVER_SUGGESTED_DELAY_MS = 15 * 60 * 1000;

function durationToMs(value: unknown): number | null {
  if (typeof value === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(value);
    if (match) return Math.round(Number(match[1]) * 1000);
    return null;
  }
  if (value && typeof value === "object") {
    const seconds = Number((value as { seconds?: unknown }).seconds ?? 0);
    const nanos = Number((value as { nanos?: unknown }).nanos ?? 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) return Math.round(seconds * 1000 + nanos / 1e6);
  }
  return null;
}

function parseJsonBody(message: string): any {
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(message.slice(start));
  } catch {
    return null;
  }
}

/** google.rpc.RetryInfo.retryDelay from a Google API error body, in ms. */
export function googleRetryInfoDelayMs(error: unknown): number | null {
  const message = String((error as { message?: unknown } | null)?.message ?? error ?? "");
  const body = parseJsonBody(message);
  const details = body?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (typeof detail?.["@type"] === "string" && detail["@type"].endsWith("google.rpc.RetryInfo")) {
        const ms = durationToMs(detail.retryDelay);
        if (ms !== null) return ms;
      }
    }
  }
  const inline = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return inline ? Math.round(Number(inline[1]) * 1000) : null;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
  return key ? String(record[key]) : null;
}

/** An HTTP Retry-After value (seconds or HTTP date) attached to an error, in ms. */
export function retryAfterHeaderMs(error: unknown, now = Date.now()): number | null {
  const err = error as { retryAfterSecs?: unknown; headers?: unknown; response?: { headers?: unknown } } | null;
  if (typeof err?.retryAfterSecs === "number" && Number.isFinite(err.retryAfterSecs) && err.retryAfterSecs >= 0) {
    return Math.round(err.retryAfterSecs * 1000);
  }
  const raw = headerValue(err?.headers, "retry-after") ?? headerValue(err?.response?.headers, "retry-after");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** The delay the server asked for (RetryInfo first, then Retry-After), capped at 15 minutes. */
export function serverSuggestedDelayMs(error: unknown, now = Date.now()): number | null {
  const ms = googleRetryInfoDelayMs(error) ?? retryAfterHeaderMs(error, now);
  return ms === null ? null : Math.min(ms, MAX_SERVER_SUGGESTED_DELAY_MS);
}

export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  capMs?: number;
  random?: () => number;
}

/** Truncated exponential backoff with full jitter: uniform in [0, min(cap, base * factor^(n-1))]. */
export function fullJitterBackoffMs(failureNumber: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 1000;
  const factor = options.factor ?? 2;
  const capMs = options.capMs ?? 32000;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, Math.floor(failureNumber) - 1);
  const ceiling = Math.min(capMs, baseMs * Math.pow(factor, exponent));
  return Math.floor(Math.max(0, Math.min(1, random())) * ceiling);
}

let backoffRandom: () => number = Math.random;

/** Tests only: make the jitter deterministic. Pass undefined to restore Math.random. */
export function setBackoffRandomForTests(random: (() => number) | undefined): void {
  backoffRandom = random ?? Math.random;
}

export function backoffRandomSource(): () => number {
  return backoffRandom;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(env[name] ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** Per-call deadline for interactive document calls (CV summary, cover letter). Default 60 s. */
export function interactiveCallDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "MODEL_INTERACTIVE_CALL_DEADLINE_MS", 60_000, 5_000, 600_000);
}

/** Per-call deadline for pipeline calls (extraction, evaluation, embeddings). Default 300 s. */
export function pipelineCallDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "MODEL_PIPELINE_CALL_DEADLINE_MS", 300_000, 5_000, 1_800_000);
}

// ---------------------------------------------------------------------------
// Vertex Flex PayGo timeouts
// ---------------------------------------------------------------------------

/** Default client request timeout for one Flex PayGo request (Google's Flex samples use 10 min). */
export const GEMINI_FLEX_REQUEST_TIMEOUT_DEFAULT_MS = 600_000;
/** Vertex accepts a Flex request timeout of at most 30 minutes. */
export const GEMINI_FLEX_REQUEST_TIMEOUT_MAX_MS = 1_800_000;
/** Default per-call deadline for a Flex pipeline call: one Flex request, one standard retry, OpenAI. */
export const GEMINI_FLEX_CALL_DEADLINE_DEFAULT_MS = 900_000;
export const GEMINI_FLEX_CALL_DEADLINE_MAX_MS = 3_600_000;

/** A malformed Flex timeout setting: a configuration error, never a model or job failure. */
export class FlexTimeoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlexTimeoutConfigError";
  }
}

function strictMsSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = String(env[name] ?? "").trim();
  if (raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new FlexTimeoutConfigError(`${name} must be a whole number of milliseconds (got "${raw.slice(0, 40)}").`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new FlexTimeoutConfigError(`${name} must be at least ${min} ms (got ${raw.slice(0, 40)}).`);
  }
  return Math.min(value, max);
}

/**
 * Client request timeout for one Vertex Flex PayGo request: GEMINI_FLEX_REQUEST_TIMEOUT_MS,
 * default 600 s, at least 60 s, capped at 1800 s (the Vertex maximum). The SDK sends the same
 * value to Vertex as X-Server-Timeout (seconds). Non-Flex requests keep MODEL_REQUEST_TIMEOUT_MS.
 */
export function geminiFlexRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return strictMsSetting(
    env, "GEMINI_FLEX_REQUEST_TIMEOUT_MS", GEMINI_FLEX_REQUEST_TIMEOUT_DEFAULT_MS, 60_000, GEMINI_FLEX_REQUEST_TIMEOUT_MAX_MS,
  );
}

/**
 * Per-call deadline for a pipeline call that starts on Flex PayGo: GEMINI_FLEX_CALL_DEADLINE_MS,
 * default 900 s (one 600 s Flex request, one 60 s standard retry, then the OpenAI fallback), at
 * least 60 s, capped at 3600 s. Non-Flex pipeline calls keep MODEL_PIPELINE_CALL_DEADLINE_MS.
 */
export function geminiFlexCallDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return strictMsSetting(
    env, "GEMINI_FLEX_CALL_DEADLINE_MS", GEMINI_FLEX_CALL_DEADLINE_DEFAULT_MS, 60_000, GEMINI_FLEX_CALL_DEADLINE_MAX_MS,
  );
}

/** Attempts per model when every failure is a 429. Default 5. */
export function rateLimitMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env, "GEMINI_RATE_LIMIT_MAX_ATTEMPTS", 5, 1, 10);
}

export function backoffOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): BackoffOptions {
  return {
    baseMs: envInt(env, "MODEL_BACKOFF_BASE_MS", 1000, 1, 60_000),
    capMs: envInt(env, "MODEL_BACKOFF_CAP_MS", 32_000, 1, 600_000),
    factor: 2,
    random: backoffRandom,
  };
}

// ---------------------------------------------------------------------------
// Process-wide per-model limiter
// ---------------------------------------------------------------------------

export interface ModelLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  maxConcurrency: number;
}

export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  requestsPerMinute: 60,
  tokensPerMinute: 1_000_000,
  maxConcurrency: 4,
};

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

/**
 * Limits for one model: GEMINI_MODEL_LIMITS_JSON ({"<model>":{"rpm":..,"tpm":..,"concurrency":..}})
 * first, then GEMINI_MAX_REQUESTS_PER_MINUTE / GEMINI_MAX_TOKENS_PER_MINUTE / GEMINI_MAX_CONCURRENCY,
 * then conservative defaults (60 rpm, 1M tpm, 4 concurrent).
 */
export function modelLimitsFromEnv(model: string, env: NodeJS.ProcessEnv = process.env): ModelLimits {
  let perModel: Record<string, unknown> = {};
  const raw = String(env.GEMINI_MODEL_LIMITS_JSON ?? "").trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("GEMINI_MODEL_LIMITS_JSON is not valid JSON.");
    }
    const entry = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[model] : undefined;
    if (entry && typeof entry === "object") perModel = entry as Record<string, unknown>;
  }
  return {
    requestsPerMinute:
      positiveInt(perModel.rpm) ?? positiveInt(env.GEMINI_MAX_REQUESTS_PER_MINUTE) ?? DEFAULT_MODEL_LIMITS.requestsPerMinute,
    tokensPerMinute:
      positiveInt(perModel.tpm) ?? positiveInt(env.GEMINI_MAX_TOKENS_PER_MINUTE) ?? DEFAULT_MODEL_LIMITS.tokensPerMinute,
    maxConcurrency:
      positiveInt(perModel.concurrency) ?? positiveInt(env.GEMINI_MAX_CONCURRENCY) ?? DEFAULT_MODEL_LIMITS.maxConcurrency,
  };
}

/** A rough token estimate (4 characters per token) used before the provider reports usage. */
export function estimateTokens(...texts: unknown[]): number {
  let chars = 0;
  for (const text of texts) {
    if (typeof text === "string") chars += text.length;
    else if (text !== undefined && text !== null) chars += JSON.stringify(text)?.length ?? 0;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export interface LimiterPermit {
  /** Frees the concurrency slot; actual total tokens (when reported) replace the estimate. */
  release(actualTokens?: number | null): void;
}

interface WindowEntry {
  at: number;
  tokens: number;
}

const WINDOW_MS = 60_000;

export class ModelRateLimiter {
  private readonly window: WindowEntry[] = [];
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(
    readonly model: string,
    readonly limits: ModelLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get inFlight(): number {
    return this.active;
  }

  private prune(now: number): void {
    while (this.window.length > 0 && now - this.window[0].at >= WINDOW_MS) this.window.shift();
  }

  private tokensInWindow(): number {
    return this.window.reduce((sum, entry) => sum + entry.tokens, 0);
  }

  /** How long to wait before a request with this estimate may start; 0 when it may start now. */
  private waitMs(estimatedTokens: number, now: number): number {
    this.prune(now);
    let wait = 0;
    if (this.window.length >= this.limits.requestsPerMinute) {
      wait = Math.max(wait, this.window[0].at + WINDOW_MS - now);
    }
    // A request larger than the whole budget may run alone once the window is empty.
    const tokenBudget = this.limits.tokensPerMinute;
    if (this.window.length > 0 && this.tokensInWindow() + estimatedTokens > tokenBudget) {
      let freed = this.tokensInWindow() + estimatedTokens - tokenBudget;
      for (const entry of this.window) {
        freed -= entry.tokens;
        if (freed <= 0) {
          wait = Math.max(wait, entry.at + WINDOW_MS - now);
          break;
        }
      }
      if (freed > 0) wait = Math.max(wait, this.window[this.window.length - 1].at + WINDOW_MS - now);
    }
    return Math.max(0, wait);
  }

  /**
   * Waits until a request may start within the limits, then reserves it. Throws
   * ModelCallDeadlineError (rate-limited) when the wait would pass deadlineAt.
   */
  async acquire(estimatedTokens: number, deadlineAt: number): Promise<LimiterPermit> {
    for (;;) {
      const now = this.now();
      const concurrencyFull = this.active >= this.limits.maxConcurrency;
      const wait = this.waitMs(estimatedTokens, now);
      if (!concurrencyFull && wait === 0) {
        const entry: WindowEntry = { at: now, tokens: estimatedTokens };
        this.window.push(entry);
        this.active += 1;
        let released = false;
        return {
          release: (actualTokens?: number | null) => {
            if (released) return;
            released = true;
            this.active -= 1;
            if (typeof actualTokens === "number" && Number.isFinite(actualTokens) && actualTokens > 0) {
              entry.tokens = actualTokens;
            }
            const waiters = this.waiters;
            this.waiters = [];
            for (const wake of waiters) wake();
          },
        };
      }
      const remaining = deadlineAt - now;
      // A concurrency wait has no known end; poll at most once a second until a slot frees.
      const sleepMs = concurrencyFull ? Math.max(wait, 1) : wait;
      if (remaining <= 0 || (!concurrencyFull && wait >= remaining)) {
        throw new ModelCallDeadlineError(
          `Local rate limiter for ${this.model} cannot start the request before the call deadline.`,
          { model: this.model, deadlineMs: Math.max(0, remaining), rateLimited: true, retryAfterMs: wait || null },
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(concurrencyFull ? Math.min(sleepMs, 1000) : sleepMs, remaining));
        function done() {
          clearTimeout(timer);
          resolve();
        }
        this.waiters.push(done);
      });
    }
  }
}

const limiters = new Map<string, ModelRateLimiter>();

/** The process-wide limiter for a model (recreated when its configured limits change). */
export function getModelLimiter(model: string, env: NodeJS.ProcessEnv = process.env): ModelRateLimiter {
  const limits = modelLimitsFromEnv(model, env);
  const existing = limiters.get(model);
  if (
    existing &&
    existing.limits.requestsPerMinute === limits.requestsPerMinute &&
    existing.limits.tokensPerMinute === limits.tokensPerMinute &&
    existing.limits.maxConcurrency === limits.maxConcurrency
  ) {
    return existing;
  }
  const limiter = new ModelRateLimiter(model, limits);
  limiters.set(model, limiter);
  return limiter;
}

export function resetModelLimitersForTests(): void {
  limiters.clear();
}

// ---------------------------------------------------------------------------
// Per-run provider call statistics
// ---------------------------------------------------------------------------

export interface ProviderCallCounts {
  provider: string;
  model: string;
  calls: number;
  succeeded: number;
  rate_limited: number;
  daily_quota: number;
  timeouts: number;
  server_errors: number;
  other_failures: number;
  retries: number;
}

const callStats = new Map<string, ProviderCallCounts>();

function emptyCounts(provider: string, model: string): ProviderCallCounts {
  return {
    provider, model, calls: 0, succeeded: 0, rate_limited: 0, daily_quota: 0,
    timeouts: 0, server_errors: 0, other_failures: 0, retries: 0,
  };
}

/** Records one HTTP attempt. `retry` marks an attempt that repeats an earlier failed one. */
export function recordProviderCall(input: {
  provider: string;
  model: string;
  outcome: "OK" | ModelFailureKind;
  retry: boolean;
}): void {
  const key = `${input.provider}\u0000${input.model}`;
  const counts = callStats.get(key) ?? emptyCounts(input.provider, input.model);
  counts.calls += 1;
  if (input.retry) counts.retries += 1;
  switch (input.outcome) {
    case "OK": counts.succeeded += 1; break;
    case "RATE_LIMITED": counts.rate_limited += 1; break;
    case "DAILY_QUOTA": counts.daily_quota += 1; break;
    case "TIMEOUT":
    case "DEADLINE": counts.timeouts += 1; break;
    case "SERVER_ERROR": counts.server_errors += 1; break;
    default: counts.other_failures += 1;
  }
  callStats.set(key, counts);
}

/** A copy of the counts recorded in this process so far. */
export function snapshotProviderCalls(): ProviderCallCounts[] {
  return [...callStats.values()].map((counts) => ({ ...counts }));
}

export function resetProviderCallsForTests(): void {
  callStats.clear();
}

const NUMERIC_FIELDS = [
  "calls", "succeeded", "rate_limited", "daily_quota", "timeouts", "server_errors", "other_failures", "retries",
] as const;

/** Counts recorded between two snapshots (a run's own calls). */
export function diffProviderCalls(before: ProviderCallCounts[], after: ProviderCallCounts[]): ProviderCallCounts[] {
  const prior = new Map(before.map((counts) => [`${counts.provider}\u0000${counts.model}`, counts]));
  const result: ProviderCallCounts[] = [];
  for (const counts of after) {
    const base = prior.get(`${counts.provider}\u0000${counts.model}`);
    const delta = { ...counts };
    if (base) for (const field of NUMERIC_FIELDS) delta[field] = counts[field] - base[field];
    if (delta.calls > 0) result.push(delta);
  }
  return result.sort((a, b) => `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`));
}

/** Operator stop rule: pause scaling when more than 5% of a run's calls were rate limited. */
export const RATE_LIMITED_STOP_RULE_SHARE = 0.05;

/**
 * Provider label for HTTP attempts sent with Vertex Flex PayGo headers. Flex trades throttling for
 * price and a throttled Flex request is retried once on standard PayGo, so Flex attempts are
 * reported on their own row and left out of the per-attempt 429 share. Flex failures that the
 * standard retry did not absorb count in the run-level provider mix (summarizeProviderMix).
 */
export const GEMINI_FLEX_PROVIDER_LABEL = "gemini-flex";

export interface ProviderCallSummary {
  total_calls: number;
  rate_limited: number;
  rate_limited_share: number;
  /** 429s on Flex PayGo attempts: reported, but not in rate_limited or the share. */
  flex_rate_limited: number;
  stop_rule_threshold: number;
  stop_rule_triggered: boolean;
  by_model: ProviderCallCounts[];
}

export function summarizeProviderCalls(byModel: ProviderCallCounts[]): ProviderCallSummary {
  const isFlex = (counts: ProviderCallCounts) => counts.provider === GEMINI_FLEX_PROVIDER_LABEL;
  const sum = (rows: ProviderCallCounts[], field: "calls" | "rate_limited") =>
    rows.reduce((total, counts) => total + counts[field], 0);
  const standardRows = byModel.filter((counts) => !isFlex(counts));
  const standardCalls = sum(standardRows, "calls");
  const rateLimited = sum(standardRows, "rate_limited");
  const share = standardCalls > 0 ? rateLimited / standardCalls : 0;
  return {
    total_calls: sum(byModel, "calls"),
    rate_limited: rateLimited,
    rate_limited_share: Math.round(share * 10000) / 10000,
    flex_rate_limited: sum(byModel.filter(isFlex), "rate_limited"),
    stop_rule_threshold: RATE_LIMITED_STOP_RULE_SHARE,
    stop_rule_triggered: share > RATE_LIMITED_STOP_RULE_SHARE,
    by_model: byModel,
  };
}

// ---------------------------------------------------------------------------
// Per-run provider mix: which path served each logical AI call
// ---------------------------------------------------------------------------

/**
 * How one logical AI call was served:
 * - FLEX: Gemini on Vertex Flex PayGo.
 * - STANDARD: Gemini on standard PayGo (a non-Flex call, or the one standard retry after Flex).
 * - OPENAI: OpenAI as the route's primary provider.
 * - OPENAI_FALLBACK: OpenAI after Gemini failed (degraded).
 */
export type ModelServedPath = "FLEX" | "STANDARD" | "OPENAI" | "OPENAI_FALLBACK";
export const MODEL_SERVED_PATHS = ["FLEX", "STANDARD", "OPENAI", "OPENAI_FALLBACK"] as const;

/** Go-live stop rule: pause when more than 20% of a run's AI calls hit a provider error. */
export const PROVIDER_ERROR_STOP_RULE_SHARE = 0.2;

export interface ModelCallRouteRecord {
  /** The path that served the call; null when every provider failed. */
  servedPath: ModelServedPath | null;
  /** True when a fallback provider or model answered (the call is degraded). */
  fallbackUsed: boolean;
  flexAttempted: boolean;
  /** Flex failed for capacity (timeout, 429, unavailable) and the standard retry answered. */
  flexRecoveredByStandard: boolean;
  /** HTTP attempts of this call that timed out / were rate limited, on any path. */
  timeouts: number;
  rateLimited: number;
  /** The subset of those attempts that were sent with Flex headers. */
  flexTimeouts: number;
  flexRateLimited: number;
}

const MIX_FIELDS = [
  "ai_calls", "served_flex", "served_standard", "served_openai", "served_openai_fallback", "failed",
  "flex_attempted", "flex_to_standard_recoveries", "timeouts", "rate_limited", "flex_timeouts",
  "flex_rate_limited", "provider_error_calls", "rate_limited_calls",
] as const;

/**
 * Logical AI calls by served path. provider_error_calls are calls that failed or were answered by
 * a fallback provider/model; rate_limited_calls are calls with a 429 that the Flex-to-standard
 * retry did not absorb.
 */
export type ProviderMixCounts = Record<(typeof MIX_FIELDS)[number], number>;

function emptyMix(): ProviderMixCounts {
  return Object.fromEntries(MIX_FIELDS.map((field) => [field, 0])) as ProviderMixCounts;
}

let providerMix: ProviderMixCounts = emptyMix();

/**
 * Records one logical AI call (all of its HTTP attempts across paths and providers). A Flex call
 * recovered by the standard retry is reported as a recovery but is not a provider error, and its
 * Flex 429s do not count toward the 429 stop rule.
 */
export function recordModelCallRoute(record: ModelCallRouteRecord): void {
  const mix = providerMix;
  mix.ai_calls += 1;
  switch (record.servedPath) {
    case "FLEX": mix.served_flex += 1; break;
    case "STANDARD": mix.served_standard += 1; break;
    case "OPENAI": mix.served_openai += 1; break;
    case "OPENAI_FALLBACK": mix.served_openai_fallback += 1; break;
    default: mix.failed += 1;
  }
  if (record.flexAttempted) mix.flex_attempted += 1;
  if (record.flexRecoveredByStandard) mix.flex_to_standard_recoveries += 1;
  mix.timeouts += record.timeouts;
  mix.rate_limited += record.rateLimited;
  mix.flex_timeouts += record.flexTimeouts;
  mix.flex_rate_limited += record.flexRateLimited;
  if (record.servedPath === null || record.fallbackUsed) mix.provider_error_calls += 1;
  const countedRateLimits = record.rateLimited - (record.flexRecoveredByStandard ? record.flexRateLimited : 0);
  if (countedRateLimits > 0) mix.rate_limited_calls += 1;
}

export function snapshotProviderMix(): ProviderMixCounts {
  return { ...providerMix };
}

export function resetProviderMixForTests(): void {
  providerMix = emptyMix();
}

/** Calls recorded between two snapshots (a run's own calls). */
export function diffProviderMix(before: ProviderMixCounts, after: ProviderMixCounts): ProviderMixCounts {
  const delta = emptyMix();
  for (const field of MIX_FIELDS) delta[field] = after[field] - before[field];
  return delta;
}

export interface ProviderMixSummary {
  ai_calls: number;
  served: Record<ModelServedPath, number>;
  failed: number;
  flex_attempted: number;
  flex_to_standard_recoveries: number;
  timeouts: number;
  rate_limited: number;
  flex_timeouts: number;
  flex_rate_limited: number;
  provider_error_calls: number;
  provider_error_share: number;
  provider_error_threshold: number;
  rate_limited_calls: number;
  rate_limited_share: number;
  rate_limited_threshold: number;
  stop_rule_triggered: boolean;
  stop_rule_reasons: string[];
}

function roundedShare(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 10000) / 10000 : 0;
}

/** The run's provider mix with the go-live stop rules (provider errors > 20%, 429s > 5% of AI calls). */
export function summarizeProviderMix(mix: ProviderMixCounts): ProviderMixSummary {
  const reasons: string[] = [];
  const providerErrorShare = roundedShare(mix.provider_error_calls, mix.ai_calls);
  const rateLimitedShare = roundedShare(mix.rate_limited_calls, mix.ai_calls);
  if (mix.ai_calls > 0 && mix.provider_error_calls / mix.ai_calls > PROVIDER_ERROR_STOP_RULE_SHARE) {
    reasons.push(
      `provider errors on ${mix.provider_error_calls}/${mix.ai_calls} AI calls (${(providerErrorShare * 100).toFixed(1)}%) exceed ${PROVIDER_ERROR_STOP_RULE_SHARE * 100}%`,
    );
  }
  if (mix.ai_calls > 0 && mix.rate_limited_calls / mix.ai_calls > RATE_LIMITED_STOP_RULE_SHARE) {
    reasons.push(
      `429s on ${mix.rate_limited_calls}/${mix.ai_calls} AI calls (${(rateLimitedShare * 100).toFixed(1)}%) exceed ${RATE_LIMITED_STOP_RULE_SHARE * 100}%`,
    );
  }
  return {
    ai_calls: mix.ai_calls,
    served: {
      FLEX: mix.served_flex,
      STANDARD: mix.served_standard,
      OPENAI: mix.served_openai,
      OPENAI_FALLBACK: mix.served_openai_fallback,
    },
    failed: mix.failed,
    flex_attempted: mix.flex_attempted,
    flex_to_standard_recoveries: mix.flex_to_standard_recoveries,
    timeouts: mix.timeouts,
    rate_limited: mix.rate_limited,
    flex_timeouts: mix.flex_timeouts,
    flex_rate_limited: mix.flex_rate_limited,
    provider_error_calls: mix.provider_error_calls,
    provider_error_share: providerErrorShare,
    provider_error_threshold: PROVIDER_ERROR_STOP_RULE_SHARE,
    rate_limited_calls: mix.rate_limited_calls,
    rate_limited_share: rateLimitedShare,
    rate_limited_threshold: RATE_LIMITED_STOP_RULE_SHARE,
    stop_rule_triggered: reasons.length > 0,
    stop_rule_reasons: reasons,
  };
}
