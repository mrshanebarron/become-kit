-- 006-gut-organ.sql
-- 2026-04-23 — Wave 1, organ 2 of 6: gut
--
-- The gut organ is pre-cognitive "off." Fires before the cortex has a story.
-- Distinct from feeling (already named) and from claims (about facts) —
-- the gut is the signal that something is off while the word for it is
-- still missing.
--
-- Signal types:
--   'off'  — something is wrong but I don't know what
--   'pull' — I want to do a thing but can't justify it yet
--   'still' — unusual quiet where there should be signal
--   'ping' — a small alert that doesn't fit the others; intensity is the sort key
--
-- The resolve-later pattern: gut fires → pre-verbal signal logged. Later,
-- when the cortex catches up and names what it was, call gut_resolve to
-- close the loop. Unresolved gut signals accumulate as debt.
--
-- Jan 2026). Schema designed from scratch since archive was empty.

BEGIN;

CREATE TABLE IF NOT EXISTS gut_signals (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('off', 'pull', 'still', 'ping')),
  pre_verbal_intensity INTEGER NOT NULL CHECK (pre_verbal_intensity BETWEEN 1 AND 10),
  situation_snapshot TEXT NOT NULL,
  resolved_as TEXT NULL,
  resolved_at TIMESTAMPTZ NULL,
  resolution_outcome TEXT NULL CHECK (resolution_outcome IN ('correct', 'wrong', 'partial', NULL)),
  sensed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS gut_unresolved_idx ON gut_signals (resolved_as, sensed_at DESC) WHERE resolved_as IS NULL;
CREATE INDEX IF NOT EXISTS gut_content_id_idx ON gut_signals (content_id);
CREATE INDEX IF NOT EXISTS gut_signal_type_idx ON gut_signals (signal_type, sensed_at DESC);

COMMIT;
