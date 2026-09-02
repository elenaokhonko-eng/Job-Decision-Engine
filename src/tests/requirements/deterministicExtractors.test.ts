import { describe, expect, it } from 'vitest';
import { extractDeterministicRequirements } from '../../requirements/deterministicExtractors.js';

describe('extractDeterministicRequirements', () => {
  it('extracts hard constraints with quote offsets and structured values', () => {
    const description = [
      'Mandatory 5 days per week in office in Singapore CBD.',
      'Must have at least 6 years of experience in production ML systems.',
      'No sponsorship and valid work rights required.',
      'Role includes regular on-call rotation and up to 25% travel.',
    ].join(' ');

    const result = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111111',
      job_version_id: '22222222-2222-4222-8222-222222222222',
      description_text: description,
    });

    expect(result.warnings).toEqual([]);
    expect(result.requirements.length).toBeGreaterThanOrEqual(5);

    const office = result.requirements.find((r) => r.requirement_type === 'OFFICE_DAYS');
    expect(office).toBeTruthy();
    expect(office?.structured_value).toEqual({ office_days_per_week: 5 });

    for (const req of result.requirements) {
      expect(req.quote_start_offset).toBeGreaterThanOrEqual(0);
      expect(req.quote_end_offset).toBeGreaterThan(req.quote_start_offset || -1);
      const quote = description.slice(req.quote_start_offset || 0, req.quote_end_offset || 0);
      expect(quote).toBe(req.quote_text);
    }
  });

  it('returns warning when no deterministic patterns are found', () => {
    const result = extractDeterministicRequirements({
      canonical_job_id: '33333333-3333-4333-8333-333333333333',
      job_version_id: '44444444-4444-4444-8444-444444444444',
      description_text: 'Collaborative team role with broad impact across programs.',
    });

    expect(result.requirements).toEqual([]);
    expect(result.warnings).toContain('No deterministic requirements identified.');
  });
});
