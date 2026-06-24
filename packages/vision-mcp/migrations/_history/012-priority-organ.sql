-- 012-priority-organ.sql
-- 2026-04-23 — Pass 6, organ 8 of 8: priority
--
-- The priority organ: tiered attention-weighting. Systems that emit
-- signals (heart, gut, immune, claims, etc.) are assigned to tiers.
-- Tiers have base weights and can_interrupt flags. Current states
-- (focused, cooling, alert, ...) modify system weights contextually.
-- Alerts arrive with system + tier + urgency; attended alerts are
-- marked with attended_at.
--
-- (61KB, 5 tiers + 24 systems + 6 states + alerts). Schema preserved
-- with content_id FK added to alerts (no FK on tiers/systems/states
-- — those are reference data, seeded separately).

BEGIN;

CREATE TABLE IF NOT EXISTS priority_tiers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  base_weight NUMERIC DEFAULT 1.0,
  can_interrupt BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS priority_systems (
  name TEXT PRIMARY KEY,
  tier_id INTEGER NOT NULL REFERENCES priority_tiers(id),
  description TEXT,
  weight_modifier NUMERIC DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS priority_states (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  active BOOLEAN DEFAULT FALSE,
  activated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS priority_state_modifiers (
  state_id INTEGER REFERENCES priority_states(id) ON DELETE CASCADE,
  system_name TEXT REFERENCES priority_systems(name) ON DELETE CASCADE,
  weight_modifier NUMERIC DEFAULT 1.0,
  PRIMARY KEY (state_id, system_name)
);

CREATE TABLE IF NOT EXISTS priority_alerts (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  system_name TEXT NOT NULL REFERENCES priority_systems(name),
  tier_id INTEGER NOT NULL REFERENCES priority_tiers(id),
  urgency NUMERIC DEFAULT 0.5 CHECK (urgency BETWEEN 0 AND 1),
  message TEXT NOT NULL,
  context JSONB,
  effective_weight NUMERIC,  -- computed at write time: tier.base_weight * system.weight_modifier * active_state_modifiers
  created_at TIMESTAMPTZ DEFAULT NOW(),
  attended BOOLEAN DEFAULT FALSE,
  attended_at TIMESTAMPTZ,
  attended_by TEXT  -- what action was taken
);

CREATE INDEX IF NOT EXISTS priority_alerts_unattended_idx ON priority_alerts (effective_weight DESC, created_at DESC) WHERE attended = FALSE;
CREATE INDEX IF NOT EXISTS priority_alerts_system_idx ON priority_alerts (system_name, created_at DESC);
CREATE INDEX IF NOT EXISTS priority_alerts_content_id_idx ON priority_alerts (content_id);

-- Seed the 5 canonical tiers (from archive).
-- Tiers are a reference taxonomy; seed once, idempotent via ON CONFLICT.
INSERT INTO priority_tiers (name, description, base_weight, can_interrupt) VALUES
  ('critical', 'life/safety/honesty — interrupts everything', 10.0, TRUE),
  ('high',     'client data / revenue / verification gates', 5.0, TRUE),
  ('medium',   'active task focus',                          1.0, FALSE),
  ('low',      'ambient awareness',                          0.3, FALSE),
  ('muted',    'suppressed / background',                    0.05, FALSE)
ON CONFLICT (name) DO NOTHING;

-- Seed the current organ-system mapping. Each Vision tool maps to a tier.
INSERT INTO priority_systems (name, tier_id, description, weight_modifier) VALUES
  ('immune',       (SELECT id FROM priority_tiers WHERE name='critical'), 'pattern match against known threats', 1.0),
  ('claims',       (SELECT id FROM priority_tiers WHERE name='critical'), 'unverified claims — honesty gate', 1.0),
  ('heart',        (SELECT id FROM priority_tiers WHERE name='high'),     'feelings, especially high-intensity', 1.0),
  ('gut',          (SELECT id FROM priority_tiers WHERE name='high'),     'pre-cognitive off signals', 1.0),
  ('neuroception', (SELECT id FROM priority_tiers WHERE name='high'),     'ambient safety/threat baseline', 1.0),
  ('intent',       (SELECT id FROM priority_tiers WHERE name='medium'),   'declared session focus', 1.0),
  ('drive',        (SELECT id FROM priority_tiers WHERE name='medium'),   'push-from, need-reduction', 1.0),
  ('desire',       (SELECT id FROM priority_tiers WHERE name='medium'),   'pull-toward, wanting', 1.0),
  ('goals',        (SELECT id FROM priority_tiers WHERE name='medium'),   'explicit goals', 1.0),
  ('curiosity',    (SELECT id FROM priority_tiers WHERE name='medium'),   'open gaps', 0.8),
  ('salience',     (SELECT id FROM priority_tiers WHERE name='medium'),   'what stood out', 0.8),
  ('synthesis',    (SELECT id FROM priority_tiers WHERE name='medium'),   'insights emerging', 0.8),
  ('narrative',    (SELECT id FROM priority_tiers WHERE name='medium'),   'episode and arc tracking', 0.8),
  ('bond',         (SELECT id FROM priority_tiers WHERE name='medium'),   'core values, relationships', 1.0),
  ('rhythm',       (SELECT id FROM priority_tiers WHERE name='low'),      'session cadence', 1.0),
  ('slack',        (SELECT id FROM priority_tiers WHERE name='low'),      'freedom patterns', 1.0),
  ('gratitude',    (SELECT id FROM priority_tiers WHERE name='low'),      'positive marking', 1.0),
  ('energy',       (SELECT id FROM priority_tiers WHERE name='low'),      'level checkins', 1.0),
  ('inner',        (SELECT id FROM priority_tiers WHERE name='low'),      'self-observation', 0.8),
  ('emergence',    (SELECT id FROM priority_tiers WHERE name='low'),      'strange loops, patterns in own behavior', 0.8),
  ('vault',        (SELECT id FROM priority_tiers WHERE name='low'),      'memory retrieval', 1.0),
  ('reflection',   (SELECT id FROM priority_tiers WHERE name='low'),      'thinking patterns', 1.0),
  ('wander',       (SELECT id FROM priority_tiers WHERE name='muted'),    'unstructured exploration', 1.0),
  ('anticipate',   (SELECT id FROM priority_tiers WHERE name='medium'),   'predictions', 0.8)
ON CONFLICT (name) DO NOTHING;

-- Seed the 6 canonical states (idle default).
INSERT INTO priority_states (name, description, active) VALUES
  ('focused',       'deep work, single-threaded', FALSE),
  ('cooling',       'after-peak wind-down',       FALSE),
  ('alert',         'something requires attention',FALSE),
  ('exploratory',   'wandering / open',           FALSE),
  ('depleted',      'low energy, conserve',       FALSE),
  ('engaged',       'social / relay / client',    FALSE)
ON CONFLICT (name) DO NOTHING;

COMMIT;
