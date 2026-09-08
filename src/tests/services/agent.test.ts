import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateContentAudited } from '../../services/agent.js';

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_FLASH_API_KEY: process.env.GEMINI_FLASH_API_KEY,
  EVALUATION_PRIMARY_PROVIDER: process.env.EVALUATION_PRIMARY_PROVIDER,
  REQUIREMENTS_PRIMARY_PROVIDER: process.env.REQUIREMENTS_PRIMARY_PROVIDER,
  REQUIREMENTS_OPENAI_MODEL: process.env.REQUIREMENTS_OPENAI_MODEL,
  REQUIREMENTS_GEMINI_MODEL: process.env.REQUIREMENTS_GEMINI_MODEL,
  EXTRACTION_PRIMARY_PROVIDER: process.env.EXTRACTION_PRIMARY_PROVIDER,
  EXTRACTION_OPENAI_MODEL: process.env.EXTRACTION_OPENAI_MODEL,
  EXTRACTION_GEMINI_MODEL: process.env.EXTRACTION_GEMINI_MODEL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  MODEL_REQUEST_MAX_RETRIES: process.env.MODEL_REQUEST_MAX_RETRIES,
  MODEL_REQUEST_TIMEOUT_MS: process.env.MODEL_REQUEST_TIMEOUT_MS,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('generateContentAudited retry policy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv();
  });

  it('does not retry non-retryable OpenAI 400 schema errors', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
    process.env.MODEL_REQUEST_MAX_RETRIES = '3';
    process.env.MODEL_REQUEST_TIMEOUT_MS = '12000';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Invalid schema for response_format 'extraction'",
            type: 'invalid_request_error',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateContentAudited({
        purpose: 'EXTRACTION',
        routeKey: 'extraction',
        model: 'gpt-4o-mini',
        contents: 'Return JSON.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok'],
          properties: { ok: { type: 'string' } },
        },
      })
    ).rejects.toThrow(/status 400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(12000);
  });

  it('routes extraction through the requirements OpenAI model instead of the global evaluation model', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.EVALUATION_PRIMARY_PROVIDER = 'openai';
    process.env.REQUIREMENTS_PRIMARY_PROVIDER = 'openai';
    process.env.OPENAI_MODEL = 'gpt-5.6-sol';
    process.env.REQUIREMENTS_OPENAI_MODEL = 'gpt-5.6-luna';
    process.env.MODEL_REQUEST_MAX_RETRIES = '3';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":"yes"}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateContentAudited({
      purpose: 'EXTRACTION',
      routeKey: 'requirements_extraction',
      model: '',
      contents: 'Return JSON.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'string' } },
      },
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(requestBody.model).toBe('gpt-5.6-luna');
    expect(requestBody.model).not.toBe('gpt-5.6-sol');
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5.6-luna');
    expect(result.attempts).toBe(1);
  });
});
