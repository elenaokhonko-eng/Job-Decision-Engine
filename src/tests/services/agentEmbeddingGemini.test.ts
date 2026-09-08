import { afterEach, describe, expect, it, vi } from 'vitest';

const geminiMock = vi.hoisted(() => ({
  embedContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function GoogleGenAIMock(this: any) {
    this.models = {
      embedContent: geminiMock.embedContent,
    };
  }),
  Type: {},
  FunctionDeclaration: vi.fn(),
}));

const originalEnv = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_FLASH_API_KEY: process.env.GEMINI_FLASH_API_KEY,
  GEMINI_API_VERSION: process.env.GEMINI_API_VERSION,
  EMBEDDING_REQUEST_TIMEOUT_MS: process.env.EMBEDDING_REQUEST_TIMEOUT_MS,
  EMBEDDING_PRIMARY_DIMENSIONS: process.env.EMBEDDING_PRIMARY_DIMENSIONS,
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

describe('Gemini embedding timeout', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    geminiMock.embedContent.mockReset();
    restoreEnv();
  });

  it('passes abort and HTTP timeout options to embedContent', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    geminiMock.embedContent.mockResolvedValue({
      embeddings: [{ values: [0.1, 0.2, 0.3] }],
    });

    const { generateEmbeddingWithProviderAndModel } = await import('../../services/agent.js');
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    delete process.env.GEMINI_FLASH_API_KEY;
    process.env.EMBEDDING_REQUEST_TIMEOUT_MS = '8000';
    process.env.EMBEDDING_PRIMARY_DIMENSIONS = '3';

    const vector = await generateEmbeddingWithProviderAndModel(
      'embedding input',
      'gemini',
      'gemini-embedding-001'
    );

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(timeoutSpy).toHaveBeenCalledWith(8000);
    expect(geminiMock.embedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-embedding-001',
        contents: 'embedding input',
        config: expect.objectContaining({
        outputDimensionality: 3,
        abortSignal: expect.any(AbortSignal),
        httpOptions: { timeout: 8000 },
        }),
      })
    );
  });
});
