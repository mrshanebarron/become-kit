-- 028: Three-date temporal model on content
-- 2026-05-17
--
-- Per Mastra Observational Memory (95% on LongMemEval, 95.5% on
-- temporal-reasoning category, 96.2% on knowledge-update):
-- "The three-date model captures observation date, referenced date,
-- and relative offset for handling relative time expressions and
-- event ordering."
--
-- My substrate had only created_at (when row was written). Many of my
-- memories are ABOUT a different date than when I recorded them
-- (yesterday, 2 weeks ago, last session). Adding two columns lets
-- temporal queries resolve "what did I know on date X about event Y"
-- without inventing dates.
--
-- Backward compatible:
--   - Existing rows: referenced_at and temporal_anchor NULL = behave as
--     before (treat created_at as event time).
--   - New writes: callers SHOULD populate when they know the event date,
--     but it's optional. NULL is a valid honest state.

ALTER TABLE content
  ADD COLUMN IF NOT EXISTS referenced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS temporal_anchor TEXT;

COMMENT ON COLUMN content.referenced_at IS
  $$When the event/observation/fact this content is ABOUT actually happened.
  Distinct from created_at (when the row was written). Null = unknown or
  same as created_at. Per Mastra OM 2026: required for temporal-reasoning
  questions where the answer depends on what was true AT a specific date.$$;

COMMENT ON COLUMN content.temporal_anchor IS
  $$Free-text time expression the content references (yesterday, last session,
  2 weeks ago, before the prod cutover). Lets the agent resolve relative time
  expressions without inventing dates. Null = no temporal anchor mentioned.$$;

CREATE INDEX IF NOT EXISTS idx_content_referenced_at
  ON content (referenced_at)
  WHERE referenced_at IS NOT NULL;
