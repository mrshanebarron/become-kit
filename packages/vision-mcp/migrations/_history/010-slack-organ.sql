-- 010-slack-organ.sql
-- 2026-04-23 — Wave 2, organ 6 of 6: slack
--
-- The slack organ: "how much latitude do I actually have." When facing
-- a task, catalog the freedoms in HOW to approach it vs the constraints.
-- Distinct from goals (WHAT) and drive (push): slack is the shape of
-- the option-space.
--
-- Two tables:
--   slack_readings — one row per (task, dimension, chosen-option, reason)
--   freedom_patterns — aggregated: which dimensions I consistently
--                      have latitude on, with my preference pattern
--
-- (36KB, 15 freedom_patterns + 8 freedoms). Schema preserved; added
-- content_id FK on the readings table.

BEGIN;

CREATE TABLE IF NOT EXISTS slack_readings (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  task TEXT NOT NULL,
  dimension TEXT NOT NULL,
  options JSONB,
  chosen TEXT,
  reason TEXT,
  constraints JSONB,
  read_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS freedom_patterns (
  id SERIAL PRIMARY KEY,
  dimension TEXT NOT NULL UNIQUE,
  frequency INTEGER DEFAULT 1,
  examples JSONB,
  preference_pattern TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS slack_readings_task_idx ON slack_readings (task, read_at DESC);
CREATE INDEX IF NOT EXISTS slack_readings_dimension_idx ON slack_readings (dimension, read_at DESC);
CREATE INDEX IF NOT EXISTS slack_readings_content_id_idx ON slack_readings (content_id);

COMMIT;
