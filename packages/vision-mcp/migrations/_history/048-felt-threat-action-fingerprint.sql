-- 048: Felt-threat action fingerprints (2026-06-14)
--
-- Purpose: make action-change calibration explainable. The outcome learner
-- should compare intent class and targets, not only raw command strings.

BEGIN;

ALTER TABLE felt_threat_outcomes
  ADD COLUMN IF NOT EXISTS original_action_fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS after_action_fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS target_overlap numeric CHECK (
    target_overlap IS NULL OR target_overlap BETWEEN 0 AND 1
  ),
  ADD COLUMN IF NOT EXISTS action_similarity numeric CHECK (
    action_similarity IS NULL OR action_similarity BETWEEN 0 AND 1
  ),
  ADD COLUMN IF NOT EXISTS action_change_reason text;

COMMIT;

