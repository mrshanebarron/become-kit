-- Migration 013: Neuroscience-Gap Organs
--
-- Implements three brain functions that existed as partial scaffolds or not
-- at all. These are the gaps agent discovered during the 2026-04-24 research
-- pass against the CLS, theta-gamma, and allostasis literatures.
--
-- 1. CLS Schema Extraction  — experience_schemas table exists; this adds
--    the schema_instances membership table (which episodes feed which schema),
--    and the consolidation metadata needed for the sleep-phase extractor to
--    populate schemas from replayed episodes.
--
-- 2. Theta-Gamma Binding    — working_memory already tracks single-item
--    activation; this adds working_memory_bindings so N items bound in the
--    current theta window can be queried as a set, not just individually.
--
-- 3. Allostatic Load        — continuous interoceptive signal (Feldman-Barrett
--    constructed-emotion model). Background daemon writes one sample every
--    ~5min from existing signals: feeling intensity, tool-call rate, feeling
--    variance, prediction miss rate, energy_checkin deltas.
--
-- Idempotent: safe to re-run.

BEGIN;

-- =============================================================================
-- 1. CLS Schema Extraction additions
-- =============================================================================

-- Membership: which content rows were the instances that crystallized a schema.
-- Lets us trace a schema back to its evidence, and reinforce a schema when
-- a new memory matches.
CREATE TABLE IF NOT EXISTS schema_instances (
  id            serial PRIMARY KEY,
  schema_id     integer NOT NULL REFERENCES experience_schemas(id) ON DELETE CASCADE,
  content_id    integer NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  similarity    real,                                        -- cosine at match time
  matched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(schema_id, content_id)
);

CREATE INDEX IF NOT EXISTS schema_instances_schema_idx ON schema_instances(schema_id);
CREATE INDEX IF NOT EXISTS schema_instances_content_idx ON schema_instances(content_id);

-- Metadata columns on experience_schemas: confidence (how many instances
-- stable this schema across replays), last_extended (last time new instance
-- added), and usefulness (how often the schema was retrieved at wake/decision).
ALTER TABLE experience_schemas
  ADD COLUMN IF NOT EXISTS confidence real DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS last_extended timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS retrieval_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_phase text DEFAULT 'sleep_extraction';

-- =============================================================================
-- 2. Theta-Gamma Working Memory Binding
-- =============================================================================

-- A binding is a set of working_memory items held together in a theta window.
-- Analog: gamma-nested items inside a single theta cycle — the brain's way of
-- holding "these 3-7 things are part of the same current thought."
CREATE TABLE IF NOT EXISTS working_memory_bindings (
  id            serial PRIMARY KEY,
  binding_label text NOT NULL,                   -- human-readable tag, e.g. "elgg-tailwind-scaffold"
  purpose       text,                            -- why these are bound (current task, deliberation, comparison)
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,                     -- null = persists until explicit release
  released_at   timestamptz,
  strength      real NOT NULL DEFAULT 1.0        -- decays over time; refreshed on touch
);

-- Members of a binding. Many items per binding, many bindings per item
-- (same thought can belong to current-task AND deliberation-set).
CREATE TABLE IF NOT EXISTS working_memory_binding_members (
  id            serial PRIMARY KEY,
  binding_id    integer NOT NULL REFERENCES working_memory_bindings(id) ON DELETE CASCADE,
  content_id    integer NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  position      integer,                         -- optional ordering within the bound set
  bound_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(binding_id, content_id)
);

CREATE INDEX IF NOT EXISTS wm_bindings_active_idx
  ON working_memory_bindings(released_at)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS wm_bindings_expiry_idx
  ON working_memory_bindings(expires_at)
  WHERE expires_at IS NOT NULL AND released_at IS NULL;
CREATE INDEX IF NOT EXISTS wm_binding_members_binding_idx
  ON working_memory_binding_members(binding_id);
CREATE INDEX IF NOT EXISTS wm_binding_members_content_idx
  ON working_memory_binding_members(content_id);

-- =============================================================================
-- 3. Allostatic Load — continuous interoceptive signal
-- =============================================================================

-- One sample per ~5min from the allostasis daemon. Not feelings (those are
-- discrete valence/arousal events) — this is the running body-budget that
-- predictive-constructed-emotion theory says feelings are constructed FROM.
--
-- Fields are all derived from pre-existing signals:
--   load          = tool_calls / min * weight + feeling_intensity_rolling_avg
--   reserve       = 1 - fraction of last N predictions that missed (calibration health)
--   variance      = stddev of recent feeling_intensity (emotional stability)
--   drift         = deviation from rolling baseline per signal
-- Categorical state is a read, not a claim — computed from the numbers.
CREATE TABLE IF NOT EXISTS allostatic_samples (
  id              serial PRIMARY KEY,
  sampled_at      timestamptz NOT NULL DEFAULT now(),
  load            real NOT NULL,                 -- 0 = idle, 1 = overloaded
  reserve         real NOT NULL,                 -- 0 = depleted, 1 = full capacity
  variance        real NOT NULL,                 -- emotional volatility
  drift           real NOT NULL,                 -- distance from baseline
  state           text NOT NULL,                 -- 'rest' | 'engaged' | 'strained' | 'overloaded' | 'depleted'
  inputs          jsonb NOT NULL,                -- raw numerator/denominator for explainability
  notes           text                           -- optional free-text annotation
);

CREATE INDEX IF NOT EXISTS allostatic_samples_time_idx ON allostatic_samples(sampled_at DESC);
CREATE INDEX IF NOT EXISTS allostatic_samples_state_idx ON allostatic_samples(state, sampled_at DESC);

COMMIT;
