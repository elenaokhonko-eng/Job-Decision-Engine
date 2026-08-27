-- Track pipeline health
CREATE TABLE IF NOT EXISTS source_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    status VARCHAR(50),
    total_fetched INT DEFAULT 0,
    total_new INT DEFAULT 0,
    total_duplicates INT DEFAULT 0,
    total_errors INT DEFAULT 0
);

-- Every time a scout sees a job
CREATE TABLE IF NOT EXISTS raw_job_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_run_id UUID REFERENCES source_runs(id),
    source_name VARCHAR(50),
    source_external_id VARCHAR(255),
    source_url TEXT,
    retrieved_at TIMESTAMPTZ DEFAULT NOW(),
    company_name TEXT,
    title TEXT,
    description_raw TEXT,
    source_lane VARCHAR(50),
    search_plan_version VARCHAR(50),
    raw_payload_hash VARCHAR(255)
);

-- The unique position
CREATE TABLE IF NOT EXISTS canonical_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name TEXT,
    normalized_title TEXT,
    canonical_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processing_status VARCHAR(50), -- RAW_STAGED, HARD_REJECTED, QUEUED_FOR_AI, etc.
    gate_decision VARCHAR(50), -- PASS, FAIL, UNKNOWN
    rejection_reason TEXT,
    primary_lane VARCHAR(50),
    semantic_score FLOAT
);

-- Version tracking for changing job descriptions
CREATE TABLE IF NOT EXISTS job_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID REFERENCES canonical_jobs(id),
    content_hash VARCHAR(255),
    description_text TEXT,
    observed_at TIMESTAMPTZ DEFAULT NOW()
);

-- The budgeted queue for AI
CREATE TABLE IF NOT EXISTS evaluation_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID REFERENCES canonical_jobs(id),
    lane VARCHAR(50),
    priority_score FLOAT,
    status VARCHAR(50) -- PENDING, EVALUATING, COMPLETED
);
