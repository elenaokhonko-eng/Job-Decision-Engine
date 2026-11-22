import { describe, expect, it } from 'vitest';
import { extractDeterministicRequirements } from '../../requirements/deterministicExtractors.js';

describe('extractDeterministicRequirements', () => {

  describe('degree and professional-credential requirements the owner lacks', () => {
    const extract = (description_text: string) => extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111111',
      job_version_id: '22222222-2222-4222-8222-222222222222',
      description_text,
    }).requirements;

    it.each([
      ['PhD', 'Qualifications: PhD in computational biology or a related field.'],
      ['Ph.D', 'Qualifications: <li>Ph.D in machine learning</li>'],
      ['Ph.D.', 'You hold a Ph.D. in physics.'],
      ['M.Sc', 'You hold an MSc in statistics.'],
      ['Doctor of Philosophy', 'A Doctor of Philosophy in a quantitative discipline.'],
    ])('extracts a %s degree requirement', (_label, text) => {
      expect(extract(text).some((r) => r.requirement_type === 'DEGREE')).toBe(true);
    });

    it.each([
      ['Fellow of the Society of Actuaries', 'You are a Fellow of the Society of Actuaries (FSA) and a Member of the American Academy of Actuaries.'],
      ['FSA', 'Credential: FSA required for this role.'],
      ['ACCA', 'Qualified accountant (ACCA) preferred.'],
    ])('extracts a professional credential: %s', (_label, text) => {
      expect(extract(text).some((r) => r.requirement_type === 'CREDENTIAL')).toBe(true);
    });

    it('does not read ordinary words as degrees or credentials', () => {
      const types = extract('We value asa tree-like structure, the msc folder and a phdr library; nothing formal is required.').map((r) => r.requirement_type);
      expect(types).not.toContain('DEGREE');
      expect(types).not.toContain('CREDENTIAL');
    });
  });
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

    // One run-on line has no requirement section, so only the structured facts are confirmed:
    // that is too thin to judge and is reported as "needs description", not as a mismatch.
    expect(result.needsDescription).toBe(true);
    expect(result.warnings.some((w) => w.startsWith('NEEDS_DESCRIPTION'))).toBe(true);
    expect(result.requirements.length).toBeGreaterThanOrEqual(5);

    const office = result.requirements.find((r) => r.requirement_type === 'OFFICE_DAYS');
    expect(office).toBeTruthy();
    expect(office?.structured_value).toEqual({ office_days_per_week: 5 });

    // The template-sentence FUNCTION and DOMAIN requirements are gone.
    expect(result.requirements.some((r) => r.requirement_type === 'FUNCTION')).toBe(false);
    expect(result.requirements.some((r) => r.requirement_type === 'DOMAIN')).toBe(false);
    expect(result.requirements.some((r) => /^Role (includes|requires|specifies)/.test(r.requirement_text) && ['FUNCTION', 'DOMAIN'].includes(r.requirement_type))).toBe(false);

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

  const IDS = {
    canonical_job_id: '77777777-7777-4777-8777-777777777777',
    job_version_id: '88888888-8888-4888-8888-888888888888',
  };

  const SECTIONED_POSTING = [
    'The role',
    'We are building a shared data platform for the business.',
    '',
    'Responsibilities',
    '- Lead delivery of the enterprise data platform roadmap',
    '- Partner with engineering and product to define priorities',
    '',
    'Requirements',
    '- 8+ years of experience in data engineering or architecture',
    '- Strong SQL and Python',
    "- Bachelor's degree in computer science or a related field",
    '- Experience with AWS, Azure or GCP',
    '',
    'Nice to have',
    '- Familiarity with Snowflake',
    '',
    'About us',
    '- We offer free lunch and a great culture',
  ].join('\n');

  it('turns each bullet of a sectioned posting into its own requirement with its exact quote', () => {
    const result = extractDeterministicRequirements({ ...IDS, description_text: SECTIONED_POSTING });
    const items = result.requirements.filter((r) => r.requirement_type === 'CUSTOM');

    expect(items.map((r) => r.requirement_text)).toEqual([
      'Lead delivery of the enterprise data platform roadmap',
      'Partner with engineering and product to define priorities',
      'Strong SQL and Python',
      'Experience with AWS, Azure or GCP',
      'Familiarity with Snowflake',
    ]);
    for (const item of items) {
      // The requirement is the posting's own words: text and quote are identical and match the offsets.
      expect(item.quote_text).toBe(item.requirement_text);
      expect(SECTIONED_POSTING.slice(item.quote_start_offset ?? 0, item.quote_end_offset ?? 0)).toBe(item.quote_text);
      expect(item.requirement_text).not.toMatch(/^Role (includes|requires|specifies)/);
    }
    expect(result.needsDescription).toBe(false);
    expect(result.hasRequirementsSection).toBe(true);
    // Intro prose and the "About us" section are not requirements.
    expect(items.some((r) => /shared data platform/.test(r.requirement_text))).toBe(false);
    expect(items.some((r) => /free lunch/.test(r.requirement_text))).toBe(false);
  });

  it('classifies items and marks nice-to-have items optional', () => {
    const result = extractDeterministicRequirements({ ...IDS, description_text: SECTIONED_POSTING });
    const byText = new Map(result.requirements.map((r) => [r.requirement_text, r]));

    expect(byText.get('Lead delivery of the enterprise data platform roadmap')?.structured_value).toMatchObject({
      item_class: 'RESPONSIBILITY',
      section: 'RESPONSIBILITIES',
    });
    expect(byText.get('Strong SQL and Python')?.structured_value).toMatchObject({ item_class: 'TOOL', section: 'REQUIREMENTS' });
    expect(byText.get('Familiarity with Snowflake')?.importance).toBe('NICE_TO_HAVE');
    expect(byText.get('Strong SQL and Python')?.importance).toBe('MUST');
  });

  describe('duties and unheaded skills are not mandatory (deterministic_v5)', () => {
    const importanceOf = (description: string, startsWith: string) =>
      extractDeterministicRequirements({ ...IDS, description_text: description })
        .requirements.find((r) => r.requirement_text.startsWith(startsWith))?.importance;

    it('makes a duty under a responsibilities heading PREFERRED, and keeps a skill under a requirements heading MUST', () => {
      const posting = [
        'Responsibilities',
        '- Lead delivery of the enterprise data platform roadmap',
        '- Partner with product and engineering teams to ship features',
        '',
        'Requirements',
        '- Strong SQL and Python',
        '- Experience building data pipelines in production',
      ].join('\n');
      expect(importanceOf(posting, 'Lead delivery')).toBe('PREFERRED');
      expect(importanceOf(posting, 'Partner with product')).toBe('PREFERRED');
      expect(importanceOf(posting, 'Strong SQL')).toBe('MUST');
      expect(importanceOf(posting, 'Experience building data pipelines')).toBe('MUST');
    });

    it('keeps a duty MUST when the item itself says it is required', () => {
      const posting = ['Responsibilities', '- You must be able to lead incident response for the platform'].join('\n');
      expect(importanceOf(posting, 'You must be able')).toBe('MUST');
    });

    it('makes a skill in a posting with no headings PREFERRED unless it says required', () => {
      const posting =
        'We build data products for banks. Hands-on experience with machine learning systems. ' +
        'Familiarity with distributed data processing frameworks. Production experience with Kubernetes is required.';
      const requirements = extractDeterministicRequirements({ ...IDS, description_text: posting }).requirements;
      const skills = requirements.filter((r) => r.requirement_type === 'CUSTOM');
      expect(skills.length).toBeGreaterThan(0);
      for (const skill of skills) {
        expect(skill.importance, skill.requirement_text).toBe(/required/i.test(skill.requirement_text) ? 'MUST' : 'PREFERRED');
      }
    });

    it('leaves years, degree and credential rules and the nice-to-have section as they were', () => {
      const posting = ['Requirements', '- 8+ years of professional experience', "- Bachelor's degree", '', 'Nice to have', '- Familiarity with Snowflake'].join('\n');
      const requirements = extractDeterministicRequirements({ ...IDS, description_text: posting }).requirements;
      expect(requirements.find((r) => r.requirement_type === 'EXPERIENCE_YEARS')?.importance).toBe('MUST');
      expect(requirements.find((r) => r.requirement_type === 'DEGREE')?.importance).toBe('MUST');
      expect(requirements.find((r) => r.requirement_text.startsWith('Familiarity with Snowflake'))?.importance).toBe('NICE_TO_HAVE');
    });

    it('still keeps duties in the requirement set so the matcher can score them', () => {
      const posting = ['Responsibilities', '- Lead delivery of the enterprise data platform roadmap'].join('\n');
      const lead = extractDeterministicRequirements({ ...IDS, description_text: posting })
        .requirements.find((r) => r.requirement_text.startsWith('Lead delivery'));
      expect(lead).toBeDefined();
      expect(lead?.structured_value).toMatchObject({ item_class: 'RESPONSIBILITY' });
    });
  });

  it('records alternatives such as "A, B or C" options and "or related field"', () => {
    const result = extractDeterministicRequirements({ ...IDS, description_text: SECTIONED_POSTING });
    const cloud = result.requirements.find((r) => r.requirement_text === 'Experience with AWS, Azure or GCP');
    expect(cloud?.structured_value).toMatchObject({ alternatives: { options: ['AWS', 'Azure', 'GCP'] } });

    const degree = result.requirements.find((r) => r.requirement_type === 'DEGREE');
    expect(degree?.structured_value).toMatchObject({ accepts_related_field: true, accepts_equivalent_experience: false });

    const equivalent = extractDeterministicRequirements({
      ...IDS,
      description_text: ['Requirements', "- Bachelor's degree or equivalent experience"].join('\n'),
    });
    expect(equivalent.requirements.find((r) => r.requirement_type === 'DEGREE')?.structured_value).toMatchObject({
      accepts_equivalent_experience: true,
    });
  });

  it('leaves years and degrees to the rules: no duplicate item for the same sentence', () => {
    const result = extractDeterministicRequirements({ ...IDS, description_text: SECTIONED_POSTING });
    expect(result.requirements.filter((r) => r.requirement_type === 'EXPERIENCE_YEARS')).toHaveLength(1);
    expect(result.requirements.filter((r) => r.requirement_type === 'DEGREE')).toHaveLength(1);
    expect(result.requirements.some((r) => r.requirement_type === 'CUSTOM' && /8\+ years|Bachelor/.test(r.requirement_text))).toBe(false);
  });

  it('classifies "you will" sentences as duties and "is valued" wording as preferred, and drops culture lines', () => {
    const result = extractDeterministicRequirements({
      ...IDS,
      description_text:
        'You will lead the development of innovation programmes across the bank. ' +
        'Experience with financial regulation or supervision is valued. ' +
        'You will find a place where you can be yourself and prioritise your wellbeing. ' +
        'Strong stakeholder management and communication skills.',
    });
    const items = result.requirements.filter((r) => r.requirement_type === 'CUSTOM');
    const byPrefix = (prefix: string) => items.find((r) => r.requirement_text.startsWith(prefix));

    expect(byPrefix('You will lead')?.structured_value).toMatchObject({ item_class: 'RESPONSIBILITY' });
    expect(byPrefix('Experience with financial regulation')?.importance).toBe('PREFERRED');
    // No headings: nothing says this is required, so it is not mandatory (deterministic_v5).
    expect(byPrefix('Strong stakeholder')?.importance).toBe('PREFERRED');
    expect(byPrefix('You will lead')?.importance).toBe('PREFERRED');
    expect(items.some((r) => /wellbeing/.test(r.requirement_text))).toBe(false);
  });

  it('keeps workability lines and negations out of the capability items', () => {
    const result = extractDeterministicRequirements({
      ...IDS,
      description_text: [
        'Requirements',
        '- Strong stakeholder management across business units',
        '- Participation in the on-call rotation',
        '- No prior banking experience needed',
        '- Valid work authorization for Singapore',
      ].join('\n'),
    });
    const items = result.requirements.filter((r) => r.requirement_type === 'CUSTOM').map((r) => r.requirement_text);
    expect(items).toEqual(['Strong stakeholder management across business units']);
  });

  it('reports "needs description" instead of a mismatch when fewer than 3 requirements are confirmed', () => {
    const thin = extractDeterministicRequirements({
      ...IDS,
      description_text: ['Requirements', '- Strong SQL', '- Clear written communication'].join('\n'),
    });
    expect(thin.confirmedRequirementCount).toBe(2);
    expect(thin.needsDescription).toBe(true);
    expect(thin.warnings.some((w) => w.startsWith('NEEDS_DESCRIPTION'))).toBe(true);

    const enough = extractDeterministicRequirements({
      ...IDS,
      description_text: ['Requirements', '- Strong SQL', '- Clear written communication', '- Experience leading teams'].join('\n'),
    });
    expect(enough.confirmedRequirementCount).toBe(3);
    expect(enough.needsDescription).toBe(false);
  });

  it('does not count workability facts toward the confirmed requirements', () => {
    const result = extractDeterministicRequirements({
      ...IDS,
      description_text: 'Hybrid role, 3 days per week in the office. Full-time permanent. Up to 20% travel.',
    });
    expect(result.requirements.length).toBeGreaterThan(0);
    expect(result.confirmedRequirementCount).toBe(0);
    expect(result.needsDescription).toBe(true);
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
    expect(additionalExperience?.structured_value).toMatchObject({ minimum_years: 2 });

    const writtenNumber = extractDeterministicRequirements({
      canonical_job_id: 'abababab-abab-4aba-8aba-abababababac',
      job_version_id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdce',
      description_text: 'At least three years of relevant technology experience in a related technical environment.',
    }).requirements.find((r) => r.requirement_type === 'EXPERIENCE_YEARS');
    expect(writtenNumber?.structured_value).toMatchObject({ minimum_years: 3 });

    const writtenScope = extractDeterministicRequirements({
      canonical_job_id: 'abababab-abab-4aba-8aba-abababababad',
      job_version_id: 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcf',
      description_text: 'At least four years of AI engineering experience required.',
    }).requirements.find((r) => r.requirement_type === 'EXPERIENCE_YEARS');
    expect(writtenScope?.structured_value).toMatchObject({
      minimum_years: 4,
      experience_scope: 'AI engineering',
      scope_schema_version: 'experience_scope_v2',
      role_families: ['AI_ENGINEERING', 'HANDS_ON_SOFTWARE_ENGINEERING'],
      domain_families: ['AI'],
    });
    expect(writtenScope?.importance).toBe('MUST');

    const scopedDescription = [
      'Required qualifications:',
      '- 8+ years of software engineering experience.',
      '- 8 years of experience in architecture or engineering.',
      '- 2 additional years at staff level.',
      '',
      'Nice to have:',
      '- 5 years of experience in finance.',
    ].join('\n');
    const scopedYears = extractDeterministicRequirements({
      canonical_job_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      job_version_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      description_text: scopedDescription,
    });
    const experienceRequirements = scopedYears.requirements.filter((r) => r.requirement_type === 'EXPERIENCE_YEARS');
    expect(experienceRequirements).toHaveLength(4);
    expect(experienceRequirements.map((r) => r.importance)).toEqual([
      'MUST', 'MUST', 'MUST', 'NICE_TO_HAVE',
    ]);
    expect(experienceRequirements[0].structured_value).toMatchObject({
      minimum_years: 8,
      role_families: ['HANDS_ON_SOFTWARE_ENGINEERING'],
      domain_families: ['SOFTWARE'],
    });
    expect(experienceRequirements[1].structured_value).toMatchObject({
      minimum_years: 8,
      role_families: ['ARCHITECTURE', 'HANDS_ON_SOFTWARE_ENGINEERING'],
      operator: 'ANY',
    });
    expect(experienceRequirements[2].structured_value).toMatchObject({
      minimum_years: 2,
      seniority_scope: 'staff level',
    });
    for (const req of experienceRequirements) {
      expect(req.quote_start_offset).toBeGreaterThanOrEqual(0);
      expect(req.quote_end_offset).toBeGreaterThan(req.quote_start_offset ?? -1);
      expect(scopedDescription.slice(req.quote_start_offset ?? 0, req.quote_end_offset ?? 0)).toBe(req.quote_text);
    }

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

    // A title-like keyword is no longer turned into a template DOMAIN requirement. With no
    // requirement section there is nothing to quote, so the job needs a fuller description.
    expect(result.requirements.some((r) => r.requirement_type === 'DOMAIN')).toBe(false);
    expect(result.needsDescription).toBe(true);
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

  it('correctly handles polarity and optionality without cross-sentence bleed', () => {
    // 1. Negated on-call with intervening modifier
    const noRegularOnCall = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111111',
      job_version_id: '22222222-2222-4222-8222-222222222222',
      description_text: 'Remote role. No regular on-call rotation expected.',
    });
    expect(noRegularOnCall.requirements.some((r) => r.requirement_type === 'ON_CALL')).toBe(false);

    // 2. Affirmative "support an" on-call
    const supportOnCall = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111112',
      job_version_id: '22222222-2222-4222-8222-222222222223',
      description_text: 'We support an on-call rotation for production escalations.',
    });
    expect(supportOnCall.requirements.some((r) => r.requirement_type === 'ON_CALL')).toBe(true);

    // 3. Suffix optionality for degree
    const preferredDegree = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111113',
      job_version_id: '22222222-2222-4222-8222-222222222224',
      description_text: "A bachelor's degree is preferred.",
    });
    const degReq = preferredDegree.requirements.find((r) => r.requirement_type === 'DEGREE');
    expect(degReq).toBeTruthy();
    expect(degReq?.importance).toBe('PREFERRED');

    // 4. Suffix optionality for credential
    const optionalCert = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111114',
      job_version_id: '22222222-2222-4222-8222-222222222225',
      description_text: 'CISSP certification is optional.',
    });
    const credReq = optionalCert.requirements.find((r) => r.requirement_type === 'CREDENTIAL');
    expect(credReq).toBeTruthy();
    expect(credReq?.importance).toBe('NICE_TO_HAVE');

    // 5. Adjacent sentence isolation: Python preferred. CISSP certification required.
    const mixedSentences = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111115',
      job_version_id: '22222222-2222-4222-8222-222222222226',
      description_text: 'Python preferred. CISSP certification required.',
    });
    const cisspReq = mixedSentences.requirements.find((r) => r.requirement_type === 'CREDENTIAL');
    expect(cisspReq).toBeTruthy();
    expect(cisspReq?.importance).toBe('MUST');

    // 6. Conjunction subclause isolation within a single sentence: Python preferred, but CISSP certification required.
    const conjunctionMixed = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111116',
      job_version_id: '22222222-2222-4222-8222-222222222227',
      description_text: 'Python preferred, but CISSP certification required.',
    });
    const conjunctionCissp = conjunctionMixed.requirements.find((r) => r.requirement_type === 'CREDENTIAL');
    expect(conjunctionCissp).toBeTruthy();
    expect(conjunctionCissp?.importance).toBe('MUST');

    // 7. Reversed conjunction subclause: CISSP certification required, but Python preferred.
    const reversedConjunction = extractDeterministicRequirements({
      canonical_job_id: '11111111-1111-4111-8111-111111111117',
      job_version_id: '22222222-2222-4222-8222-222222222228',
      description_text: 'CISSP certification required, but Python preferred.',
    });
    const reversedCissp = reversedConjunction.requirements.find((r) => r.requirement_type === 'CREDENTIAL');
    expect(reversedCissp).toBeTruthy();
    expect(reversedCissp?.importance).toBe('MUST');
  });
});
