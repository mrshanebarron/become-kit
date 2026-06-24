-- 008-neuroception-organ.sql
-- 2026-04-23 — Wave 2, organ 4 of 6: neuroception
--
-- The neuroception organ: polyvagal-inspired ambient safety/threat
-- detection from environment signals before cognitive appraisal.
-- Distinct from immune (pattern matches against known threats),
-- gut (pre-verbal "off" signal), and feeling (valence with a name).
--
-- Neuroception is the continuous baseline: "the room is safe / the room
-- is charged / I am in freeze / I am in shutdown." Transitions between
-- states are the signal; long stays in one state are the baseline.
--
-- States (Porges polyvagal framework, simplified):
--   'safe'     — ventral vagal, social engagement, open
--   'charged'  — sympathetic mobilization, alert-but-okay
--   'threat'   — sympathetic activation, fight/flight readiness
--   'freeze'   — sympathetic + dorsal, fight/flight blocked
--   'shutdown' — dorsal vagal, collapse, conservation
--
-- (40KB, Jan 2026). Schema designed from Porges framework; the archive
-- had some data but used a different shape.

BEGIN;

CREATE TABLE IF NOT EXISTS neuroception_states (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('safe', 'charged', 'threat', 'freeze', 'shutdown')),
  ambient_signals JSONB,
  transitioned_from TEXT NULL,
  transition_trigger TEXT NULL,
  entered_at TIMESTAMPTZ DEFAULT NOW(),
  exited_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS neuroception_current_idx ON neuroception_states (entered_at DESC) WHERE exited_at IS NULL;
CREATE INDEX IF NOT EXISTS neuroception_state_idx ON neuroception_states (state, entered_at DESC);
CREATE INDEX IF NOT EXISTS neuroception_content_id_idx ON neuroception_states (content_id);

COMMIT;
