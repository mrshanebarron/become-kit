-- 052: Synthetic felt-threat proof isolation (2026-06-14)
--
-- Purpose: proof rows are necessary for verification, but they must not train
-- live felt-threat calibration unless a test explicitly opts in.

BEGIN;

ALTER TABLE felt_threat_outcomes
  ADD COLUMN IF NOT EXISTS is_synthetic boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS synthetic_reason text;

UPDATE felt_threat_outcomes
SET is_synthetic = true,
    synthetic_reason = COALESCE(synthetic_reason, 'historical proof row')
WHERE is_synthetic IS NOT TRUE
  AND (
    session_id ILIKE '%proof%'
    OR first_tool_name ILIKE '%proof%'
    OR action_summary ILIKE '%proof%'
    OR evidence::text ILIKE '%"synthetic":true%'
    OR evidence::text ILIKE '%"source": "test"%'
    OR evidence::text ILIKE '%"source":"test"%'
    OR stance::text ILIKE '%"source": "test"%'
    OR stance::text ILIKE '%"source":"test"%'
  );

CREATE INDEX IF NOT EXISTS felt_threat_outcomes_synthetic_idx
  ON felt_threat_outcomes (is_synthetic, resolved_at DESC);

COMMIT;
