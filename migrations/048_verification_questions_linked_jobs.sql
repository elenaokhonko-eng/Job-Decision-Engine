-- 048_verification_questions_linked_jobs.sql
-- Add linked_job_ids column to verification_questions for existing environments

ALTER TABLE verification_questions
  ADD COLUMN IF NOT EXISTS linked_job_ids JSONB DEFAULT '[]'::jsonb;
