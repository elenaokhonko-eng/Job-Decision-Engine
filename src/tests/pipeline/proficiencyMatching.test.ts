import { describe, expect, it } from 'vitest';
import { computeProficiencyFactor } from '../../pipeline/deterministicMatcher.js';
import { computeEvidenceStrength, DEFAULT_EVIDENCE_STRENGTH_POLICY } from '../../evidence/evidenceStrengthPolicy.js';

describe('Proficiency-Aware Matching & Evidence Strength', () => {
  it('demonstrates that a 5-year production ML requirement receives minimal score from LEARNING evidence', () => {
    const learningFact = {
      id: 'fact.ai.model_training.planned',
      fact_type: 'SKILL',
      statement: 'Model training from scratch: planned and learning; not yet deployed in production.',
      evidence_tier: 'KNOWLEDGE_ONLY',
      verification_status: 'SELF_ATTESTED',
      structured_value: {
        proficiency: 'LEARNING',
        hands_on_level: 'NONE',
        development_status: 'PLANNED',
        interest: 'TARGET', // High interest, but only LEARNING evidence
      },
    };

    const productionRequirement = {
      id: 'req.ml.production',
      requirement_key: 'req.ml.production_5yr',
      requirement_type: 'SKILL',
      importance: 'MUST' as const,
      requirement_text: 'Requires at least 5 years hands-on production machine learning model training experience.',
      quote_text: '5 years production model training',
      structured_value: null,
    };

    const factor = computeProficiencyFactor(learningFact, productionRequirement);
    expect(factor).toBeLessThanOrEqual(0.05);

    const baseEvidenceStrength = computeEvidenceStrength(
      learningFact.evidence_tier as any,
      learningFact.verification_status as any,
      DEFAULT_EVIDENCE_STRENGTH_POLICY
    );
    const effectiveStrength = baseEvidenceStrength * factor;

    // Must be far below the 0.4 threshold required for a counted match
    expect(effectiveStrength).toBeLessThan(0.1);
  });

  it('demonstrates that an LLM/RAG architecture requirement legitimately matches applied startup evidence', () => {
    const appliedRAGFact = {
      id: 'fact.ai.rag_architectures.hands_on',
      fact_type: 'SKILL',
      statement: 'Hands-on production architecture and deployment of multi-stage RAG pipelines and vector search.',
      evidence_tier: 'PROFESSIONAL_PRODUCTION',
      verification_status: 'SELF_ATTESTED',
      structured_value: {
        proficiency: 'ADVANCED',
        hands_on_level: 'PRODUCTION',
        development_status: 'CURRENT',
        interest: 'TARGET',
      },
    };

    const ragRequirement = {
      id: 'req.ai.rag',
      requirement_key: 'req.ai.rag_architecture',
      requirement_type: 'SKILL',
      importance: 'MUST' as const,
      requirement_text: 'Experience designing and deploying LLM and RAG solution architectures.',
      quote_text: 'LLM RAG architecture',
      structured_value: null,
    };

    const factor = computeProficiencyFactor(appliedRAGFact, ragRequirement);
    expect(factor).toBe(1.0);

    const baseEvidenceStrength = computeEvidenceStrength(
      appliedRAGFact.evidence_tier as any,
      appliedRAGFact.verification_status as any,
      DEFAULT_EVIDENCE_STRENGTH_POLICY
    );
    const effectiveStrength = baseEvidenceStrength * factor;

    // Strong match above 0.4 threshold
    expect(effectiveStrength).toBeGreaterThanOrEqual(0.5);
  });

  it('demonstrates that personal interest (TARGET vs AVOID) does not alter capability match score', () => {
    const targetFact = {
      id: 'fact.delivery.prog.1',
      fact_type: 'SKILL',
      statement: 'Transformation decomposition across multi-tier enterprise systems.',
      evidence_tier: 'PROFESSIONAL_PRODUCTION',
      verification_status: 'SELF_ATTESTED',
      structured_value: {
        proficiency: 'EXPERT',
        hands_on_level: 'PRODUCTION',
        interest: 'TARGET',
      },
    };

    const avoidFact = {
      id: 'fact.delivery.prog.2',
      fact_type: 'SKILL',
      statement: 'Transformation decomposition across multi-tier enterprise systems.',
      evidence_tier: 'PROFESSIONAL_PRODUCTION',
      verification_status: 'SELF_ATTESTED',
      structured_value: {
        proficiency: 'EXPERT',
        hands_on_level: 'PRODUCTION',
        interest: 'AVOID', // Same capability, but marked AVOID
      },
    };

    const req = {
      id: 'req.decomp',
      requirement_key: 'req.decomp',
      requirement_type: 'SKILL',
      importance: 'MUST' as const,
      requirement_text: 'Experience with complex transformation decomposition and delivery.',
      quote_text: null,
      structured_value: null,
    };

    const factorTarget = computeProficiencyFactor(targetFact, req);
    const factorAvoid = computeProficiencyFactor(avoidFact, req);

    // Interest MUST NOT alter capability factor
    expect(factorTarget).toBe(factorAvoid);
    expect(factorTarget).toBe(1.0);
  });
});
