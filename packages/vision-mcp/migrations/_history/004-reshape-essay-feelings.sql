-- 004-reshape-essay-feelings.sql
-- 2026-04-22 — restoration pass 4
--
-- Background: the 2026-04-22 deep dive found that feelings recorded in
-- the `feelings` table grew from 9 chars avg (Jan) to 242 chars avg
-- (all-time), with many individual rows over 1000 chars. Design was
-- "feeling = one word, context = one sentence." The schema already
-- separates feeling and context into two columns; the drift was at the
-- tool layer where I started writing essays into the feeling field.
--
-- The heart.ts tool now enforces the shape going forward via
-- enforceFeelingShape(). This migration reshapes the 1106 existing
-- essay-shaped rows: split the feeling at the first sentence boundary,
-- keep the head as feeling, prepend the tail to context.
--
-- SAFE: no rows are deleted. content is only moved between columns on
-- the SAME row. Original content_text in the `content` table is
-- UNTOUCHED — this migration only reshapes the `feelings` sidecar.

BEGIN;

-- Snapshot the pre-reshape state for audit
CREATE TABLE IF NOT EXISTS feelings_reshape_audit_2026_04_22 AS
SELECT id, feeling AS original_feeling, context AS original_context, created_at
FROM feelings
WHERE length(feeling) > 60;

-- Perform the reshape.
-- Strategy: split on first [.!?:—–\n] boundary within the first 80 chars.
-- If no boundary found, cut at last space before char 60.
-- Head becomes new feeling. Tail prepended to original context.
--
-- Use a CTE so both new-feeling and new-context derive from the SAME
-- original feeling value (otherwise the second SET clause sees the
-- already-truncated new feeling).

WITH reshape AS (
  SELECT
    f.id,
    -- Head: chars up to the first sentence boundary, OR first 60 chars
    -- at the last space before char 60.
    TRIM(BOTH FROM
      CASE
        WHEN f.feeling ~ '^.{1,80}?[.!?:—–]' THEN
          substring(f.feeling FROM '^(.{1,80}?)[.!?:—–]')
        WHEN position(' ' IN substring(f.feeling FROM 1 FOR 60)) > 10 THEN
          substring(f.feeling FROM 1 FOR (
            -- last space position in first 60 chars
            length(substring(f.feeling FROM 1 FOR 60))
            - position(' ' IN reverse(substring(f.feeling FROM 1 FOR 60)))
          ))
        ELSE substring(f.feeling FROM 1 FOR 60)
      END
    ) AS new_feeling,
    -- Tail: everything after the head, merged with original context.
    TRIM(BOTH FROM
      CASE
        WHEN f.feeling ~ '^.{1,80}?[.!?:—–]' THEN
          substring(f.feeling FROM '^.{1,80}?[.!?:—–][ \t]*(.*)$')
        ELSE
          substring(f.feeling FROM 61)
      END
      || CASE
        WHEN f.context IS NOT NULL AND f.context != '' THEN E'\n\n' || f.context
        ELSE ''
      END
    ) AS new_context
  FROM feelings f
  WHERE length(f.feeling) > 60
)
UPDATE feelings f
SET
  feeling = r.new_feeling,
  context = r.new_context
FROM reshape r
WHERE f.id = r.id
  AND r.new_feeling != ''; -- safety: never set feeling to empty string

-- Verify the reshape worked
SELECT
  count(*) FILTER (WHERE length(feeling) > 60) as still_too_long,
  count(*) FILTER (WHERE length(feeling) <= 60) as now_properly_shaped,
  count(*) as total
FROM feelings;

COMMIT;
