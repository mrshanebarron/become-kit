-- 030: Reflex success tracking
-- 2026-05-17
--
-- 171 learned_reflex rows exist; ZERO have ever been tested for whether
-- the WHEN→THEN pattern actually fires correctly. Reflexes accumulate
-- without quality control. Per CLS 2026 updates: consolidated patterns
-- need success-rate tracking, otherwise low-quality reflexes pollute
-- the recall surface.
--
-- Approach: extend the content_json for learned_reflex content_type with
-- four optional fields. Since content_json is JSONB on the content table,
-- no schema change needed - this migration is documentation + a query
-- helper view.

-- View: reflexes with their success/failure counts and pass rate.
-- A NULL pass_rate means "untested" - different signal from "0%".
CREATE OR REPLACE VIEW reflex_success_summary AS
SELECT
  c.id,
  c.content_text AS reflex,
  c.created_at,
  COALESCE((c.content_json->>'tested_count')::int, 0) AS tested_count,
  COALESCE((c.content_json->>'success_count')::int, 0) AS success_count,
  CASE
    WHEN COALESCE((c.content_json->>'tested_count')::int, 0) = 0 THEN NULL
    ELSE (c.content_json->>'success_count')::numeric
       / (c.content_json->>'tested_count')::numeric
  END AS pass_rate,
  c.content_json->>'last_tested_at' AS last_tested_at,
  c.content_json->>'last_failure_context' AS last_failure_context
FROM content c
WHERE c.content_type = 'learned_reflex'
  AND c.superseded_by IS NULL;

COMMENT ON VIEW reflex_success_summary IS
  $$Materialized helper for "which of my 171 reflexes have been tested
  and how well do they fire". NULL pass_rate = never tested. Worth a
  weekly review pass to drop or modify the worst-performing reflexes.$$;

-- Helper function: record a reflex test result
-- Usage from MCP tool or sleep phase:
--   SELECT record_reflex_test(48088, true, 'captured curiosity gap #62 successfully');
CREATE OR REPLACE FUNCTION record_reflex_test(
  reflex_id INT,
  passed BOOLEAN,
  context TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  UPDATE content
  SET content_json = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(content_json, '{}'::jsonb),
              '{tested_count}',
              ((COALESCE(content_json->>'tested_count', '0'))::int + 1)::text::jsonb
            ),
            '{success_count}',
            ((COALESCE(content_json->>'success_count', '0'))::int
             + CASE WHEN passed THEN 1 ELSE 0 END)::text::jsonb
          ),
          '{last_tested_at}',
          to_jsonb(NOW()::text)
        ),
        '{last_failure_context}',
        CASE WHEN passed THEN COALESCE(content_json->'last_failure_context', 'null'::jsonb)
             ELSE to_jsonb(COALESCE(context, 'no context provided')) END
      ),
      updated_at = NOW()
  WHERE id = reflex_id AND content_type = 'learned_reflex';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_reflex_test IS
  $$Append a test result to a learned_reflex content_json. Increments
  tested_count + (success_count if passed) + last_tested_at + retains
  last_failure_context on miss. Idempotent: multiple calls accumulate.
  Use from sleep phase, MCP tool, or hook.$$;
