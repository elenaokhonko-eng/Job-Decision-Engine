import { afterEach, describe, expect, it, vi } from "vitest";

import {
  diffProviderCalls,
  fullJitterBackoffMs,
  getModelLimiter,
  googleRetryInfoDelayMs,
  isRateLimitedFailure,
  ModelCallDeadlineError,
  ModelRateLimitedError,
  ModelRateLimiter,
  modelLimitsFromEnv,
  recordProviderCall,
  resetProviderCallsForTests,
  retryAfterHeaderMs,
  serverSuggestedDelayMs,
  snapshotProviderCalls,
  summarizeProviderCalls,
} from "../../services/modelCallResilience.js";
import { rateLimitedRetryAt } from "../../tasks/pipelineTasks.js";

afterEach(() => {
  vi.useRealTimers();
  resetProviderCallsForTests();
});

describe("backoff and server-suggested delays", () => {
  it("draws full jitter from a truncated exponential ceiling (1 s base, x2, 32 s cap)", () => {
    expect([1, 2, 3, 6, 7, 10].map((n) => fullJitterBackoffMs(n, { random: () => 0.999999 }))).toEqual([999, 1999, 3999, 31999, 31999, 31999]);
    expect(fullJitterBackoffMs(4, { random: () => 0 })).toBe(0);
  });

  it("reads google.rpc.RetryInfo and Retry-After (seconds or HTTP date), capped at 15 minutes", () => {
    const body = (delay: unknown) => new Error(JSON.stringify({
      error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] },
    }));
    expect(googleRetryInfoDelayMs(body("12s"))).toBe(12000);
    expect(googleRetryInfoDelayMs(body("1.5s"))).toBe(1500);
    expect(googleRetryInfoDelayMs(body({ seconds: 2, nanos: 500_000_000 }))).toBe(2500);
    expect(googleRetryInfoDelayMs(new Error("no details"))).toBeNull();
    expect(retryAfterHeaderMs({ headers: new Headers({ "retry-after": "4" }) })).toBe(4000);
    expect(retryAfterHeaderMs({ retryAfterSecs: 2 })).toBe(2000);
    const now = Date.parse("2026-11-07T00:00:00Z");
    expect(retryAfterHeaderMs({ headers: { "Retry-After": "Sat, 07 Nov 2026 00:00:10 GMT" } }, now)).toBe(10000);
    expect(serverSuggestedDelayMs(body("7200s"))).toBe(15 * 60 * 1000);
  });

  it("identifies rate-limited failures, including a deadline that ran out while waiting on 429s", () => {
    expect(isRateLimitedFailure(new ModelRateLimitedError("x", { provider: "gemini", model: "m", retryAfterMs: null, attempts: 1 }))).toBe(true);
    expect(isRateLimitedFailure(new ModelCallDeadlineError("x", { model: "m", deadlineMs: 1, rateLimited: true, retryAfterMs: null }))).toBe(true);
    expect(isRateLimitedFailure(new ModelCallDeadlineError("x", { model: "m", deadlineMs: 1, rateLimited: false, retryAfterMs: null }))).toBe(false);
    expect(isRateLimitedFailure(new Error("429"))).toBe(false);
  });

  it("reschedules a rate-limited task at least 30 s out with jitter, honouring a longer provider delay", () => {
    const now = 1_000_000;
    expect(rateLimitedRetryAt(null, now, () => 0).getTime()).toBe(now + 30_000);
    expect(rateLimitedRetryAt(null, now, () => 1).getTime()).toBe(now + 60_000);
    expect(rateLimitedRetryAt(120_000, now, () => 0).getTime()).toBe(now + 120_000);
    expect(rateLimitedRetryAt(3_600_000, now, () => 0).getTime()).toBe(now + 15 * 60_000);
  });
});

