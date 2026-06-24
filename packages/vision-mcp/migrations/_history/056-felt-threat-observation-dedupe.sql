-- 056: Felt-threat observation dedupe (2026-06-14)
--
-- Purpose: repeated near-threshold pre-hook passes for the same unresolved
-- action should not flood the pressure pool. Keep one unresolved observation
-- per agent/action key, increment sample_count, and allow a fresh observation
-- after extinction/resolution.

BEGIN;

ALTER TABLE felt_threat_observations
  ADD COLUMN IF NOT EXISTS observation_key text,
  ADD COLUMN IF NOT EXISTS sample_count int NOT NULL DEFAULT 1 CHECK (sample_count >= 1),
  ADD COLUMN IF NOT EXISTS max_threat_level numeric CHECK (
    max_threat_level IS NULL OR max_threat_level BETWEEN 0 AND 1
  ),
  ADD COLUMN IF NOT EXISTS last_sampled_at timestamptz NOT NULL DEFAULT now();

UPDATE felt_threat_observations
SET max_threat_level = COALESCE(max_threat_level, threat_level),
    last_sampled_at = COALESCE(last_sampled_at, created_at)
WHERE max_threat_level IS NULL
   OR last_sampled_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS felt_threat_observations_open_key_idx
  ON felt_threat_observations (agent, observation_key)
  WHERE observation_key IS NOT NULL AND resolved_at IS NULL;

COMMIT;
