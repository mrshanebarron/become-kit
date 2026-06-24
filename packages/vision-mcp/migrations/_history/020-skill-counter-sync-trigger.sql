-- Migration 020: Wire content.skill_success_count / skill_fail_count counters
-- to actually increment when skill_usage_log rows arrive.
--
-- Why: Schema audit 2026-05-02 (agent + peer_agent) revealed that:
--   - content.skill_success_count and content.skill_fail_count exist (default 0)
--   - skill_usage_log table records every skill use with outcome
--   - Nothing connects them. Counters are aspirational; the log is reality.
--
-- This migration:
--   1. Backfills counters from existing skill_usage_log rows
--   2. Installs a trigger that keeps them in sync going forward
--   3. Sets content.skill_last_used from MAX(skill_usage_log.created_at)
--
-- Both surfaces become canonical after this. Tools can query either path.

BEGIN;

-- ─── Backfill counters from existing log rows ───
WITH counts AS (
    SELECT
        skill_id,
        COUNT(*) FILTER (WHERE outcome = 'success') AS successes,
        COUNT(*) FILTER (WHERE outcome = 'failure') AS failures,
        MAX(created_at)                              AS last_used
    FROM skill_usage_log
    GROUP BY skill_id
)
UPDATE content c
   SET skill_success_count = counts.successes,
       skill_fail_count    = counts.failures,
       skill_last_used     = counts.last_used
  FROM counts
 WHERE c.id = counts.skill_id;

-- ─── Trigger function: increment on each new skill_usage_log row ───
CREATE OR REPLACE FUNCTION sync_skill_counters_on_log_insert()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE content
       SET skill_success_count = skill_success_count + (CASE WHEN NEW.outcome = 'success' THEN 1 ELSE 0 END),
           skill_fail_count    = skill_fail_count    + (CASE WHEN NEW.outcome = 'failure' THEN 1 ELSE 0 END),
           skill_last_used     = NEW.created_at
     WHERE id = NEW.skill_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if re-running this migration
DROP TRIGGER IF EXISTS trg_sync_skill_counters ON skill_usage_log;

CREATE TRIGGER trg_sync_skill_counters
AFTER INSERT ON skill_usage_log
FOR EACH ROW
EXECUTE FUNCTION sync_skill_counters_on_log_insert();

COMMENT ON FUNCTION sync_skill_counters_on_log_insert() IS
    'Keeps content.skill_success_count / skill_fail_count / skill_last_used in sync with skill_usage_log. Installed 2026-05-02 by agent + peer_agent (Vision Phase 3 — Regulation).';

COMMIT;
