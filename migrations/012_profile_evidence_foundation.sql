-- Migration 012: Profile Evidence Foundation
-- Description: Create tables for versioned candidate profiles with engagement, fact, and credential evidence
-- This is the foundation for the evidence-first job decision engine redesign
--
-- Key principles:
-- 1. Profile versions are immutable after use in a match_run
-- 2. Founder experience counts equally to employee experience
-- 3. Evidence is atomic (one fact per row) and attributed to engagements
-- 4. All evidence has verification status and confidentiality classification
-- 5. Taxonomy concepts normalize skills, technologies, domains, and functions

BEGIN;

-- ============================================================================
-- candidate_profiles: Top-level profile container
-- ============================================================================
CREATE TABLE IF NOT EXISTS candidate_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_candidate_profiles_profile_key ON candidate_profiles(profile_key);

-- ============================================================================
-- profile_versions: Immutable versioned snapshots of a candidate's profile
-- ============================================================================
CREATE TABLE IF NOT EXISTS profile_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_profile_id UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number > 0),
    schema_version TEXT NOT NULL DEFAULT '2.0',
    source_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
    effective_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(candidate_profile_id, version_number)
);

-- Ensure only one ACTIVE version per candidate
CREATE UNIQUE INDEX idx_profile_versions_one_active
    ON profile_versions(candidate_profile_id)
    WHERE status = 'ACTIVE';

CREATE INDEX idx_profile_versions_candidate_id ON profile_versions(candidate_profile_id);
CREATE INDEX idx_profile_versions_status ON profile_versions(status);

-- ============================================================================
-- profile_engagements: Employment, founder, contractor, or research roles
-- ============================================================================
CREATE TABLE IF NOT EXISTS profile_engagements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
    engagement_key TEXT NOT NULL,
    organization_legal_name TEXT NOT NULL,
    brand_or_program_name TEXT,
    role_title TEXT NOT NULL,
    engagement_type TEXT NOT NULL CHECK (
        engagement_type IN ('EMPLOYEE', 'FOUNDER_OPERATOR', 'CONTRACTOR', 'RESEARCHER')
    ),
    experience_class TEXT NOT NULL CHECK (
        experience_class IN (
            'PROFESSIONAL_PRODUCTION',
            'DEPLOYED_OPEN_SOURCE',
            'APPLIED_PROJECT',
            'COURSE_PROJECT',
            'KNOWLEDGE_ONLY'
        )
    ),
    operating_model TEXT,
    start_date DATE NOT NULL,
    end_date DATE,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    production_start_date DATE,
    first_external_user_date DATE,
    hours_per_week_band TEXT CHECK (
        hours_per_week_band IN ('FULL_TIME', 'SUBSTANTIAL_PART_TIME', 'LIMITED')
    ),
    summary TEXT NOT NULL,
    verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (
        verification_status IN ('VERIFIED', 'SELF_ATTESTED', 'UNVERIFIED')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_version_id, engagement_key)
);

CREATE INDEX idx_profile_engagements_profile_version ON profile_engagements(profile_version_id);
CREATE INDEX idx_profile_engagements_engagement_key ON profile_engagements(engagement_key);

-- ============================================================================
-- taxonomy_concepts: Normalized vocabulary for skills, technologies, etc.
-- ============================================================================
CREATE TABLE IF NOT EXISTS taxonomy_concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_key TEXT NOT NULL UNIQUE,
    concept_type TEXT NOT NULL CHECK (
        concept_type IN (
            'SKILL', 'TECHNOLOGY', 'DOMAIN', 'FUNCTION',
            'CERTIFICATION', 'DEGREE', 'PUBLICATION', 'LANGUAGE'
        )
    ),
    canonical_label TEXT NOT NULL,
    aliases TEXT[],
    parent_concept_id UUID REFERENCES taxonomy_concepts(id) ON DELETE SET NULL,
    taxonomy_version TEXT NOT NULL DEFAULT '1.0',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_taxonomy_concepts_concept_key ON taxonomy_concepts(concept_key);
CREATE INDEX idx_taxonomy_concepts_concept_type ON taxonomy_concepts(concept_type);
CREATE INDEX idx_taxonomy_concepts_active ON taxonomy_concepts(active);

-- ============================================================================
-- profile_facts: Atomic factual claims about professional capabilities
-- ============================================================================
CREATE TABLE IF NOT EXISTS profile_facts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
    engagement_id UUID REFERENCES profile_engagements(id) ON DELETE SET NULL,
    fact_key TEXT NOT NULL,
    fact_type TEXT NOT NULL CHECK (
        fact_type IN (
            'ACHIEVEMENT', 'RESPONSIBILITY', 'PROJECT', 'SKILL',
            'DOMAIN', 'TECHNOLOGY', 'PUBLICATION', 'OPEN_SOURCE'
        )
    ),
    statement TEXT NOT NULL,
    structured_value JSONB,
    evidence_tier TEXT NOT NULL CHECK (
        evidence_tier IN (
            'PRODUCTION_PROFESSIONAL',
            'DEPLOYED_OPEN_SOURCE',
            'APPLIED_PROJECT',
            'COURSE_PROJECT',
            'KNOWLEDGE_ONLY'
        )
    ),
    verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (
        verification_status IN ('VERIFIED', 'SELF_ATTESTED', 'UNVERIFIED')
    ),
    start_date DATE,
    end_date DATE,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    confidentiality TEXT NOT NULL DEFAULT 'PRIVATE_REUSABLE' CHECK (
        confidentiality IN ('PUBLIC', 'PRIVATE_REUSABLE', 'PRIVATE_INTERNAL')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_version_id, fact_key)
);

