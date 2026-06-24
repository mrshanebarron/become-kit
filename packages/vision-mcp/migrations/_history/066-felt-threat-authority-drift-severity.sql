-- 066: Authority drift severity for felt-threat decisions (2026-06-14)
--
-- Purpose: field-level drift is queryable, but future learning needs salience.
-- Store a passive severity score so source/precedence drift can be separated
-- from lower-risk metadata drift without changing gate behavior.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS authority_drift_severity numeric NOT NULL DEFAULT 0;

UPDATE felt_threat_gate_decisions
SET authority_drift_severity = LEAST(1.0, GREATEST(0.0,
  (CASE WHEN authority_drift_fields ? 'source' THEN 0.35 ELSE 0 END) +
  (CASE WHEN authority_drift_fields ? 'effective_precedence' THEN 0.35 ELSE 0 END) +
  (CASE WHEN authority_drift_fields ? 'active' THEN 0.12 ELSE 0 END) +
  (CASE WHEN authority_drift_fields ? 'event_id' THEN 0.08 ELSE 0 END) +
  (CASE WHEN authority_drift_fields ? 'session_id' THEN 0.06 ELSE 0 END) +
  (CASE WHEN authority_drift_fields ? 'state' THEN 0.08 ELSE 0 END) +
  (CASE WHEN authority_drift_fields ? 'stance' THEN 0.04 ELSE 0 END)
))
WHERE authority_drift IS TRUE;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_authority_drift_severity_idx
  ON felt_threat_gate_decisions (authority_drift_severity DESC, resolved_at DESC);

COMMENT ON COLUMN felt_threat_gate_decisions.authority_drift_severity IS
  'Passive salience score for authority drift; source/effective_precedence changes weigh highest. Does not change gate thresholds.';

COMMIT;
