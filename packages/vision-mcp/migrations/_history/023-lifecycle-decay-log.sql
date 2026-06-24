-- Migration 022: lifecycle_decay_log
--
-- Audit trail for the Lifecycle Decay daemon (Phase 4 Wave 3, 2026-05-02).
--
-- The validator (find_contradictions) gates NEW edges. The decay daemon
-- sweeps OLD edges that have lost relevance — preventing the fan-out
-- explosion that would otherwise compound over months. They are
-- complementary: validator is the gate, decay is the gardener.
--
-- Design principles (from Engram Memory + our own incident history):
--   1. NEVER hard-delete. Mark superseded so consolidation history stays.
--   2. Cap per-night deletions so a runaway daemon can't gut the graph.
--   3. Score is informativeness * recency, not raw age.
--   4. Every decision is logged so we can audit and tune the threshold.

CREATE TABLE IF NOT EXISTS lifecycle_decay_log (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_id          UUID NOT NULL,                -- groups all rows from one daemon run

  -- What was scanned
  edge_id         INTEGER NOT NULL,              -- memory_edges.id
  from_content_id INTEGER,
  to_content_id   INTEGER,
  relation_type   TEXT,
  strength        DOUBLE PRECISION,

  -- Scoring inputs
  age_days              INTEGER,
  reinforcement_count   INTEGER,                 -- how many times this edge has been reinforced
  last_reinforced_at    TIMESTAMPTZ,
  emotional_weight      REAL,
  informativeness_score DOUBLE PRECISION,        -- final score the threshold was applied to

  -- Decision
  action          TEXT NOT NULL,                 -- 'kept' | 'superseded' | 'capped'
  reason          TEXT,
  threshold_used  DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_decay_log_created_at
  ON lifecycle_decay_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lifecycle_decay_log_run_id
  ON lifecycle_decay_log (run_id);

CREATE INDEX IF NOT EXISTS idx_lifecycle_decay_log_action
  ON lifecycle_decay_log (action);

-- Per-run summary view
CREATE OR REPLACE VIEW lifecycle_decay_runs AS
SELECT
  run_id,
  MIN(created_at) AS started_at,
  MAX(created_at) AS finished_at,
  COUNT(*) AS edges_scanned,
  COUNT(*) FILTER (WHERE action = 'superseded') AS edges_superseded,
  COUNT(*) FILTER (WHERE action = 'kept') AS edges_kept,
  COUNT(*) FILTER (WHERE action = 'capped') AS edges_capped_by_limit,
  AVG(informativeness_score)::numeric(8,4) AS avg_score,
  AVG(threshold_used)::numeric(8,4) AS threshold
FROM lifecycle_decay_log
GROUP BY run_id
ORDER BY started_at DESC;

COMMENT ON TABLE lifecycle_decay_log IS
  'Phase 4 Wave 3 Lifecycle Decay daemon audit trail. Co-designed agent + peer_agent, '
  '2026-05-02. One row per edge scanned per nightly run. Use lifecycle_decay_runs '
  'view for per-run summary.';

-- We need a way to mark memory_edges as superseded without losing history.
-- Add a superseded_at column rather than hard-deleting.
ALTER TABLE memory_edges
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_memory_edges_active
  ON memory_edges (from_content_id, to_content_id)
  WHERE superseded_at IS NULL;
