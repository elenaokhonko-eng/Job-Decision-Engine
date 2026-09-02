import {
  QuotedRequirementExtractorResponseSchema,
  QuotedRequirementSchema,
} from './contracts.js';
import { z } from 'zod';

export interface QuoteValidationIssue {
  requirement_key: string;
  message: string;
}

export interface QuoteValidationResult {
  valid: boolean;
  issues: QuoteValidationIssue[];
  requirements: z.infer<typeof QuotedRequirementSchema>[];
}

export function locateQuoteOffset(descriptionText: string, quoteText: string): number {
  return descriptionText.indexOf(quoteText);
}

export function validateQuoteOffsets(
  descriptionText: string,
  quoteText: string,
  quoteStartOffset: number,
  quoteEndOffset: number
): boolean {
  if (quoteStartOffset < 0 || quoteEndOffset <= quoteStartOffset) {
    return false;
  }
  const extracted = descriptionText.slice(quoteStartOffset, quoteEndOffset);
  return extracted === quoteText;
}

export function validateQuotedRequirements(
  descriptionText: string,
  payload: unknown
): QuoteValidationResult {
  const parsed = QuotedRequirementExtractorResponseSchema.parse(payload);
  const issues: QuoteValidationIssue[] = [];
  const normalizedRequirements: z.infer<typeof QuotedRequirementSchema>[] = [];

  for (const requirement of parsed.requirements) {
    const existingStart = requirement.quote_start_offset;
    const existingEnd = requirement.quote_end_offset;

    let start = typeof existingStart === 'number' ? existingStart : locateQuoteOffset(descriptionText, requirement.quote_text);
    let end = typeof existingEnd === 'number' ? existingEnd : start + requirement.quote_text.length;

    if (start < 0) {
      issues.push({
        requirement_key: requirement.requirement_key,
        message: `Quote not found in description: ${requirement.quote_text}`,
      });
      continue;
    }

    if (!validateQuoteOffsets(descriptionText, requirement.quote_text, start, end)) {
      issues.push({
        requirement_key: requirement.requirement_key,
        message: `Quote offsets do not match quote text at [${start}, ${end}).`,
      });
      continue;
    }

    normalizedRequirements.push({
      ...requirement,
      quote_start_offset: start,
      quote_end_offset: end,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    requirements: normalizedRequirements,
  };
}

export function parseQuotedExtractorResponse(payload: unknown) {
  return QuotedRequirementExtractorResponseSchema.parse(payload);
}
