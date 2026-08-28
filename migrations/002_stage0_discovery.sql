-- Migration 002: Stage 0 Discovery Tables
CREATE TABLE IF NOT EXISTS source_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status VARCHAR(50) DEFAULT 'RUNNING',
    total_fetched INT DEFAULT 0,
    total_new INT DEFAULT 0,
    total_duplicates INT DEFAULT 0,
    total_errors INT DEFAULT 0,
    error_log JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS raw_job_observations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_run_id UUID REFERENCES source_runs(id),
    source_name VARCHAR(50) NOT NULL,
    source_external_id VARCHAR(255),
    source_url TEXT,
    retrieved_at TIMESTAMPTZ DEFAULT NOW(),
    company_name TEXT NOT NULL,
    title TEXT NOT NULL,
    description_raw TEXT NOT NULL,
    location_raw TEXT DEFAULT 'Unknown',
    workplace_type_raw VARCHAR(100) DEFAULT 'UNKNOWN',
    employment_type_raw VARCHAR(100) DEFAULT 'UNKNOWN',
    compensation_raw VARCHAR(255) DEFAULT 'UNKNOWN',
    canonical_apply_url TEXT,
    source_lane VARCHAR(50),
    search_plan_version VARCHAR(50) DEFAULT '1.0',
    raw_payload JSONB,
    raw_payload_hash VARCHAR(255) NOT NULL,
    processing_status VARCHAR(50) DEFAULT 'PENDING',
    error_history JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS canonical_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_name TEXT NOT NULL,
    normalized_title TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    location_summary TEXT DEFAULT 'Unknown',
    workplace_type VARCHAR(50) DEFAULT 'UNKNOWN',
    employment_type VARCHAR(50) DEFAULT 'UNKNOWN',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    processing_status VARCHAR(50) DEFAULT 'RAW_STAGED',
    gate_decision VARCHAR(50),
    rejection_reason TEXT,
    primary_lane VARCHAR(50),
    semantic_score FLOAT DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS job_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    canonical_job_id UUID REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    version_number INT DEFAULT 1,
    content_hash VARCHAR(255) NOT NULL,
    description_text TEXT NOT NULL,
    observed_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_canonical_job_content_hash UNIQUE (canonical_job_id, content_hash)
);

CREATE TABLE IF NOT EXISTS evaluation_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    canonical_job_id UUID REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id VARCHAR(50) DEFAULT 'v1',
    lane VARCHAR(50) NOT NULL,
    priority_score FLOAT DEFAULT 0.0,
    status VARCHAR(50) DEFAULT 'PENDING',
    lease_id UUID,
    lease_expires_at TIMESTAMPTZ,
    attempt_count INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    last_error TEXT,
    enqueued_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_evaluations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    canonical_job_id UUID REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id VARCHAR(50) DEFAULT 'v1',
    gate_decision VARCHAR(50) DEFAULT 'PASS',
    gate_version VARCHAR(50) DEFAULT '1.0',
    lane_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
    workability_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
    unknown_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    profile_version VARCHAR(50) DEFAULT '1.0',
    evaluation_schema_version VARCHAR(50) DEFAULT '1.0.0',
    provider VARCHAR(50) DEFAULT 'gemini',
    model VARCHAR(100) DEFAULT 'gemini-1.5-flash',
    attempt INT DEFAULT 1,
    is_fallback BOOLEAN DEFAULT FALSE,
    degraded_state BOOLEAN DEFAULT FALSE,
    cost_usd NUMERIC(10, 6) DEFAULT 0.000000,
    full_evaluation_payload JSONB,
    evaluated_at TIMESTAMPTZ DEFAULT NOW()
);
