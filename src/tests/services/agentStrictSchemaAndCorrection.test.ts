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
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
  return {
    ApiError: actual.ApiError,
    GoogleGenAI: vi.fn(function GoogleGenAIMock(this: any) {
      this.models = { generateContent: geminiMock.generateContent, embedContent: vi.fn() };
    }),
    Type: {},
    FunctionDeclaration: vi.fn(),
  };
});

vi.mock('../../modelRoutes/registry.js', () => routeRegistryMock);

import { ApiError } from '@google/genai';
import { openAiStrictSchema } from '../../services/agent.js';
import { coverLetterProviderSchema, summaryProviderSchema } from '../../documents/manualCoverLetter.js';
import { pairingProviderSchema } from '../../documents/manualEvidencePairing.js';
import { quotedRequirementProviderSchema } from '../../requirements/quotedProvider.js';

const ENV_KEYS = [
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_FLASH_API_KEY', 'DOCUMENT_PRIMARY_PROVIDER', 'EVALUATION_PRIMARY_PROVIDER',
  'FORCE_OPENAI', 'DOCUMENT_PRIMARY_MODEL', 'DOCUMENT_FALLBACK_MODEL', 'MODEL_REQUEST_MAX_RETRIES', 'MODEL_REQUEST_TIMEOUT_MS',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function useDocumentRoute(primary: 'gemini' | 'openai'): void {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.DOCUMENT_PRIMARY_PROVIDER = primary;
  process.env.DOCUMENT_PRIMARY_MODEL = 'gemini-primary';
  process.env.DOCUMENT_FALLBACK_MODEL = 'gpt-fallback';
  delete process.env.FORCE_OPENAI;
}

function openAiResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

const gemini400 = () => new ApiError({
  status: 400,
  message: JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }),
});

// OpenAI's strict structured-output rules, checked at every level of a converted schema.
const UNSUPPORTED = ['minLength', 'maxLength'];
function strictViolations(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema)) return schema.flatMap((item, index) => strictViolations(item, `${path}[${index}]`));
  if (!schema || typeof schema !== 'object') return [];
  const node = schema as Record<string, any>;
  const issues: string[] = [];
  for (const keyword of UNSUPPORTED) if (keyword in node) issues.push(`${path}: unsupported keyword ${keyword}`);
  if (node.type === 'object' || node.properties) {
    if (node.additionalProperties !== false) issues.push(`${path}: additionalProperties must be false`);
    const keys = Object.keys(node.properties ?? {}).sort();
    if (JSON.stringify([...(node.required ?? [])].sort()) !== JSON.stringify(keys)) issues.push(`${path}: required must list every property`);
    for (const [name, child] of Object.entries(node.properties ?? {})) issues.push(...strictViolations(child, `${path}.properties.${name}`));
  }
  for (const key of ['items', 'anyOf']) if (key in node) issues.push(...strictViolations(node[key], `${path}.${key}`));
  return issues;
}

describe('openAiStrictSchema', () => {
  it.each([
    ['cover letter', coverLetterProviderSchema],
    ['CV summary', summaryProviderSchema],
    ['evidence pairing', pairingProviderSchema],
    ['quoted requirements', quotedRequirementProviderSchema],
  ])('makes the %s schema satisfy OpenAI strict mode at every level', (_name, schema) => {
    expect(strictViolations(openAiStrictSchema(schema))).toEqual([]);
  });

  it('sends the optional gap_note as required but nullable, and leaves the original schema untouched', () => {
    const before = JSON.stringify(coverLetterProviderSchema);
    const strict = openAiStrictSchema(coverLetterProviderSchema) as any;

    expect(strict.required).toEqual(['schema_version', 'opening', 'gap_note', 'paragraphs']);
    expect(strict.properties.gap_note.anyOf).toEqual([expect.objectContaining({ type: 'object' }), { type: 'null' }]);
    expect(strict.properties.opening.anyOf).toBeUndefined();
    // Array bounds and enums stay; string length bounds go.
    expect(strict.properties.paragraphs).toMatchObject({ minItems: 2, maxItems: 5 });
    expect(strict.properties.schema_version.enum).toEqual(coverLetterProviderSchema.properties.schema_version.enum);
    expect(JSON.stringify(coverLetterProviderSchema)).toBe(before);
  });

  it('closes an object schema that declared no properties list', () => {
    expect(openAiStrictSchema({ type: 'object' })).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false });
  });
});

