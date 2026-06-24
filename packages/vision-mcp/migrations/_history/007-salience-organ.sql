-- 007-salience-organ.sql
-- 2026-04-23 — Wave 1, organ 3 of 6: salience
--
-- The salience organ: what stood out. Which events got attention-weighted
-- above baseline. Distinct from feeling (valence) and from curiosity (gap):
-- salience is the raw "this caught my eye" before interpretation.
--
-- Retrofit migration: 31 rows already exist in content with
-- content_type = 'salient_event' but no detail table and no tool to
-- write them. This migration creates the table and backfills existing
-- rows with null salience_score so they're queryable.

BEGIN;

CREATE TABLE IF NOT EXISTS salient_events (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  salience_score NUMERIC NOT NULL DEFAULT 0.5 CHECK (salience_score BETWEEN 0 AND 1),
  what_stood_out TEXT NOT NULL,
  attention_vector JSONB,
  marked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(content_id)
);

CREATE INDEX IF NOT EXISTS salient_events_score_idx ON salient_events (salience_score DESC);
CREATE INDEX IF NOT EXISTS salient_events_content_id_idx ON salient_events (content_id);

-- Backfill existing salient_event rows so they're queryable from the detail table.
-- Uses content_text as a stand-in for what_stood_out; salience_score defaults to 0.5.
INSERT INTO salient_events (content_id, salience_score, what_stood_out, marked_at)
SELECT c.id,
       COALESCE(c.emotional_intensity / 10.0, 0.5) AS salience_score,
       substring(c.content_text FROM 1 FOR 500) AS what_stood_out,
       c.learned_at
FROM content c
WHERE c.content_type = 'salient_event'
  AND NOT EXISTS (SELECT 1 FROM salient_events s WHERE s.content_id = c.id)
ON CONFLICT (content_id) DO NOTHING;

COMMIT;
