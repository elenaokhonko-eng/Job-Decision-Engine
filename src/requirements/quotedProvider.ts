import { runAgentWithFallback } from '../services/agent.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  QuotedRequirementExtractorResponseSchema,
  REQUIREMENTS_SCHEMA_VERSION,
} from './contracts.js';

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

const extractorSchema = (zodToJsonSchema(
  QuotedRequirementExtractorResponseSchema,
  'QuotedRequirementExtractorResponse'
) as any).definitions?.QuotedRequirementExtractorResponse || zodToJsonSchema(QuotedRequirementExtractorResponseSchema, 'QuotedRequirementExtractorResponse');

function buildPrompt(input: QuotedProviderInput): string {
  return [
    'Extract job requirements using exact verbatim quotes from the supplied job description.',
    'Return STRICT JSON matching the provided schema.',
    'Rules:',
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

export async function runQuotedRequirementProvider(
  input: QuotedProviderInput
): Promise<QuotedProviderOutput> {
  const prompt = buildPrompt(input);

  const response = await runAgentWithFallback<any>(
    prompt,
    extractorSchema,
    'You are a strict requirement extractor. Return valid JSON only.'
  );

  return {
    payload: response.payload,
    provider: response.provider,
    model: response.model,
    extractorVersion: `quoted_provider_${REQUIREMENTS_SCHEMA_VERSION}`,
    attempts: response.attempts,
    fallbackUsed: response.fallbackUsed,
    errors: response.errors,
  };
}
