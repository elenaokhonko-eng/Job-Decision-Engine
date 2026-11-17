import { describe, expect, it } from 'vitest';
import {
  validateQuoteOffsets,
  validateQuotedRequirements,
} from '../../requirements/quotedRequirementExtractor.js';

describe('quotedRequirementExtractor', () => {
  it('validates and normalizes quoted requirements using exact substring offsets', () => {
    const description =
      'This role requires 4 days per week in office and at least 5 years of experience in Python data pipelines.';

    const payload = {
      schema_version: '2.0',
      requirements: [
        {
          requirement_key: 'R-001',
          requirement_type: 'OFFICE_DAYS',
          importance: 'MUST',
          requirement_text: 'Role requires 4 in-office days weekly.',
          quote_text: '4 days per week in office',
          confidence: 0.96,
        },
      ],
    };

    const result = validateQuotedRequirements(description, payload);

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.requirements).toHaveLength(1);
    const req = result.requirements[0];
    expect(typeof req.quote_start_offset).toBe('number');
    expect(typeof req.quote_end_offset).toBe('number');
    expect(
      validateQuoteOffsets(description, req.quote_text, req.quote_start_offset || 0, req.quote_end_offset || 0)
    ).toBe(true);
  });

  it('rejects requirements whose quote text is not found in the description', () => {
    const description = 'Hybrid role with occasional travel and stakeholder presentations.';
    const payload = {
      schema_version: '2.0',
      requirements: [
        {
          requirement_key: 'R-002',
          requirement_type: 'TRAVEL',
          importance: 'MUST',
          requirement_text: 'Role requires up to 50% travel.',
          quote_text: 'up to 50% travel',
          confidence: 0.8,
        },
      ],
    };

    const result = validateQuotedRequirements(description, payload);

    expect(result.valid).toBe(false);
    expect(result.requirements).toEqual([]);
    expect(result.issues[0].requirement_key).toBe('R-002');
    expect(result.issues[0].message).toContain('Quote not found');
  });

  const requirement = (key: string, quote: string) => ({
    requirement_key: key,
    requirement_type: 'CUSTOM',
    importance: 'MUST',
    requirement_text: 'Candidate needs this.',
    quote_text: quote,
    confidence: 0.9,
  });

  it('accepts a quote that differs only in spacing or quote marks and stores the posting’s own wording', () => {
    const description = 'You will own the “data platform” roadmap\n  and  report to the CTO.';
    const result = validateQuotedRequirements(description, {
      schema_version: '2.0',
      requirements: [requirement('R-001', 'own the "data platform" roadmap and report to the CTO')],
    });

    expect(result.valid).toBe(true);
    const stored = result.requirements[0];
    // The stored quote is the exact slice of the posting, so exact checks downstream still hold.
    expect(description.slice(stored.quote_start_offset, stored.quote_end_offset)).toBe(stored.quote_text);
    expect(stored.quote_text).toBe('own the “data platform” roadmap\n  and  report to the CTO');
  });

  it('does not loosen anything beyond spacing and quote marks: changed words are still rejected', () => {
    const result = validateQuotedRequirements('Strong SQL and Python skills.', {
      schema_version: '2.0',
      requirements: [requirement('R-001', 'Strong SQL and Java skills')],
    });
    expect(result.valid).toBe(false);
    expect(result.requirements).toEqual([]);
  });

  it('keeps the quotes that are found and reports the ones that are not', () => {
    const result = validateQuotedRequirements('Strong SQL and Python skills. Clear communication.', {
      schema_version: '2.0',
      requirements: [
        requirement('R-001', 'Strong SQL and Python skills'),
        requirement('R-002', 'Ten years of invented experience'),
        requirement('R-003', 'Clear communication'),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.requirements.map((r) => r.requirement_key)).toEqual(['R-001', 'R-003']);
    expect(result.issues.map((i) => i.requirement_key)).toEqual(['R-002']);
  });
});
