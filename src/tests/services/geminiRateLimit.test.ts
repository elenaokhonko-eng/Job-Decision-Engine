import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const geminiMock = vi.hoisted(() => ({
  generateContent: vi.fn(),
  embedContent: vi.fn(),
  constructed: [] as unknown[],
}));

const routeRegistryMock = vi.hoisted(() => ({
  ensureModelRouteActiveRevision: vi.fn(),
  getActiveModelRouteRevision: vi.fn(async () => null),
  recordModelRouteInvocation: vi.fn(async () => 'invocation-1'),
}));

vi.mock('@google/genai', async () => {
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    ApiError: actual.ApiError,
    GoogleGenAI: vi.fn(function GoogleGenAIMock(this: any, options: unknown) {
      geminiMock.constructed.push(options);
      this.models = { generateContent: geminiMock.generateContent, embedContent: geminiMock.embedContent };
    }),
    Type: {},
    FunctionDeclaration: vi.fn(),
  };
});

vi.mock('../../modelRoutes/registry.js', () => routeRegistryMock);

import { ApiError } from '@google/genai';

// Each test re-imports the modules (vi.resetModules), so the resilience module is re-bound per test.
let resilience: typeof import('../../services/modelCallResilience.js');

const ENV_KEYS = [
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_FLASH_API_KEY', 'DOCUMENT_GEMINI_API_KEY', 'GEMINI_BACKEND',
  'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_ALLOW_REGIONAL_LOCATION', 'GEMINI_PIPELINE_FLEX',
  'DOCUMENT_PRIMARY_PROVIDER', 'EVALUATION_PRIMARY_PROVIDER', 'FORCE_OPENAI', 'DOCUMENT_PRIMARY_MODEL',
  'DOCUMENT_FALLBACK_MODEL', 'MODEL_REQUEST_MAX_RETRIES', 'MODEL_REQUEST_TIMEOUT_MS', 'GEMINI_RATE_LIMIT_MAX_ATTEMPTS',
  'MODEL_INTERACTIVE_CALL_DEADLINE_MS', 'MODEL_PIPELINE_CALL_DEADLINE_MS', 'GEMINI_MAX_REQUESTS_PER_MINUTE',
  'GEMINI_MAX_CONCURRENCY', 'GEMINI_MODEL_LIMITS_JSON', 'EMBEDDING_GEMINI_BATCH_SIZE',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function gemini429(details: unknown[] = [], message = 'Resource has been exhausted (e.g. check quota).'): ApiError {
  return new ApiError({
    status: 429,
    message: JSON.stringify({ error: { code: 429, message, status: 'RESOURCE_EXHAUSTED', details } }),
  });
}

const perMinuteQuota = () => gemini429([
  {
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count', quotaId: 'GenerateContentPaidTierInputTokensPerModelPerMinute' }],
  },
], 'Quota exceeded for metric: generate_content_paid_tier_input_token_count, limit: 1000000');
const perDayQuota = () => gemini429([
  {
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
  },
], 'You exceeded your current quota, please check your plan and billing details.');
const retryInfo = (delay: string) => gemini429([{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }]);

function geminiOnlyDocumentRoute(): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.DOCUMENT_PRIMARY_PROVIDER = 'gemini';
  process.env.DOCUMENT_PRIMARY_MODEL = 'gemini-primary';
  process.env.DOCUMENT_FALLBACK_MODEL = 'gpt-fallback';
}

beforeEach(async () => {
  vi.resetModules();
  resilience = await import('../../services/modelCallResilience.js');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  geminiMock.generateContent.mockReset();
  geminiMock.embedContent.mockReset();
  geminiMock.constructed.length = 0;
  routeRegistryMock.recordModelRouteInvocation.mockClear();
  restoreEnv();
});

