-- Migration 040: include task context in durable task identity
--
-- Existing rows receive an explicit legacy context. New stage work can then
-- coexist with completed work from an older profile/policy/content context.
-- No task history is deleted or overwritten.

UPDATE pipeline_tasks
SET context_fingerprint = 'legacy_pipeline_context_v1'
WHERE context_fingerprint IS NULL;

ALTER TABLE pipeline_tasks
  ALTER COLUMN context_fingerprint SET DEFAULT 'legacy_pipeline_context_v1',
  ALTER COLUMN context_fingerprint SET NOT NULL;

ALTER TABLE pipeline_tasks
  DROP CONSTRAINT IF EXISTS pipeline_tasks_workspace_id_task_key_key;

ALTER TABLE pipeline_tasks
  ADD CONSTRAINT pipeline_tasks_workspace_task_context_key
  UNIQUE (workspace_id, task_key, context_fingerprint);

CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_context_lookup
  ON pipeline_tasks(workspace_id, task_type, context_fingerprint, status, available_at);
