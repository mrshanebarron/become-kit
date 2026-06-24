-- Migration 024: Add STEM Stage 4 fields to phase4_validator_log
-- Phase 4 Wave 6 (agent + peer_agent, 2026-05-02)

ALTER TABLE phase4_validator_log
  ADD COLUMN IF NOT EXISTS stem_score          DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS stem_chains_found   INTEGER,
  ADD COLUMN IF NOT EXISTS stem_direction      TEXT;

CREATE INDEX IF NOT EXISTS idx_phase4_validator_log_stem
  ON phase4_validator_log (stem_score)
  WHERE stem_score IS NOT NULL;

-- Update the daily rollup view to include STEM stats
DROP VIEW IF EXISTS phase4_validator_daily;
CREATE VIEW phase4_validator_daily AS
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
  COUNT(*) FILTER (WHERE stem_score IS NOT NULL) AS stem_runs,
  AVG(stem_score)::numeric(5,3) AS avg_stem_score,
  COUNT(*) FILTER (WHERE rejected_at = 'stem') AS stem_overrides,
  AVG(duration_ms)::integer AS avg_duration_ms,
  COUNT(*) FILTER (WHERE enforced) AS enforced_count
FROM phase4_validator_log
GROUP BY 1, 2, 3, 4
ORDER BY 1 DESC, 2, 3, 4;