describe('classifyGeminiError', () => {
  it('treats a per-minute 429 that mentions "quota" as a retryable rate limit, not a daily quota', async () => {
    const { classifyGeminiError } = await import('../../services/agent.js');
    expect(classifyGeminiError(perMinuteQuota(), 'studio')).toMatchObject({ rateLimit: true, dailyQuota: false, retryable: true });
    expect(classifyGeminiError(gemini429(), 'studio')).toMatchObject({ rateLimit: true, dailyQuota: false, retryable: true });
  });

  it('treats a named per-day quota as a daily quota on AI Studio only', async () => {
    const { classifyGeminiError } = await import('../../services/agent.js');
    expect(classifyGeminiError(perDayQuota(), 'studio')).toMatchObject({ dailyQuota: true, rateLimit: false, retryable: false });
    // Vertex pay-as-you-go has no per-day request quota: the same body is a retryable rate limit there.
    expect(classifyGeminiError(perDayQuota(), 'vertex')).toMatchObject({ dailyQuota: false, rateLimit: true, retryable: true });
  });

  it('keeps timeouts and 5xx separate from rate limits', async () => {
    const { classifyGeminiError } = await import('../../services/agent.js');
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(classifyGeminiError(timeout, 'vertex')).toMatchObject({ timeout: true, rateLimit: false, serverError: false });
    const unavailable = new ApiError({ status: 503, message: JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }) });
    expect(classifyGeminiError(unavailable, 'vertex')).toMatchObject({ serverError: true, rateLimit: false, timeout: false });
  });
});

describe('Gemini 429 handling', () => {
  it('retries a 429 twice with jittered backoff and succeeds on the same model', async () => {
    geminiOnlyDocumentRoute();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    resilience.setBackoffRandomForTests(() => 0.5);
    geminiMock.generateContent
      .mockRejectedValueOnce(perMinuteQuota())
      .mockRejectedValueOnce(perMinuteQuota())
      .mockResolvedValueOnce({ text: '{"ok":true}' });

    const { generateContentAudited } = await import('../../services/agent.js');
    const pending = generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.' });
    // Full jitter at 0.5: 500 ms after the first 429, 1000 ms after the second.
    await vi.advanceTimersByTimeAsync(499);
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-primary', fallbackUsed: false });
    expect(resilience.snapshotProviderCalls()).toEqual([expect.objectContaining({
      provider: 'gemini', model: 'gemini-primary', calls: 3, succeeded: 1, rate_limited: 2, retries: 2,
    })]);
  });

  it("honours google.rpc.RetryInfo's retryDelay instead of the jittered backoff", async () => {
    geminiOnlyDocumentRoute();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    resilience.setBackoffRandomForTests(() => 0);
    geminiMock.generateContent.mockRejectedValueOnce(retryInfo('7s')).mockResolvedValueOnce({ text: 'done' });

    const { generateContentAudited } = await import('../../services/agent.js');
    const pending = generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.' });
    await vi.advanceTimersByTimeAsync(6999);
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ text: 'done' });
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(2);
  });

  it('honours an HTTP Retry-After value attached to the error', async () => {
    geminiOnlyDocumentRoute();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const withHeader = Object.assign(gemini429(), { headers: { 'Retry-After': '3' } });
    geminiMock.generateContent.mockRejectedValueOnce(withHeader).mockResolvedValueOnce({ text: 'done' });

    const { generateContentAudited } = await import('../../services/agent.js');
    const pending = generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.' });
    await vi.advanceTimersByTimeAsync(2999);
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ text: 'done' });
  });

  it('stops cleanly with a rate-limited error when the wait would pass the call deadline (no hang)', async () => {
    geminiOnlyDocumentRoute();
    process.env.MODEL_INTERACTIVE_CALL_DEADLINE_MS = '10000';
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    // The server asks for 30 s, beyond the 10 s interactive deadline.
    geminiMock.generateContent.mockRejectedValue(retryInfo('30s'));

    const { generateContentAudited } = await import('../../services/agent.js');
    const outcome = generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.', interactive: true })
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const error = await outcome;

    expect(error).toBeInstanceOf(resilience.ModelRateLimitedError);
    expect((error as InstanceType<typeof resilience.ModelRateLimitedError>).details.retryAfterMs).toBe(30000);
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after GEMINI_RATE_LIMIT_MAX_ATTEMPTS 429s and reports a rate-limited (not a job) failure', async () => {
    geminiOnlyDocumentRoute();
    process.env.GEMINI_RATE_LIMIT_MAX_ATTEMPTS = '3';
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    resilience.setBackoffRandomForTests(() => 1);
    geminiMock.generateContent.mockRejectedValue(perMinuteQuota());

    const { generateContentAudited } = await import('../../services/agent.js');
    const outcome = generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.' })
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    const error = await outcome;

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(resilience.ModelRateLimitedError);
    expect(String((error as Error).message)).toContain('All model API calls failed');
  });

  it('switches an interactive call to the secondary model on the first 429', async () => {
    geminiOnlyDocumentRoute();
    geminiMock.generateContent.mockImplementation(async (request: { model: string }) => {
      if (request.model === 'gemini-primary') throw perMinuteQuota();
      return { text: 'secondary text' };
    });

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.', interactive: true, secondaryGeminiModel: 'gemini-secondary',
    });

    expect(geminiMock.generateContent.mock.calls.map(([request]) => request.model)).toEqual(['gemini-primary', 'gemini-secondary']);
    expect(result).toMatchObject({ model: 'gemini-secondary', fallbackUsed: true });
  });

  it('does not retry an AI Studio per-day quota and moves to the next model at once', async () => {
    geminiOnlyDocumentRoute();
    geminiMock.generateContent.mockImplementation(async (request: { model: string }) => {
      if (request.model === 'gemini-primary') throw perDayQuota();
      return { text: 'ok' };
    });
    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.', secondaryGeminiModel: 'gemini-secondary',
    });
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(2);
    expect(result.model).toBe('gemini-secondary');
  });

  it('fails a pipeline call with a typed deadline error when timeouts use up the deadline', async () => {
    geminiOnlyDocumentRoute();
    process.env.MODEL_REQUEST_MAX_RETRIES = '5';
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    resilience.setBackoffRandomForTests(() => 0);
    geminiMock.generateContent.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });

    const { generateContentAudited } = await import('../../services/agent.js');
    const outcome = generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.', deadlineMs: 10000 })
      .then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30000);
    const error = await outcome;

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(resilience.ModelRateLimitedError);
    expect(String((error as Error).message)).toMatch(/deadline/);
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(3);
  });
});

