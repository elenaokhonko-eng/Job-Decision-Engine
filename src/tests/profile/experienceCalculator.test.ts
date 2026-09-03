import { describe, expect, it } from 'vitest';
import {
  calculateConceptExperience,
  calculateEngagementExperience,
} from '../../profile/experienceCalculator.js';

describe('experienceCalculator', () => {
  it('counts founder and employee professional engagements with parity', async () => {
    const referenceDate = new Date('2024-01-01T00:00:00.000Z');

    const founder = {
      id: '00000000-0000-0000-0000-000000000001',
      profile_version_id: '00000000-0000-0000-0000-000000000010',
      engagement_key: 'founder.alpha',
      organization_legal_name: 'Alpha Startup',
      brand_or_program_name: null,
      role_title: 'Founder',
      engagement_type: 'FOUNDER_OPERATOR' as const,
      experience_class: 'PROFESSIONAL_PRODUCTION' as const,
      operating_model: null,
      start_date: '2023-01-01',
      end_date: null,
      is_current: true,
      production_start_date: '2023-02-01',
      first_external_user_date: '2023-03-01',
      hours_per_week_band: 'FULL_TIME' as const,
      summary: 'Built and operated a production platform.',
      verification_status: 'SELF_ATTESTED' as const,
      created_at: new Date('2024-01-01T00:00:00.000Z'),
    };

    const employee = {
      ...founder,
      id: '00000000-0000-0000-0000-000000000002',
      engagement_key: 'employee.alpha',
      engagement_type: 'EMPLOYEE' as const,
      role_title: 'Engineer',
    };

    const founderDuration = await calculateEngagementExperience(founder, referenceDate);
    const employeeDuration = await calculateEngagementExperience(employee, referenceDate);

    expect(founderDuration.totalMonths).toBe(employeeDuration.totalMonths);
    expect(founderDuration.totalMonths).toBe(12);
  });

  it('merges overlapping professional intervals and excludes non-professional classes', async () => {
    const referenceDate = new Date('2024-12-31T00:00:00.000Z');
    const engagements = [
      {
        id: '00000000-0000-0000-0000-000000000101',
        profile_version_id: '00000000-0000-0000-0000-000000000010',
        engagement_key: 'eng.one',
        organization_legal_name: 'Org One',
        brand_or_program_name: null,
        role_title: 'Engineer',
        engagement_type: 'EMPLOYEE' as const,
        experience_class: 'PROFESSIONAL_PRODUCTION' as const,
        operating_model: null,
        start_date: '2020-01-01',
        end_date: '2021-01-01',
        is_current: false,
        production_start_date: null,
        first_external_user_date: null,
        hours_per_week_band: null,
        summary: 'Built production systems in an engineering team.',
        verification_status: 'VERIFIED' as const,
        created_at: new Date('2024-01-01T00:00:00.000Z'),
      },
      {
        id: '00000000-0000-0000-0000-000000000102',
        profile_version_id: '00000000-0000-0000-0000-000000000010',
        engagement_key: 'eng.two',
        organization_legal_name: 'Org Two',
        brand_or_program_name: null,
        role_title: 'Consultant',
        engagement_type: 'CONTRACTOR' as const,
        experience_class: 'PROFESSIONAL_PRODUCTION' as const,
        operating_model: null,
        start_date: '2020-06-01',
        end_date: '2021-06-01',
        is_current: false,
        production_start_date: null,
        first_external_user_date: null,
        hours_per_week_band: null,
        summary: 'Delivered production features for client operations.',
        verification_status: 'VERIFIED' as const,
        created_at: new Date('2024-01-01T00:00:00.000Z'),
      },
      {
        id: '00000000-0000-0000-0000-000000000103',
        profile_version_id: '00000000-0000-0000-0000-000000000010',
        engagement_key: 'eng.three',
        organization_legal_name: 'Org Three',
        brand_or_program_name: null,
        role_title: 'Learner',
        engagement_type: 'RESEARCHER' as const,
        experience_class: 'COURSE_PROJECT' as const,
        operating_model: null,
        start_date: '2021-01-01',
        end_date: '2022-01-01',
        is_current: false,
        production_start_date: null,
        first_external_user_date: null,
        hours_per_week_band: null,
        summary: 'Built course project prototypes for learning outcomes.',
        verification_status: 'SELF_ATTESTED' as const,
        created_at: new Date('2024-01-01T00:00:00.000Z'),
      },
    ];

    const result = await calculateConceptExperience(engagements, referenceDate);

    expect(result.intervals.length).toBe(1);
    expect(result.totalMonths).toBe(17);
    expect(result.totalYears).toBeCloseTo(17 / 12, 6);
  });
});
