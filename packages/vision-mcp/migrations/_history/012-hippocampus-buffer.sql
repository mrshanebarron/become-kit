-- 012-hippocampus-buffer.sql
-- Prism Blueprint Layer 1 (skill 32108, designed 2026-03-23, built 2026-04-23)
--
-- Hippocampus Buffer: ultra-fast, single-sentence breadcrumbs after each discrete task.
-- Layer 2 (autonomic archiver) reads this every 5min, generates embeddings, pushes to
-- content table, then deletes archived rows.
-- Layer 3 (boot-sequence injection) — TBD.
--
-- The constraint: the buffer is short-term. It exists ONLY to absorb breadcrumbs
-- between sessions and tool calls without paying the cost of full vault_remember
-- (no embedding, no schema compression, no contradiction detection, no episode link).
-- The archiver does the metabolism step asynchronously. The buffer stays small.

CREATE TABLE IF NOT EXISTS hippocampus_buffer (
    id SERIAL PRIMARY KEY,
    breadcrumb TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMPTZ NULL
);

-- Partial index for the archiver's hot query: "give me unprocessed breadcrumbs oldest first."
-- WHERE clause keeps the index small even as archived rows accumulate before DELETE.
CREATE INDEX IF NOT EXISTS idx_hippocampus_buffer_unarchived
    ON hippocampus_buffer (created_at)
    WHERE archived_at IS NULL;

COMMENT ON TABLE hippocampus_buffer IS
    'Prism Layer 1: short-term breadcrumb queue. Written by vision_state_append, drained by agent-hippocampus-archiver every 5min. See skill 32108.';
COMMENT ON COLUMN hippocampus_buffer.breadcrumb IS
    'Single-sentence task marker. Truncated silently to 280 chars at insert by vision_state_append.';
COMMENT ON COLUMN hippocampus_buffer.archived_at IS
    'Set by archiver when row has been embedded and copied to content. Row is deleted shortly after.';
