-- 047_verification_questions.sql
-- Automated verification question aggregation for NEEDS_VERIFICATION cohorts

CREATE TABLE IF NOT EXISTS verification_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  question_key VARCHAR(120) NOT NULL,
  category VARCHAR(60) NOT NULL,
  question_text TEXT NOT NULL,
  impact_job_count INTEGER NOT NULL DEFAULT 0,
  suggested_options JSONB DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  answer_value JSONB,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_verification_questions_key UNIQUE (workspace_id, question_key)
);

CREATE INDEX IF NOT EXISTS idx_verification_questions_workspace_status
  ON verification_questions (workspace_id, status);
