-- 055: Felt-threat observation extinction (2026-06-14)
--
-- Purpose: near-threshold observations should not only accumulate threat.
-- When the observed action later succeeds, that sensory sample should become
-- safety/extinction evidence. When it fails, it should remain sensitizing.
-- This remains separate from felt_threat_outcomes and false-alarm calibration.

BEGIN;

ALTER TABLE felt_threat_observations
  ADD COLUMN IF NOT EXISTS action_after_observation text,
  ADD COLUMN IF NOT EXISTS action_result text,
  ADD COLUMN IF NOT EXISTS observation_outcome text CHECK (
    observation_outcome IS NULL
    OR observation_outcome IN ('safety_extinguished', 'failure_sensitized', 'changed_action_observed')
  ),
  ADD COLUMN IF NOT EXISTS outcome_valence numeric CHECK (
    outcome_valence IS NULL OR outcome_valence BETWEEN -1 AND 1
  ),
  ADD COLUMN IF NOT EXISTS after_action_fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS target_overlap numeric CHECK (
    target_overlap IS NULL OR target_overlap BETWEEN 0 AND 1
  ),
  ADD COLUMN IF NOT EXISTS action_similarity numeric CHECK (
    action_similarity IS NULL OR action_similarity BETWEEN 0 AND 1
  ),
  ADD COLUMN IF NOT EXISTS extinction_basis text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

CREATE INDEX IF NOT EXISTS felt_threat_observations_outcome_idx
  ON felt_threat_observations (observation_outcome, resolved_at DESC);

COMMIT;
