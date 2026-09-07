import { describe, expect, it } from 'vitest';
import {
  assertQuotedRequirementProviderSchemaCompatible,
  quotedRequirementProviderSchema,
} from '../../requirements/quotedProvider.js';
import { REQUIREMENTS_SCHEMA_VERSION } from '../../requirements/contracts.js';

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
  it('is explicit enough for OpenAI structured-output response_format validation', () => {
    expect(findUntypedAdditionalProperties(quotedRequirementProviderSchema)).toEqual([]);
    expect(quotedRequirementProviderSchema.required).toEqual(['schema_version', 'requirements']);
    expect(quotedRequirementProviderSchema.properties.schema_version.enum).toEqual([REQUIREMENTS_SCHEMA_VERSION]);

    const item = quotedRequirementProviderSchema.properties.requirements.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.properties).not.toHaveProperty('structured_value');
    expect(() => assertQuotedRequirementProviderSchemaCompatible()).not.toThrow();
  });
});
