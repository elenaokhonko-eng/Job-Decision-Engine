import { describe, expect, it, vi } from 'vitest';
import {
  createProfileSourceHash,
  importLoadedProfile,
} from '../../profile/importer.js';
import type { LoadedProfile } from '../../profile/loader.js';
import type { EvidenceSourceInput } from '../../profile/evidenceValidator.js';

function createLoadedProfile(): LoadedProfile {
  return {
    profile: {
      schema_version: '2.0',
      profile_key: 'candidate_alpha',
      profile_version: 3,
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
          is_current: false,
          end_date: '2021-01-01',
          summary: 'Built production systems and shipped measurable improvements.',
          verification_status: 'VERIFIED',
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
          statement: 'Delivered AI-backed production services used by external users.',
          concept_keys: ['MACHINE_LEARNING'],
          evidence_tier: 'PROFESSIONAL_PRODUCTION',
          verification_status: 'VERIFIED',
          is_current: false,
          start_date: '2020-02-01',
          end_date: '2020-12-01',
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

function createEvidenceSources(): EvidenceSourceInput[] {
  return [
    {
      source_key: 'src.resume',
      source_type: 'DOCUMENT',
      label: 'Resume',
      verification_status: 'VERIFIED',
    },
    {
      source_key: 'src.repo',
      source_type: 'REPOSITORY',
      label: 'Repository',
      verification_status: 'SELF_ATTESTED',
    },
    {
      source_key: 'src.badge',
      source_type: 'CERTIFICATE',
      label: 'Badge',
      verification_status: 'VERIFIED',
    },
  ];
}

describe('importLoadedProfile', () => {
  it('imports profile data inside a transaction and sets ACTIVE status at end', async () => {
    let sourceInsertCounter = 0;
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO candidate_profiles')) {
        return { rows: [{ id: 'candidate-id-1' }] };
      }
      if (sql.includes('INSERT INTO evidence_sources')) {
        sourceInsertCounter += 1;
        return { rows: [{ id: `source-id-${sourceInsertCounter}` }] };
      }
      if (sql.includes('INSERT INTO profile_versions')) {
        return { rows: [{ id: 'profile-version-id-1' }] };
      }
      if (sql.includes('INSERT INTO profile_engagements')) {
        return { rows: [{ id: 'engagement-id-1' }] };
      }
      if (sql.includes('INSERT INTO profile_facts')) {
        return { rows: [{ id: 'fact-id-1' }] };
      }
      if (sql.includes('SELECT id') && sql.includes('FROM taxonomy_concepts')) {
        return { rows: [{ id: 'concept-id-1' }] };
      }
      return { rows: [] };
    });

    const fakeClient = {
      query,
      release: vi.fn(),
    } as any;

    const fakePool = {
      connect: vi.fn().mockResolvedValue(fakeClient),
    } as any;

    const loaded = createLoadedProfile();
    const summary = await importLoadedProfile(loaded, createEvidenceSources(), fakePool);

    expect(summary.candidateProfileId).toBe('candidate-id-1');
    expect(summary.profileVersionId).toBe('profile-version-id-1');
    expect(summary.sourceHash).toBe(createProfileSourceHash('candidate_alpha', 3));
    expect(summary.inserted.engagements).toBe(1);
    expect(summary.inserted.facts).toBe(1);
    expect(summary.inserted.credentials).toBe(1);

    const calls = query.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls[0]).toBe('BEGIN');
    expect(calls).toContain('COMMIT');
    expect(
      calls.some((sql: string) => sql.includes("SET status = 'ACTIVE', effective_at = CURRENT_TIMESTAMP"))
    ).toBe(true);
  });

  it('rolls back when an insert operation fails', async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO candidate_profiles')) {
        return { rows: [{ id: 'candidate-id-1' }] };
      }
      if (sql.includes('INSERT INTO evidence_sources')) {
        return { rows: [{ id: 'source-id-1' }] };
      }
      if (sql.includes('INSERT INTO profile_versions')) {
        return { rows: [{ id: 'profile-version-id-1' }] };
      }
      if (sql.includes('INSERT INTO profile_engagements')) {
        return { rows: [{ id: 'engagement-id-1' }] };
      }
      if (sql.includes('INSERT INTO profile_facts')) {
        throw new Error('fact insert failure');
      }
      return { rows: [] };
    });

    const fakeClient = {
      query,
      release: vi.fn(),
    } as any;

    const fakePool = {
      connect: vi.fn().mockResolvedValue(fakeClient),
    } as any;

    await expect(
      importLoadedProfile(createLoadedProfile(), createEvidenceSources(), fakePool)
    ).rejects.toThrow('fact insert failure');

    const calls = query.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(calls).toContain('ROLLBACK');
  });
});
