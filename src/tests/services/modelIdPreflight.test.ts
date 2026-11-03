import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkConfiguredModelIds,
  configuredModelIds,
  logModelIdPreflight,
} from '../../services/modelIdPreflight.js';

const GEMINI_KEY = 'gemini-secret-key-123';
const OPENAI_KEY = 'sk-openai-secret-456';

const GEMINI_DEFAULT_IDS = ['gemini-3.6-flash', 'gemini-embedding-001', 'gemini-3.5-flash-lite'];
const OPENAI_DEFAULT_IDS = ['gpt-4o-mini', 'text-embedding-3-small', 'gpt-5.6-luna'];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Gemini returns two pages; OpenAI one list. Records every request for header checks. */
function providerFetch(options: { geminiIds?: string[]; openaiIds?: string[] } = {}) {
  const geminiIds = options.geminiIds ?? GEMINI_DEFAULT_IDS;
  const openaiIds = options.openaiIds ?? OPENAI_DEFAULT_IDS;
  return vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const names = geminiIds.map((id) => ({ name: `models/${id}` }));
      if (!url.searchParams.get('pageToken')) {
        return json({ models: names.slice(0, 1), nextPageToken: 'page-2' });
      }
      return json({ models: names.slice(1) });
    }
    if (url.hostname === 'api.openai.com') {
      return json({ object: 'list', data: openaiIds.map((id) => ({ id, object: 'model' })) });
    }
    throw new Error(`unexpected URL ${url}`);
  });
}

const bothKeys = { GEMINI_API_KEY: GEMINI_KEY, OPENAI_API_KEY: OPENAI_KEY } as NodeJS.ProcessEnv;

describe('model id preflight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the same ids as MODEL_REGISTRY for the current environment', async () => {
    const { MODEL_REGISTRY } = await import('../../services/agent.js');
    const configured = configuredModelIds(process.env);
    const has = (provider: string, id: string) => configured.some((entry) => entry.provider === provider && entry.id === id);
    expect(has('gemini', MODEL_REGISTRY.EVALUATION_PRIMARY_MODEL)).toBe(true);
    expect(has('gemini', MODEL_REGISTRY.DOCUMENT_PRIMARY_MODEL)).toBe(true);
    expect(has('gemini', MODEL_REGISTRY.EMBEDDING_PRIMARY_MODEL)).toBe(true);
    expect(has('gemini', MODEL_REGISTRY.EXTRACTION_GEMINI_MODEL)).toBe(true);
    expect(has('openai', MODEL_REGISTRY.EVALUATION_FALLBACK_MODEL)).toBe(true);
    expect(has('openai', MODEL_REGISTRY.DOCUMENT_FALLBACK_MODEL)).toBe(true);
    expect(has('openai', MODEL_REGISTRY.EMBEDDING_FALLBACK_MODEL)).toBe(true);
    expect(has('openai', MODEL_REGISTRY.EXTRACTION_OPENAI_MODEL)).toBe(true);
  });

  it('reports an unknown id with the env var that set it and ignores known ids', async () => {
    const fetchMock = providerFetch();
    const result = await checkConfiguredModelIds({
      env: { ...bothKeys, OPENAI_MODEL: 'gpt-6-Luna' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.warnings).toEqual([]);
    expect(result.checked).toEqual(['gemini', 'openai']);
    expect(result.unknown).toHaveLength(1);
    expect(result.unknown[0]).toMatchObject({ provider: 'openai', id: 'gpt-6-Luna', sources: ['OPENAI_MODEL'] });
    expect(result.unknown[0].message).toBe(
      'Model id "gpt-6-Luna" (OPENAI_MODEL) is not available on your OpenAI account; fix it in .env.local or remove the line to use the default.'
    );

    // Gemini pagination was followed and the key travelled only in headers.
    const geminiCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('generativelanguage'));
    expect(geminiCalls).toHaveLength(2);
    expect(String(geminiCalls[1][0])).toContain('pageToken=page-2');
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(GEMINI_KEY);
      expect(String(url)).not.toContain(OPENAI_KEY);
      const headers = init?.headers as Record<string, string>;
      if (String(url).includes('generativelanguage')) expect(headers['x-goog-api-key']).toBe(GEMINI_KEY);
      else expect(headers.Authorization).toBe(`Bearer ${OPENAI_KEY}`);
    }
  });

  it('labels an unknown code default "(default)" and names every env var sharing an id', async () => {
    const result = await checkConfiguredModelIds({
      env: { ...bothKeys, DOCUMENT_SECONDARY_GEMINI_MODEL: 'gemini-typo', EXTRACTION_GEMINI_MODEL: 'gemini-typo' },
      fetchImpl: providerFetch({ openaiIds: ['gpt-4o-mini', 'text-embedding-3-small'] }) as unknown as typeof fetch,
    });

    expect(result.unknown.map((entry) => [entry.id, entry.sources])).toEqual([
      ['gemini-typo', ['EXTRACTION_GEMINI_MODEL', 'DOCUMENT_SECONDARY_GEMINI_MODEL']],
      ['gpt-5.6-luna', ['(default)']],
    ]);
    expect(result.unknown[1].message).toBe(
      'Model id "gpt-5.6-luna" (default) is not available on your OpenAI account; set a supported model id in .env.local.'
    );
  });

  it('skips providers without a key', async () => {
    const fetchMock = providerFetch();
    const result = await checkConfiguredModelIds({
      env: { GEMINI_API_KEY: 'MY_GEMINI_API_KEY', OPENAI_API_KEY: OPENAI_KEY },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result.skipped).toEqual(['gemini']);
    expect(result.checked).toEqual(['openai']);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('api.openai.com'))).toBe(true);
  });

  it('degrades a network failure or auth error to a key-free warning instead of throwing', async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes('generativelanguage')) {
        throw new TypeError(`fetch failed for key ${GEMINI_KEY}`);
      }
      return json({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }, 401);
    });

    const result = await checkConfiguredModelIds({ env: bothKeys, fetchImpl: fetchMock as unknown as typeof fetch });

    expect(result.unknown).toEqual([]);
    expect(result.checked).toEqual([]);
    expect(result.warnings).toEqual([
      'could not check Gemini models: fetch failed for key [redacted]',
      'could not check OpenAI models: HTTP 401',
    ]);
    expect(JSON.stringify(result)).not.toContain(GEMINI_KEY);
    expect(JSON.stringify(result)).not.toContain(OPENAI_KEY);
  });

  it('logs one line per unknown id and per warning at startup', async () => {
    const logger = { warn: vi.fn() };
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes('generativelanguage')) return json({ unexpected: true });
      return json({ data: OPENAI_DEFAULT_IDS.map((id) => ({ id })) });
    });

    await logModelIdPreflight({
      env: { ...bothKeys, OPENAI_MODEL: 'gpt-6-Luna' },
      fetchImpl: fetchMock as unknown as typeof fetch,
      logger,
    });

    expect(logger.warn.mock.calls.map(([line]) => line)).toEqual([
      '[models] Model id "gpt-6-Luna" (OPENAI_MODEL) is not available on your OpenAI account; fix it in .env.local or remove the line to use the default.',
      '[models] could not check Gemini models: response has no models array',
    ]);
  });
});
