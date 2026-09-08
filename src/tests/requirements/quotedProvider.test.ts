import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/agent.js', () => ({
  MODEL_REGISTRY: {
    EXTRACTION_OPENAI_MODEL: 'gpt-5.6-luna',
  },
  generateContentAudited: vi.fn(),
}));

import { generateContentAudited } from '../../services/agent.js';
import {
  assertQuotedRequirementProviderSchemaCompatible,
  quotedRequirementProviderSchema,
  runQuotedRequirementProvider,
} from '../../requirements/quotedProvider.js';
import { REQUIREMENTS_SCHEMA_VERSION } from '../../requirements/contracts.js';

const mockedGenerateContentAudited = vi.mocked(generateContentAudited);

function findUntypedAdditionalProperties(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];

  const obj = value as Record<string, unknown>;
  const issues: string[] = [];
  const additionalProperties = obj.additionalProperties;
  if (
    additionalProperties &&
    typeof additionalProperties === 'object' &&
    !Array.isArray(additionalProperties) &&
    !('type' in (additionalProperties as Record<string, unknown>))
  ) {
    issues.push(`${path}.additionalProperties`);
  }

  for (const [key, child] of Object.entries(obj)) {
    issues.push(...findUntypedAdditionalProperties(child, `${path}.${key}`));
  }

  return issues;
}

describe('quotedRequirementProviderSchema', () => {
  afterEach(() => {
    mockedGenerateContentAudited.mockReset();
  });

  it('is explicit enough for OpenAI structured-output response_format validation', () => {
    expect(findUntypedAdditionalProperties(quotedRequirementProviderSchema)).toEqual([]);
    expect(quotedRequirementProviderSchema.required).toEqual(['schema_version', 'requirements']);
    expect(quotedRequirementProviderSchema.properties.schema_version.enum).toEqual([REQUIREMENTS_SCHEMA_VERSION]);

    const item = quotedRequirementProviderSchema.properties.requirements.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.properties).not.toHaveProperty('structured_value');
    expect(() => assertQuotedRequirementProviderSchemaCompatible()).not.toThrow();
  });

  it('runs quoted extraction on the requirements extraction route', async () => {
    const payload = {
      schema_version: REQUIREMENTS_SCHEMA_VERSION,
      requirements: [
        {
          requirement_key: 'R-001',
          requirement_type: 'DOMAIN',
          importance: 'MUST',
          requirement_text: 'Experience with AI systems is required.',
          quote_text: 'Experience with AI systems',
          confidence: 0.92,
        },
      ],
    };

    mockedGenerateContentAudited.mockResolvedValueOnce({
      text: JSON.stringify(payload),
      provider: 'openai',
      model: 'gpt-5.6-luna',
      fallbackUsed: false,
      attempts: 1,
      errors: [],
      latencyMs: 42,
      routeKey: 'requirements_extraction',
    });

    const result = await runQuotedRequirementProvider({
      canonicalJobId: 'job-1',
      jobVersionId: 'version-1',
      descriptionText: 'Experience with AI systems is required.',
    });

    expect(mockedGenerateContentAudited).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'EXTRACTION',
        routeKey: 'requirements_extraction',
        model: 'gpt-5.6-luna',
        responseMimeType: 'application/json',
        responseSchema: quotedRequirementProviderSchema,
      })
    );
    expect(result.payload).toEqual(payload);
    expect(result.provider).toBe('openai');
    expect(result.model).toBe('gpt-5.6-luna');
    expect(result.attempts).toBe(1);
  });
});
