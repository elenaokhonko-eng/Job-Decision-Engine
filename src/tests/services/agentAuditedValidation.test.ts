import { afterEach, describe, expect, it, vi } from 'vitest';

const geminiMock = vi.hoisted(() => ({
  generateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function GoogleGenAIMock(this: any) {
    this.models = {
      generateContent: geminiMock.generateContent,
      embedContent: vi.fn(),
    };
  }),
  Type: {},
  FunctionDeclaration: vi.fn(),
}));

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_FLASH_API_KEY: process.env.GEMINI_FLASH_API_KEY,
  REQUIREMENTS_PRIMARY_PROVIDER: process.env.REQUIREMENTS_PRIMARY_PROVIDER,
  REQUIREMENTS_OPENAI_MODEL: process.env.REQUIREMENTS_OPENAI_MODEL,
  REQUIREMENTS_GEMINI_MODEL: process.env.REQUIREMENTS_GEMINI_MODEL,
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

describe('generateContentAudited response validation fallback', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    geminiMock.generateContent.mockReset();
    restoreEnv();
  });

  it('tries the fallback provider when the primary provider returns invalid JSON payload semantics', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.REQUIREMENTS_PRIMARY_PROVIDER = 'openai';
    process.env.REQUIREMENTS_OPENAI_MODEL = 'gpt-4o-mini';
    process.env.REQUIREMENTS_GEMINI_MODEL = 'gemini-3.6-flash';
    process.env.MODEL_REQUEST_MAX_RETRIES = '1';

    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"wrong":true}' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    geminiMock.generateContent.mockResolvedValue({
      text: '{"ok":"yes"}',
    });

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'EXTRACTION',
      routeKey: 'requirements_extraction',
      model: 'gpt-4o-mini',
      contents: 'Return JSON.',
      responseMimeType: 'application/json',
      validateResponseText: (text) => {
        const parsed = JSON.parse(text) as { ok?: string };
        if (parsed.ok !== 'yes') {
          throw new Error('validated payload missing ok=yes');
        }
        return parsed;
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(geminiMock.generateContent).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('gemini');
    expect(result.model).toBe('gemini-3.6-flash');
    expect(result.fallbackUsed).toBe(true);
    expect(result.validatedPayload).toEqual({ ok: 'yes' });
    expect(result.errors[0].error).toContain('validated payload missing ok=yes');
  });
});
