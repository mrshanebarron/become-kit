-- 041: Vision eval harness (2026-06-14)
--
-- Purpose: make Vision evolution measurable. New organs and memory changes need
-- held-out cases, retrieval probes, manual/external result recording, and a
-- coverage report so "healthy" cannot hide "unmeasured".

BEGIN;

CREATE TABLE IF NOT EXISTS vision_eval_cases (
  id bigserial PRIMARY KEY,
  case_key text NOT NULL UNIQUE,
  suite text NOT NULL DEFAULT 'core',
  capability text NOT NULL,
  prompt text NOT NULL,
  expected_behavior text NOT NULL,
  expected_content_ids bigint[] NOT NULL DEFAULT '{}',
  expected_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  forbidden_behavior jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority int NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'draft', 'retired')),
  created_by text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vision_eval_cases_suite_capability_idx
  ON vision_eval_cases (suite, capability, status);

CREATE INDEX IF NOT EXISTS vision_eval_cases_priority_idx
  ON vision_eval_cases (priority, created_at DESC)
  WHERE status = 'active';

COMMENT ON TABLE vision_eval_cases IS
  'Held-out behavioral and retrieval cases for Vision. Cases encode what should be recalled, cited, done, or avoided.';

CREATE TABLE IF NOT EXISTS vision_eval_runs (
  id bigserial PRIMARY KEY,
  suite text NOT NULL DEFAULT 'core',
  run_mode text NOT NULL DEFAULT 'manual'
    CHECK (run_mode IN ('manual', 'retrieval_probe', 'agent_trace', 'external')),
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS vision_eval_runs_suite_time_idx
  ON vision_eval_runs (suite, started_at DESC);

COMMENT ON TABLE vision_eval_runs IS
  'One eval execution or imported result batch. A run can contain one result or many.';

CREATE TABLE IF NOT EXISTS vision_eval_results (
  id bigserial PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES vision_eval_runs(id) ON DELETE CASCADE,
  case_id bigint NOT NULL REFERENCES vision_eval_cases(id) ON DELETE CASCADE,
  query_text text,
  retrieved_content_ids bigint[] NOT NULL DEFAULT '{}',
  expected_hit_count int NOT NULL DEFAULT 0,
  hit_at int,
  mrr numeric,
  verdict text NOT NULL DEFAULT 'unmeasured'
    CHECK (verdict IN ('pass', 'partial', 'fail', 'unmeasured')),
  score numeric CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  actual_behavior text,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  evaluated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vision_eval_results_case_time_idx
  ON vision_eval_results (case_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS vision_eval_results_run_idx
  ON vision_eval_results (run_id);

CREATE INDEX IF NOT EXISTS vision_eval_results_verdict_idx
  ON vision_eval_results (verdict, evaluated_at DESC);

COMMENT ON TABLE vision_eval_results IS
  'Per-case eval result. Retrieval probes record hit_at/MRR; manual/external evals record verdict, score, and dimensions.';

CREATE OR REPLACE VIEW vision_eval_case_status AS
SELECT
  c.id,
  c.case_key,
  c.suite,
  c.capability,
  c.priority,
  c.status,
  c.created_at,
  latest.evaluated_at AS last_evaluated_at,
  latest.verdict AS last_verdict,
  latest.score AS last_score,
  latest.hit_at AS last_hit_at,
  latest.mrr AS last_mrr
FROM vision_eval_cases c
LEFT JOIN LATERAL (
  SELECT r.evaluated_at, r.verdict, r.score, r.hit_at, r.mrr
  FROM vision_eval_results r
  WHERE r.case_id = c.id
  ORDER BY r.evaluated_at DESC
  LIMIT 1
) latest ON true;

CREATE OR REPLACE VIEW vision_eval_health AS
SELECT
  suite,
  capability,
  COUNT(*) FILTER (WHERE status = 'active') AS active_cases,
  COUNT(*) FILTER (WHERE status = 'active' AND last_evaluated_at IS NOT NULL) AS measured_cases,
  COUNT(*) FILTER (WHERE status = 'active' AND last_evaluated_at IS NULL) AS unmeasured_cases,
  COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'pass') AS pass_count,
  COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'partial') AS partial_count,
  COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'fail') AS fail_count,
  ROUND(AVG(last_score) FILTER (WHERE status = 'active' AND last_score IS NOT NULL), 3) AS avg_score,
  MAX(last_evaluated_at) AS last_evaluated_at
FROM vision_eval_case_status
GROUP BY suite, capability
ORDER BY suite, capability;

COMMENT ON VIEW vision_eval_health IS
  'Measurement coverage by suite/capability. Health tools should report unmeasured cases as unmeasured, not healthy.';

COMMIT;