describe('generateContentAudited: strict OpenAI schema and correction round', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    geminiMock.generateContent.mockReset();
    routeRegistryMock.recordModelRouteInvocation.mockClear();
    restoreEnv();
  });

  // Accepts {"ok": true} only, so a test can make a model's first answer fail validation.
  const okValidator = (text: string) => {
    const payload = JSON.parse(text) as { ok?: unknown };
    if (payload.ok !== true) throw new Error('Letter validation failed: ok must be true.');
    return payload;
  };

  it('sends OpenAI the strict form of the caller schema; Gemini keeps the original', async () => {
    useDocumentRoute('gemini');
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => openAiResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    geminiMock.generateContent.mockRejectedValue(gemini400());

    const agent = await import('../../services/agent.js');
    await agent.generateContentAudited({
      purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.', maxRetries: 1,
      responseMimeType: 'application/json', responseSchema: coverLetterProviderSchema,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(body.response_format.json_schema.schema).toEqual(agent.openAiStrictSchema(coverLetterProviderSchema));
    expect(geminiMock.generateContent.mock.calls[0][0].config.responseSchema.required).toEqual(['schema_version', 'opening', 'paragraphs']);
  });

  it('asks the same Gemini model to correct an answer that failed validation, citing the reason', async () => {
    useDocumentRoute('gemini');
    vi.stubGlobal('fetch', vi.fn());
    geminiMock.generateContent
      .mockResolvedValueOnce({ text: '{"ok":false}' })
      .mockResolvedValueOnce({ text: '{"ok":true}' });

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write the letter.', maxRetries: 1,
      secondaryGeminiModel: 'gemini-secondary', validateResponseText: okValidator, correctOnValidationFailure: true,
      clientOrPool: {} as any, context: { workspaceId: 'ws-1' } as any,
    });

    const calls = geminiMock.generateContent.mock.calls.map(([request]) => request);
    expect(calls.map((request) => request.model)).toEqual(['gemini-primary', 'gemini-primary']);
    expect(calls[1].contents).toContain('Write the letter.');
    expect(calls[1].contents).toContain('Your previous answer was rejected for these reasons:\nLetter validation failed: ok must be true.');
    expect(calls[1].contents).toContain('Your previous answer:\n{"ok":false}');
    expect(result).toMatchObject({ provider: 'gemini', model: 'gemini-primary', fallbackUsed: false, attempts: 2, validatedPayload: { ok: true } });
    expect(result.errors).toEqual([expect.objectContaining({ model: 'gemini-primary', error: expect.stringContaining('ok must be true') })]);
    const invocation = (routeRegistryMock.recordModelRouteInvocation.mock.calls[0] as unknown[])[0] as any;
    expect(invocation.requestMetadata).toMatchObject({ correct_on_validation_failure: true });
  });

  it('moves to the secondary Gemini model when the corrected answer also fails', async () => {
    useDocumentRoute('gemini');
    vi.stubGlobal('fetch', vi.fn());
    geminiMock.generateContent.mockImplementation(async (request: { model: string }) =>
      ({ text: request.model === 'gemini-secondary' ? '{"ok":true}' : '{"ok":false}' }));

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.', maxRetries: 1,
      secondaryGeminiModel: 'gemini-secondary', validateResponseText: okValidator, correctOnValidationFailure: true,
    });

    expect(geminiMock.generateContent.mock.calls.map(([request]) => request.model)).toEqual(['gemini-primary', 'gemini-primary', 'gemini-secondary']);
    expect(result).toMatchObject({ model: 'gemini-secondary', attempts: 3 });
  });

  it('keeps the previous behaviour when the option is off', async () => {
    useDocumentRoute('gemini');
    vi.stubGlobal('fetch', vi.fn());
    geminiMock.generateContent.mockImplementation(async (request: { model: string }) =>
      ({ text: request.model === 'gemini-secondary' ? '{"ok":true}' : '{"ok":false}' }));

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.', maxRetries: 1,
      secondaryGeminiModel: 'gemini-secondary', validateResponseText: okValidator,
    });

    expect(geminiMock.generateContent.mock.calls.map(([request]) => request.model)).toEqual(['gemini-primary', 'gemini-secondary']);
    expect(result).toMatchObject({ model: 'gemini-secondary', attempts: 2 });
  });

  it('never runs a correction round for a provider error', async () => {
    useDocumentRoute('gemini');
    vi.stubGlobal('fetch', vi.fn());
    geminiMock.generateContent.mockImplementation(async (request: { model: string }) => {
      if (request.model === 'gemini-primary') throw gemini400();
      return { text: '{"ok":true}' };
    });

    const { generateContentAudited } = await import('../../services/agent.js');
    await generateContentAudited({
      purpose: 'DOCUMENT', model: 'gemini-primary', contents: 'Write.', maxRetries: 1,
      secondaryGeminiModel: 'gemini-secondary', validateResponseText: okValidator, correctOnValidationFailure: true,
    });

    expect(geminiMock.generateContent.mock.calls.map(([request]) => request.model)).toEqual(['gemini-primary', 'gemini-secondary']);
  });

  it('runs the correction round on OpenAI too', async () => {
    useDocumentRoute('openai');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(openAiResponse('{"ok":false}'))
      .mockResolvedValueOnce(openAiResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    const { generateContentAudited } = await import('../../services/agent.js');
    const result = await generateContentAudited({
      purpose: 'DOCUMENT', model: 'gpt-fallback', contents: 'Write.', maxRetries: 1,
      validateResponseText: okValidator, correctOnValidationFailure: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(second.messages.at(-1).content).toContain('ok must be true');
    expect(geminiMock.generateContent).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: 'openai', attempts: 2 });
  });
});
