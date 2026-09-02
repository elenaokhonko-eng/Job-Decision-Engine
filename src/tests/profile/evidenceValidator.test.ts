import { describe, expect, it } from 'vitest';
import { validateEvidenceSourceReferences } from '../../profile/evidenceValidator.js';
import type { LoadedProfile } from '../../profile/loader.js';

function createLoadedProfile(): LoadedProfile {
  return {
    profile: {
      schema_version: '2.0',
      profile_key: 'candidate_alpha',
      profile_version: 1,
      display_name: 'Candidate Alpha',
      status: 'ACTIVE',
    },
    engagements: {
      schema_version: '2.0',
      profile_key: 'candidate_alpha',
      engagements: [
        {
          engagement_key: 'eng.alpha',
          organization_legal_name: 'Alpha Org',
          role_title: 'Engineer',
          engagement_type: 'EMPLOYEE',
          experience_class: 'PROFESSIONAL_PRODUCTION',
          start_date: '2020-01-01',
          is_current: true,
          summary: 'Built production systems for enterprise users.',
          verification_status: 'SELF_ATTESTED',
          evidence_source_keys: ['src.resume'],
        },
      ],
    },
    facts: {
      schema_version: '2.0',
      profile_key: 'candidate_alpha',
      facts: [
        {
          fact_key: 'fact.alpha',
          engagement_key: 'eng.alpha',
          fact_type: 'PROJECT',
          statement: 'Delivered a production AI service to external customers.',
          evidence_tier: 'PROFESSIONAL_PRODUCTION',
          verification_status: 'SELF_ATTESTED',
          is_current: true,
          confidentiality: 'PUBLIC',
          evidence_source_keys: ['src.repo'],
        },
      ],
    },
    credentials: {
      schema_version: '2.0',
      profile_key: 'candidate_alpha',
      credentials: [
        {
          credential_key: 'cred.alpha',
          credential_name: 'Cloud Cert',
          issuer: 'Provider',
          credential_type: 'CERTIFICATION',
          status: 'ACTIVE',
          verification_status: 'VERIFIED',
          evidence_source_key: 'src.badge',
        },
      ],
    },
  };
}

describe('validateEvidenceSourceReferences', () => {
  it('returns missing keys when references are undefined', () => {
    const loaded = createLoadedProfile();
    const result = validateEvidenceSourceReferences(loaded, [
      {
        source_key: 'src.resume',
        source_type: 'DOCUMENT',
        label: 'Resume PDF',
        verification_status: 'VERIFIED',
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('Missing evidence source definition for key: src.badge');
    expect(result.issues).toContain('Missing evidence source definition for key: src.repo');
  });

  it('passes when every referenced key has one source definition', () => {
    const loaded = createLoadedProfile();
    const result = validateEvidenceSourceReferences(loaded, [
      {
        source_key: 'src.resume',
        source_type: 'DOCUMENT',
        label: 'Resume PDF',
        verification_status: 'VERIFIED',
      },
      {
        source_key: 'src.repo',
        source_type: 'REPOSITORY',
        label: 'Repository URL',
        verification_status: 'SELF_ATTESTED',
      },
      {
        source_key: 'src.badge',
        source_type: 'CERTIFICATE',
        label: 'Badge URL',
        verification_status: 'VERIFIED',
      },
    ]);

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.referencedKeys).toEqual(['src.badge', 'src.repo', 'src.resume']);
  });
});
