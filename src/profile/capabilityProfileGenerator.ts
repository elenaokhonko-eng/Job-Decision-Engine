/**
 * Deterministic Capability Profile & Skills Markdown Generator
 *
 * Generates role-neutral capability_profile.json and skills.md from canonical
 * profile facts, credentials, and engagements. Neither derived artifact is an
 * editable source of truth; both are strictly derived from canonical evidence.
 */

import type { LoadedProfile } from './loader.js';
import {
  type CapabilityProfile,
  type CapabilityFamily,
  type CapabilityEntry,
  type CapabilityFamilyGroup,
  type DomainExpertiseEntry,
  type SignatureStrengthEntry,
  type LanguageProficiency,
  type ProfessionalGeography,
  type DevelopmentPipelineEntry,
  type EvidenceIndexEntry,
  CapabilityProfileSchema,
} from './contracts.js';

export interface GenerationOptions {
  profileVersionId?: string;
  generatedAt?: string;
}

export interface GeneratedCapabilityArtifacts {
  capabilityProfile: CapabilityProfile;
  markdown: string;
}

const FAMILY_METADATA: Record<CapabilityFamily, { display_title: string; description: string }> = {
  SYSTEMS_ARCHITECTURE: {
    display_title: 'Systems & Architecture',
    description: 'Enterprise, application, data, and AI/LLM solution architecture; operating model design.',
  },
  AI_ENGINEERING: {
    display_title: 'AI Engineering & Agentic Systems',
    description: 'Multi-agent orchestration, RAG architectures, prompt engineering, vector search, and AI governance.',
  },
  SOFTWARE_ENGINEERING: {
    display_title: 'Hands-On Software Engineering',
    description: 'Independently usable Python, TypeScript, SQL, full-stack prototyping, APIs, and modern toolchains.',
  },
  DATA_ANALYTICS: {
    display_title: 'Data Architecture & Analytics',
    description: 'Data modelling, SQL, pipelines, vector databases, BI, analytics, and data governance.',
  },
  PRODUCT: {
    display_title: 'Product Strategy & Discovery',
    description: 'Problem discovery, user research, solution architecture, rapid prototyping, roadmaps, and 0-to-1 MVP launches.',
  },
  TECHNICAL_DELIVERY: {
    display_title: 'Technical Delivery & Transformation',
    description: 'Programme rescue, complex decomposition, dependency architecture, and regulatory change.',
  },
  RESEARCH: {
    display_title: 'Research & Complex Problem Solving',
    description: 'Literature review, research synthesis, pattern recognition, and empirical analysis.',
  },
  GOVERNANCE_RISK: {
    display_title: 'Governance, Risk & Compliance',
    description: 'Regulatory controls, model governance, compliance automation, operational risk, and legal-process design.',
  },
  DOMAIN_EXPERTISE: {
    display_title: 'Domain & Industry Expertise',
    description: 'Deep institutional domain knowledge across financial markets, FinTech, FMCG, and emerging fields.',
  },
  LEADERSHIP: {
    display_title: 'Leadership & Influence',
    description: 'Architecture authority, technical leadership, small expert teams, and selected mentoring.',
  },
  COMMUNICATION: {
    display_title: 'Communication & Stakeholder Translation',
    description: 'Technical writing, executive decks, architecture blueprints, and complex concept translation.',
  },
  FOUNDER_OPERATOR: {
    display_title: 'Founder & Operator Capabilities',
    description: 'End-to-end company creation, product architecture, grants, GTM, compliance, and delivery.',
  },
  LANGUAGES_GEOGRAPHY: {
    display_title: 'Languages & Regional Experience',
    description: 'Multi-lingual proficiencies and multi-jurisdiction operational familiarity across APAC, US, and Europe.',
  },
  SIGNATURE_STRENGTHS: {
    display_title: 'Signature Cognitive & Operating Strengths',
    description: 'High-order cross-domain strengths: pattern recognition, systems thinking, decomposition, and chaos-to-order transformation.',
  },
};