describe('Gemini backend selection', () => {
  it('builds a Vertex client with ADC, project and the global location, without AI Studio headers', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.GEMINI_BACKEND = 'vertex';
    process.env.GOOGLE_CLOUD_PROJECT = 'example-project';
    const { getGeminiClient } = await import('../../services/agent.js');
    getGeminiClient();
    getGeminiClient();
    expect(geminiMock.constructed).toEqual([
      { vertexai: true, project: 'example-project', location: 'global', httpOptions: { timeout: 45000 } },
    ]);
  });

  it('reuses a studio client for the same key and rebuilds it when the key or backend changes', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.GEMINI_API_KEY = 'first-test-key';
    const { getGeminiClient } = await import('../../services/agent.js');
    getGeminiClient();
    getGeminiClient();
    process.env.GEMINI_API_KEY = 'second-test-key';
    getGeminiClient();
    process.env.GEMINI_BACKEND = 'vertex';
    process.env.GOOGLE_CLOUD_PROJECT = 'example-project';
    getGeminiClient();
    expect(geminiMock.constructed.map((options: any) => options.apiKey ?? `vertex:${options.project}`)).toEqual([
      'first-test-key',
      'second-test-key',
      'vertex:example-project',
    ]);
  });

  it('rejects a single-region Vertex location unless explicitly allowed', async () => {
    const { geminiConfigProblem, isGeminiConfigured } = await import('../../services/geminiConfig.js');
    const env = { GEMINI_BACKEND: 'vertex', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'us-central1' } as NodeJS.ProcessEnv;
    expect(geminiConfigProblem(env)).toContain('GEMINI_ALLOW_REGIONAL_LOCATION=true');
    expect(isGeminiConfigured({ ...env, GEMINI_ALLOW_REGIONAL_LOCATION: 'true' })).toBe(true);
    expect(isGeminiConfigured({ GEMINI_BACKEND: 'vertex' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isGeminiConfigured({ GEMINI_BACKEND: 'other', GEMINI_API_KEY: 'k' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('treats complete Vertex config as configured without any AI Studio key, and keeps studio unchanged', async () => {
    const { isGeminiConfigured, resolveGeminiClientConfig } = await import('../../services/geminiConfig.js');
    expect(isGeminiConfigured({ GEMINI_BACKEND: 'vertex', GOOGLE_CLOUD_PROJECT: 'p' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isGeminiConfigured({ GEMINI_API_KEY: 'MY_GEMINI_API_KEY' } as NodeJS.ProcessEnv)).toBe(false);
    expect(resolveGeminiClientConfig({ GEMINI_FLASH_API_KEY: 'flash' } as NodeJS.ProcessEnv)).toMatchObject({ backend: 'studio', keySource: 'GEMINI_FLASH_API_KEY' });
    // DOCUMENT_GEMINI_API_KEY serves manual documents only.
    const env = { GEMINI_API_KEY: 'pipeline', DOCUMENT_GEMINI_API_KEY: 'laptop' } as NodeJS.ProcessEnv;
    expect(resolveGeminiClientConfig(env, 'document')).toMatchObject({ keySource: 'DOCUMENT_GEMINI_API_KEY' });
    expect(resolveGeminiClientConfig(env)).toMatchObject({ keySource: 'GEMINI_API_KEY' });
    expect(isGeminiConfigured({ DOCUMENT_GEMINI_API_KEY: 'laptop' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isGeminiConfigured({ DOCUMENT_GEMINI_API_KEY: 'laptop' } as NodeJS.ProcessEnv, 'document')).toBe(true);
  });

  it('sends Flex PayGo headers only for flagged pipeline calls on Vertex', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.GEMINI_BACKEND = 'vertex';
    process.env.GOOGLE_CLOUD_PROJECT = 'example-project';
    process.env.GEMINI_PIPELINE_FLEX = 'true';
    process.env.DOCUMENT_PRIMARY_PROVIDER = 'gemini';
    geminiMock.generateContent.mockResolvedValue({ text: 'ok' });

    const { generateContentAudited } = await import('../../services/agent.js');
    await generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Pipeline.', flex: true });
    await generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Interactive.', flex: true, interactive: true });
    await generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Unflagged.' });

    const headers = geminiMock.generateContent.mock.calls.map(([request]) => request.config.httpOptions.headers);
    expect(headers[0]).toEqual({ 'X-Vertex-AI-LLM-Request-Type': 'shared', 'X-Vertex-AI-LLM-Shared-Request-Type': 'flex' });
    expect(headers[1]).toBeUndefined();
    expect(headers[2]).toBeUndefined();
  });
});

describe('batched embeddings', () => {
  it('sends several inputs per embedContent request and keeps one outcome per input', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.EMBEDDING_GEMINI_BATCH_SIZE = '2';
    geminiMock.embedContent.mockImplementation(async ({ contents }: { contents: string | string[] }) => {
      const texts = Array.isArray(contents) ? contents : [contents];
      if (texts.includes('broken')) throw new ApiError({ status: 400, message: '{"error":{"code":400,"status":"INVALID_ARGUMENT"}}' });
      return { embeddings: texts.map((text) => ({ values: [text.length, 1] })) };
    });

    const { generateEmbeddingsWithProviderAndModel } = await import('../../services/agent.js');
    const outcomes = await generateEmbeddingsWithProviderAndModel(['a', 'bb', 'broken', 'ccc', 'dddd'], 'gemini', 'gemini-embedding-001');

    expect(geminiMock.embedContent.mock.calls.map(([request]) => request.contents)).toEqual([['a', 'bb'], ['broken', 'ccc'], 'dddd']);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, false, false, true]);
    expect(outcomes[0]).toEqual({ ok: true, vector: [1, 1] });
    expect(outcomes[4]).toEqual({ ok: true, vector: [4, 1] });
  });

  it('defaults to one input per request on Vertex and marks an exhausted 429 as rate limited', async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.GEMINI_BACKEND = 'vertex';
    process.env.GOOGLE_CLOUD_PROJECT = 'example-project';
    process.env.GEMINI_RATE_LIMIT_MAX_ATTEMPTS = '1';
    geminiMock.embedContent.mockRejectedValue(gemini429());

    const { generateEmbeddingsWithProviderAndModel, geminiEmbeddingBatchSize } = await import('../../services/agent.js');
    expect(geminiEmbeddingBatchSize()).toBe(1);
    const outcomes = await generateEmbeddingsWithProviderAndModel(['a', 'b'], 'gemini', 'gemini-embedding-001');
    expect(geminiMock.embedContent).toHaveBeenCalledTimes(2);
    expect(outcomes.every((outcome) => !outcome.ok && outcome.error instanceof resilience.ModelRateLimitedError)).toBe(true);
  });
});

describe('typed deadline errors', () => {
  it('marks limiter waits past the deadline as rate limited', async () => {
    const { ModelRateLimiter } = resilience;
    let now = 0;
    const limiter = new ModelRateLimiter('m', { requestsPerMinute: 1, tokensPerMinute: 1000, maxConcurrency: 4 }, () => now);
    (await limiter.acquire(10, 60_000)).release();
    now = 1000;
    const error = await limiter.acquire(10, 30_000).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(resilience.ModelCallDeadlineError);
    expect((error as InstanceType<typeof resilience.ModelCallDeadlineError>).rateLimited).toBe(true);
  });
});
