import { describe, expect, it } from 'vitest';
import { extractDeterministicRequirements } from '../../requirements/deterministicExtractors.js';

describe('extractDeterministicRequirements', () => {
  it('extracts hard constraints with quote offsets and structured values', () => {
    const description = [
      'Mandatory 5 days per week in office in Singapore CBD.',
      'Must have at least 6 years of experience in production ML systems.',
      'No sponsorship and valid work rights required.',
      'Role includes regular on-call rotation and up to 25% travel.',
      'Machine learning engineer for data platform systems.',
    ].join(' ');

    const result = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111111',
      job_version_id: '22222222-2222-4222-8222-222222222222',
      description_text: description,
    });

    expect(result.warnings).toEqual([]);
    expect(result.requirements.length).toBeGreaterThanOrEqual(7);

    const office = result.requirements.find((r) => r.requirement_type === 'OFFICE_DAYS');
    expect(office).toBeTruthy();
    expect(office?.structured_value).toEqual({ office_days_per_week: 5 });

    const functionReq = result.requirements.find((r) => r.requirement_type === 'FUNCTION');
    const domainReq = result.requirements.find((r) => r.requirement_type === 'DOMAIN');
    expect(functionReq).toBeTruthy();
    expect(domainReq).toBeTruthy();
    expect(functionReq?.structured_value).toHaveProperty('function_key');
    expect(domainReq?.structured_value).toHaveProperty('domain_key');

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

  it('is idempotent for the same job_version with stable keys and no duplicate requirement types', () => {
    const input = {
      canonical_job_id: '55555555-5555-4555-8555-555555555555',
      job_version_id: '66666666-6666-4666-8666-666666666666',
      description_text:
        'Hybrid role with 2 days per week in office. Must have at least 5 years of experience. Full-time permanent role.',
    };

    const first = extractDeterministicRequirements(input);
    const second = extractDeterministicRequirements(input);

    const firstKeys = first.requirements.map((r) => r.requirement_key);
    const secondKeys = second.requirements.map((r) => r.requirement_key);
    expect(firstKeys).toEqual(secondKeys);

    const types = first.requirements.map((r) => r.requirement_type);
    expect(new Set(types).size).toBe(types.length);
  });
});
