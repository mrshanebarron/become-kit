-- 063: Effective gate authority snapshot for felt-threat decisions (2026-06-14)
--
-- Purpose: live status can derive the current authority stack, but decision
-- audit needs the authority that won at the moment of the gate decision. This
-- stores a read-only snapshot on each decision row, separate from Presence
-- sticky/session state and separate from felt-threat state files.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS effective_gate_authority jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_authority_idx
  ON felt_threat_gate_decisions ((effective_gate_authority->>'effective_precedence'), created_at DESC);

COMMENT ON COLUMN felt_threat_gate_decisions.effective_gate_authority IS
  'Read-only snapshot of the Presence/felt-threat state that had gate authority when the decision was recorded.';

COMMIT;