describe("per-model limiter", () => {
  it("reads per-model limits, then the global defaults", () => {
    const env = {
      GEMINI_MAX_REQUESTS_PER_MINUTE: "20",
      GEMINI_MODEL_LIMITS_JSON: JSON.stringify({ "gemini-3.8-flash": { rpm: 5, concurrency: 2 } }),
    } as NodeJS.ProcessEnv;
    expect(modelLimitsFromEnv("gemini-3.8-flash", env)).toEqual({ requestsPerMinute: 5, tokensPerMinute: 1_000_000, maxConcurrency: 2 });
    expect(modelLimitsFromEnv("other", env)).toEqual({ requestsPerMinute: 20, tokensPerMinute: 1_000_000, maxConcurrency: 4 });
    expect(() => modelLimitsFromEnv("x", { GEMINI_MODEL_LIMITS_JSON: "{" } as NodeJS.ProcessEnv)).toThrow("not valid JSON");
  });

  it("waits for the requests-per-minute window instead of sending a burst", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const limiter = new ModelRateLimiter("m", { requestsPerMinute: 2, tokensPerMinute: 1_000_000, maxConcurrency: 10 });
    (await limiter.acquire(1, Date.now() + 300_000)).release();
    (await limiter.acquire(1, Date.now() + 300_000)).release();
    let third = false;
    const pending = limiter.acquire(1, Date.now() + 300_000).then((permit) => { third = true; permit.release(); });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(third).toBe(true);
  });

  it("limits tokens per minute and reconciles the estimate with reported usage", async () => {
    let now = 0;
    const limiter = new ModelRateLimiter("m", { requestsPerMinute: 100, tokensPerMinute: 1000, maxConcurrency: 10 }, () => now);
    // Estimated 800 tokens, but the provider reported 100: the window now holds 100.
    (await limiter.acquire(800, 60_000)).release(100);
    const permit = await limiter.acquire(800, 60_000);
    permit.release();
    // 900 of 1000 used: a 200-token request cannot start before the deadline in this minute.
    now = 1000;
    await expect(limiter.acquire(200, 30_000)).rejects.toBeInstanceOf(ModelCallDeadlineError);
  });

  it("is one process-wide limiter per model, so every worker lane shares its concurrency cap", async () => {
    const env = { GEMINI_MAX_CONCURRENCY: "2" } as NodeJS.ProcessEnv;
    const laneA = getModelLimiter("shared-model", env);
    const laneB = getModelLimiter("shared-model", env);
    expect(laneB).toBe(laneA);
    const first = await laneA.acquire(1, Date.now() + 60_000);
    const second = await laneB.acquire(1, Date.now() + 60_000);
    expect(laneA.inFlight).toBe(2);
    // A third lane cannot start before the deadline while both slots are held.
    await expect(getModelLimiter("shared-model", env).acquire(1, Date.now() + 1)).rejects.toBeInstanceOf(ModelCallDeadlineError);
    first.release();
    second.release();
  });

  it("caps concurrent requests and starts the next one when a slot is released", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const limiter = new ModelRateLimiter("m", { requestsPerMinute: 100, tokensPerMinute: 1_000_000, maxConcurrency: 1 });
    const first = await limiter.acquire(1, Date.now() + 60_000);
    let started = false;
    const second = limiter.acquire(1, Date.now() + 60_000).then((permit) => { started = true; return permit; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(started).toBe(false);
    expect(limiter.inFlight).toBe(1);
    first.release();
    await vi.advanceTimersByTimeAsync(0);
    (await second).release();
    expect(started).toBe(true);
    expect(limiter.inFlight).toBe(0);
  });
});

describe("per-run provider call counts", () => {
  it("counts calls, 429s, timeouts and retries by model and flags the >5% stop rule", () => {
    const before = snapshotProviderCalls();
    for (let index = 0; index < 18; index++) recordProviderCall({ provider: "gemini", model: "a", outcome: "OK", retry: false });
    recordProviderCall({ provider: "gemini", model: "a", outcome: "RATE_LIMITED", retry: false });
    recordProviderCall({ provider: "gemini", model: "a", outcome: "TIMEOUT", retry: true });
    const summary = summarizeProviderCalls(diffProviderCalls(before, snapshotProviderCalls()));
    expect(summary.by_model).toEqual([expect.objectContaining({ calls: 20, succeeded: 18, rate_limited: 1, timeouts: 1, retries: 1 })]);
    expect(summary).toMatchObject({ total_calls: 20, rate_limited_share: 0.05, stop_rule_triggered: false });
    recordProviderCall({ provider: "gemini", model: "a", outcome: "RATE_LIMITED", retry: true });
    expect(summarizeProviderCalls(diffProviderCalls(before, snapshotProviderCalls())).stop_rule_triggered).toBe(true);
  });
});