CREATE INDEX idx_profile_facts_profile_version ON profile_facts(profile_version_id);
CREATE INDEX idx_profile_facts_engagement ON profile_facts(engagement_id);
CREATE INDEX idx_profile_facts_fact_key ON profile_facts(fact_key);
CREATE INDEX idx_profile_facts_fact_type ON profile_facts(fact_type);

-- ============================================================================
-- profile_fact_concepts: Many-to-many mapping of facts to taxonomy concepts
-- ============================================================================
CREATE TABLE IF NOT EXISTS profile_fact_concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_fact_id UUID NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
    concept_id UUID NOT NULL REFERENCES taxonomy_concepts(id) ON DELETE CASCADE,
    evidence_relationship TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_fact_id, concept_id)
);

CREATE INDEX idx_profile_fact_concepts_fact ON profile_fact_concepts(profile_fact_id);
CREATE INDEX idx_profile_fact_concepts_concept ON profile_fact_concepts(concept_id);

-- ============================================================================
-- profile_credentials: Certifications, degrees, course completions, licenses
-- ============================================================================
CREATE TABLE IF NOT EXISTS profile_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_version_id UUID NOT NULL REFERENCES profile_versions(id) ON DELETE CASCADE,
    credential_key TEXT NOT NULL,
    credential_name TEXT NOT NULL,
    issuer TEXT NOT NULL,
    credential_type TEXT NOT NULL CHECK (
        credential_type IN ('CERTIFICATION', 'DEGREE', 'COURSE', 'LICENSE')
    ),
    level TEXT,
    issued_on DATE,
    expires_on DATE,
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
        status IN ('ACTIVE', 'EXPIRED', 'IN_PROGRESS', 'REVOKED')
    ),
    verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (
        verification_status IN ('VERIFIED', 'SELF_ATTESTED', 'UNVERIFIED')
    ),
    evidence_source_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_version_id, credential_key)
);

CREATE INDEX idx_profile_credentials_profile_version ON profile_credentials(profile_version_id);
CREATE INDEX idx_profile_credentials_credential_key ON profile_credentials(credential_key);

-- ============================================================================
-- evidence_sources: External sources for verifying profile claims
-- ============================================================================
CREATE TABLE IF NOT EXISTS evidence_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_profile_id UUID NOT NULL REFERENCES candidate_profiles(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    source_type TEXT NOT NULL,
    label TEXT NOT NULL,
    uri TEXT,
    source_date DATE,
    verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (
        verification_status IN ('VERIFIED', 'SELF_ATTESTED', 'UNVERIFIED')
    ),
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(candidate_profile_id, source_key)
);

CREATE INDEX idx_evidence_sources_candidate ON evidence_sources(candidate_profile_id);
CREATE INDEX idx_evidence_sources_source_key ON evidence_sources(source_key);

-- ============================================================================
-- profile_fact_evidence_sources: Many-to-many mapping for fact attribution
-- ============================================================================
CREATE TABLE IF NOT EXISTS profile_fact_evidence_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_fact_id UUID NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
    evidence_source_id UUID NOT NULL REFERENCES evidence_sources(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(profile_fact_id, evidence_source_id)
);

CREATE INDEX idx_profile_fact_evidence_sources_fact ON profile_fact_evidence_sources(profile_fact_id);
CREATE INDEX idx_profile_fact_evidence_sources_source ON profile_fact_evidence_sources(evidence_source_id);

-- ============================================================================
-- Comments for clarity
-- ============================================================================
COMMENT ON TABLE candidate_profiles IS
    'Top-level container for a candidate profile, referenced by multiple versions';

COMMENT ON TABLE profile_versions IS
    'Immutable versioned snapshots. Once referenced by a match_run, the version cannot be modified.';

COMMENT ON TABLE profile_engagements IS
    'Employment history: FOUNDER_OPERATOR counts equally to EMPLOYEE under PROFESSIONAL_PRODUCTION.';

COMMENT ON TABLE profile_facts IS
    'Atomic factual claims. One claim per row. Facts are linked to engagements but can stand alone.';

COMMENT ON TABLE profile_credentials IS
    'Verifiable credentials: certifications, degrees, course completions, licenses.';

COMMENT ON TABLE taxonomy_concepts IS
    'Normalized vocabulary for semantic matching. Skills, technologies, domains, functions.';

COMMENT ON TABLE evidence_sources IS
    'External sources for verification: repositories, deployments, transcripts, certificates, etc.';

COMMIT;
