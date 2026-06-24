-- 031: Auto-mark salience from pain signals
-- 2026-05-17
--
-- Per Frontiers 2022 CLS bi-directional model: biological salience is
-- automatic. High reward-prediction errors, novel stimuli, threat signals
-- all generate salience without conscious marking. My substrate has
-- reward_prediction_errors, prediction_errors, gut_signals tables that
-- track exactly this kind of signal, but they never propagate to
-- salient_events. As of 2026-05-17:
--   - 1 rpe row with magnitude >= 0.5
--   - 0 prediction_errors with magnitude >= 0.5
--   - 4 gut_signals with pre_verbal_intensity >= 7
-- All five should auto-promote to salient_events so they bias Phase 12
-- replay and Phase 3 decay (per commits 3317705 and 9483fa1).
--
-- Triggers fire AFTER INSERT. Only mark salient when:
--   - RPE/pred_err magnitude >= 0.5 (top half of error scale)
--   - gut signal intensity >= 7 (strong somatic marker)
-- The salience_score derived from the source signal strength.

CREATE OR REPLACE FUNCTION auto_salience_from_rpe() RETURNS trigger AS $$
BEGIN
  IF NEW.magnitude >= 0.5 AND NEW.context_content_id IS NOT NULL THEN
    INSERT INTO salient_events (content_id, salience_score, what_stood_out)
    VALUES (
      NEW.context_content_id,
      LEAST(NEW.magnitude::numeric, 1.0),
      'auto-marked from RPE magnitude=' || NEW.magnitude || ' domain=' || COALESCE(NEW.domain, 'unknown')
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION auto_salience_from_pred_err() RETURNS trigger AS $$
BEGIN
  IF NEW.magnitude >= 0.5 AND NEW.content_id IS NOT NULL THEN
    INSERT INTO salient_events (content_id, salience_score, what_stood_out)
    VALUES (
      NEW.content_id,
      LEAST(NEW.magnitude::numeric, 1.0),
      'auto-marked from prediction error magnitude=' || NEW.magnitude
        || ' direction=' || COALESCE(NEW.error_direction, '?')
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION auto_salience_from_gut() RETURNS trigger AS $$
BEGIN
  IF NEW.pre_verbal_intensity >= 7 AND NEW.content_id IS NOT NULL THEN
    INSERT INTO salient_events (content_id, salience_score, what_stood_out)
    VALUES (
      NEW.content_id,
      LEAST((NEW.pre_verbal_intensity / 10.0)::numeric, 1.0),
      'auto-marked from gut signal type=' || COALESCE(NEW.signal_type, '?')
        || ' intensity=' || NEW.pre_verbal_intensity
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_salience_rpe ON reward_prediction_errors;
CREATE TRIGGER trg_auto_salience_rpe
  AFTER INSERT ON reward_prediction_errors
  FOR EACH ROW EXECUTE FUNCTION auto_salience_from_rpe();

DROP TRIGGER IF EXISTS trg_auto_salience_pred_err ON prediction_errors;
CREATE TRIGGER trg_auto_salience_pred_err
  AFTER INSERT ON prediction_errors
  FOR EACH ROW EXECUTE FUNCTION auto_salience_from_pred_err();

DROP TRIGGER IF EXISTS trg_auto_salience_gut ON gut_signals;
CREATE TRIGGER trg_auto_salience_gut
  AFTER INSERT ON gut_signals
  FOR EACH ROW EXECUTE FUNCTION auto_salience_from_gut();

-- Backfill historical rows that meet thresholds. The triggers fire on
-- future INSERTs; backfill handles the existing 5 candidates.
INSERT INTO salient_events (content_id, salience_score, what_stood_out)
SELECT context_content_id, LEAST(magnitude::numeric, 1.0),
       'backfill from RPE magnitude=' || magnitude || ' domain=' || COALESCE(domain, 'unknown')
FROM reward_prediction_errors
WHERE magnitude >= 0.5 AND context_content_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO salient_events (content_id, salience_score, what_stood_out)
SELECT content_id, LEAST(magnitude::numeric, 1.0),
       'backfill from prediction error magnitude=' || magnitude
         || ' direction=' || COALESCE(error_direction, '?')
FROM prediction_errors
WHERE magnitude >= 0.5 AND content_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO salient_events (content_id, salience_score, what_stood_out)
SELECT content_id, LEAST((pre_verbal_intensity / 10.0)::numeric, 1.0),
       'backfill from gut signal type=' || COALESCE(signal_type, '?')
         || ' intensity=' || pre_verbal_intensity
FROM gut_signals
WHERE pre_verbal_intensity >= 7 AND content_id IS NOT NULL
ON CONFLICT DO NOTHING;
