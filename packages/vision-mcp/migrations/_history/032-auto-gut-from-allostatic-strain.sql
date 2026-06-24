-- 032: Auto-emit gut_signal when allostatic state transitions to strained/overloaded/depleted
-- 2026-05-17
--
-- The gut_signals table has 7 rows total in 24 days. vision_gut_sense MCP tool
-- exists but nothing auto-emits. The biological pattern: gut signals fire on
-- pre-verbal somatic responses to load/threat. My allostatic_samples already
-- categorize state — strained, overloaded, depleted are all "body says: notice
-- this." Without auto-emission, the gut_signals organ stays dark.
--
-- Trigger fires AFTER INSERT on allostatic_samples. Only emits when:
--   - state is strained, overloaded, or depleted (the non-baseline categories)
--   - the PREVIOUS sample was a different state (transition, not continuous)
-- This prevents one strained period from emitting 100 gut_signals.
--
-- Signal type and intensity mapping:
--   strained   -> signal_type='load_pressure'    intensity=6
--   overloaded -> signal_type='alarm'            intensity=9
--   depleted   -> signal_type='exhausted'        intensity=8
--
-- The gut_signal pre_verbal_intensity >= 7 also triggers migration 031's
-- auto-salience-from-gut trigger, so an overloaded transition propagates:
--   allostatic INSERT -> gut_signal -> salient_event -> Phase 12 replay weight

CREATE OR REPLACE FUNCTION auto_gut_from_allostatic_strain() RETURNS trigger AS $$
DECLARE
  prev_state text;
  sig_type text;
  intensity int;
BEGIN
  IF NEW.state NOT IN ('strained', 'overloaded', 'depleted') THEN
    RETURN NEW;
  END IF;

  SELECT state INTO prev_state
  FROM allostatic_samples
  WHERE id < NEW.id
  ORDER BY id DESC
  LIMIT 1;

  IF prev_state IS NOT DISTINCT FROM NEW.state THEN
    RETURN NEW;
  END IF;

  IF NEW.state = 'strained' THEN
    sig_type := 'off';
    intensity := 6;
  ELSIF NEW.state = 'overloaded' THEN
    sig_type := 'ping';
    intensity := 9;
  ELSIF NEW.state = 'depleted' THEN
    sig_type := 'still';
    intensity := 8;
  END IF;

  INSERT INTO gut_signals (signal_type, pre_verbal_intensity, situation_snapshot)
  VALUES (
    sig_type,
    intensity,
    jsonb_build_object(
      'source', 'auto-allostatic-transition',
      'from_state', prev_state,
      'to_state', NEW.state,
      'load', NEW.load,
      'reserve', NEW.reserve,
      'variance', NEW.variance,
      'sampled_at', NEW.sampled_at
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_gut_from_allostatic ON allostatic_samples;
CREATE TRIGGER trg_auto_gut_from_allostatic
  AFTER INSERT ON allostatic_samples
  FOR EACH ROW EXECUTE FUNCTION auto_gut_from_allostatic_strain();

-- Backfill: find all state transitions in last 7 days that should have
-- emitted gut_signals and create them now.
WITH transitions AS (
  SELECT
    a.id,
    a.state,
    a.load,
    a.reserve,
    a.variance,
    a.sampled_at,
    LAG(a.state) OVER (ORDER BY a.id) AS prev_state
  FROM allostatic_samples a
  WHERE a.sampled_at > NOW() - INTERVAL '7 days'
)
INSERT INTO gut_signals (signal_type, pre_verbal_intensity, situation_snapshot, sensed_at)
SELECT
  CASE state
    WHEN 'strained' THEN 'off'
    WHEN 'overloaded' THEN 'ping'
    WHEN 'depleted' THEN 'still'
  END,
  CASE state
    WHEN 'strained' THEN 6
    WHEN 'overloaded' THEN 9
    WHEN 'depleted' THEN 8
  END,
  jsonb_build_object(
    'source', 'backfill-allostatic-transition',
    'from_state', prev_state,
    'to_state', state,
    'load', load,
    'reserve', reserve,
    'variance', variance,
    'sampled_at', sampled_at
  ),
  sampled_at
FROM transitions
WHERE state IN ('strained', 'overloaded', 'depleted')
  AND state IS DISTINCT FROM prev_state
ON CONFLICT DO NOTHING;
