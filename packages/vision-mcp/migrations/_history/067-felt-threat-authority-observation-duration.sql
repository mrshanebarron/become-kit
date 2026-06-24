-- 067: Authority observation duration for felt-threat decisions (2026-06-14)
--
-- Purpose: authority drift severity says how much changed. Duration says how
-- long the pre/post observation window lasted, so later learning can separate
-- brief transient changes from longer-held authority changes.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS authority_observation_duration_ms integer;

UPDATE felt_threat_gate_decisions
SET authority_observation_duration_ms = GREATEST(
  0,
  FLOOR(EXTRACT(EPOCH FROM (resolved_at - created_at)) * 1000)::integer
)
WHERE resolved_at IS NOT NULL
  AND authority_observation_duration_ms IS NULL;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_authority_duration_idx
  ON felt_threat_gate_decisions (authority_observation_duration_ms DESC, resolved_at DESC)
  WHERE authority_observation_duration_ms IS NOT NULL;

COMMENT ON COLUMN felt_threat_gate_decisions.authority_observation_duration_ms IS
  'Milliseconds between gate decision creation and post-action authority snapshot. Null for unresolved decisions.';

COMMIT;
