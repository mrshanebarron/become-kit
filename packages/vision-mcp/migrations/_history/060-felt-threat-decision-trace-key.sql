-- 060: Link felt-threat gate decisions to action eligibility traces (2026-06-14)
--
-- Purpose: decisions now have pre/post audit metadata, but they should also
-- carry the same action_trace_key used by felt_threat_outcomes so later RPE
-- and audit work can follow a gate choice back to the pre-action trace.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS action_trace_key text;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_trace_key_idx
  ON felt_threat_gate_decisions (action_trace_key)
  WHERE action_trace_key IS NOT NULL;

COMMIT;
