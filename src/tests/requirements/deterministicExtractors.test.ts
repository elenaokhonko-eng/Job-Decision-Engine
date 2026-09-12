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

  it('extracts broad technical leadership and delivery function families', () => {
    const result = extractDeterministicRequirements({
      canonical_job_id: '77777777-7777-4777-8777-777777777777',
      job_version_id: '88888888-8888-4888-8888-888888888888',
      description_text:
        'Transformation Programme Director leading software development and data platform delivery. Own the technical roadmap and coordinate the project manager workstream.',
    });

    const functionReq = result.requirements.find((r) => r.requirement_type === 'FUNCTION');
    expect(functionReq).toBeTruthy();
    expect(functionReq?.structured_value).toEqual({ function_key: 'TRANSFORMATION_PROGRAMME_DIRECTOR' });
  });

  it('extracts a generic project manager function only when technical context is present', () => {
    const result = extractDeterministicRequirements({
      canonical_job_id: '99999999-9999-4999-8999-999999999999',
      job_version_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      description_text:
        'Project Manager responsible for software delivery, data platform milestones, and technical release management.',
    });

    expect(result.requirements.some((r) => r.requirement_type === 'FUNCTION')).toBe(true);
  });

  it('extracts data pipeline associate and SQL ETL warehouse evidence', () => {
    const result = extractDeterministicRequirements({
      canonical_job_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      job_version_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      description_text:
        'Junior Data Pipeline Associate supporting standard SQL ETL maintenance and dashboard data warehouse support.',
    });

    const functionReq = result.requirements.find((r) => r.requirement_type === 'FUNCTION');
    const domainReq = result.requirements.find((r) => r.requirement_type === 'DOMAIN');

    expect(functionReq?.quote_text).toMatch(/data pipeline associate/i);
    expect(domainReq?.quote_text).toMatch(/data pipeline|sql etl|data warehouse/i);
  });

  it('extracts slash-form office days as a known workability fact', () => {
    const result = extractDeterministicRequirements({
      canonical_job_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      job_version_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      description_text: 'Singapore hybrid role with 1 day/week office for planning sessions.',
    });

    const officeReq = result.requirements.find((r) => r.requirement_type === 'OFFICE_DAYS');
    expect(officeReq?.quote_text).toMatch(/1 day\/week office/i);
    expect(officeReq?.structured_value).toEqual({ office_days_per_week: 1 });
  });

  it('structures varied experience-year wording and degree subject evidence', () => {
    const commercial = extractDeterministicRequirements({
      canonical_job_id: 'abababab-abab-4aba-8aba-abababababab',
      job_version_id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd',
      description_text:
        'At least 3 years of commercial experience with React.',
    });

    const commercialExperience = commercial.requirements.find((r) => r.requirement_type === 'EXPERIENCE_YEARS');
    expect(commercialExperience?.structured_value).toMatchObject({
      minimum_years: 3,
      experience_scope: 'commercial',
    });

    const additional = extractDeterministicRequirements({
      canonical_job_id: 'efefefef-efef-4efe-8efe-efefefefefef',
      job_version_id: '12121212-1212-4121-8121-121212121212',
      description_text: 'Minimum of 2 additional years of experience related to the functional area.',
    });
    const additionalExperience = additional.requirements.find((r) => r.requirement_type === 'EXPERIENCE_YEARS');
    expect(additionalExperience?.structured_value).toEqual({ minimum_years: 2 });

    const writtenNumber = extractDeterministicRequirements({
      canonical_job_id: 'abababab-abab-4aba-8aba-abababababac',
      job_version_id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdce',
      description_text: 'At least three years of relevant technology experience in a related technical environment.',
    }).requirements.find((r) => r.requirement_type === 'EXPERIENCE_YEARS');
    expect(writtenNumber?.structured_value).toMatchObject({ minimum_years: 3 });

    const degree = extractDeterministicRequirements({
      canonical_job_id: '34343434-3434-4343-8343-343434343434',
      job_version_id: '56565656-5656-4565-8565-565656565656',
      description_text: 'Degree in Computer Science, Software Engineering, or a related field.',
    }).requirements.find((r) => r.requirement_type === 'DEGREE');
    expect(degree?.quote_text).toMatch(/Degree in Computer Science/i);
    expect(degree?.structured_value).toMatchObject({
      degree_reference: expect.stringMatching(/Degree in Computer Science/i),
    });
  });

  it('expands short domain tokens into schema-valid evidence quotes', () => {
    const description =
      'Principal AI Systems Engineer building LLM training pipelines and NLP systems.';
    const result = extractDeterministicRequirements({
      canonical_job_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      job_version_id: '11111111-2222-4333-8444-555555555555',
      description_text: description,
    });

    for (const req of result.requirements) {
      expect(req.quote_text?.length).toBeGreaterThanOrEqual(5);
      expect(description.slice(req.quote_start_offset || 0, req.quote_end_offset || 0)).toBe(
        req.quote_text
      );
    }

    const domainReq = result.requirements.find((r) => r.requirement_type === 'DOMAIN');
    expect(domainReq?.quote_text).toMatch(/AI Systems|LLM training|NLP systems/i);
  });

  it('keeps structured deterministic requirements usable when evidence is too short to quote', () => {
    const result = extractDeterministicRequirements({
      canonical_job_id: '12121212-1212-4121-8121-121212121212',
      job_version_id: '34343434-3434-4343-8343-343434343434',
      description_text: 'Hybrid role with AI.',
    });

    // The extractor must never emit a schema-invalid short quote. If a future
    // pattern produces one, it must be represented as missing evidence rather
    // than failing the complete deterministic requirement stage.
    for (const requirement of result.requirements) {
      expect(requirement.quote_text == null || requirement.quote_text.length >= 5).toBe(true);
      if (requirement.quote_text == null) {
        expect(requirement.quote_start_offset).toBeNull();
        expect(requirement.quote_end_offset).toBeNull();
      }
    }
  });
});
