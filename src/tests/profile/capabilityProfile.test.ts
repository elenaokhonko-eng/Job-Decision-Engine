import { describe, expect, it } from 'vitest';
import { createCapabilityProfileFixture } from './profileFixtures.js';
import { generateCapabilityProfile } from '../../profile/capabilityProfileGenerator.js';
import { validateDocumentCurrentContext, type DocumentCurrentContext } from '../../documents/currentContext.js';
import { computeProficiencyFactor } from '../../pipeline/deterministicMatcher.js';
import type { LoadedProfile } from '../../profile/loader.js';

describe('Stage 1 Capability Profile V1', () => {
  it('demonstrates one capability can have high proficiency but low future interest', () => {
    const loaded = createCapabilityProfileFixture();
    const { capabilityProfile } = generateCapabilityProfile(loaded);

    // Routine programme coordination: high proficiency (EXPERT), but interest is AVOID
    const progCoord = capabilityProfile.capability_families
      .flatMap((f) => f.capabilities)
      .find((c) => c.capability_name === 'programme_coordination');

    expect(progCoord).toBeDefined();
    expect(progCoord?.proficiency).toBe('EXPERT');
    expect(progCoord?.interest).toBe('AVOID');
  });

  it('demonstrates one capability can have high interest but only LEARNING evidence', () => {
    const loaded = createCapabilityProfileFixture();
    const { capabilityProfile } = generateCapabilityProfile(loaded);

    // Observability or fine-tuning: learning proficiency, knowledge-only or applied, strong/target interest
    const observability = capabilityProfile.capability_families
      .flatMap((f) => f.capabilities)
      .find((c) => c.capability_name === 'observability');

    expect(observability).toBeDefined();
    expect(observability?.proficiency).toBe('LEARNING');
    expect(observability?.hands_on_level).toBe('CONCEPTUAL');
    expect(observability?.evidence_strength).toBe('KNOWLEDGE_ONLY');
    expect(observability?.interest).toBe('SUPPORTING');
  });

  it('demonstrates knowledge-only does not become production experience', () => {
    const loaded = createCapabilityProfileFixture();
    const { capabilityProfile } = generateCapabilityProfile(loaded);

    // Cloud architecture: developing/conceptual, knowledge-only
    const cloudArch = capabilityProfile.capability_families
      .flatMap((f) => f.capabilities)
      .find((c) => c.capability_name === 'cloud_architecture');

    expect(cloudArch).toBeDefined();
    expect(cloudArch?.evidence_strength).toBe('KNOWLEDGE_ONLY');
    expect(cloudArch?.hands_on_level).toBe('CONCEPTUAL');
    expect(cloudArch?.proficiency).toBe('FOUNDATIONAL');

    // Test proficiency factor against a requirement demanding production experience
    const mockFact = {
      id: 'mock-fact-1',
      fact_type: 'SKILL',
      statement: cloudArch!.statement,
      evidence_tier: 'KNOWLEDGE_ONLY',
      verification_status: 'SELF_ATTESTED',
      structured_value: {
        proficiency: cloudArch!.proficiency,
        hands_on_level: cloudArch!.hands_on_level,
        development_status: cloudArch!.development_status,
      },
    };

    const productionReq = {
      id: 'mock-req-1',
      requirement_key: 'req.cloud.prod',
      requirement_type: 'SKILL',
      importance: 'MUST' as const,
      requirement_text: 'Minimum 5 years production cloud architecture experience required.',
      quote_text: 'proven production cloud architecture',
      structured_value: null,
    };

    const factor = computeProficiencyFactor(mockFact, productionReq);
    expect(factor).toBeLessThan(0.35); // Strongly discounted, cannot satisfy production requirement
  });

  it('demonstrates AI-assisted software engineering remains accurately labelled', () => {
    const loaded = createCapabilityProfileFixture();
    const { capabilityProfile, markdown } = generateCapabilityProfile(loaded);

    const pythonCap = capabilityProfile.capability_families
      .flatMap((f) => f.capabilities)
      .find((c) => c.capability_name === 'python');
    const tsCap = capabilityProfile.capability_families
      .flatMap((f) => f.capabilities)
      .find((c) => c.capability_name === 'typescript');

    expect(pythonCap).toBeDefined();
    expect(pythonCap?.ai_assisted).toBe(true);
    expect(pythonCap?.proficiency).toBe('INDEPENDENT');

    expect(tsCap).toBeDefined();
    expect(tsCap?.ai_assisted).toBe(true);
    expect(tsCap?.proficiency).toBe('INDEPENDENT');

    // Verify markdown renders (AI-assisted) tag
    expect(markdown).toContain('*(AI-assisted)*');
  });

  it('demonstrates derived skills.md and JSON contain only canonical source facts', () => {
    const loaded = createCapabilityProfileFixture();
    const { capabilityProfile } = generateCapabilityProfile(loaded);

    const sourceFactKeys = new Set(loaded.facts.facts.map((f) => f.fact_key));

    // Every key in evidence_index must be a real canonical fact
    for (const factKey of Object.keys(capabilityProfile.evidence_index)) {
      expect(sourceFactKeys.has(factKey)).toBe(true);
    }

    // Every capability in capability_families must point to valid source fact keys
    for (const family of capabilityProfile.capability_families) {
      for (const cap of family.capabilities) {
        for (const key of cap.source_fact_keys) {
          expect(sourceFactKeys.has(key)).toBe(true);
        }
      }
    }

    // Domain expertise must point to valid source fact keys
    for (const domain of capabilityProfile.domain_expertise) {
      for (const key of domain.source_fact_keys) {
        expect(sourceFactKeys.has(key)).toBe(true);
      }
    }
  });

  it('demonstrates deleting or changing a fact changes derived output', () => {
    const loaded = createCapabilityProfileFixture();
    const original = generateCapabilityProfile(loaded);

    // Deep clone loaded profile and change a statement and proficiency
    const cloned: LoadedProfile = JSON.parse(JSON.stringify(loaded));
    const targetFact = cloned.facts.facts.find(
      (f) => f.fact_key === 'fact.arch.ai_llm_solution_architecture'
    );
    expect(targetFact).toBeDefined();
    targetFact!.statement = 'MODIFIED: Specialized in autonomous micro-agent frameworks.';
    (targetFact!.structured_value as any).proficiency = 'EXPERT';

    const modified = generateCapabilityProfile(cloned);

    // Statement changed in derived JSON and Markdown
    const modifiedCap = modified.capabilityProfile.capability_families
      .flatMap((f) => f.capabilities)
      .find((c) => c.capability_name === 'ai_llm_solution_architecture');

    expect(modifiedCap?.statement).toContain('MODIFIED: Specialized');
    expect(modifiedCap?.proficiency).toBe('EXPERT');
    expect(modified.markdown).toContain('MODIFIED: Specialized');

    // Deleting a fact removes it from derived output
    const beforeCount = Object.keys(modified.capabilityProfile.evidence_index).length;
    cloned.facts.facts = cloned.facts.facts.filter(
      (f) => f.fact_key !== 'fact.arch.ai_llm_solution_architecture'
    );
    const afterDelete = generateCapabilityProfile(cloned);
    const afterCount = Object.keys(afterDelete.capabilityProfile.evidence_index).length;

    expect(afterCount).toBe(beforeCount - 1);
    expect(afterDelete.capabilityProfile.evidence_index['fact.arch.ai_llm_solution_architecture']).toBeUndefined();
  });

  it('demonstrates derived outputs never create new unsupported claims', () => {
    const loaded = createCapabilityProfileFixture();
    const { capabilityProfile } = generateCapabilityProfile(loaded);

    // Check that every capability statement is directly sourced from a canonical statement
    const canonicalStatements = new Set(loaded.facts.facts.map((f) => f.statement));

    for (const family of capabilityProfile.capability_families) {
      for (const cap of family.capabilities) {
        expect(canonicalStatements.has(cap.statement)).toBe(true);
      }
    }
  });

  it('demonstrates profile-version change invalidates current match/ranking/document contexts', () => {
    // When the active profile version changes, previous contexts become stale
    const contextWithStaleProfile: DocumentCurrentContext = {
      current_job_version_id: 'jv-1',
      selected_job_version_id: 'jv-1',
      active_profile_version_id: 'pv-new-v6',
      selected_profile_version_id: 'pv-old-v5', // Stale selection!
      latest_match_run_id: 'mr-1',
      match_run_id: 'mr-1',
      match_run_job_version_id: 'jv-1',
      match_run_profile_version_id: 'pv-old-v5',
      match_run_status: 'COMPLETED',
      match_run_requirement_set_id: 'rs-1',
      active_requirement_set_id: 'rs-1',
      match_run_job_content_hash: 'hash-1',
      current_job_content_hash: 'hash-1',
      match_run_context_fingerprint: 'fp-1',
      latest_deterministic_decision_id: 'dd-1',
      deterministic_decision_id: 'dd-1',
      decision_job_version_id: 'jv-1',
      decision_match_run_id: 'mr-1',
      decision_context_fingerprint: 'fp-1',
      decision_recommendation_eligibility: 'ELIGIBLE',
      decision_recommendation_outcome: 'APPLY_NOW',
      readiness_status: 'READY',
      readiness_fingerprint: 'a'.repeat(64),
      readiness_expires_at: '2099-01-01T00:00:00.000Z',
      readiness_reason_codes: [],
      gate_status: 'PASS',
      recommendation_eligibility: 'ELIGIBLE',
      recommendation_outcome: 'APPLY_NOW',
    };

    const result = validateDocumentCurrentContext(contextWithStaleProfile);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('PROFILE_STALE');
    }

    // When selected_profile_version_id is updated to active, but match_run was against old profile
    const contextWithStaleMatch: DocumentCurrentContext = {
      ...contextWithStaleProfile,
      selected_profile_version_id: 'pv-new-v6',
      match_run_profile_version_id: 'pv-old-v5', // Old match run!
    };

    const matchResult = validateDocumentCurrentContext(contextWithStaleMatch);
    expect(matchResult.ok).toBe(false);
    if (!matchResult.ok) {
      expect(matchResult.reason).toBe('MATCH_STALE');
    }
  });

  it('demonstrates the capability profile generator is generic for any candidate', () => {
    // Construct an entirely different generic user
    const genericCandidate: LoadedProfile = {
      profile: {
        schema_version: '2.0',
        profile_key: 'generic_dev_01',
        profile_version: 1,
        display_name: 'Alex Developer',
        professional_headline: 'Distributed Systems & Database Architect',
        status: 'ACTIVE',
      },
      engagements: {
        schema_version: '2.0',
        profile_key: 'generic_dev_01',
        engagements: [
          {
            engagement_key: 'eng.beta_corp',
            organization_legal_name: 'Beta Corp',
            role_title: 'Staff Systems Architect',
            engagement_type: 'EMPLOYEE',
            experience_class: 'PROFESSIONAL_PRODUCTION',
            start_date: '2021-01-01',
            is_current: true,
            summary: 'Architected distributed consensus and storage engines.',
            verification_status: 'VERIFIED',
          },
        ],
      },
      facts: {
        schema_version: '2.0',
        profile_key: 'generic_dev_01',
        facts: [
          {
            fact_key: 'fact.generic.raft_consensus',
            engagement_key: 'eng.beta_corp',
            fact_type: 'SKILL',
            statement: 'Designed and deployed Raft distributed consensus protocol handling 100K ops/sec.',
            structured_value: {
              capability_family: 'SYSTEMS_ARCHITECTURE',
              capability_name: 'raft_consensus',
              proficiency: 'EXPERT',
              hands_on_level: 'PRODUCTION',
              interest: 'TARGET',
              evidence_strength: 'PROFESSIONAL_PRODUCTION',
            },
            evidence_tier: 'PROFESSIONAL_PRODUCTION',
            verification_status: 'VERIFIED',
            is_current: true,
            confidentiality: 'PUBLIC',
          },
        ],
      },
      credentials: {
        schema_version: '2.0',
        profile_key: 'generic_dev_01',
        credentials: [],
      },
    };

    const { capabilityProfile, markdown } = generateCapabilityProfile(genericCandidate);

    expect(capabilityProfile.identity.display_name).toBe('Alex Developer');
    expect(capabilityProfile.profile_key).toBe('generic_dev_01');
    expect(capabilityProfile.capability_families.length).toBeGreaterThan(0);
    expect(markdown).toContain('Alex Developer');
    expect(markdown).toContain('Raft distributed consensus');
  });
});
