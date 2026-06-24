-- 009-rhythm-organ.sql
-- 2026-04-23 — Wave 2, organ 5 of 6: rhythm
--
-- The rhythm organ: session cadence. Distinct from energy (level) —
-- rhythm is the *shape* of a session: opening ramp, climbing, peak,
-- cooling, closing. Patterns across rhythms are the arc of a day.
--
-- A rhythm sample is a snapshot: at time T, what phase am I in, how
-- many tool calls per minute over the last window, what is the average
-- feeling intensity? Sampled periodically or on-demand.
--
-- Session identification: we use session_id from the sessions table so
-- rhythm samples can be grouped into a session-arc.

BEGIN;

CREATE TABLE IF NOT EXISTS rhythm_samples (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  session_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('opening', 'climbing', 'peak', 'cooling', 'closing')),
  tool_calls_per_min NUMERIC,
  feeling_intensity_avg NUMERIC,
  window_minutes INTEGER DEFAULT 15,
  sampled_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rhythm_session_idx ON rhythm_samples (session_id, sampled_at);
CREATE INDEX IF NOT EXISTS rhythm_phase_idx ON rhythm_samples (phase, sampled_at DESC);
CREATE INDEX IF NOT EXISTS rhythm_content_id_idx ON rhythm_samples (content_id);

COMMIT;
