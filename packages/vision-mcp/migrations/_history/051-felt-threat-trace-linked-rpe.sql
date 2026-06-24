-- 051: Trace-linked RPE feedback for felt-threat outcomes (2026-06-14)
--
-- Purpose: cross-organ RPE feedback should prefer causal action trace matches
-- over loose source_label/text matching.

BEGIN;

ALTER TABLE felt_threat_outcomes
  ADD COLUMN IF NOT EXISTS action_trace_key text,
  ADD COLUMN IF NOT EXISTS rpe_match_strategy text,
  ADD COLUMN IF NOT EXISTS rpe_match_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS felt_threat_outcomes_trace_key_idx
  ON felt_threat_outcomes (action_trace_key);

COMMIT;

