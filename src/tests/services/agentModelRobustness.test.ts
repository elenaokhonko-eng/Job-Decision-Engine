import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const geminiMock = vi.hoisted(() => ({
  generateContent: vi.fn(),
}));

const routeRegistryMock = vi.hoisted(() => ({
  ensureModelRouteActiveRevision: vi.fn(),
  getActiveModelRouteRevision: vi.fn(async () => null),
  recordModelRouteInvocation: vi.fn(async () => 'invocation-1'),
}));

vi.mock('@google/genai', async () => {
  // Keep the real ApiError so the fixtures below have exactly the SDK's error shape.
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    ApiError: actual.ApiError,
    GoogleGenAI: vi.fn(function GoogleGenAIMock(this: any) {
      this.models = {
        generateContent: geminiMock.generateContent,
        embedContent: vi.fn(),
      };
    }),
    Type: {},
    FunctionDeclaration: vi.fn(),
  };
});

vi.mock('../../modelRoutes/registry.js', () => routeRegistryMock);

import { ApiError } from '@google/genai';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GEMINI_FLASH_API_KEY',
  'DOCUMENT_PRIMARY_PROVIDER',
  'EVALUATION_PRIMARY_PROVIDER',
  'FORCE_OPENAI',
  'DOCUMENT_PRIMARY_MODEL',
  'DOCUMENT_FALLBACK_MODEL',
  'MODEL_REQUEST_MAX_RETRIES',
  'MODEL_REQUEST_TIMEOUT_MS',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/** What @google/genai throws for a non-2xx generateContent response (see throwErrorIfNotOK). */
function geminiApiError(httpStatus: number, status: string, message: string): ApiError {
  return new ApiError({
    status: httpStatus,
    message: JSON.stringify({ error: { code: httpStatus, message, status } }),
  });
}

