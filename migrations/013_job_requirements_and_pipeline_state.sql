-- Migration 013: Job requirements extraction and pipeline state tracking
--
-- Goals:
-- 1. Persist deterministic and quoted job requirements with source quote offsets.
-- 2. Track per-version pipeline stage state with retry/manual-review transitions.
-- 3. Record extraction run metadata and stage transition events.

BEGIN;

CREATE TABLE IF NOT EXISTS job_requirements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
    requirement_key TEXT NOT NULL,
    requirement_type TEXT NOT NULL CHECK (
      requirement_type IN (
        'OFFICE_DAYS', 'WORK_MODE', 'EXPERIENCE_YEARS', 'CREDENTIAL', 'DEGREE',
        'EMPLOYMENT_TYPE', 'TRAVEL', 'WORK_AUTH', 'ON_CALL', 'SHIFT_WORK',
        'DOMAIN', 'FUNCTION', 'CUSTOM'
      )
    ),
    importance TEXT NOT NULL CHECK (importance IN ('MUST', 'PREFERRED', 'NICE_TO_HAVE')),
    requirement_text TEXT NOT NULL,
    quote_text TEXT,
    quote_start_offset INTEGER,
    quote_end_offset INTEGER,
    structured_value JSONB,
    extractor_type TEXT NOT NULL CHECK (extractor_type IN ('DETERMINISTIC', 'LLM_QUOTED')),
    extractor_version TEXT NOT NULL,
    confidence NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    status TEXT NOT NULL DEFAULT 'EXTRACTED' CHECK (status IN ('EXTRACTED', 'VALIDATED', 'REJECTED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (job_version_id, requirement_key)
);

CREATE INDEX IF NOT EXISTS idx_job_requirements_job_version ON job_requirements(job_version_id);
CREATE INDEX IF NOT EXISTS idx_job_requirements_canonical ON job_requirements(canonical_job_id);
CREATE INDEX IF NOT EXISTS idx_job_requirements_type ON job_requirements(requirement_type);

CREATE TABLE IF NOT EXISTS requirement_extraction_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
    run_type TEXT NOT NULL CHECK (run_type IN ('DETERMINISTIC', 'LLM_QUOTED')),
    provider TEXT,
    model TEXT,
    status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED')),
    error_message TEXT,
    requirements_extracted INTEGER NOT NULL DEFAULT 0,
    response_payload JSONB,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_requirement_runs_job_version ON requirement_extraction_runs(job_version_id, started_at DESC);

CREATE TABLE IF NOT EXISTS job_version_pipeline_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
    current_stage TEXT NOT NULL CHECK (
      current_stage IN (
        'NORMALIZED', 'REQUIREMENTS_EXTRACTED', 'GATE_EVALUATED', 'LANE_ROUTED',
        'QUEUED_FOR_AI', 'EVALUATING', 'EVALUATED', 'DOCUMENT_READY'
      )
    ),
    stage_status TEXT NOT NULL CHECK (
      stage_status IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'RETRY_WAIT', 'NEEDS_MANUAL_REVIEW', 'FAILED')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (job_version_id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_state_stage ON job_version_pipeline_state(current_stage, stage_status);
CREATE INDEX IF NOT EXISTS idx_pipeline_state_retry ON job_version_pipeline_state(stage_status, next_retry_at);

CREATE TABLE IF NOT EXISTS pipeline_stage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_job_id UUID NOT NULL REFERENCES canonical_jobs(id) ON DELETE CASCADE,
    job_version_id UUID NOT NULL REFERENCES job_versions(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (
      stage IN (
        'NORMALIZED', 'REQUIREMENTS_EXTRACTED', 'GATE_EVALUATED', 'LANE_ROUTED',
        'QUEUED_FOR_AI', 'EVALUATING', 'EVALUATED', 'DOCUMENT_READY'
      )
    ),
    transition_from TEXT CHECK (
      transition_from IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'RETRY_WAIT', 'NEEDS_MANUAL_REVIEW', 'FAILED')
    ),
    transition_to TEXT NOT NULL CHECK (
      transition_to IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'RETRY_WAIT', 'NEEDS_MANUAL_REVIEW', 'FAILED')
    ),
    event_type TEXT NOT NULL CHECK (event_type IN ('STAGE_ENTERED', 'STAGE_COMPLETED', 'STAGE_FAILED', 'RETRY_SCHEDULED')),
    error_message TEXT,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_job_version ON pipeline_stage_events(job_version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_stage ON pipeline_stage_events(stage, event_type);

COMMENT ON TABLE job_requirements IS
  'Atomic job requirements with deterministic or quoted extraction provenance.';

COMMENT ON TABLE requirement_extraction_runs IS
  'Extractor run audit trail with provider/model status and payload.';

COMMENT ON TABLE job_version_pipeline_state IS
  'Recoverable per-job-version state machine for requirements through documents readiness.';

COMMENT ON TABLE pipeline_stage_events IS
  'Append-only event stream of state transitions and failures for observability.';

COMMIT;
