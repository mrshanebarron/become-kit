-- 058: Link gate decisions to observation samples (2026-06-14)
--
-- Purpose: a mutating_pass decision can mark sampled_observation=true, but the
-- cortical trace should also carry the observation_key so audits can follow
-- the decision to the deduped sensory sample it created or updated.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS observation_key text;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_observation_key_idx
  ON felt_threat_gate_decisions (observation_key)
  WHERE observation_key IS NOT NULL;

COMMIT;
