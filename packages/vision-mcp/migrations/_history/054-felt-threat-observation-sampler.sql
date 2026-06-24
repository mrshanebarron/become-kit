-- 054: Felt-threat observation sampler (2026-06-14)
--
-- Purpose: holds are sparse, but the nervous system also needs low-noise live
-- readings of near-threshold felt threat. These observations are deliberately
-- separate from felt_threat_outcomes: they are sensory samples, not calibration
-- truth, and must not train false-alarm probability by themselves.

BEGIN;

CREATE TABLE IF NOT EXISTS felt_threat_observations (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  session_id text,
  tool_name text,
  action_category text,
  action_summary text,
  permission_path text NOT NULL DEFAULT 'pass' CHECK (permission_path IN ('pass', 'allow', 'hold')),
  sampled_reason text,
  stance jsonb NOT NULL DEFAULT '{}'::jsonb,
  threat_level numeric CHECK (threat_level IS NULL OR threat_level BETWEEN 0 AND 1),
  safety_level numeric CHECK (safety_level IS NULL OR safety_level BETWEEN 0 AND 1),
  action_fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_synthetic boolean NOT NULL DEFAULT false,
  synthetic_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS felt_threat_observations_agent_time_idx
  ON felt_threat_observations (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS felt_threat_observations_live_idx
  ON felt_threat_observations (is_synthetic, created_at DESC);

COMMENT ON TABLE felt_threat_observations IS
  'Low-noise sensory samples from felt-threat gating. Separate from outcomes so near-misses do not become calibration truth.';

COMMIT;