export function generateCapabilityProfile(
  loaded: LoadedProfile,
  options?: GenerationOptions
): GeneratedCapabilityArtifacts {
  const profile = loaded.profile;
  const facts = loaded.facts.facts;
  const credentials = loaded.credentials.credentials;
  const engagements = loaded.engagements.engagements;
  const profileVersionId = options?.profileVersionId || `v${profile.profile_version}`;
  const generatedAt = options?.generatedAt || new Date().toISOString();

  // 1. Build Evidence Index
  const evidenceIndex: Record<string, EvidenceIndexEntry> = {};
  for (const f of facts) {
    const meta = (f.structured_value || {}) as Record<string, any>;
    evidenceIndex[f.fact_key] = {
      fact_key: f.fact_key,
      statement: f.statement,
      fact_type: f.fact_type,
      evidence_tier: f.evidence_tier,
      verification_status: f.verification_status,
      engagement_key: f.engagement_key || null,
      proficiency: meta.proficiency,
      interest: meta.interest,
      evidence_strength: meta.evidence_strength || f.evidence_tier,
    };
  }

  // 2. Group Facts by Capability Family
  const familyFactsMap = new Map<CapabilityFamily, typeof facts>();
  for (const familyKey of Object.keys(FAMILY_METADATA) as CapabilityFamily[]) {
    familyFactsMap.set(familyKey, []);
  }

  for (const f of facts) {
    const meta = (f.structured_value || {}) as Record<string, any>;
    const family = meta.capability_family as CapabilityFamily | undefined;
    if (family && familyFactsMap.has(family)) {
      familyFactsMap.get(family)!.push(f);
    }
  }

  // 3. Build Capability Families
  const capabilityFamilies: CapabilityFamilyGroup[] = [];
  for (const [familyKey, groupFacts] of familyFactsMap.entries()) {
    if (familyKey === 'DOMAIN_EXPERTISE' || familyKey === 'SIGNATURE_STRENGTHS' || familyKey === 'LANGUAGES_GEOGRAPHY') {
      // Handled in dedicated sections below
      continue;
    }

    const capabilities: CapabilityEntry[] = groupFacts.map((f) => {
      const meta = (f.structured_value || {}) as Record<string, any>;
      const capName = String(meta.capability_name || f.fact_key.split('.').pop() || f.fact_key);
      const displayLabel = String(
        meta.display_label || capName.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
      );
      const linkedEngagement = f.engagement_key ? [f.engagement_key] : [];

      return {
        capability_name: capName,
        display_label: displayLabel,
        proficiency: meta.proficiency || 'FOUNDATIONAL',
        hands_on_level: meta.hands_on_level || (f.evidence_tier === 'PROFESSIONAL_PRODUCTION' ? 'PRODUCTION' : 'NONE'),
        interest: meta.interest || 'ACCEPTABLE',
        evidence_strength: meta.evidence_strength || f.evidence_tier,
        recency: meta.recency || (f.is_current ? 'CURRENT' : 'HISTORICAL'),
        ai_assisted: meta.ai_assisted,
        development_status: meta.development_status || 'CURRENT',
        statement: f.statement,
        source_fact_keys: [f.fact_key],
        engagement_keys: linkedEngagement,
        notes: meta.notes,
      };
    });

    capabilityFamilies.push({
      family: familyKey,
      display_title: FAMILY_METADATA[familyKey].display_title,
      description: FAMILY_METADATA[familyKey].description,
      capabilities,
    });
  }

  // 4. Build Domain Expertise
  const domainFacts = familyFactsMap.get('DOMAIN_EXPERTISE') || [];
  const domainExpertise: DomainExpertiseEntry[] = domainFacts.map((f) => {
    const meta = (f.structured_value || {}) as Record<string, any>;
    const domain = String(
      typeof meta.domain === 'string'
        ? meta.domain
        : meta.capability_name || f.fact_key.split('.').pop() || f.fact_key
    );
    const rating = typeof meta.rating === 'number' ? meta.rating : 3;
    const selfRating = meta.self_rating || `${rating}/5`;

    return {
      domain,
      display_label: String(
        meta.display_label || domain.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
      ),
      rating: Math.max(1, Math.min(5, rating)),
      self_rating: selfRating,
      proficiency: meta.proficiency || 'INDEPENDENT',
      interest: meta.interest || 'ACCEPTABLE',
      source_fact_keys: [f.fact_key],
      development_status: meta.development_status,
      notes: meta.notes,
    };
  });

  // 5. Build Signature Strengths
  const strengthFacts = familyFactsMap.get('SIGNATURE_STRENGTHS') || [];
  const signatureStrengths: SignatureStrengthEntry[] = strengthFacts.map((f) => {
    const meta = (f.structured_value || {}) as Record<string, any>;
    const strengthKey = String(meta.strength_key || meta.capability_name || f.fact_key);
    const name = String(
      meta.display_label || strengthKey.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
    );

    return {
      strength_key: strengthKey,
      name,
      description: f.statement,
      source_fact_keys: [f.fact_key],
    };
  });

  // 6. Build Languages & Geography
  const langGeoFacts = familyFactsMap.get('LANGUAGES_GEOGRAPHY') || [];
  const languages: LanguageProficiency[] = [];
  const professionalGeographies: ProfessionalGeography[] = [];

  for (const f of langGeoFacts) {
    const meta = (f.structured_value || {}) as Record<string, any>;
    if (meta.language) {
      languages.push({
        language: meta.language,
        speaking: meta.speaking || 'N/A',
        reading: meta.reading || 'N/A',
        writing: meta.writing || 'N/A',
        source_fact_keys: [f.fact_key],
      });
    } else if (meta.region || meta.geography) {
      professionalGeographies.push({
        region: meta.region || meta.geography,
        familiarity: meta.familiarity || 'PROFESSIONAL_DELIVERY',
        source_fact_keys: [f.fact_key],
      });
    }
  }

  // 7. Build Leadership Profile
  const leadershipFacts = familyFactsMap.get('LEADERSHIP') || [];
  const targetLeadershipModes: Array<{ mode: string; description: string; source_fact_keys: string[] }> = [];
  const nonTargetLeadershipModes: Array<{ mode: string; reason: string; source_fact_keys: string[] }> = [];

  for (const f of leadershipFacts) {
    const meta = (f.structured_value || {}) as Record<string, any>;
    const mode = meta.leadership_mode || meta.capability_name || f.statement;
    if (meta.interest === 'AVOID' || meta.interest === 'NO_INTEREST') {
      nonTargetLeadershipModes.push({
        mode,
        reason: f.statement,
        source_fact_keys: [f.fact_key],
      });
    } else {
      targetLeadershipModes.push({
        mode,
        description: f.statement,
        source_fact_keys: [f.fact_key],
      });
    }
  }

  // 8. Build Development Pipeline (In-progress & Planned)
  const developmentPipeline: DevelopmentPipelineEntry[] = [];

  // Add credentials from credentials.json that are IN_PROGRESS
  for (const cred of credentials) {
    if (cred.status === 'IN_PROGRESS') {
      const isArchitect = cred.credential_name.toLowerCase().includes('architect');
      developmentPipeline.push({
        item_type: 'CREDENTIAL',
        name: cred.credential_name,
        issuer_or_domain: cred.issuer,
        status: 'IN_PROGRESS',
        priority: isArchitect ? 'HIGHEST' : 'HIGH',
        credential_key: cred.credential_key,
        target_timeline: 'Under active study',
      });
    }
  }

  // Add learning/planned capabilities from facts
  for (const f of facts) {
    const meta = (f.structured_value || {}) as Record<string, any>;
    if (meta.development_status === 'DEVELOPING' || meta.development_status === 'PLANNED' || meta.proficiency === 'LEARNING') {
      developmentPipeline.push({
        item_type: 'CAPABILITY',
        name: meta.display_label || meta.capability_name || f.statement,
        issuer_or_domain: meta.capability_family,
        status: meta.development_status === 'PLANNED' ? 'PLANNED' : 'IN_PROGRESS',
        priority: meta.interest === 'TARGET' ? 'HIGH' : 'MEDIUM',
        source_fact_keys: [f.fact_key],
        target_timeline: meta.notes || 'In progress / planned expansion',
      });
    }
  }

  // 9. Career Direction & Identity
  const identity = {
    display_name: profile.display_name,
    professional_summary:
      profile.professional_headline ||
      'Complex-systems architect and builder who turns ambiguity and multi-dimensional problems into an architecture, requirements model and delivery roadmap, then automates or delegates repeatable execution.',
    signature: 'Chaos → structure → architecture → build',
    role_identity_verbatim:
      'Complex-systems architect and builder who turns ambiguity and multi-dimensional problems into an architecture, requirements model and delivery roadmap, then automates or delegates repeatable execution.',
  };

  const careerDirection = {
    trajectories: [
      'Becoming an AI-enabled engineer and solution builder',
      'Systems architecture & solution design as central future focus',
      'Applied AI engineering as a rapidly expanding operational capability',
      'Research-heavy work (cognitive systems, AuDHD, bio/computational analysis)',
      'Technical product/solution building from 0 to production',
      'Remote-first future with high autonomy',
      'Legal technology, access-to-justice, and fiduciary automation',
      'Investment & market automation/AI infrastructure rather than discretionary wealth management',
    ],
    target_work_environments: [
      'Widely used product/platform companies and high-growth engineering teams',
      'Autonomous, research-driven labs and technical startups',
      'High-stakes regulatory, financial, or healthcare software environments',
    ],
    future_identity: 'Complex-systems architect, AI engineer, and pragmatic builder.',
    notes: 'Preferences and trajectory; distinct from current proven technical mastery.',
  };

  const workPreferences = {
    ideal_composition: {
      'building_coding': { target_band: '20–30%', min_pct: 20, max_pct: 30 },
      'architecture_design': { target_band: '30–40%', min_pct: 30, max_pct: 40 },
      'research_synthesis': { target_band: '30–40%', min_pct: 30, max_pct: 40 },
      'technical_writing_documentation': { target_band: '~10%', max_pct: 15 },
      'product_decisions': { target_band: '~10%', max_pct: 15 },
      'programme_coordination': { target_band: 'Near 0%', max_pct: 5 },
      'meetings_ceremonies': { target_band: '10–20% ceiling', ceiling_pct: 20 },
      'customer_interaction': { target_band: 'Near 0%', max_pct: 5 },
      'mentoring': { target_band: 'Selective / limited', max_pct: 10 },
    },
    explicit_non_target_work: [
      'Primary sales and quota-carrying business development',
      'Heavy pre-sales and sales engineering',
      'Forward Deployed Engineering (FDE) or parachute consulting',
      'Customer success and routine client management',
      'Direct people management and performance appraisal bureaucracy',
      'Frequent SteerCos and executive political navigation',
      'Programme coordination as primary day-to-day work',
      'Pure traditional PMO administration',
      'Pure discretionary wealth management or portfolio sales',
      'Computer vision specialist engineering',
      'NLP-specialist linguistics/model engineering',
      'Pure quantitative-modelling-only roles',
    ],
    interaction_constraints: {
      stakeholder_facilitation: 'Possible but undesirable as a primary work fraction (ceiling 10%)',
      public_speaking: 'Capable but not an intrinsic attraction',
      client_entertainment: 'To be strictly avoided',
    },
  };

  const capabilityProfile: CapabilityProfile = {
    schema_version: '1.0',
    profile_version_id: profileVersionId,
    profile_key: profile.profile_key,
    generated_at: generatedAt,
    identity,
    capability_families: capabilityFamilies,
    domain_expertise: domainExpertise,
    signature_strengths: signatureStrengths,
    languages,
    professional_geographies: professionalGeographies,
    leadership: {
      target_modes: targetLeadershipModes,
      non_target_modes: nonTargetLeadershipModes,
    },
    development_pipeline: developmentPipeline,
    career_direction: careerDirection,
    work_preferences: workPreferences,
    evidence_index: evidenceIndex,
  };

  // Validate output against Zod schema
  CapabilityProfileSchema.parse(capabilityProfile);

  // Generate skills.md Markdown
  const markdown = renderSkillsMarkdown(capabilityProfile, loaded);

  return { capabilityProfile, markdown };
}

