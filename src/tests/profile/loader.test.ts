import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

async function createProfileDir(): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-loader-'));

  const profile = {
    schema_version: '2.0',
    profile_key: 'candidate_alpha',
    profile_version: 1,
    display_name: 'Candidate Alpha',
    status: 'ACTIVE',
  };

  const engagements = {
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
        end_date: '2021-01-01',
        is_current: false,
        summary: 'Built production services and supporting components.',
        verification_status: 'VERIFIED',
      },
    ],
  };

  const facts = {
    schema_version: '2.0',
    profile_key: 'candidate_alpha',
    facts: [
      {
        fact_key: 'fact.alpha',
        engagement_key: 'eng.alpha',
        fact_type: 'PROJECT',
        statement: 'Delivered system improvements with measurable user impact.',
        evidence_tier: 'PROFESSIONAL_PRODUCTION',
        verification_status: 'VERIFIED',
        start_date: '2020-03-01',
        end_date: '2020-12-01',
        is_current: false,
        confidentiality: 'PUBLIC',
      },
    ],
  };

  const credentials = {
    schema_version: '2.0',
    profile_key: 'candidate_alpha',
    credentials: [
      {
        credential_key: 'cred.alpha',
        credential_name: 'Cloud Cert',
        issuer: 'Provider',
        credential_type: 'CERTIFICATION',
        issued_on: '2020-01-01',
        expires_on: '2024-01-01',
        status: 'ACTIVE',
        verification_status: 'VERIFIED',
      },
    ],
  };

  await fs.writeFile(path.join(tmpDir, 'profile.json'), JSON.stringify(profile, null, 2));
  await fs.writeFile(path.join(tmpDir, 'engagements.json'), JSON.stringify(engagements, null, 2));
  await fs.writeFile(path.join(tmpDir, 'facts.json'), JSON.stringify(facts, null, 2));
  await fs.writeFile(path.join(tmpDir, 'credentials.json'), JSON.stringify(credentials, null, 2));

  return tmpDir;
}

afterEach(async () => {
  delete process.env.PROFILE_DIR;
  vi.resetModules();
});

describe('loadProfile', () => {
  it('loads required files and allows missing optional files', async () => {
    const profileDir = await createProfileDir();
    process.env.PROFILE_DIR = profileDir;
    const mod = await import('../../profile/loader.js');

    const loaded = await mod.loadProfile();

    expect(loaded.profile.profile_key).toBe('candidate_alpha');
    expect(loaded.engagements.engagements.length).toBe(1);
    expect(loaded.workPreferences).toBeUndefined();
    expect(loaded.lanePreferences).toBeUndefined();

    await fs.rm(profileDir, { recursive: true, force: true });
  });

  it('fails on cross-file profile key mismatch', async () => {
    const profileDir = await createProfileDir();
    const factsPath = path.join(profileDir, 'facts.json');
    const facts = JSON.parse(await fs.readFile(factsPath, 'utf-8')) as {
      schema_version: string;
      profile_key: string;
      facts: unknown[];
    };
    facts.profile_key = 'candidate_beta';
    await fs.writeFile(factsPath, JSON.stringify(facts, null, 2));

    process.env.PROFILE_DIR = profileDir;
    const mod = await import('../../profile/loader.js');

    await expect(mod.loadProfile()).rejects.toThrow(
      'profile_key mismatch between profile.json and facts.json'
    );

    await fs.rm(profileDir, { recursive: true, force: true });
  });
});
