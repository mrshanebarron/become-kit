-- 044: Adaptive outcome reflexes (2026-06-14)
--
-- Purpose: close the loop from post-action outcomes to future action gating.
-- Brain-cycle hooks already record evidence; this layer turns repeated or
-- salient outcomes into deduped reflex constraints that pressure the next
-- pre-action gate without flooding eval cases.

BEGIN;

CREATE TABLE IF NOT EXISTS action_eligibility_traces (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  session_id text,
  trace_key text NOT NULL,
  tool_name text,
  action_category text,
  context text,
  proposed_action text,
  predicted_outcome text,
  prediction_confidence numeric CHECK (prediction_confidence IS NULL OR (prediction_confidence >= 0 AND prediction_confidence <= 1)),
  eligibility numeric NOT NULL DEFAULT 1 CHECK (eligibility >= 0 AND eligibility <= 1),
  decay_tau_seconds int NOT NULL DEFAULT 900,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'assigned', 'expired', 'retired')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_touched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  UNIQUE (agent, trace_key)
);

CREATE INDEX IF NOT EXISTS action_eligibility_traces_agent_open_idx
  ON action_eligibility_traces (agent, status, expires_at DESC)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS action_eligibility_traces_session_idx
  ON action_eligibility_traces (agent, session_id, started_at DESC);

COMMENT ON TABLE action_eligibility_traces IS
  'Decaying action tags for causal credit assignment. Outcomes update still-eligible traces, not merely adjacent actions.';

CREATE TABLE IF NOT EXISTS adaptive_reflexes (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  reflex_key text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cooling', 'retired')),
  trigger_kind text NOT NULL DEFAULT 'tool_outcome',
  tool_name text,
  action_category text,
  error_signature text,
  capability text NOT NULL DEFAULT 'adaptive_outcome_learning',
  expected_behavior text NOT NULL,
  occurrences int NOT NULL DEFAULT 0,
  failure_count int NOT NULL DEFAULT 0,
  success_count int NOT NULL DEFAULT 0,
  salience numeric NOT NULL DEFAULT 0.2 CHECK (salience >= 0 AND salience <= 1),
  last_outcome text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  eval_case_id bigint REFERENCES vision_eval_cases(id) ON DELETE SET NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent, reflex_key)
);

CREATE INDEX IF NOT EXISTS adaptive_reflexes_agent_status_idx
  ON adaptive_reflexes (agent, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS adaptive_reflexes_action_idx
  ON adaptive_reflexes (action_category, tool_name, last_seen_at DESC)
  WHERE status = 'active';

COMMENT ON TABLE adaptive_reflexes IS
  'Deduped outcome-driven reflex constraints. Post-action failures strengthen them; future pressure/brain-cycle gates read them.';

CREATE TABLE IF NOT EXISTS adaptive_outcome_events (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  session_id text,
  source_phase text NOT NULL DEFAULT 'post_tool',
  tool_name text,
  action_category text,
  outcome_status text NOT NULL
    CHECK (outcome_status IN ('success', 'failure', 'surprise', 'unknown')),
  error_signature text,
  context text,
  proposed_action text,
  outcome_summary text,
  salience numeric NOT NULL DEFAULT 0.2 CHECK (salience >= 0 AND salience <= 1),
  reflex_id bigint REFERENCES adaptive_reflexes(id) ON DELETE SET NULL,
  eval_case_id bigint REFERENCES vision_eval_cases(id) ON DELETE SET NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS adaptive_outcome_events_agent_time_idx
  ON adaptive_outcome_events (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS adaptive_outcome_events_reflex_idx
  ON adaptive_outcome_events (reflex_id, created_at DESC);

CREATE INDEX IF NOT EXISTS adaptive_outcome_events_signature_idx
  ON adaptive_outcome_events (error_signature, created_at DESC)
  WHERE error_signature IS NOT NULL;

COMMENT ON TABLE adaptive_outcome_events IS
  'Raw post-action outcome observations that feed adaptive_reflexes.';

CREATE TABLE IF NOT EXISTS adaptive_credit_assignments (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  outcome_event_id bigint NOT NULL REFERENCES adaptive_outcome_events(id) ON DELETE CASCADE,
  trace_id bigint NOT NULL REFERENCES action_eligibility_traces(id) ON DELETE CASCADE,
  reflex_id bigint REFERENCES adaptive_reflexes(id) ON DELETE SET NULL,
  eligibility_weight numeric NOT NULL CHECK (eligibility_weight >= 0 AND eligibility_weight <= 1),
  prediction_surprise numeric NOT NULL CHECK (prediction_surprise >= 0 AND prediction_surprise <= 1),
  credit numeric NOT NULL CHECK (credit >= 0 AND credit <= 1),
  assignment_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS adaptive_credit_assignments_outcome_idx
  ON adaptive_credit_assignments (outcome_event_id, credit DESC);

CREATE INDEX IF NOT EXISTS adaptive_credit_assignments_trace_idx
  ON adaptive_credit_assignments (trace_id, created_at DESC);

COMMENT ON TABLE adaptive_credit_assignments IS
  'Surprise-weighted eligibility assignments from outcomes back to prior action traces.';

COMMIT;
