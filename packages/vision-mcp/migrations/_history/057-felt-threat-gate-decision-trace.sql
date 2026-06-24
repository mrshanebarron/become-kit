-- 057: Felt-threat gate decision trace (2026-06-14)
--
-- Purpose: outcome and observation ledgers say what happened after a hold or
-- near-miss. The gate also needs a cortical trace of why a significant
-- mutating pre-decision passed or held: raw stance, integrated stance, active
-- state precedence, and resulting threshold decision.

BEGIN;

CREATE TABLE IF NOT EXISTS felt_threat_gate_decisions (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  session_id text,
  tool_name text,
  action_category text,
  action_summary text,
  gate_path text NOT NULL CHECK (
    gate_path IN ('presence_deferred', 'mutating_pass', 'mutating_hold')
  ),
  should_hold boolean,
  permission_decision text,
  presence_event_id bigint REFERENCES presence_events(id) ON DELETE SET NULL,
  active_felt_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_stance jsonb NOT NULL DEFAULT '{}'::jsonb,
  integrated_stance jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  sampled_observation boolean NOT NULL DEFAULT false,
  is_synthetic boolean NOT NULL DEFAULT false,
  synthetic_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_agent_time_idx
  ON felt_threat_gate_decisions (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_path_time_idx
  ON felt_threat_gate_decisions (gate_path, created_at DESC);

COMMENT ON TABLE felt_threat_gate_decisions IS
  'Cortical trace of significant felt-threat gate decisions. Separate from Presence sticky state and from outcome calibration.';

COMMIT;
