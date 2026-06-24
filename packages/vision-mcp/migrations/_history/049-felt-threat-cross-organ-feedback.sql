-- 049: Felt-threat cross-organ feedback (2026-06-14)
--
-- Purpose: immediate action success is not enough to judge a felt hold. Later
-- negative RPE and resolved gut correctness should feed calibration as weak
-- cross-organ evidence.

BEGIN;

ALTER TABLE felt_threat_outcomes
  ADD COLUMN IF NOT EXISTS cross_organ_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS cross_organ_score numeric,
  ADD COLUMN IF NOT EXISTS cross_organ_basis text,
  ADD COLUMN IF NOT EXISTS last_cross_organ_scan_at timestamptz;

CREATE INDEX IF NOT EXISTS felt_threat_outcomes_cross_scan_idx
  ON felt_threat_outcomes (last_cross_organ_scan_at, resolved_at DESC);

COMMIT;

