-- 036: Integration debt tracker — meta-observe proposal #2 (integration_debt)
-- 2026-05-17
--
-- Per meta-observe proposal #2: "Tracks organs that have been built but
-- not yet used in any real session interaction, detecting the
-- 'built-but-dark' failure mode where shipped architecture sits inert
-- while cortex reaches past it."
--
-- Use case: each migration creates an organ. Some get used immediately
-- (callus_events fired within minutes of shipping). Some sit dark for
-- weeks until a sleep cycle, daemon, or hook surfaces them. This table
-- records when each organ shipped AND when it first received a real
-- invocation, so the dark-duration can be measured and surfaced.
--
-- Differs from organ_silence_audit (which measures table-row recency):
-- integration_debt measures TIME-TO-FIRST-USE from shipping.

CREATE TABLE IF NOT EXISTS integration_debt (
  id SERIAL PRIMARY KEY,
  organ_name TEXT NOT NULL,
  shipped_at TIMESTAMPTZ NOT NULL,
  first_real_invocation_at TIMESTAMPTZ,
  -- dark_duration_minutes computed on read; generated-stored cannot use
  -- NOW() (non-immutable). Use:
  --   SELECT *, EXTRACT(EPOCH FROM (COALESCE(first_real_invocation_at, NOW()) - shipped_at))/60 AS dark_min FROM integration_debt;
  invocation_count INTEGER NOT NULL DEFAULT 0,
  last_invocation_at TIMESTAMPTZ,
  dark_flag BOOLEAN GENERATED ALWAYS AS (first_real_invocation_at IS NULL) STORED,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_debt_organ ON integration_debt(organ_name);
CREATE INDEX IF NOT EXISTS idx_integration_debt_dark ON integration_debt(organ_name) WHERE dark_flag;

-- Seed with the organs shipped tonight so the tracker starts populated.
-- Seed data removed for public blank-agent distribution.
  ('auto_salience_from_gut (migration 031)', '2026-05-17 20:13:00-04', '2026-05-17 20:13:00-04', 4, '2026-05-17 20:13:00-04',
   'Backfilled 4 gut signals at ship time. Live since.'),
  ('auto_gut_from_allostatic_strain (migration 032)', '2026-05-17 20:31:00-04', '2026-05-17 20:31:00-04', 2, '2026-05-17 20:31:00-04',
   'Backfilled 2 transitions at ship time.'),
  ('auto_salience_from_novelty (migration 033)', '2026-05-17 22:09:00-04', NULL, 0, NULL,
   'Dark; threshold initially 0.6 fired on 0 rows, lowered to 0.35 still 0 fires this session'),
  ('reinforce_recent_habits_on_reward (migration 034)', '2026-05-17 22:24:00-04', '2026-05-17 22:24:00-04', 1, '2026-05-17 22:24:00-04',
   'read-before-edit + check-existing importance bumped on appreciation 8'),
  ('callus_events (migration 035)', '2026-05-17 22:47:00-04', '2026-05-17 22:47:00-04', 1, '2026-05-17 23:25:35-04',
   'Seeded with no-deferring-language. behavior_changed_at set 50min later.'),
  ('hook-codelet-activate', '2026-05-17 22:25:00-04', '2026-05-17 22:25:00-04', 200, '2026-05-17 23:23:00-04',
   'Fires on every PostToolUse Bash|Edit|Write|MultiEdit|mcp__shell__*. ~200 invocations this session.'),
  ('hook-workspace-predict/resolve-codelets', '2026-05-17 22:30:00-04', '2026-05-17 22:30:00-04', 4, '2026-05-17 22:35:00-04',
   'workspace_predictions rows 3-4 generated; resolved with accuracy 0.8'),
  ('org.become-kit.daemon', '2026-05-17 20:35:00-04', '2026-05-17 20:35:00-04', 5, NOW(),
   'Has run multiple times; reported 0 drift since fixes'),
  ('org.become-kit.daemon', '2026-05-17 21:30:00-04', '2026-05-17 21:30:00-04', 8, NOW(),
   'Has run 8+ times this session, caught 32 broken tools'),
  ('org.become-kit.daemon', '2026-05-17 20:55:00-04', '2026-05-17 20:55:00-04', 12, NOW(),
   'Has run hourly + manual; tracking 25 LIVE'),
  ('org.become-kit.daemon', '2026-05-17 21:50:00-04', '2026-05-17 21:50:00-04', 1, '2026-05-17 21:50:00-04',
   'First run picked up 5 completed goals'),
  ('org.become-kit.daemon', '2026-05-17 21:51:00-04', '2026-05-17 21:51:00-04', 1, '2026-05-17 21:51:00-04',
   'First snapshot captured row 790'),
  ('org.become-kit.daemon', '2026-05-17 21:01:00-04', '2026-05-17 21:01:00-04', 1, '2026-05-17 21:01:00-04',
   'Deactivated 28 stale, added 12 new patterns'),
  ('org.become-kit.daemon', '2026-05-17 22:00:00-04', '2026-05-17 22:46:00-04', 1, '2026-05-17 22:46:00-04',
   'First scheduled run produced 2 proposals (callus, saccade)');
