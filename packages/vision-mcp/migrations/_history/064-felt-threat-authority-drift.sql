-- 064: Post-action authority drift for felt-threat decisions (2026-06-14)
--
-- Purpose: a gate decision now stores the authority that won before action.
-- Record the post-action authority too, so later audit can tell whether the
-- state stack changed while the action was running.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS post_action_gate_authority jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS authority_drift boolean,
  ADD COLUMN IF NOT EXISTS authority_drift_basis text;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_authority_drift_idx
  ON felt_threat_gate_decisions (authority_drift, resolved_at DESC);

COMMENT ON COLUMN felt_threat_gate_decisions.post_action_gate_authority IS
  'Read-only snapshot of Presence/felt-threat authority observed when the tool result was processed.';

COMMENT ON COLUMN felt_threat_gate_decisions.authority_drift IS
  'Whether the winning Presence/felt-threat authority changed between pre-decision and post-action resolution.';

COMMIT;
