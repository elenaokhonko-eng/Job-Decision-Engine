import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateContentAudited, geminiResponseSchema } from '../../services/agent.js';
import { quotedRequirementProviderSchema } from '../../requirements/quotedProvider.js';
import { MAX_QUOTED_REQUIREMENTS, validateQuotedRequirements } from '../../requirements/quotedRequirementExtractor.js';

const ENV_KEYS = ['GEMINI_API_KEY', 'GEMINI_FLASH_API_KEY', 'OPENAI_API_KEY', 'REQUIREMENTS_PRIMARY_PROVIDER', 'EXTRACTION_PRIMARY_PROVIDER', 'MODEL_REQUEST_MAX_RETRIES'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function keysIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysIn(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysIn(child, found);
    }
  }
  return found;
}

describe('Gemini response schema', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('drops array caps, which Gemini rejects with 400 INVALID_ARGUMENT, and keeps everything else', () => {
    const sent = geminiResponseSchema(quotedRequirementProviderSchema) as any;
    expect(keysIn(sent).has('maxItems')).toBe(false);
    expect(sent.properties.requirements.minItems).toBe(1);
    expect(sent.properties.requirements.items.properties.importance.enum).toEqual(['MUST', 'PREFERRED', 'NICE_TO_HAVE']);
    expect(sent.properties.requirements.items.properties.requirement_key.pattern).toBe('^R-[0-9]{3}$');
    // The shared schema object is not mutated.
    expect(quotedRequirementProviderSchema.properties.requirements.maxItems).toBe(MAX_QUOTED_REQUIREMENTS);
    // A field that happens to be called maxItems is a property name, not a constraint.
    expect(geminiResponseSchema({ type: 'object', properties: { maxItems: { type: 'integer', maxItems: 3 } } }))
      .toEqual({ type: 'object', properties: { maxItems: { type: 'integer' } } });
  });

  it('still enforces the cap locally on the returned requirements', () => {
    const requirements = Array.from({ length: MAX_QUOTED_REQUIREMENTS + 1 }, (_, index) => ({
      requirement_key: `R-${String(index + 1).padStart(3, '0')}`, requirement_type: 'SKILL', importance: 'MUST',
      requirement_text: 'Python experience', quote_text: 'Python experience', confidence: 0.9,
    }));
    expect(() => validateQuotedRequirements('Python experience', { schema_version: 'x', requirements })).toThrow(/item limit/);
  });

  it('sends the capped-free schema in the Gemini request body', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    delete process.env.GEMINI_FLASH_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.REQUIREMENTS_PRIMARY_PROVIDER = 'gemini';
    process.env.EXTRACTION_PRIMARY_PROVIDER = 'gemini';
    process.env.MODEL_REQUEST_MAX_RETRIES = '1';
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await generateContentAudited({
      purpose: 'EXTRACTION',
      routeKey: 'requirements_extraction',
      model: 'gemini-3.5-flash-lite',
      contents: 'Extract requirements.',
      responseMimeType: 'application/json',
      responseSchema: quotedRequirementProviderSchema,
    });

    expect(result.provider).toBe('gemini');
    const sentSchema = bodies[0]?.generationConfig?.responseSchema;
    expect(sentSchema).toBeDefined();
    expect(keysIn(sentSchema).has('maxItems')).toBe(false);
    expect(JSON.stringify(sentSchema)).toContain('NICE_TO_HAVE');
  });
});
