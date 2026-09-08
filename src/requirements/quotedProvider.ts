import { generateContentAudited, MODEL_REGISTRY } from '../services/agent.js';
import {
  RequirementImportanceSchema,
  RequirementTypeSchema,
  REQUIREMENTS_SCHEMA_VERSION,
} from './contracts.js';
import { validateQuotedRequirements } from './quotedRequirementExtractor.js';

export interface QuotedProviderInput {
  canonicalJobId: string;
  jobVersionId: string;
  descriptionText: string;
}

export interface QuotedProviderOutput {
  payload: unknown;
  provider: string;
  model: string;
  extractorVersion: string;
  attempts: number;
  fallbackUsed: boolean;
  errors: Array<{ provider: string; model: string; error: string }>;
}

export const quotedRequirementProviderSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'requirements'],
  properties: {
    schema_version: {
      type: 'string',
      enum: [REQUIREMENTS_SCHEMA_VERSION],
    },
    requirements: {
      type: 'array',
      minItems: 1,
      maxItems: 25,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'requirement_key',
          'requirement_type',
          'importance',
          'requirement_text',
          'quote_text',
          'confidence',
        ],
        properties: {
          requirement_key: {
            type: 'string',
            pattern: '^R-[0-9]{3}$',
          },
          requirement_type: {
            type: 'string',
            enum: RequirementTypeSchema.options,
          },
          importance: {
            type: 'string',
            enum: RequirementImportanceSchema.options,
          },
          requirement_text: {
            type: 'string',
            minLength: 5,
            maxLength: 4000,
          },
          quote_text: {
            type: 'string',
            minLength: 5,
            maxLength: 4000,
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
        },
      },
    },
  },
} as const;

export function assertQuotedRequirementProviderSchemaCompatible(): void {
  const issues = findUntypedAdditionalProperties(quotedRequirementProviderSchema);
  if (issues.length > 0) {
    throw new Error(
      `Quoted requirement provider schema contains untyped additionalProperties entries: ${issues.join(', ')}`
    );
  }
}

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

function buildPrompt(input: QuotedProviderInput): string {
  return [
    'Extract job requirements using exact verbatim quotes from the supplied job description.',
    'Return STRICT JSON matching the provided schema.',
    'Rules:',
    `- schema_version must be "${REQUIREMENTS_SCHEMA_VERSION}".`,
    '- Do not invent or paraphrase quote_text.',
    '- Every quote_text must appear verbatim in the description.',
    '- Confidence must be 0..1.',
    '- Include only concrete requirements.',
    '',
    `canonical_job_id: ${input.canonicalJobId}`,
    `job_version_id: ${input.jobVersionId}`,
    '',
    'Job description:',
    input.descriptionText,
  ].join('\n');
}

function cleanJsonResponseText(rawText: string): string {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }

  const startIdx = cleaned.indexOf('{');
  const endIdx = cleaned.lastIndexOf('}');
  if (startIdx >= 0 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }
  return cleaned;
}

function parseAndValidateQuotedPayload(input: QuotedProviderInput, rawText: string): unknown {
  let payload: unknown;
  try {
    payload = JSON.parse(cleanJsonResponseText(rawText));
  } catch (error: any) {
    throw new Error(`Quoted requirement provider returned invalid JSON: ${error.message || String(error)}`);
  }

  const validated = validateQuotedRequirements(input.descriptionText, payload);
  if (!validated.valid) {
    throw new Error(
      `Quoted requirement validation failed: ${validated.issues
        .map((issue) => `${issue.requirement_key}: ${issue.message}`)
        .join('; ')}`
    );
  }

  return {
    schema_version: REQUIREMENTS_SCHEMA_VERSION,
    requirements: validated.requirements,
  };
}

export async function runQuotedRequirementProvider(
  input: QuotedProviderInput
): Promise<QuotedProviderOutput> {
  const prompt = buildPrompt(input);

  const response = await generateContentAudited({
    purpose: 'EXTRACTION',
    routeKey: 'requirements_extraction',
    model: MODEL_REGISTRY.EXTRACTION_OPENAI_MODEL,
    contents: prompt,
    responseMimeType: 'application/json',
    responseSchema: quotedRequirementProviderSchema,
    systemInstruction: 'You are a strict requirement extractor. Return valid JSON only.',
    validateResponseText: (text) => parseAndValidateQuotedPayload(input, text),
  });

  return {
    payload: response.validatedPayload ?? parseAndValidateQuotedPayload(input, response.text),
    provider: response.provider,
    model: response.model,
    extractorVersion: `quoted_provider_${REQUIREMENTS_SCHEMA_VERSION}`,
    attempts: response.attempts,
    fallbackUsed: response.fallbackUsed,
    errors: response.errors,
  };
}
