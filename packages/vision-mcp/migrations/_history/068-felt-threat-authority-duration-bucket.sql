-- 068: Authority observation duration buckets (2026-06-14)
--
-- Purpose: duration in milliseconds is precise but hard to scan. Bucket the
-- decision-to-resolution window so later reads can separate reflex-scale,
-- brief, sustained, and extended authority changes.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS authority_observation_duration_bucket text;

UPDATE felt_threat_gate_decisions
SET authority_observation_duration_bucket = CASE
  WHEN authority_observation_duration_ms IS NULL THEN NULL
  WHEN authority_observation_duration_ms < 250 THEN 'reflex'
  WHEN authority_observation_duration_ms < 2000 THEN 'brief'
  WHEN authority_observation_duration_ms < 30000 THEN 'sustained'
  ELSE 'extended'
END
WHERE authority_observation_duration_bucket IS NULL
  AND authority_observation_duration_ms IS NOT NULL;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_authority_duration_bucket_idx
  ON felt_threat_gate_decisions (authority_observation_duration_bucket, resolved_at DESC)
  WHERE authority_observation_duration_bucket IS NOT NULL;

COMMENT ON COLUMN felt_threat_gate_decisions.authority_observation_duration_bucket IS
  'Bucket for authority observation duration: reflex <250ms, brief <2s, sustained <30s, extended >=30s.';

COMMIT;
