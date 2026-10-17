import { describe, expect, it } from 'vitest';
import { loadProfile } from '../../profile/loader.js';
import { compareProfiles } from '../../profile/profileDiff.js';
import type { LoadedProfile } from '../../profile/loader.js';

describe('Profile Diff & Upgrade Reporting', () => {
  it('correctly compares version 5 archive and version 6 candidate profile', async () => {
    const oldProfile = await loadProfile('private/profile_v5');
    const newProfile = await loadProfile('private/profile');

    const { report, markdown } = compareProfiles(oldProfile, newProfile);

    expect(report.old_version).toBe(5);
    expect(report.new_version).toBe(6);
    expect(report.facts_added.length).toBeGreaterThan(0);
    expect(report.credentials_added.length).toBe(6); // 5 in-progress Google certs + AWS Certified AI Specialist
    expect(report.credentials_removed.length).toBe(1); // cred.aws.sa removed / realigned to roadmap
    expect(report.engagement_summaries_changed.length).toBe(7);

    // Verify proficiency breakdown totals match new facts count
    const totalProficiencyCount = Object.values(report.proficiency_breakdown).reduce((a, b) => a + b, 0);
    expect(totalProficiencyCount).toBe(newProfile.facts.facts.length);

    // Verify markdown structure
    expect(markdown).toContain('# Profile Difference & Capability Upgrade Report');
    expect(markdown).toContain('AWS Certified AI Specialist');
    expect(markdown).toContain('Google Professional Cloud Architect');
    expect(markdown).toContain('AWS Certified Solutions Architect');
    expect(markdown).toContain('auDHD Research Lab');
  });

  it('detects added facts, updated statements, and credential status transitions', () => {
    const base: LoadedProfile = {
      profile: {
        schema_version: '2.0',
        profile_key: 'test_candidate',
        profile_version: 1,
        display_name: 'Test Candidate',
        status: 'ACTIVE',
      },
      engagements: {
        schema_version: '2.0',
        profile_key: 'test_candidate',
        engagements: [
          {
            engagement_key: 'eng.test',
            organization_legal_name: 'Test Org',
            role_title: 'Engineer',
            engagement_type: 'EMPLOYEE',
            experience_class: 'PROFESSIONAL_PRODUCTION',
            start_date: '2022-01-01',
            is_current: true,
            summary: 'Initial summary.',
            verification_status: 'VERIFIED',
          },
        ],
      },
      facts: {
        schema_version: '2.0',
        profile_key: 'test_candidate',
        facts: [
          {
            fact_key: 'fact.test.1',
            engagement_key: 'eng.test',
            fact_type: 'SKILL',
            statement: 'Initial fact statement.',
            evidence_tier: 'PROFESSIONAL_PRODUCTION',
            verification_status: 'VERIFIED',
            is_current: true,
            confidentiality: 'PUBLIC',
          },
        ],
      },
      credentials: {
        schema_version: '2.0',
        profile_key: 'test_candidate',
        credentials: [
          {
            credential_key: 'cred.test.1',
            credential_name: 'Test Cert',
            issuer: 'Test Issuer',
            credential_type: 'CERTIFICATION',
            status: 'IN_PROGRESS',
            verification_status: 'SELF_ATTESTED',
          },
        ],
      },
    };

    const next: LoadedProfile = JSON.parse(JSON.stringify(base));
    next.profile.profile_version = 2;
    next.engagements.engagements[0].summary = 'Updated summary with more details.';
    next.facts.facts[0].statement = 'Updated fact statement with more impact.';
    next.facts.facts.push({
      fact_key: 'fact.test.2',
      engagement_key: 'eng.test',
      fact_type: 'ACHIEVEMENT',
      statement: 'Brand new achievement statement.',
      evidence_tier: 'PROFESSIONAL_PRODUCTION',
      verification_status: 'VERIFIED',
      is_current: true,
      confidentiality: 'PUBLIC',
    });
    next.credentials.credentials[0].status = 'ACTIVE';

    const { report } = compareProfiles(base, next);

    expect(report.facts_added.length).toBe(1);
    expect(report.facts_added[0].fact_key).toBe('fact.test.2');
    expect(report.facts_updated.length).toBe(1);
    expect(report.facts_updated[0].fact_key).toBe('fact.test.1');
    expect(report.engagement_summaries_changed.length).toBe(1);
    expect(report.credentials_updated.length).toBe(1);
    expect(report.credentials_updated[0].details).toContain('IN_PROGRESS -> ACTIVE');
  });
});
