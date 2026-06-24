-- Migration 014: Neuroscience-Gap Organs, Pass 2
--
-- Yesterday's pass (013) filled CLS schemas, theta-gamma binding, allostatic load.
-- Today's pass audits the 2025-2026 computational-neuroscience literature against
-- Vision's current organ coverage and fills three more genuine gaps:
--
-- 1. Locus Coeruleus / Norepinephrine gain modulation  — the brainstem "unexpected
--    uncertainty" interrupt. Transient LC firing sets a global neural_gain that
--    scales learning rate and salience weighting in other organs. Phasic pulses
--    on big surprise; tonic baseline from recent volatility. Dayan-Yu 2005 model.
--
-- 2. Reward Prediction Error (RPE) as first-class teaching signal. Phasic dopamine
--    computes δ = observed − expected on goal/desire/action completion. desire.ts
--    tracks wanting-vs-liking phenomenology; this adds the clean scalar δ that
--    credit-assignment across the cortico-striatal loop needs.
--
-- 3. Cerebellar forward model per tool-call. Predict the outcome of a tool
--    invocation before firing it, record the actual, compare. Aggregate per-tool
--    calibration over time. Wolpert-Kawato internal-model architecture.
--
-- Idempotent: safe to re-run.

BEGIN;

-- =============================================================================
-- 1. Locus Coeruleus / Norepinephrine — neural gain modulation
-- =============================================================================

-- Each row = a gain sample at a moment in time. Organs that want the current
-- gain read the most-recent non-expired sample. Phasic = transient pulse from
-- surprise; tonic = rolling baseline. Both share the table; mode distinguishes.
CREATE TABLE IF NOT EXISTS lc_samples (
  id                  serial PRIMARY KEY,
  sampled_at          timestamptz NOT NULL DEFAULT now(),
  gain                real NOT NULL,                 -- 0.5 (depressed) to 2.0 (hyper-aroused); 1.0 neutral
  mode                text NOT NULL,                 -- 'tonic' | 'phasic'
  ttl_seconds         integer NOT NULL DEFAULT 300,  -- how long this sample is "current"
  decay_half_life     real,                          -- optional exponential decay; null = step function
  trigger_content_id  integer REFERENCES content(id) ON DELETE SET NULL,  -- the surprise/event that caused this
  trigger_source      text,                          -- 'prediction_miss' | 'allostatic_spike' | 'manual' | 'cerebellar_miss' | 'tonic_update'
  reason              text,                          -- human-readable "why the dial moved"
  inputs              jsonb                          -- raw signals (surprise delta, prior, posterior, etc)
);

CREATE INDEX IF NOT EXISTS lc_samples_time_idx ON lc_samples(sampled_at DESC);
CREATE INDEX IF NOT EXISTS lc_samples_mode_idx ON lc_samples(mode, sampled_at DESC);
CREATE INDEX IF NOT EXISTS lc_samples_active_idx
  ON lc_samples(sampled_at DESC)
  WHERE mode = 'phasic';

-- =============================================================================
-- 2. Reward Prediction Error — phasic dopamine teaching signal
-- =============================================================================

-- Each row = one δ (delta) event. Computed on goal-complete, desire-satisfy,
-- or explicit action resolution. δ > 0 = positive surprise (do more of this);
-- δ < 0 = negative surprise (update expectations downward).
CREATE TABLE IF NOT EXISTS reward_prediction_errors (
  id                 serial PRIMARY KEY,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  source_type        text NOT NULL,                  -- 'goal' | 'desire' | 'action' | 'work_opportunity' | 'manual'
  source_id          integer,                        -- id in source table (goals.id, desires.id, etc); null for manual
  source_label       text,                           -- human-readable "what completed"
  expected_value     real NOT NULL,                  -- 0..1, prior expectation
  observed_value     real NOT NULL,                  -- 0..1, actual outcome
  delta              real NOT NULL,                  -- observed − expected; signed
  magnitude          real NOT NULL,                  -- abs(delta); for quick sorting by "surprising"
  domain             text,                           -- optional domain tag (work-domain, vision-build, client-comms, etc)
  context_content_id integer REFERENCES content(id) ON DELETE SET NULL,
  credited_beliefs   jsonb DEFAULT '[]'::jsonb,      -- array of belief_ids whose confidence should be nudged
  credited_actions   jsonb DEFAULT '[]'::jsonb,      -- array of action descriptors (tool calls, decisions)
  notes              text
);

CREATE INDEX IF NOT EXISTS rpe_time_idx ON reward_prediction_errors(computed_at DESC);
CREATE INDEX IF NOT EXISTS rpe_source_idx ON reward_prediction_errors(source_type, source_id);
CREATE INDEX IF NOT EXISTS rpe_domain_idx ON reward_prediction_errors(domain, computed_at DESC);
CREATE INDEX IF NOT EXISTS rpe_magnitude_idx ON reward_prediction_errors(magnitude DESC);

-- =============================================================================
-- 3. Cerebellar Forward Model — per-tool-call prediction
-- =============================================================================

-- Each row = one prediction-before-action paired with its actual outcome.
-- The cerebellar analog: predict sensory consequence of motor command, compare
-- afterward, aggregate error over time to improve the inverse model. Here the
-- "motor command" is a tool invocation; the "sensory consequence" is the
-- tool result summary.
CREATE TABLE IF NOT EXISTS forward_predictions (
  id                 serial PRIMARY KEY,
  predicted_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  tool_name          text NOT NULL,                  -- 'Edit', 'Bash', 'vision_heart_feel', etc
  args_summary       text,                           -- short hash or gist of args; not full payload
  predicted_outcome  text NOT NULL,                  -- one-line prediction
  actual_outcome     text,                           -- one-line actual result
  match_score        real,                           -- 0..1; null until resolved
  surprise           real,                           -- 1 − match_score
  notes              text
);

CREATE INDEX IF NOT EXISTS forward_predictions_time_idx ON forward_predictions(predicted_at DESC);
CREATE INDEX IF NOT EXISTS forward_predictions_tool_idx ON forward_predictions(tool_name, predicted_at DESC);
CREATE INDEX IF NOT EXISTS forward_predictions_unresolved_idx
  ON forward_predictions(predicted_at DESC)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS forward_predictions_surprise_idx
  ON forward_predictions(surprise DESC)
  WHERE surprise IS NOT NULL;

COMMIT;
