import { describe, expect, it } from 'vitest';
import {
  computeRequirementEvidenceStrength,
  selectBestEvidenceFact,
  type FactRow,
  type RequirementRow,
  type ScoredFactCandidate,
} from '../../pipeline/deterministicMatcher.js';
import { DEFAULT_EVIDENCE_STRENGTH_POLICY } from '../../evidence/evidenceStrengthPolicy.js';
import {
  DETERMINISTIC_MATCHER_POLICY_VERSION,
  currentProfileMatchSql,
  profileMatchSupersededSql,
} from '../../pipeline/profileMatchCurrency.js';

const policy = DEFAULT_EVIDENCE_STRENGTH_POLICY;

const domainRequirement: RequirementRow = {
  id: 'req-domain',
  requirement_key: 'domain.healthcare',
  requirement_type: 'DOMAIN',
  importance: 'MUST',
  requirement_text: 'Experience in healthcare data products',
  quote_text: null,
  structured_value: null,
};

const degreeRequirement: RequirementRow = {
  id: 'req-degree',
  requirement_key: 'degree.masters',
  requirement_type: 'DEGREE',
  importance: 'MUST',
  requirement_text: "Master's degree in business or a related field",
  quote_text: null,
  structured_value: { degree_level: 'MASTERS' },
};

const weakSelfRatedFact: FactRow = {
  id: 'fact.domain.healthcare.2',
  fact_type: 'DOMAIN',
  statement: 'Healthcare domain expertise (Self-rating: 2/5, developing)',
  evidence_tier: 'KNOWLEDGE_ONLY',
  verification_status: 'SELF_ATTESTED',
  structured_value: null,
};

const professionalFact: FactRow = {
  id: 'fact.project.clinical_data_platform',
  fact_type: 'PROJECT',
  statement: 'Built and ran a production clinical data platform for a hospital network',
  evidence_tier: 'PROFESSIONAL_PRODUCTION',
  verification_status: 'SELF_ATTESTED',
  structured_value: null,
};

const mbaFact: FactRow = {
  id: 'fact.education.mba_business_foundation',
  fact_type: 'EDUCATION',
  statement: 'MBA, business foundation',
  evidence_tier: 'KNOWLEDGE_ONLY',
  verification_status: 'SELF_ATTESTED',
  structured_value: { degree_level: 'MASTERS' },
};

function candidate(fact: FactRow, score: number): ScoredFactCandidate {
  return { fact, score, lexicalScore: 0, semanticScore: score };
}

describe('selectBestEvidenceFact', () => {
  it('credits a strong professional fact over a slightly more similar weak self-rated fact', () => {
    const selected = selectBestEvidenceFact(
      [candidate(weakSelfRatedFact, 0.56), candidate(professionalFact, 0.53)],
      domainRequirement,
      policy,
      { usedEmbeddings: true },
    );

    expect(selected?.fact.id).toBe(professionalFact.id);
    expect(selected?.score).toBe(0.53);
    expect(selected?.evidenceStrength).toBeCloseTo(0.7, 6);
    expect(selected?.credit).toBeCloseTo(0.53 * 0.7, 6);
  });

  it('is independent of candidate order and breaks credit ties by score, then first candidate', () => {
    const reversed = selectBestEvidenceFact(
      [candidate(professionalFact, 0.53), candidate(weakSelfRatedFact, 0.56)],
      domainRequirement,
      policy,
      { usedEmbeddings: true },
    );
    expect(reversed?.fact.id).toBe(professionalFact.id);

    const twin: FactRow = { ...professionalFact, id: 'fact.project.twin' };
    const tie = selectBestEvidenceFact(
      [candidate(professionalFact, 0.6), candidate(twin, 0.6)],
      domainRequirement,
      policy,
      { usedEmbeddings: true },
    );
    expect(tie?.fact.id).toBe(professionalFact.id);
  });

  it('does not credit a strong fact below the semantic threshold; keeps the most similar fact uncredited', () => {
    const selected = selectBestEvidenceFact(
      [candidate(weakSelfRatedFact, 0.5), candidate(professionalFact, 0.44)],
      domainRequirement,
      policy,
      { usedEmbeddings: true },
    );

    expect(selected?.fact.id).toBe(weakSelfRatedFact.id);
    expect(selected?.credit).toBe(0);
    expect(selected?.evidenceStrength).toBeCloseTo(0.1 * 0.7, 6);
  });

  it('keeps raw-similarity selection and no credit when embeddings are not ready', () => {
    const selected = selectBestEvidenceFact(
      [candidate(weakSelfRatedFact, 0.56), candidate(professionalFact, 0.53)],
      domainRequirement,
      policy,
      { usedEmbeddings: false },
    );

    expect(selected?.fact.id).toBe(weakSelfRatedFact.id);
    expect(selected?.credit).toBe(0);
  });

  it('returns no fact when no candidate has a positive score', () => {
    expect(
      selectBestEvidenceFact([candidate(professionalFact, 0)], domainRequirement, policy, { usedEmbeddings: true }),
    ).toBeNull();
  });
});

describe('computeRequirementEvidenceStrength', () => {
  it('credits a structured degree match by verification status, not the KNOWLEDGE_ONLY tier', () => {
    expect(
      computeRequirementEvidenceStrength(mbaFact, degreeRequirement, policy, { structuredExactMatch: true }),
    ).toBeCloseTo(0.7, 6);
    expect(
      computeRequirementEvidenceStrength(
        { ...mbaFact, verification_status: 'VERIFIED' },
        degreeRequirement,
        policy,
        { structuredExactMatch: true },
      ),
    ).toBe(1);
    expect(
      computeRequirementEvidenceStrength(
        mbaFact,
        { ...degreeRequirement, requirement_type: 'CREDENTIAL' },
        policy,
        { structuredExactMatch: true },
      ),
    ).toBeCloseTo(0.7, 6);
  });

  it('keeps the hands-on tier for non-structured matches and for other structured requirement types', () => {
    expect(
      computeRequirementEvidenceStrength(mbaFact, degreeRequirement, policy, { structuredExactMatch: false }),
    ).toBeCloseTo(0.1 * 0.7, 6);
    expect(
      computeRequirementEvidenceStrength(
        mbaFact,
        { ...degreeRequirement, requirement_type: 'EXPERIENCE_YEARS' },
        policy,
        { structuredExactMatch: true },
      ),
    ).toBeCloseTo(0.1 * 0.7, 6);
  });

  it('gives no credit without a fact', () => {
    expect(computeRequirementEvidenceStrength(null, degreeRequirement, policy, { structuredExactMatch: true })).toBe(0);
  });
});

describe('matcher scoring version currency', () => {
  it('treats an older-rules match run as superseded only when the matcher can re-match the job', () => {
    const superseded = profileMatchSupersededSql('c', 'mr');
    expect(superseded).toContain(`mr.policy_version IS DISTINCT FROM '${DETERMINISTIC_MATCHER_POLICY_VERSION}'`);
    expect(superseded).toContain(`c.description_quality_status = 'COMPLETE'`);
    // An older-rules match is still a complete match for the decision and AI enqueue paths.
    expect(currentProfileMatchSql('c', 'mr', 'jv')).not.toContain('policy_version');
    expect(DETERMINISTIC_MATCHER_POLICY_VERSION).not.toBe('deterministic_v1');
  });
});
