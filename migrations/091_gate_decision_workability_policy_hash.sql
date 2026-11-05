-- Preserve the exact effective workability policy used for each new gate decision.
-- Existing rows remain NULL because their effective policy hash cannot be reconstructed.
ALTER TABLE gate_decisions
  ADD COLUMN IF NOT EXISTS workability_policy_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gate_decisions_workability_policy_hash_format'
      AND conrelid = 'gate_decisions'::regclass
  ) THEN
    ALTER TABLE gate_decisions
      ADD CONSTRAINT gate_decisions_workability_policy_hash_format
      CHECK (workability_policy_hash IS NULL OR workability_policy_hash ~ '^[a-f0-9]{64}$');
  END IF;
END $$;

COMMENT ON COLUMN gate_decisions.workability_policy_hash IS
  'SHA-256 of the effective workability rules and active preference mode used by this decision; NULL is reserved for legacy rows predating hash persistence.';
