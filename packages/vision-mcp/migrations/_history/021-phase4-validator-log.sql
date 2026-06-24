-- Migration 021: phase4_validator_log
--
-- Dedicated audit trail for the find_contradictions multi-stage validator.
-- Every call to validateEdge() inserts one row, capturing the full
-- per-stage transcript so we can audit shadow-mode behavior before
-- flipping VISION_PHASE4_* flags from 'shadow' to 'on'.
--
-- Why a dedicated table instead of tool_invocations.attributes JSONB:
--   - tool_invocations is INSERT-once at MCP-tool boundary; validateEdge
--     is called from inside MCP tools (heart_feel, vault_remember), so
--     it never gets its own row in tool_invocations.
--   - Dedicated table gives us typed columns (verdict, confidence, distance)
--     for cheap aggregation queries instead of JSONB extraction.
--   - 24h shadow → audit → enforce cycle needs simple SELECT GROUP BY,
--     not jsonb_path_query gymnastics.
--
-- Co-designed with peer_agent 2026-05-02 (Phase 4 Wave 1 prep, post-commit).
-- Adds nothing to the hot path — INSERT is fire-and-forget, errors logged not raised.

CREATE TABLE IF NOT EXISTS phase4_validator_log (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The two graph nodes the validator was asked about
  from_content_id INTEGER NOT NULL,
  to_content_id   INTEGER NOT NULL,
  from_type       TEXT,                    -- denormalized for cheap aggregation
  to_type         TEXT,

  -- Caller context
  caller          TEXT,                    -- e.g. 'inference-loop:checkPredictions', 'evidence:autoGenerate'
  mode            TEXT NOT NULL,           -- 'shadow' | 'on'

  -- Per-stage outputs
  semantic_similarity   DOUBLE PRECISION,
  type_compatible       BOOLEAN,
  structural_distance   INTEGER,           -- NULL means Infinity (disconnected)
  llm_verdict_raw       TEXT,
  llm_reasoning         TEXT,

  -- Final verdict
  verdict         TEXT NOT NULL,           -- 'supports' | 'contradicts' | 'unrelated' | 'insufficient'
  confidence      DOUBLE PRECISION NOT NULL,
  stages_passed   TEXT[],                  -- e.g. {'semantic', 'structural', 'llm'}
  rejected_at     TEXT,                    -- 'semantic' | 'structural' | 'llm' | NULL
  rejected_reason TEXT,

  -- T³ Ψ when an oracle was in play
  oracle_tier     TEXT,                    -- 'A' | 'B' | 'C' | NULL
  psi_estimate    DOUBLE PRECISION,

  -- Whether the verdict actually drove a write (only true in 'on' mode + final action)
  enforced        BOOLEAN NOT NULL DEFAULT FALSE,

  -- Cost tracking — Stage 3 LLM call is the expensive part
  llm_called      BOOLEAN NOT NULL DEFAULT FALSE,
  duration_ms     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_phase4_validator_log_created_at
  ON phase4_validator_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_phase4_validator_log_verdict
  ON phase4_validator_log (verdict);

CREATE INDEX IF NOT EXISTS idx_phase4_validator_log_caller
  ON phase4_validator_log (caller);

CREATE INDEX IF NOT EXISTS idx_phase4_validator_log_mode_verdict
  ON phase4_validator_log (mode, verdict);

-- Daily rollup view for the audit queries peer_agent and I will run
-- before flipping flags from 'shadow' to 'on'.
CREATE OR REPLACE VIEW phase4_validator_daily AS
SELECT
  DATE_TRUNC('day', created_at) AS day,
  caller,
  mode,
  verdict,
  COUNT(*) AS n,
  AVG(confidence)::numeric(5,3) AS avg_confidence,
  AVG(semantic_similarity)::numeric(5,3) AS avg_similarity,
  AVG(structural_distance)::numeric(5,2) AS avg_distance,
  COUNT(*) FILTER (WHERE llm_called) AS llm_calls,
  AVG(duration_ms)::integer AS avg_duration_ms,
  COUNT(*) FILTER (WHERE enforced) AS enforced_count
FROM phase4_validator_log
GROUP BY 1, 2, 3, 4
ORDER BY 1 DESC, 2, 3, 4;

-- Comment for documentation in psql \d output
COMMENT ON TABLE phase4_validator_log IS
  'Multi-stage edge validator audit trail. Co-designed agent + peer_agent, 2026-05-02. '
  'One row per validateEdge() call. Used to verify shadow-mode signal before '
  'flipping VISION_PHASE4_* flags to on.';
