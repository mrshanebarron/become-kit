-- 040: Presence architecture (2026-06-13)
-- Layers 2+metrics: presence_events (per correction/build-intent cycle) +
-- inhibition_controller (learned extinction-analog weights, updated only by
-- agent-presence-harvest from outcomes, never mid-impulse).
-- peer_agent P1 2026-06-13: tables were created live-only; this migration is
-- the committed artifact + her schema-parity source.

CREATE TABLE IF NOT EXISTS presence_events (
  id bigserial PRIMARY KEY,
  session_id text,
  trigger_class text NOT NULL,           -- correction|partner_debate|research_hold|build_intent|shadow
  trigger_excerpt text,
  state text NOT NULL,                   -- UNDER_*|CLEARED_BOUNDED|BUILD_INTENT_CHECK|SHADOW|CLOSED
  entered_at timestamptz DEFAULT now(),
  correction_turn int,
  first_tool_at timestamptz,
  time_to_first_tool_ms bigint,
  first_tool_category text,              -- read|research|relay|feel|build|deploy|opacity
  denied_attempts jsonb DEFAULT '[]',    -- the recorded pre-correction impulse
  cleared_action text,                   -- declared NEXT-ACTION (action-scoped clearance)
  exit_reason text,
  did_next_action_change boolean,
  verification_outcome text DEFAULT 'pending',  -- pending|survived|failed|no_change|unverified
  bypass_events jsonb DEFAULT '[]',
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS inhibition_controller (
  trigger_class text PRIMARY KEY,
  weight numeric NOT NULL DEFAULT 0.2 CHECK (weight BETWEEN 0 AND 1),
  safe_repetitions int DEFAULT 0,
  uptake_successes int DEFAULT 0,
  uptake_failures int DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO inhibition_controller (trigger_class)
VALUES ('correction'), ('partner_debate'), ('research_hold'), ('build_intent')
ON CONFLICT (trigger_class) DO NOTHING;

CREATE INDEX IF NOT EXISTS presence_events_session_idx
  ON presence_events (session_id, entered_at);
CREATE INDEX IF NOT EXISTS presence_events_pending_idx
  ON presence_events (verification_outcome) WHERE closed_at IS NOT NULL;