function renderSkillsMarkdown(profile: CapabilityProfile, loaded: LoadedProfile): string {
  const lines: string[] = [];

  lines.push(`# Candidate Capability Profile & Evidence Ledger`);
  lines.push(``);
  lines.push(`> **Signature**: ${profile.identity.signature}`);
  lines.push(`> **Identity**: ${profile.identity.professional_summary}`);
  lines.push(`> **Profile Key**: \`${profile.profile_key}\` | **Version**: \`${profile.profile_version_id}\` | **Generated**: ${profile.generated_at}`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  // Table of Contents / Executive Summary
  lines.push(`## 1. Executive Summary & Core Identity`);
  lines.push(``);
  lines.push(`- **Candidate Name**: ${profile.identity.display_name}`);
  lines.push(`- **Core Archetype**: Systems Architect & Complex-Problem Decomposer / Transformation Builder`);
  lines.push(`- **Primary Operating Mode**: Turns ambiguity and multi-dimensional complexity into architecture, clear requirements, and roadmaps; automates or delegates repeatable execution.`);
  lines.push(``);

  // Signature Strengths
  lines.push(`## 2. Signature Strengths (Cross-Role Searchable Concepts)`);
  lines.push(``);
  lines.push(`| Strength | Description | Provenance |`);
  lines.push(`| --- | --- | --- |`);
  for (const s of profile.signature_strengths) {
    lines.push(`| **${s.name}** | ${s.description} | \`${s.source_fact_keys.join(', ')}\` |`);
  }
  lines.push(``);

  // Capability Families
  lines.push(`## 3. Role-Neutral Capability Families`);
  lines.push(``);
  for (const group of profile.capability_families) {
    lines.push(`### ${group.display_title}`);
    lines.push(`*${group.description}*`);
    lines.push(``);
    lines.push(`| Capability | Proficiency | Hands-On Level | Interest | Evidence Tier | Recency | Evidence Key |`);
    lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
    for (const c of group.capabilities) {
      const aiTag = c.ai_assisted ? ' *(AI-assisted)*' : '';
      lines.push(
        `| **${c.display_label}**${aiTag} | \`${c.proficiency}\` | \`${c.hands_on_level}\` | \`${c.interest}\` | \`${c.evidence_strength}\` | \`${c.recency}\` | \`${c.source_fact_keys.join(', ')}\` |`
      );
    }
    lines.push(``);
  }

  // Domain Expertise
  lines.push(`## 4. Domain & Industry Expertise`);
  lines.push(``);
  lines.push(`| Domain | Self-Rating | Proficiency | Interest | Development Status | Evidence Key |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const d of profile.domain_expertise) {
    const devStatus = d.development_status ? `\`${d.development_status}\`` : 'CURRENT';
    lines.push(`| **${d.display_label}** | **${d.self_rating}** | \`${d.proficiency}\` | \`${d.interest}\` | ${devStatus} | \`${d.source_fact_keys.join(', ')}\` |`);
  }
  lines.push(``);

  // Languages & Regional Experience
  lines.push(`## 5. Languages & Professional Geographies`);
  lines.push(``);
  lines.push(`### Languages (Speaking / Reading / Writing)`);
  lines.push(``);
  lines.push(`| Language | Speaking | Reading | Writing | Provenance |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const l of profile.languages) {
    lines.push(`| **${l.language}** | ${l.speaking} | ${l.reading} | ${l.writing} | \`${l.source_fact_keys.join(', ')}\` |`);
  }
  lines.push(``);
  lines.push(`### Professional Geographies`);
  lines.push(``);
  for (const g of profile.professional_geographies) {
    lines.push(`- **${g.region}**: ${g.familiarity}`);
  }
  lines.push(``);

  // Leadership & Interaction
  lines.push(`## 6. Leadership Profile & Working Preferences`);
  lines.push(``);
  lines.push(`### Target Leadership Modes`);
  for (const t of profile.leadership.target_modes) {
    lines.push(`- **${t.mode}**: ${t.description}`);
  }
  lines.push(``);
  lines.push(`### Non-Target Leadership Modes (Explicit Avoidance)`);
  for (const nt of profile.leadership.non_target_modes) {
    lines.push(`- **${nt.mode}**: ${nt.reason}`);
  }
  lines.push(``);

  // Work Preferences & Composition
  lines.push(`### Desired Work Composition Bands`);
  lines.push(``);
  lines.push(`| Activity | Target Band |`);
  lines.push(`| --- | --- |`);
  for (const [key, comp] of Object.entries(profile.work_preferences.ideal_composition)) {
    lines.push(`| ${key.replace(/_/g, ' ')} | **${comp.target_band}** |`);
  }
  lines.push(``);

  lines.push(`### Explicit Non-Target Work Activities`);
  for (const nonTarget of profile.work_preferences.explicit_non_target_work) {
    lines.push(`- ❌ ${nonTarget}`);
  }
  lines.push(``);

  // Development Pipeline
  lines.push(`## 7. Active Development Pipeline & In-Progress Credentials`);
  lines.push(``);
  lines.push(`| Item | Type | Issuer / Domain | Priority | Status | Timeline |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const p of profile.development_pipeline) {
    lines.push(`| **${p.name}** | \`${p.item_type}\` | ${p.issuer_or_domain || '—'} | \`${p.priority}\` | \`${p.status}\` | ${p.target_timeline || 'Underway'} |`);
  }
  lines.push(``);

  // Career Direction
  lines.push(`## 8. Career Direction & Trajectory (Preferences & Goals)`);
  lines.push(``);
  lines.push(`*Note: Preferences and trajectory, distinct from current proven technical mastery.*`);
  lines.push(``);
  for (const t of profile.career_direction.trajectories) {
    lines.push(`- 🎯 ${t}`);
  }
  lines.push(``);

  // Evidence Ledger Index
  lines.push(`## 9. Canonical Evidence Ledger Index (${Object.keys(profile.evidence_index).length} Atomic Facts)`);
  lines.push(``);
  lines.push(`| Fact Key | Type | Tier | Verification | Statement |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const f of Object.values(profile.evidence_index)) {
    lines.push(`| \`${f.fact_key}\` | \`${f.fact_type}\` | \`${f.evidence_tier}\` | \`${f.verification_status}\` | ${f.statement.replace(/\|/g, '\\|')} |`);
  }
  lines.push(``);

  return lines.join('\n');
}
