-- Migration 001: Legacy Base Tables
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    industry VARCHAR(100),
    website_url TEXT,
    careers_page_url TEXT,
    nd_friendly_avg_score NUMERIC(5, 2) DEFAULT 0.00,
    politics_stress_avg_score NUMERIC(5, 2) DEFAULT 0.00,
    sensory_overload_avg_index NUMERIC(5, 2) DEFAULT 0.00,
    focus_protection_avg_score NUMERIC(5, 2) DEFAULT 0.00,
    is_neurodivergent_approved BOOLEAN DEFAULT FALSE,
    is_toxic_culture_blacklisted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_hash TEXT UNIQUE,
    company_name TEXT NOT NULL,
    company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    source VARCHAR(50) NOT NULL,
    raw_description TEXT NOT NULL,
    salary_range VARCHAR(100),
    location TEXT DEFAULT 'Singapore',
    posted_date DATE DEFAULT CURRENT_DATE,
    careers_portal_url TEXT NOT NULL,
    processing_status VARCHAR(50) DEFAULT 'PENDING_GLOBAL_GATE',
    rejection_code VARCHAR(100),
    gate_version VARCHAR(20),
    primary_lane VARCHAR(50),
    secondary_lanes JSONB,
    lane_confidence VARCHAR(20),
    lane_evidence TEXT,
    source_lane VARCHAR(50),
    nd_gate_status VARCHAR(50),
    nd_score INT,
    nd_evidence TEXT,
    nd_risk_flags JSONB,
    work_mode_status VARCHAR(50),
    office_days INT,
    interaction_load INT,
    building_research_ratio INT,
    rejection_codes JSONB,
    nd_friendly_score INT DEFAULT 50,
    politics_stress_score INT DEFAULT 50,
    sensory_overload_index INT DEFAULT 50,
    biological_stress_risk TEXT,
    strategic_value TEXT,
    recommended_cv_version VARCHAR(50),
    next_action VARCHAR(50),
    is_top_ten BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    industry VARCHAR(100),
    website_url TEXT,
    careers_page_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_prompt TEXT NOT NULL,
    tools_used JSONB NOT NULL,
    agent_response JSONB NOT NULL,
    reasoning_trace JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_tool_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    interaction_id VARCHAR(100) NOT NULL,
    tool_name VARCHAR(100) NOT NULL,
    arguments JSONB,
    response JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interactions_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email VARCHAR(255),
    question TEXT NOT NULL,
    tools_used VARCHAR(255)[],
    agent_trace TEXT[],
    structured_answer JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS raw_email_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject VARCHAR(512),
    body TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW(),
    processed BOOLEAN DEFAULT FALSE,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

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
