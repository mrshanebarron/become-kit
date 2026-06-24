-- 046: Felt-threat outcome learning (2026-06-14)
--
-- Purpose: the felt-threat gate can now pause an action, but a pause is still
-- theater unless the nervous system learns whether the pause was a false alarm
-- or a true catch. This ledger keys calibration outcomes to presence_events
-- without writing into the single-slot presence sticky state.

BEGIN;

CREATE TABLE IF NOT EXISTS felt_threat_outcomes (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  presence_event_id bigint NOT NULL REFERENCES presence_events(id) ON DELETE CASCADE,
  session_id text,
  first_tool_name text,
  last_tool_name text,
  action_category text,
  action_summary text,
  last_permission_decision text CHECK (last_permission_decision IN ('ask', 'deny')),
  hold_count int NOT NULL DEFAULT 0 CHECK (hold_count >= 0),
  stance jsonb NOT NULL DEFAULT '{}'::jsonb,
  threat_level numeric,
  safety_level numeric,
  action_after_hold text,
  action_result text,
  outcome_valence numeric CHECK (outcome_valence IS NULL OR outcome_valence BETWEEN -1 AND 1),
  false_alarm_probability numeric CHECK (
    false_alarm_probability IS NULL OR false_alarm_probability BETWEEN 0 AND 1
  ),
  resolution text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (agent, presence_event_id)
);

CREATE INDEX IF NOT EXISTS felt_threat_outcomes_agent_time_idx
  ON felt_threat_outcomes (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS felt_threat_outcomes_resolution_idx
  ON felt_threat_outcomes (resolution, resolved_at DESC);

COMMENT ON TABLE felt_threat_outcomes IS
  'Calibration ledger for felt-threat holds: what the gate sensed, what action followed, and whether the hold looked like false alarm or true catch.';

COMMIT;

