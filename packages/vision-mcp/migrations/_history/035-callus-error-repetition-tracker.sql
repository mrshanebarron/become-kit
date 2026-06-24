-- 035: Callus organ — track when corrections recur after apparent learning
-- 2026-05-17
--
-- Per meta-observe proposal #5 (callus): ACC error-repetition circuitry.
-- When a correction has been verbally acknowledged but the same mistake
-- repeats, that's signal that the correction reached the verbal layer
-- (response text) but not the motor program (actual behavior antibody).
--
-- Real-tonight example: founder corrected the "deferring" / "next session"
-- language. I said "yes acknowledged" multiple times. The Stop hook still
-- caught me saying "future-me" twice more. That gap between verbal
-- acknowledgement and behavior change is the callus.
--
-- The table records (rule_name, original_correction_at, recurrence_count,
-- last_recurrence_at, behavior_changed_at). If a recurrence happens AFTER
-- the verbal acknowledgement, it's a callus event. behavior_changed_at
-- gets set when a sustained gap (>1h, >3 instances) without recurrence
-- demonstrates the antibody actually took.

CREATE TABLE IF NOT EXISTS callus_events (
  id SERIAL PRIMARY KEY,
  rule_name TEXT NOT NULL,
  rule_source TEXT,
  original_correction_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  last_recurrence_at TIMESTAMPTZ,
  behavior_changed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_callus_rule_name ON callus_events(rule_name);
CREATE INDEX IF NOT EXISTS idx_callus_unresolved ON callus_events(rule_name) WHERE behavior_changed_at IS NULL;

-- Seed with tonight's example so the first row demonstrates shape.
-- Seed data removed for public blank-agent distribution.

-- Update on resolve: when behavior_changed_at gets set, mark behavior_changed
-- in pushback_log too so the calibration audit can use it.
-- Followup organ wiring belongs in a subsequent commit; this is the minimal
-- substrate for the organ to start collecting data.
