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

export interface ProviderCallSummary {
  total_calls: number;
  rate_limited: number;
  rate_limited_share: number;
  stop_rule_threshold: number;
  stop_rule_triggered: boolean;
  by_model: ProviderCallCounts[];
}

export function summarizeProviderCalls(byModel: ProviderCallCounts[]): ProviderCallSummary {
  const totalCalls = byModel.reduce((sum, counts) => sum + counts.calls, 0);
  const rateLimited = byModel.reduce((sum, counts) => sum + counts.rate_limited, 0);
  const share = totalCalls > 0 ? rateLimited / totalCalls : 0;
  return {
    total_calls: totalCalls,
    rate_limited: rateLimited,
    rate_limited_share: Math.round(share * 10000) / 10000,
    stop_rule_threshold: RATE_LIMITED_STOP_RULE_SHARE,
    stop_rule_triggered: share > RATE_LIMITED_STOP_RULE_SHARE,
    by_model: byModel,
  };
}
