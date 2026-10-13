-- Migration 053: Persist the pipeline-run identity for gate decisions.
--
-- GateDecisionSchema requires pipeline_run_id for every new deterministic
-- decision. Existing audit rows remain nullable because their originating run
-- identity is not recoverable without inventing lineage.

ALTER TABLE gate_decisions
  ADD COLUMN IF NOT EXISTS pipeline_run_id UUID;

CREATE INDEX IF NOT EXISTS idx_gate_decisions_pipeline_run
  ON gate_decisions (workspace_id, pipeline_run_id, created_at DESC);
