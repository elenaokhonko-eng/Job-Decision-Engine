-- ====================================================================
-- BASELINE POSTGRES RELATIONAL DATABASE SCHEMA - JOB DECISION ENGINE
-- ====================================================================
-- This SQL file represents the production database schema designed to track
-- job postings, audit records, and high-autonomy workplace culture analytics.
-- It enables tech builders to analyze company toxicity, political overhead,
-- and focus protection indices.
-- ====================================================================

-- Enable necessary Postgres extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: companies
-- Stores consolidated company-level ratings compiled from job evaluations.
-- This enables aggregate analytics on ND culture.
DROP TABLE IF EXISTS interactions_log CASCADE;
DROP TABLE IF EXISTS agent_tool_logs CASCADE;
-- DROP TABLE IF EXISTS raw_email_alerts CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
-- DROP TABLE IF EXISTS raw_jobs CASCADE;
DROP TABLE IF EXISTS companies CASCADE;
-- DROP TABLE IF EXISTS raw_companies CASCADE;

CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT UNIQUE NOT NULL,
    industry VARCHAR(100),
    website_url TEXT,
    careers_page_url TEXT,
    
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
    content_hash TEXT UNIQUE,
    company_name TEXT NOT NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    source VARCHAR(50) NOT NULL, -- 'LinkedIn', 'MyCareersFuture', 'eFinancialCareers', 'Gmail'
    raw_description TEXT NOT NULL,
    salary_range VARCHAR(100),
    location TEXT DEFAULT 'Singapore',
    posted_date DATE DEFAULT CURRENT_DATE,
    careers_portal_url TEXT NOT NULL, -- Direct URL to company's career page to verify real job
    
    -- Status in evaluation pipeline
    processing_status VARCHAR(50) DEFAULT 'PENDING_GLOBAL_GATE', -- 'PENDING_GLOBAL_GATE', 'PENDING_LANE_CLASSIFICATION', 'PENDING_LLM_EVAL', 'FAILED', 'REJECTED', 'AMBIGUOUS', 'EVALUATED'
    rejection_code VARCHAR(100),
    gate_version VARCHAR(20),
    
    -- Lane Classification
    primary_lane VARCHAR(50), -- 'CORE_AI_DATA', 'LEGAL_REGTECH', 'HEALTH_BIO_PHARMA', 'INVESTMENT_MARKETS_FINTECH'
    secondary_lanes JSONB,
    lane_confidence VARCHAR(20),
    lane_evidence TEXT,
    source_lane VARCHAR(50),
    
    -- Specific ND & stress assessment metrics (from evaluation)
    nd_friendly_score INTEGER DEFAULT NULL,     -- 0 to 100
    politics_stress_score INTEGER DEFAULT NULL,  -- 0 to 100
    sensory_overload_index INTEGER DEFAULT 0, -- 0 to 100 (Keep for legacy support or future use)
    biological_stress_risk TEXT,
    strategic_value TEXT,
    recommended_cv_version TEXT,
    next_action TEXT,
    is_top_ten BOOLEAN DEFAULT FALSE,

    -- New ND Work-Fit Fields
    nd_gate_status VARCHAR(50),
    nd_score INTEGER,
    nd_evidence TEXT,
    nd_risk_flags JSONB,
    work_mode_status VARCHAR(50),
    office_days INTEGER,
    interaction_load INTEGER,
    building_research_ratio INTEGER,
    rejection_codes JSONB,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table: raw_companies
-- Staging table for companies before they are evaluated.
CREATE TABLE IF NOT EXISTS raw_companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT UNIQUE NOT NULL,
    industry VARCHAR(100),
    website_url TEXT,
    careers_page_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Table: raw_jobs
-- Staging table for raw extracted job postings before they are evaluated.
CREATE TABLE IF NOT EXISTS raw_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    content_hash TEXT UNIQUE,
    company_name TEXT NOT NULL,
    title TEXT NOT NULL,
    source VARCHAR(50) NOT NULL,
    raw_description TEXT NOT NULL,
    salary_range VARCHAR(100),
    location TEXT,
    posted_date DATE DEFAULT CURRENT_DATE,
    careers_portal_url TEXT NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    processing_status VARCHAR(50) DEFAULT 'PENDING_GLOBAL_GATE',
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Ensure is_top_ten column is added if table exists (for compatibility if not wiped)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_top_ten BOOLEAN DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS content_hash TEXT UNIQUE;

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

-- Table: raw_email_alerts
-- Stores raw Gmail email alert bodies before they are parsed into jobs by Gemini.
CREATE TABLE IF NOT EXISTS raw_email_alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject VARCHAR(512),
    body TEXT,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed BOOLEAN DEFAULT FALSE,
    processed_at TIMESTAMP WITH TIME ZONE
);


-- ====================================================================
-- ANALYTICS VIEWS FOR HIGH-AUTONOMY BUILDER COMMUNITIES
-- ====================================================================

-- View 1: Top 10 Best Companies for High-Autonomy Builders
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
  AND EXISTS (SELECT 1 FROM jobs WHERE jobs.company_id = companies.id)
ORDER BY nd_friendly_avg_score DESC;

-- View 2: High Risk / Toxic Culture Blacklist for High-Autonomy Builders
-- Low environmental score, high politics, high sensory overload, heavy micromanagement
-- Hard rule: only can be blacklisted if the score is low (below 30% threshold: nd_friendly <= 30 or politics >= 70)
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
WHERE (politics_stress_avg_score >= 70 OR nd_friendly_avg_score <= 30)
  AND EXISTS (SELECT 1 FROM jobs WHERE jobs.company_id = companies.id)
ORDER BY politics_stress_avg_score DESC;

-- ====================================================================
-- INDEXES FOR HIGH-PERFORMANCE ANALYTICS
-- ====================================================================
CREATE INDEX IF NOT EXISTS idx_jobs_company_name ON jobs(company_name);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(processing_status);
CREATE INDEX IF NOT EXISTS idx_jobs_nd_scores ON jobs(nd_friendly_score, politics_stress_score);
CREATE INDEX IF NOT EXISTS idx_companies_scores ON companies(nd_friendly_avg_score, politics_stress_avg_score);
