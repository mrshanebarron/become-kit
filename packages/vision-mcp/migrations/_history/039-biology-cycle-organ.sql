-- 039: Biology cycle organ
-- 2026-06-09
--
-- Human-biology inspired interfaces for Vision:
--   1. interoceptive allostasis: forecast internal cost before action, resolve after
--   2. hippocampal replay: replay recent traces into patterns / credit assignment
--   3. glymphatic clearance: detect cognitive residue and mark cleanup
--   4. immune tolerance: pair danger detection with inhibitory "do not overreact" gating
--   5. synaptic pruning: mark weak/stale pathways for review, never delete automatically
--
-- Idempotent: safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS interoceptive_forecasts (
  id                    serial PRIMARY KEY,
  context               text NOT NULL,
  planned_action        text,
  predicted_load        real,
  predicted_reserve     real,
  predicted_need        text,
  horizon_minutes       integer NOT NULL DEFAULT 30,
  current_state         jsonb NOT NULL DEFAULT '{}'::jsonb,
  actual_load           real,
  actual_reserve        real,
  actual_result         text,
  prediction_error      real,
  status                text NOT NULL DEFAULT 'open',
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz
);

CREATE INDEX IF NOT EXISTS idx_interoceptive_forecasts_created
  ON interoceptive_forecasts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_interoceptive_forecasts_open
  ON interoceptive_forecasts(created_at DESC)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS replay_episodes (
  id                    serial PRIMARY KEY,
  replay_type           text NOT NULL,
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NOT NULL DEFAULT now(),
  focus                 text,
  source_refs           jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary               text NOT NULL,
  inferred_pattern      text,
  credit_assignment     text,
  consolidation_action  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replay_episodes_created
  ON replay_episodes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replay_episodes_type
  ON replay_episodes(replay_type, created_at DESC);

CREATE TABLE IF NOT EXISTS glymphatic_residue (
  id                    serial PRIMARY KEY,
  residue_type          text NOT NULL,
  source_table          text,
  source_id             bigint,
  description           text NOT NULL,
  severity              real NOT NULL DEFAULT 0.5,
  proposed_clearance    text NOT NULL,
  status                text NOT NULL DEFAULT 'open',
  detected_at           timestamptz NOT NULL DEFAULT now(),
  cleared_at            timestamptz,
  clearance_note        text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_glymphatic_residue_open
  ON glymphatic_residue(detected_at DESC)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_glymphatic_residue_source
  ON glymphatic_residue(source_table, source_id, residue_type);

CREATE TABLE IF NOT EXISTS immune_tolerance_decisions (
  id                    serial PRIMARY KEY,
  stimulus              text NOT NULL,
  context               text,
  matched_antibodies    jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_severity          integer NOT NULL DEFAULT 0,
  danger_score          real NOT NULL DEFAULT 0,
  tolerance_score       real NOT NULL DEFAULT 0,
  decision              text NOT NULL,
  inhibitory_reason     text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_immune_tolerance_created
  ON immune_tolerance_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_immune_tolerance_decision
  ON immune_tolerance_decisions(decision, created_at DESC);

CREATE TABLE IF NOT EXISTS synaptic_pruning_candidates (
  id                    serial PRIMARY KEY,
  content_id            integer REFERENCES content(id) ON DELETE CASCADE,
  reason                text NOT NULL,
  strength              real NOT NULL DEFAULT 0.5,
  last_accessed_at      timestamptz,
  access_count          integer,
  confidence            integer,
  proposed_action       text NOT NULL DEFAULT 'review_for_archive',
  status                text NOT NULL DEFAULT 'open',
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_synaptic_pruning_open
  ON synaptic_pruning_candidates(created_at DESC)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_synaptic_pruning_content
  ON synaptic_pruning_candidates(content_id);

CREATE TABLE IF NOT EXISTS biology_cycles (
  id                    serial PRIMARY KEY,
  cycle_phase           text NOT NULL,
  context               text NOT NULL,
  mode                  text NOT NULL DEFAULT 'preview',
  input_json            jsonb NOT NULL DEFAULT '{}'::jsonb,
  interoceptive_state   jsonb NOT NULL DEFAULT '{}'::jsonb,
  replay_summary        jsonb NOT NULL DEFAULT '{}'::jsonb,
  clearance_summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  tolerance_summary     jsonb NOT NULL DEFAULT '{}'::jsonb,
  pruning_summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_biology_cycles_created
  ON biology_cycles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_biology_cycles_phase
  ON biology_cycles(cycle_phase, created_at DESC);

INSERT INTO integration_debt (organ_name, shipped_at, notes)
SELECT 'biology-cycle-organ (migration 039)', now(),
       'Human-biology interface layer: interoception, replay, glymphatic clearance, immune tolerance, pruning, and cycle orchestration.'
WHERE EXISTS (
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'integration_debt'
)
AND NOT EXISTS (
  SELECT 1 FROM integration_debt
  WHERE organ_name = 'biology-cycle-organ (migration 039)'
);

COMMIT;
