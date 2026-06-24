-- 033: Auto-mark salience from novelty on content write
-- 2026-05-17
--
-- Per Frontiers 2022 CLS bi-directional model: novel perception generates
-- salience automatically. Hippocampal CA3 detects mismatch between expected
-- and actual via pattern separation. My substrate has novelty columns on
-- dream_journal, insights, feelings, memory_importance — but never computed
-- at content INSERT time.
--
-- Trigger fires AFTER INSERT on content. Scoped:
--   - only content_types where novelty matters (insight/feeling/heart_feel/
--     curiosity_exploration/observation/skill_composition/learned_reflex)
--   - only when embedding is present
--   - compares to last 30 days of same-type content for nearest neighbor
--   - if cosine distance to nearest > 0.6 (i.e. similarity < 0.4), mark salient
--
-- Mirror of migration 031 (pain -> salience). The salience score is the
-- novelty itself (clamped to 0-1).
--
-- Cheap because the WHERE clause restricts to one content_type + 30 day window,
-- and pgvector's ivfflat index handles the nearest-neighbor query.

CREATE OR REPLACE FUNCTION auto_salience_from_novelty() RETURNS trigger AS $$
DECLARE
  nearest_dist real;
  novelty real;
BEGIN
  IF NEW.embedding IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.content_type NOT IN (
    'insight', 'feeling', 'heart_feel', 'curiosity_exploration',
    'observation', 'skill_composition', 'learned_reflex', 'discovery',
    'memory', 'world_observation', 'core_value', 'thinking_pattern',
    'self_model_observation', 'episode'
  ) THEN
    RETURN NEW;
  END IF;

  -- Cosine distance to nearest same-type content row in last 30 days.
  -- pgvector <=> returns cosine distance (1 - cosine_similarity).
  SELECT MIN(c.embedding <=> NEW.embedding) INTO nearest_dist
  FROM content c
  WHERE c.id != NEW.id
    AND c.content_type = NEW.content_type
    AND c.embedding IS NOT NULL
    AND c.learned_at > NOW() - INTERVAL '30 days';

  -- No prior to compare against = max novelty
  IF nearest_dist IS NULL THEN
    novelty := 1.0;
  ELSE
    novelty := LEAST(1.0, GREATEST(0.0, nearest_dist::real));
  END IF;

  -- Calibrated 2026-05-17 same session via 200-row distribution sample:
  -- 0.0(9%) 0.1(10%) 0.2(36%) 0.3(42%) 0.4(2%). Most rows cluster 0.2-0.3.
  -- 0.35 captures top ~5% as genuinely novel.
  IF novelty >= 0.35 THEN
    INSERT INTO salient_events (content_id, salience_score, what_stood_out)
    VALUES (
      NEW.id,
      novelty::numeric,
      'auto-marked from novelty=' || ROUND(novelty::numeric, 3)
        || ' content_type=' || NEW.content_type
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_salience_novelty ON content;
CREATE TRIGGER trg_auto_salience_novelty
  AFTER INSERT ON content
  FOR EACH ROW EXECUTE FUNCTION auto_salience_from_novelty();