const gemini504 = () => geminiApiError(504, 'DEADLINE_EXCEEDED', 'Deadline expired before operation could complete.');
const gemini503 = () => geminiApiError(503, 'UNAVAILABLE', 'The model is overloaded. Please try again later.');
const gemini400 = () => geminiApiError(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.');

function openAiResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function useGeminiFirstDocumentRoute(): void {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.DOCUMENT_PRIMARY_PROVIDER = 'gemini';
  process.env.DOCUMENT_PRIMARY_MODEL = 'gemini-primary';
  process.env.DOCUMENT_FALLBACK_MODEL = 'gpt-fallback';
  delete process.env.FORCE_OPENAI;
}

describe('classifyGeminiError', () => {
  it('treats SDK 504 DEADLINE_EXCEEDED and 503 UNAVAILABLE errors as retryable server errors', async () => {
    const { classifyGeminiError } = await import('../../services/agent.js');
    const err504 = gemini504();
    expect(err504.name).toBe('ApiError');
    expect(err504.status).toBe(504);
    expect(err504.message).toContain('"status":"DEADLINE_EXCEEDED"');
    expect(classifyGeminiError(err504)).toMatchObject({ serverError: true, retryable: true });
    expect(classifyGeminiError(gemini503())).toMatchObject({ serverError: true, retryable: true });
    expect(classifyGeminiError(geminiApiError(500, 'INTERNAL', 'An internal error has occurred.'))).toMatchObject({ retryable: true });
    expect(classifyGeminiError(geminiApiError(502, 'UNKNOWN', 'Bad gateway'))).toMatchObject({ retryable: true });
  });

  it('recognises server errors from the message alone when no HTTP status is attached', async () => {
    const { classifyGeminiError } = await import('../../services/agent.js');
    expect(classifyGeminiError(new Error('got status: DEADLINE_EXCEEDED.'))).toMatchObject({ retryable: true });
    expect(classifyGeminiError(new Error('got status: UNAVAILABLE.'))).toMatchObject({ retryable: true });
    expect(classifyGeminiError(new Error('{"error":{"status":"INTERNAL"}}'))).toMatchObject({ retryable: true });
    expect(classifyGeminiError(new Error('The model is overloaded'))).toMatchObject({ retryable: true });
    // "internal" as an ordinary lowercase word is not the INTERNAL status.
    expect(classifyGeminiError(new Error('invalid internal reference in schema'))).toMatchObject({ retryable: false });
  });

  it('does not retry a 400 INVALID_ARGUMENT or an exhausted daily quota', async () => {
    const { classifyGeminiError } = await import('../../services/agent.js');
    expect(classifyGeminiError(gemini400())).toMatchObject({ serverError: false, retryable: false });
    const dailyQuota = geminiApiError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric GenerateRequestsPerDay');
    expect(classifyGeminiError(dailyQuota)).toMatchObject({ dailyQuota: true, retryable: false });
  });
});

describe('generateContentAudited model-call robustness', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    geminiMock.generateContent.mockReset();
    routeRegistryMock.recordModelRouteInvocation.mockClear();
    restoreEnv();
  });

  it('retries a Gemini 504 DEADLINE_EXCEEDED with backoff and succeeds on the same model', async () => {
    useGeminiFirstDocumentRoute();
    process.env.MODEL_REQUEST_MAX_RETRIES = '3';
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    geminiMock.generateContent.mockRejectedValueOnce(gemini504()).mockResolvedValueOnce({ text: '{"ok":true}' });

    const { generateContentAudited } = await import('../../services/agent.js');
    const pending = generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.' });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-primary', fallbackUsed: false, attempts: 1 });
  });

  it('does not retry a Gemini 400 and moves straight to the next provider', async () => {
    useGeminiFirstDocumentRoute();
    process.env.MODEL_REQUEST_MAX_RETRIES = '3';
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => openAiResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    geminiMock.generateContent.mockRejectedValue(gemini400());

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({ purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.' });

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-fallback', fallbackUsed: true });
  });

  it('tries the secondary Gemini model before OpenAI and reports it on success', async () => {
    useGeminiFirstDocumentRoute();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    geminiMock.generateContent.mockImplementation(async (request: { model: string }) => {
      if (request.model === 'gemini-primary') throw gemini400();
      return { text: '{"ok":"secondary"}' };
    });

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT',
      model: 'gemini-primary',
      contents: 'Write.',
      maxRetries: 1,
      secondaryGeminiModel: 'gemini-secondary',
      validateResponseText: (text) => JSON.parse(text),
      clientOrPool: {} as any,
      context: { workspaceId: 'ws-1' } as any,
    });

    expect(geminiMock.generateContent.mock.calls.map(([request]) => request.model)).toEqual(['gemini-primary', 'gemini-secondary']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: 'gemini',
      model: 'gemini-secondary',
      fallbackUsed: true,
      attempts: 2,
      validatedPayload: { ok: 'secondary' },
    });
    expect(result.errors).toEqual([
      expect.objectContaining({ provider: 'gemini', model: 'gemini-primary', error: expect.stringContaining('INVALID_ARGUMENT') }),
    ]);
    const invocation = (routeRegistryMock.recordModelRouteInvocation.mock.calls[0] as unknown[])[0] as any;
    expect(invocation).toMatchObject({ provider: 'gemini', model: 'gemini-secondary', status: 'COMPLETED', fallbackUsed: true });
    expect(invocation.requestMetadata).toMatchObject({ secondary_gemini_model: 'gemini-secondary', model_request_max_retries: 1 });
    expect(invocation.responseMetadata.provider_attempts.map((attempt: any) => [attempt.model, attempt.status])).toEqual([
      ['gemini-primary', 'FAILED'],
      ['gemini-secondary', 'COMPLETED'],
    ]);
  });

  it('falls back to OpenAI only after the secondary Gemini model also fails, recording every failure', async () => {
    useGeminiFirstDocumentRoute();
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => openAiResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    geminiMock.generateContent.mockRejectedValue(gemini400());

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT',
      model: 'gemini-primary',
      contents: 'Write.',
      maxRetries: 1,
      secondaryGeminiModel: 'gemini-secondary',
    });

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ provider: 'openai', model: 'gpt-fallback', attempts: 3 });
    expect(result.errors.map((error) => `${error.provider}:${error.model}`)).toEqual(['gemini:gemini-primary', 'gemini:gemini-secondary']);
  });

  it('does not try the secondary model twice when it equals the route model', async () => {
    useGeminiFirstDocumentRoute();
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => openAiResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    geminiMock.generateContent.mockRejectedValue(gemini400());

    const { generateContentAudited } = await import('../../services/agent.js');
    await generateContentAudited({
      purpose: 'DOCUMENT',
      model: 'gemini-primary',
      contents: 'Write.',
      maxRetries: 1,
      secondaryGeminiModel: 'gemini-primary',
    });

    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
  });

  it('passes a per-call timeout and attempt limit to both providers and records the effective values', async () => {
    useGeminiFirstDocumentRoute();
    process.env.MODEL_REQUEST_TIMEOUT_MS = '60000';
    process.env.MODEL_REQUEST_MAX_RETRIES = '3';
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => openAiResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    geminiMock.generateContent.mockRejectedValue(gemini400());

    const { generateContentAudited } = await import('../../services/agent.js');
    await generateContentAudited({
      purpose: 'DOCUMENT',
      model: 'gemini-primary',
      contents: 'Write.',
      timeoutMs: 20000,
      maxRetries: 2,
      clientOrPool: {} as any,
      context: { workspaceId: 'ws-1' } as any,
    });

    expect(geminiMock.generateContent.mock.calls[0][0].config.httpOptions).toEqual({ timeout: 20000 });
    expect(timeoutSpy).toHaveBeenCalledWith(20000);
    expect(timeoutSpy).not.toHaveBeenCalledWith(60000);
    const invocation = (routeRegistryMock.recordModelRouteInvocation.mock.calls[0] as unknown[])[0] as any;
    expect(invocation.requestMetadata).toMatchObject({ model_request_timeout_ms: 20000, model_request_max_retries: 2 });
    expect(invocation.responseMetadata.provider_attempts.map((attempt: any) => attempt.maxAttempts)).toEqual([2, 2]);
  });

  it('keeps the env defaults and metadata for callers that pass no per-call options', async () => {
    useGeminiFirstDocumentRoute();
    process.env.MODEL_REQUEST_TIMEOUT_MS = '61000';
    process.env.MODEL_REQUEST_MAX_RETRIES = '1';
    vi.stubGlobal('fetch', vi.fn());
    geminiMock.generateContent.mockResolvedValue({ text: 'done' });

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT',
      model: 'gemini-primary',
      contents: 'Write.',
      clientOrPool: {} as any,
      context: { workspaceId: 'ws-1' } as any,
    });

    expect(geminiMock.generateContent.mock.calls[0][0].config.httpOptions).toEqual({ timeout: 61000 });
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-primary', fallbackUsed: false, attempts: 1 });
    const invocation = (routeRegistryMock.recordModelRouteInvocation.mock.calls[0] as unknown[])[0] as any;
    expect(invocation.requestMetadata).toMatchObject({ model_request_timeout_ms: 61000, model_request_max_retries: 1 });
    expect(invocation.requestMetadata).not.toHaveProperty('secondary_gemini_model');
  });
});
