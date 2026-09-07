import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateContentAudited } from '../../services/agent.js';

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_FLASH_API_KEY: process.env.GEMINI_FLASH_API_KEY,
  EVALUATION_PRIMARY_PROVIDER: process.env.EVALUATION_PRIMARY_PROVIDER,
  MODEL_REQUEST_MAX_RETRIES: process.env.MODEL_REQUEST_MAX_RETRIES,
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
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_FLASH_API_KEY;

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
  });
});
