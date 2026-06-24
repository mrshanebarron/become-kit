-- 062: Presence precedence trace for felt-threat gate decisions (2026-06-14)
--
-- Purpose: when Presence sticky/session state has precedence, the felt-threat
-- gate must defer without losing the reason. Store a read-only trace of the
-- Presence state that won precedence, separate from active_felt_state and
-- without writing to the Presence sticky slot.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS presence_state_trace jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_presence_deferred_idx
  ON felt_threat_gate_decisions (agent, created_at DESC)
  WHERE gate_path = 'presence_deferred';

COMMENT ON COLUMN felt_threat_gate_decisions.presence_state_trace IS
  'Read-only trace of Presence sticky/session state observed when felt-threat evaluated or deferred. Does not modify Presence state.';

COMMIT;
