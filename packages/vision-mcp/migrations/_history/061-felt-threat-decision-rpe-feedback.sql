-- 061: RPE feedback for felt-threat gate decisions (2026-06-14)
--
-- Purpose: gate decisions now carry action_trace_key and post-action outcome.
-- Add passive cross-organ feedback so later reward-prediction error can audit
-- whether a pass/hold decision was followed by negative surprise. This does
-- not change thresholds or false-alarm calibration.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS cross_organ_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cross_organ_score numeric,
  ADD COLUMN IF NOT EXISTS cross_organ_basis text,
  ADD COLUMN IF NOT EXISTS rpe_match_strategy text,
  ADD COLUMN IF NOT EXISTS rpe_match_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_cross_organ_scan_at timestamptz;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_cross_scan_idx
  ON felt_threat_gate_decisions (last_cross_organ_scan_at, resolved_at DESC);

COMMIT;
