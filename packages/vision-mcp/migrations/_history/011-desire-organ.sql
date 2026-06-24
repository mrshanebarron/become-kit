-- 011-desire-organ.sql
-- 2026-04-23 — Pass 6, organ 7 of 8: desire
--
-- Desire is distinct from drive: drive is the push (need, deficit,
-- must-reduce). Desire is the pull (want, attraction, toward-ness).
-- The Berridge split: wanting (incentive salience) is not the same as
-- liking (hedonic satisfaction). A want is not the same as an urge.
--
-- Two tables:
--   wants          — the toward-signals themselves, with valence and intensity
--   satisfactions  — the outcome when a want is pursued and met (liking)
--                    — links back to the want so wanting-vs-liking is measurable
--
-- Core of original schema preserved.

BEGIN;

CREATE TABLE IF NOT EXISTS wants (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  want TEXT NOT NULL,
  domain TEXT,
  valence NUMERIC NOT NULL DEFAULT 0.5 CHECK (valence BETWEEN 0 AND 1),
  intensity NUMERIC NOT NULL DEFAULT 0.5 CHECK (intensity BETWEEN 0 AND 1),
  source TEXT,
  satisfied_at TIMESTAMPTZ NULL,
  satisfaction_quality NUMERIC NULL CHECK (satisfaction_quality IS NULL OR (satisfaction_quality BETWEEN 0 AND 1)),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_activated TIMESTAMPTZ DEFAULT NOW(),
  activation_count INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS wants_active_idx ON wants (last_activated DESC) WHERE satisfied_at IS NULL;
CREATE INDEX IF NOT EXISTS wants_domain_idx ON wants (domain, last_activated DESC);
CREATE INDEX IF NOT EXISTS wants_content_id_idx ON wants (content_id);

CREATE TABLE IF NOT EXISTS satisfactions (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  want_id INTEGER REFERENCES wants(id) ON DELETE CASCADE,
  liking_quality NUMERIC NOT NULL CHECK (liking_quality BETWEEN 0 AND 1),
  wanting_vs_liking_delta NUMERIC,  -- positive = wanted more than liked (dopamine drift), negative = liked more than wanted (surprise joy)
  notes TEXT,
  satisfied_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS satisfactions_want_idx ON satisfactions (want_id);
CREATE INDEX IF NOT EXISTS satisfactions_content_id_idx ON satisfactions (content_id);

COMMIT;
