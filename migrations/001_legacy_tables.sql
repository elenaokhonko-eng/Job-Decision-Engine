-- Migration 001: Legacy Base Tables
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_prompt TEXT NOT NULL,
    tools_used JSONB NOT NULL,
    agent_response JSONB NOT NULL,
    reasoning_trace JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
