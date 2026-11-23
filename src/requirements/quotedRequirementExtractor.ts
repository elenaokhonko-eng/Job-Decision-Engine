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

export const MAX_QUOTED_REQUIREMENTS = 25;

/** Normalisation for AI quotes: curly quotes become straight and whitespace runs collapse. */
function normalizeLoosely(text: string): { normalized: string; origin: number[] } {
  let normalized = '';
  const origin: number[] = [];
  let previousWasSpace = false;
  for (let index = 0; index < text.length; index += 1) {
    let char = text[index];
    if (/\s/.test(char)) {
      if (previousWasSpace) continue;
      char = ' ';
      previousWasSpace = true;
    } else {
      previousWasSpace = false;
      if (char === '\u2018' || char === '\u2019') char = "'";
      else if (char === '\u201c' || char === '\u201d') char = '"';
    }
    normalized += char;
    origin.push(index);
  }
  return { normalized, origin };
}

/**
 * Finds a quote that differs from the posting only in spacing or quote marks. Returns the
 * span in the original text, so the stored quote is always the posting's own wording.
 */
export function locateQuoteLoosely(descriptionText: string, quoteText: string): { start: number; end: number } | null {
  const needle = normalizeLoosely(quoteText).normalized.trim();
  if (needle.length === 0) return null;
  const haystack = normalizeLoosely(descriptionText);
  const at = haystack.normalized.indexOf(needle);
  if (at < 0) return null;
  const start = haystack.origin[at];
  const end = haystack.origin[at + needle.length - 1] + 1;
  return { start, end };
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

function assertRequirementCollectionBounded(payload: unknown): void {
  if (
    payload === null
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !("requirements" in payload)
  ) {
    return;
  }
  const requirements = payload.requirements;
  if (Array.isArray(requirements) && requirements.length > MAX_QUOTED_REQUIREMENTS) {
    throw new RangeError(`Quoted requirements exceed the ${MAX_QUOTED_REQUIREMENTS}-item limit.`);
  }
}

export function validateQuotedRequirements(
  descriptionText: string,
  payload: unknown
): QuoteValidationResult {
  assertRequirementCollectionBounded(payload);
  const parsed = QuotedRequirementExtractorResponseSchema.parse(payload);
  const issues: QuoteValidationIssue[] = [];
  const normalizedRequirements: z.infer<typeof QuotedRequirementSchema>[] = [];

  for (const requirement of parsed.requirements) {
    const existingStart = requirement.quote_start_offset;
    const existingEnd = requirement.quote_end_offset;

    let start = typeof existingStart === 'number' ? existingStart : locateQuoteOffset(descriptionText, requirement.quote_text);
    let end = typeof existingEnd === 'number' ? existingEnd : start + requirement.quote_text.length;

    let quoteText = requirement.quote_text;
    const exactOk = start >= 0 && validateQuoteOffsets(descriptionText, quoteText, start, end);
    if (!exactOk) {
      const loose = locateQuoteLoosely(descriptionText, quoteText);
      if (!loose) {
        issues.push({
          requirement_key: requirement.requirement_key,
          message:
            start < 0
              ? `Quote not found in description: ${requirement.quote_text}`
              : `Quote offsets do not match quote text at [${start}, ${end}).`,
        });
        continue;
      }
      start = loose.start;
      end = loose.end;
      quoteText = descriptionText.slice(start, end);
    }

    normalizedRequirements.push({
      ...requirement,
      quote_text: quoteText,
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
  assertRequirementCollectionBounded(payload);
  return QuotedRequirementExtractorResponseSchema.parse(payload);
}
