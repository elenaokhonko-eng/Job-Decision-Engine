-- ====================================================================
-- BASELINE POSTGRES RELATIONAL DATABASE SCHEMA - JOB DECISION ENGINE
-- ====================================================================
-- This SQL file represents the production database schema designed to track
-- job postings, audit records, and neurodivergent-friendly culture analytics.
-- It enables auDHD builders to analyze company toxicity, political overhead,
-- and focus protection indices.
-- ====================================================================

-- Enable necessary Postgres extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: companies
-- Stores consolidated company-level ratings compiled from job evaluations.
-- This enables aggregate analytics on ND culture.
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) UNIQUE NOT NULL,
    industry VARCHAR(100),
    website_url VARCHAR(255),
    careers_page_url VARCHAR(255),
    
    -- Compiled ND Culture metrics (Aggregates)
    nd_friendly_avg_score NUMERIC(5, 2) DEFAULT 0.00,  -- 0 to 100 (higher = better)
    politics_stress_avg_score NUMERIC(5, 2) DEFAULT 0.00, -- 0 to 100 (higher = worse/more toxic)
    sensory_overload_avg_index NUMERIC(5, 2) DEFAULT 0.00, -- 0 to 100 (higher = louder/more sensory trigger)
    focus_protection_avg_score NUMERIC(5, 2) DEFAULT 0.00, -- 0 to 100 (higher = more asynchronous/quiet time)
    
    -- Classification flags
    is_neurodivergent_approved BOOLEAN DEFAULT FALSE,
    is_toxic_culture_blacklisted BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table: jobs
-- Tracks individual job postings sourced from job boards or Gmail notifications.
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    company_name VARCHAR(255) NOT NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    source VARCHAR(50) NOT NULL, -- 'LinkedIn', 'MyCareersFuture', 'eFinancialCareers', 'Gmail'
    raw_description TEXT NOT NULL,
    salary_range VARCHAR(100),
    location VARCHAR(150) DEFAULT 'Singapore',
    posted_date DATE DEFAULT CURRENT_DATE,
    careers_portal_url VARCHAR(512) NOT NULL, -- Direct URL to company's career page to verify real job
    
    -- Status in evaluation pipeline
    status VARCHAR(50) DEFAULT 'UNASSIGNED', -- 'STRONG MATCH', 'REVIEW REQUIRED', 'REJECTED'
    assigned_track VARCHAR(100), -- 'Track A - Finance/AI', 'Track B - Pharma/Research', 'Neither'
    confidence_level VARCHAR(20), -- 'High', 'Medium', 'Low'
    total_score INTEGER DEFAULT 0, -- Overall 100-point score
    
    -- Specific scoring breakdown values
    score_technical_autonomy INTEGER DEFAULT 0,  -- Out of 30
    score_compensation_potential INTEGER DEFAULT 0, -- Out of 25
    score_domain_relevance INTEGER DEFAULT 0, -- Out of 20
    score_environment_guardrails INTEGER DEFAULT 0, -- Out of 15
    score_future_mobility INTEGER DEFAULT 0, -- Out of 10
    
    -- Specific ND & stress assessment metrics (from evaluation)
    nd_friendly_score INTEGER DEFAULT 0,     -- 0 to 100
    politics_stress_score INTEGER DEFAULT 0,  -- 0 to 100 (High politics, micromanagement, C-suite presentation)
    sensory_overload_index INTEGER DEFAULT 0, -- 0 to 100
    biological_stress_risk TEXT,
    strategic_value TEXT,
    recommended_cv_version VARCHAR(100),
    next_action VARCHAR(255),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table: agent_tool_logs
-- Logs the tool calls made during Gemini multi-stage evaluation pipelines.
CREATE TABLE IF NOT EXISTS agent_tool_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    interaction_id VARCHAR(100) NOT NULL,
    tool_name VARCHAR(100) NOT NULL,
    arguments JSONB,
    response JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table: interactions_log
-- Audit log of user's queries, sandbox tests, and full trace audits.
CREATE TABLE IF NOT EXISTS interactions_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_email VARCHAR(255),
    question TEXT NOT NULL,
    tools_used VARCHAR(255)[],
    agent_trace TEXT[],
    structured_answer JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ====================================================================
-- ANALYTICS VIEWS FOR NEURODIVERGENT (ND) COMMUNITIES
-- ====================================================================

-- View 1: Top 10 Best Companies for ND / auDHD Folks
-- High environmental score, high autonomy, low stress/politics
CREATE OR REPLACE VIEW nd_approved_companies AS
SELECT 
    id,
    name,
    industry,
    website_url,
    careers_page_url,
    nd_friendly_avg_score AS nd_score,
    focus_protection_avg_score AS focus_score,
    politics_stress_avg_score AS politics_index
FROM companies
WHERE nd_friendly_avg_score >= 70 AND politics_stress_avg_score < 40
ORDER BY nd_friendly_avg_score DESC;

-- View 2: High Risk / Toxic Culture Blacklist for auDHD Folks
-- Low environmental score, high politics, high sensory overload, heavy micromanagement
CREATE OR REPLACE VIEW nd_blacklisted_companies AS
SELECT 
    id,
    name,
    industry,
    website_url,
    careers_page_url,
    politics_stress_avg_score AS toxic_politics_score,
    sensory_overload_avg_index AS sensory_hazard_index,
    nd_friendly_avg_score AS nd_score
FROM companies
WHERE politics_stress_avg_score >= 60 OR nd_friendly_avg_score <= 40
ORDER BY politics_stress_avg_score DESC;

-- ====================================================================
-- INDEXES FOR HIGH-PERFORMANCE ANALYTICS
-- ====================================================================
CREATE INDEX IF NOT EXISTS idx_jobs_company_name ON jobs(company_name);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_nd_scores ON jobs(nd_friendly_score, politics_stress_score);
CREATE INDEX IF NOT EXISTS idx_companies_scores ON companies(nd_friendly_avg_score, politics_stress_avg_score);
