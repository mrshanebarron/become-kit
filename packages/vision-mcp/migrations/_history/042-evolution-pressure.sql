-- 042: Evolution pressure snapshots (2026-06-14)
--
-- Purpose: close the loop between measured failures and next action.
-- vision_health can expose measurement gaps; vision_evolution_pressure turns
-- active eval failures, presence outcomes, and tool errors into an explicit
-- clearance/hold/block signal that hooks or agents can consult before acting.

BEGIN;

CREATE TABLE IF NOT EXISTS evolution_pressure_events (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  session_id text,
  context text,
  proposed_action text,
  action_category text,
  clearance text NOT NULL CHECK (clearance IN ('clear', 'warn', 'hold', 'blocked')),
  pressure_score numeric NOT NULL DEFAULT 0,
  active_eval_failures int NOT NULL DEFAULT 0,
  active_eval_partials int NOT NULL DEFAULT 0,
  active_eval_unmeasured int NOT NULL DEFAULT 0,
  presence_failed int NOT NULL DEFAULT 0,
  presence_unresolved int NOT NULL DEFAULT 0,
  tool_error_count int NOT NULL DEFAULT 0,
  constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evolution_pressure_events_agent_time_idx
  ON evolution_pressure_events (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS evolution_pressure_events_clearance_idx
  ON evolution_pressure_events (clearance, created_at DESC);

COMMENT ON TABLE evolution_pressure_events IS
  'Recorded pressure snapshots from active eval failures, presence outcomes, and tool errors. Turns measured failures into next-action control signals.';

COMMIT;
