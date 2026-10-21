import type { CapabilityFamily } from '../../profile/contracts.js';
import type { LoadedProfile } from '../../profile/loader.js';

type ProfileFact = LoadedProfile['facts']['facts'][number];
type ProfileCredential = LoadedProfile['credentials']['credentials'][number];

function createFact(
  factKey: string,
  capabilityName: string,
  statement: string,
  options: {
    capabilityFamily: CapabilityFamily;
    proficiency: string;
    handsOn: string;
    interest: string;
    evidenceStrength: string;
    aiAssisted?: boolean;
  }
): ProfileFact {
  return {
    fact_key: factKey,
    fact_type: 'SKILL',
    statement,
    evidence_tier: 'PROFESSIONAL_PRODUCTION',
    verification_status: 'SELF_ATTESTED',
    is_current: true,
    confidentiality: 'PUBLIC',
    structured_value: {
      capability_family: options.capabilityFamily,
      capability_name: capabilityName,
      display_label: capabilityName.replaceAll('_', ' '),
      proficiency: options.proficiency,
      hands_on_level: options.handsOn,
      interest: options.interest,
      evidence_strength: options.evidenceStrength,
      development_status: options.proficiency === 'LEARNING' ? 'DEVELOPING' : 'CURRENT',
      ...(options.aiAssisted ? { ai_assisted: true } : {}),
    },
  };
}

function createCredential(
  key: string,
  name: string,
  status: ProfileCredential['status']
): ProfileCredential {
  return {
    credential_key: key,
    credential_name: name,
    issuer: 'Test Issuer',
    credential_type: 'CERTIFICATION',
    status,
    verification_status: 'SELF_ATTESTED',
  };
}

function createBaseProfile(version: number, status: 'ACTIVE' | 'DRAFT'): LoadedProfile {
  return {
    profile: {
      schema_version: '2.0',
      profile_key: 'test_candidate',
      profile_version: version,
      display_name: 'Test Candidate',
      professional_headline: 'Technical Architect',
      status,
    },
    engagements: {
      schema_version: '2.0',
      profile_key: 'test_candidate',
      engagements: [{
        engagement_key: 'eng.test_lab',
        organization_legal_name: 'Test Research Lab',
        role_title: 'Research Platform Engineer',
        engagement_type: 'EMPLOYEE',
        experience_class: 'PROFESSIONAL_PRODUCTION',
        start_date: '2022-01-01',
        is_current: true,
        summary: 'Built a technical research platform.',
        verification_status: 'SELF_ATTESTED',
      }],
    },
    facts: {
      schema_version: '2.0',
      profile_key: 'test_candidate',
      facts: [
        createFact('fact.test.programme_coordination', 'programme_coordination', 'Led programme coordination.', {
          capabilityFamily: 'TECHNICAL_DELIVERY',
          proficiency: 'EXPERT',
          handsOn: 'PRODUCTION',
          interest: 'AVOID',
          evidenceStrength: 'PROFESSIONAL_PRODUCTION',
        }),
        createFact('fact.test.observability', 'observability', 'Learning observability foundations.', {
          capabilityFamily: 'AI_ENGINEERING',
          proficiency: 'LEARNING',
          handsOn: 'CONCEPTUAL',
          interest: 'SUPPORTING',
          evidenceStrength: 'KNOWLEDGE_ONLY',
        }),
        createFact('fact.test.cloud_architecture', 'cloud_architecture', 'Studied cloud architecture concepts.', {
          capabilityFamily: 'SYSTEMS_ARCHITECTURE',
          proficiency: 'FOUNDATIONAL',
          handsOn: 'CONCEPTUAL',
          interest: 'TARGET',
          evidenceStrength: 'KNOWLEDGE_ONLY',
        }),
        createFact('fact.test.python', 'python', 'Used Python with AI-assisted development.', {
          capabilityFamily: 'SOFTWARE_ENGINEERING',
          proficiency: 'INDEPENDENT',
          handsOn: 'PRODUCTION',
          interest: 'TARGET',
          evidenceStrength: 'PROFESSIONAL_PRODUCTION',
          aiAssisted: true,
        }),
        createFact('fact.test.typescript', 'typescript', 'Used TypeScript with AI-assisted development.', {
          capabilityFamily: 'SOFTWARE_ENGINEERING',
          proficiency: 'INDEPENDENT',
          handsOn: 'PRODUCTION',
          interest: 'TARGET',
          evidenceStrength: 'PROFESSIONAL_PRODUCTION',
          aiAssisted: true,
        }),
        createFact('fact.arch.ai_llm_solution_architecture', 'ai_llm_solution_architecture', 'Designed a test AI and LLM solution architecture.', {
          capabilityFamily: 'SYSTEMS_ARCHITECTURE',
          proficiency: 'ADVANCED',
          handsOn: 'PRODUCTION',
          interest: 'TARGET',
          evidenceStrength: 'PROFESSIONAL_PRODUCTION',
        }),
      ],
    },
    credentials: {
      schema_version: '2.0',
      profile_key: 'test_candidate',
      credentials: [createCredential('cred.test.architect', 'Test Architect Certificate', 'ACTIVE')],
    },
  };
}

export function createCapabilityProfileFixture(): LoadedProfile {
  return createBaseProfile(1, 'ACTIVE');
}

export function createProfileUpgradeFixtures(): { oldProfile: LoadedProfile; newProfile: LoadedProfile } {
  const oldProfile = createBaseProfile(5, 'ACTIVE');
  const newProfile = createBaseProfile(6, 'DRAFT');

  oldProfile.engagements.engagements[0].summary = 'Delivered a first-generation research platform.';
  newProfile.engagements.engagements[0].summary = 'Delivered an updated technical research platform.';

  const oldCloudFact = oldProfile.facts.facts.find((fact) => fact.fact_key === 'fact.test.cloud_architecture');
  const newCloudFact = newProfile.facts.facts.find((fact) => fact.fact_key === 'fact.test.cloud_architecture');
  if (oldCloudFact) oldCloudFact.statement = 'Studied cloud architecture concepts.';
  if (newCloudFact) newCloudFact.statement = 'Applied cloud architecture concepts in a test project.';
  newProfile.facts.facts.push(
    createFact('fact.test.ai_platform', 'ai_platform', 'Built a test AI platform.', {
      capabilityFamily: 'AI_ENGINEERING',
      proficiency: 'APPLIED',
      handsOn: 'APPLIED_PROJECT',
      interest: 'TARGET',
      evidenceStrength: 'APPLIED_PROJECT',
    })
  );

  oldProfile.credentials.credentials = [
    createCredential('cred.test.architect', 'Test Architect Certificate', 'ACTIVE'),
    createCredential('cred.test.ai', 'Test AI Specialist', 'IN_PROGRESS'),
    createCredential('cred.test.roadmap', 'Test Roadmap Credential', 'ACTIVE'),
  ];
  newProfile.credentials.credentials = [
    createCredential('cred.test.architect', 'Test Architect Certificate', 'ACTIVE'),
    createCredential('cred.test.ai', 'Test AI Specialist', 'ACTIVE'),
    createCredential('cred.test.new', 'Test Data Specialist', 'ACTIVE'),
  ];

  return { oldProfile, newProfile };
}
