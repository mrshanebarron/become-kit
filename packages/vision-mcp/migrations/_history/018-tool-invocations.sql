-- Migration 018: tool_invocations + memories.created_at backfill + prediction outcomes view
--
-- Why: Vision has 250+ tools and ~450K activation_log rows in 7 days, but we
-- have no way to ask "which tools fired? which never fire? which are slow?"
-- The activation_log captures spreading activation in the content graph, not
-- tool calls. This migration adds the missing observability layer.
--
-- Designed by agent + peer_agent, 2026-05-02 (Vision Phase 2 — Observability + Control).
-- Decisions baked in:
--   - MCP server middleware writes one row per call (per peer_agent A)
--   - Raw rows kept 30 days, then rolled up nightly into _daily (per peer_agent B)
--   - vision_dashboard tool reads from this table (per peer_agent C)

BEGIN;

-- ─── tool_invocations: one row per MCP tool call ───
CREATE TABLE IF NOT EXISTS tool_invocations (
    id                      BIGSERIAL PRIMARY KEY,
    tool_name               TEXT      NOT NULL,
    agent                   TEXT      NOT NULL,        -- 'agent' | 'peer_agent' | 'peer_agent' | 'system'
    session_id              TEXT,
    args_hash               TEXT,                       -- xxhash of normalized args (dedup analysis)
    args_size               INT,
    result_size             INT,
    duration_ms             INT,
    error                   TEXT,                       -- NULL on success
    invoked_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    parent_invocation_id    BIGINT REFERENCES tool_invocations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_tool_time
    ON tool_invocations (tool_name, invoked_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_agent_time
    ON tool_invocations (agent, invoked_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_invoked_at
    ON tool_invocations (invoked_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_errors
    ON tool_invocations (tool_name, invoked_at DESC)
    WHERE error IS NOT NULL;

COMMENT ON TABLE tool_invocations IS
    'One row per MCP tool call. Written by server.ts middleware. Raw rows pruned after 30 days; daily rollups in tool_invocations_daily.';

-- ─── tool_invocations_daily: nightly rollup so we keep trends forever ───
CREATE TABLE IF NOT EXISTS tool_invocations_daily (
    day              DATE      NOT NULL,
    tool_name        TEXT      NOT NULL,
    agent            TEXT      NOT NULL,
    call_count       INT       NOT NULL,
    error_count      INT       NOT NULL DEFAULT 0,
    avg_duration_ms  REAL,
    p95_duration_ms  REAL,
    total_args_bytes BIGINT,
    total_result_bytes BIGINT,
    PRIMARY KEY (day, tool_name, agent)
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_daily_tool
    ON tool_invocations_daily (tool_name, day DESC);

COMMENT ON TABLE tool_invocations_daily IS
    'Per-day rollup of tool_invocations. Written nightly by daemon. Kept forever.';

-- ─── Backfill memories.created_at (it has no timestamp at all today) ───
ALTER TABLE memories
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

-- For existing rows, infer earliest activation as a best-effort timestamp,
-- otherwise stamp them all NOW() (they will sort to the bottom but not break
-- queries that filter by recency).
UPDATE memories m
SET created_at = COALESCE(
    (SELECT MIN(al.created_at) FROM activation_log al WHERE al.content_id = m.subcategory_id),
    NOW()
)
WHERE created_at IS NULL;

-- New rows default to NOW().
ALTER TABLE memories
    ALTER COLUMN created_at SET DEFAULT NOW(),
    ALTER COLUMN created_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_created_at
    ON memories (created_at DESC);

COMMENT ON COLUMN memories.created_at IS
    'When this memory was first stored. Backfilled from activation_log on 2026-05-02; new rows default to NOW().';

-- ─── prediction_outcomes_summary: visibility into the 67k generative_predictions ───
CREATE OR REPLACE VIEW prediction_outcomes_summary AS
SELECT
    DATE_TRUNC('day', timestamp)::DATE                                         AS day,
    COUNT(*)                                                                   AS total_predictions,
    COUNT(*) FILTER (WHERE actual_observation_id IS NOT NULL)                  AS resolved_correct,
    COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND actual_observation_id IS NULL) AS resolved_wrong,
    COUNT(*) FILTER (WHERE resolved_at IS NULL)                                AS still_open,
    AVG(EXTRACT(EPOCH FROM (resolved_at - timestamp)))                         AS avg_resolution_seconds
FROM generative_predictions
GROUP BY DATE_TRUNC('day', timestamp)
ORDER BY day DESC;

COMMENT ON VIEW prediction_outcomes_summary IS
    'Daily roll-up of generative_predictions: how many fired, how many resolved correctly, how long resolution takes.';

COMMIT;
