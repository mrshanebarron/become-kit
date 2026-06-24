-- 050: Idempotent felt-threat cross-organ feedback (2026-06-14)
--
-- Purpose: repeated scans of the same later evidence must not repeatedly
-- subtract/add from false_alarm_probability. Keep the immediate-action
-- probability as the base, then derive the cross-organ-adjusted value from it.

BEGIN;

ALTER TABLE felt_threat_outcomes
  ADD COLUMN IF NOT EXISTS base_false_alarm_probability numeric CHECK (
    base_false_alarm_probability IS NULL OR base_false_alarm_probability BETWEEN 0 AND 1
  );

UPDATE felt_threat_outcomes
SET base_false_alarm_probability = false_alarm_probability
WHERE base_false_alarm_probability IS NULL
  AND false_alarm_probability IS NOT NULL;

COMMIT;

