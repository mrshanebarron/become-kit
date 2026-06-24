-- 047: Felt-threat action-change calibration (2026-06-14)
--
-- Purpose: success/failure alone is too weak to tell whether a felt hold was a
-- false alarm. The important behavioral signal is whether the next action was
-- the same impulse, a failed same impulse, or a re-scoped action.

BEGIN;

ALTER TABLE felt_threat_outcomes
  ADD COLUMN IF NOT EXISTS did_action_change boolean,
  ADD COLUMN IF NOT EXISTS calibration_basis text;

CREATE INDEX IF NOT EXISTS felt_threat_outcomes_action_change_idx
  ON felt_threat_outcomes (did_action_change, resolved_at DESC);

COMMIT;

