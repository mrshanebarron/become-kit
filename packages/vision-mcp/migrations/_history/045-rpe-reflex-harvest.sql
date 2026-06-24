-- 045: RPE -> adaptive reflex harvest (2026-06-14)
--
-- Purpose: make reward_prediction_errors.credited_actions a live teaching
-- signal. Each credited RPE is harvested once into adaptive_reflexes so
-- negative surprise can pressure future action gates.

BEGIN;

CREATE TABLE IF NOT EXISTS adaptive_rpe_reflex_harvests (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  rpe_id bigint NOT NULL REFERENCES reward_prediction_errors(id) ON DELETE CASCADE,
  reflex_id bigint REFERENCES adaptive_reflexes(id) ON DELETE SET NULL,
  trace_key text,
  tool_name text,
  action_category text,
  delta numeric NOT NULL,
  magnitude numeric NOT NULL,
  credit numeric NOT NULL CHECK (credit >= 0 AND credit <= 1),
  direction text NOT NULL CHECK (direction IN ('reinforce', 'inhibit', 'neutral')),
  credited_action jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent, rpe_id, trace_key)
);

CREATE INDEX IF NOT EXISTS adaptive_rpe_reflex_harvests_agent_time_idx
  ON adaptive_rpe_reflex_harvests (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS adaptive_rpe_reflex_harvests_reflex_idx
  ON adaptive_rpe_reflex_harvests (reflex_id, created_at DESC);

COMMENT ON TABLE adaptive_rpe_reflex_harvests IS
  'One-time harvest ledger from credited RPE rows into adaptive_reflexes.';

COMMIT;
