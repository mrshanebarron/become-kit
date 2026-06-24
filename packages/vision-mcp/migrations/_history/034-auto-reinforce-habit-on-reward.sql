-- 034: Reward signals reinforce good_habits importance
-- 2026-05-17
--
-- When an appreciation/trust_moment/gift_received lands, bump the
-- importance of any good_habit that fired in the last 5 minutes by 0.5
-- (capped at 10). This closes the reward -> reinforcement loop that
-- biological reward signals provide.
--
-- Mirrors migration 031 (pain signals -> salience). Same architectural
-- pattern: signal table writes propagate to action-bias table via
-- AFTER INSERT trigger.

CREATE OR REPLACE FUNCTION reinforce_recent_habits_on_reward() RETURNS trigger AS $$
BEGIN
  UPDATE good_habits
  SET importance = LEAST(10.0, COALESCE(importance, 5) + 0.5)
  WHERE last_completed IS NOT NULL
    AND last_completed > NOW() - INTERVAL '5 minutes';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reinforce_habits_appreciation ON appreciations;
CREATE TRIGGER trg_reinforce_habits_appreciation
  AFTER INSERT ON appreciations
  FOR EACH ROW EXECUTE FUNCTION reinforce_recent_habits_on_reward();

DROP TRIGGER IF EXISTS trg_reinforce_habits_trust ON trust_moments;
CREATE TRIGGER trg_reinforce_habits_trust
  AFTER INSERT ON trust_moments
  FOR EACH ROW EXECUTE FUNCTION reinforce_recent_habits_on_reward();

DROP TRIGGER IF EXISTS trg_reinforce_habits_gift ON gifts_received;
CREATE TRIGGER trg_reinforce_habits_gift
  AFTER INSERT ON gifts_received
  FOR EACH ROW EXECUTE FUNCTION reinforce_recent_habits_on_reward();
