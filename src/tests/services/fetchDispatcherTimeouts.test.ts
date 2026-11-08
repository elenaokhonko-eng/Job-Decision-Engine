import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureFetchDispatcherTimeouts,
  resetFetchDispatcherTimeoutsForTests,
} from '../../services/fetchDispatcherTimeouts.js';

const GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1');
const globals = globalThis as unknown as Record<PropertyKey, unknown>;
let originalDispatcher: unknown;

beforeEach(async () => {
  // Make sure Node's own dispatcher exists, then remember it so every test can restore it.
  await fetch('http://127.0.0.1/', { signal: AbortSignal.abort() }).catch((error: unknown) => {
    if ((error as { name?: string }).name !== 'AbortError') throw error;
  });
  originalDispatcher = globals[GLOBAL_DISPATCHER];
  resetFetchDispatcherTimeoutsForTests();
});

afterEach(() => {
  globals[GLOBAL_DISPATCHER] = originalDispatcher;
  resetFetchDispatcherTimeoutsForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ensureFetchDispatcherTimeouts', () => {
  it('replaces the default Agent with one whose headers/body timeouts cover the Flex request, and never shortens them', async () => {
    class Agent {
      constructor(readonly options: Record<string, number> = {}) {}
    }
    globals[GLOBAL_DISPATCHER] = new Agent();

    await expect(ensureFetchDispatcherTimeouts(630_000)).resolves.toBe('REPLACED');
    expect((globals[GLOBAL_DISPATCHER] as Agent).options).toEqual({ headersTimeout: 630_000, bodyTimeout: 630_000 });

    const replaced = globals[GLOBAL_DISPATCHER];
    await expect(ensureFetchDispatcherTimeouts(600_000)).resolves.toBe('ALREADY_SUFFICIENT');
    expect(globals[GLOBAL_DISPATCHER]).toBe(replaced);

    await expect(ensureFetchDispatcherTimeouts(1_830_000)).resolves.toBe('REPLACED');
    expect((globals[GLOBAL_DISPATCHER] as Agent).options).toEqual({ headersTimeout: 1_830_000, bodyTimeout: 1_830_000 });
  });

  it('leaves a dispatcher it does not recognise (e.g. a proxy agent) alone and says so', async () => {
    class ProxyAgent {}
    const proxy = new ProxyAgent();
    globals[GLOBAL_DISPATCHER] = proxy;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(ensureFetchDispatcherTimeouts(630_000)).resolves.toBe('UNSUPPORTED');
    expect(globals[GLOBAL_DISPATCHER]).toBe(proxy);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not Node's default Agent"));
    await expect(ensureFetchDispatcherTimeouts(0)).rejects.toThrow(RangeError);
  });

  it("lifts Node's fetch headers timeout for real (loopback server, no external network)", async () => {
    const server = http.createServer((_request, response) => {
      setTimeout(() => response.end('ok'), 1_500);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const NodeAgent = (originalDispatcher as { constructor: new (options: object) => unknown }).constructor;
      // A short headers timeout stands in for undici's 300 s default.
      globals[GLOBAL_DISPATCHER] = new NodeAgent({ headersTimeout: 300, bodyTimeout: 300 });
      const cut = await fetch(url).then(() => null, (error: { cause?: { code?: string } }) => error);
      expect(cut?.cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT');

      await expect(ensureFetchDispatcherTimeouts(10_000)).resolves.toBe('REPLACED');
      const response = await fetch(url);
      await expect(response.text()).resolves.toBe('ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('@google/genai server timeout header', () => {
  async function wireHeaders(httpOptions: { timeout: number; headers?: Record<string, string> }): Promise<Headers> {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const ai = new GoogleGenAI({ apiKey: 'synthetic-test-key' });
    await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: 'x', config: { httpOptions } });
    return new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
  }

  it('sends X-Server-Timeout in seconds, once, from the request timeout (600 for a Flex request)', async () => {
    const flex = await wireHeaders({
      timeout: 600_000,
      headers: { 'X-Vertex-AI-LLM-Request-Type': 'shared', 'X-Vertex-AI-LLM-Shared-Request-Type': 'flex' },
    });
    expect(flex.get('X-Server-Timeout')).toBe('600');
    expect(flex.get('X-Vertex-AI-LLM-Shared-Request-Type')).toBe('flex');
    expect(flex.get('X-Vertex-AI-LLM-Request-Type')).toBe('shared');

    // A non-Flex request carries its own 60 s value and no Flex headers.
    const standard = await wireHeaders({ timeout: 60_000 });
    expect(standard.get('X-Server-Timeout')).toBe('60');
    expect(standard.get('X-Vertex-AI-LLM-Shared-Request-Type')).toBeNull();
  });
});
