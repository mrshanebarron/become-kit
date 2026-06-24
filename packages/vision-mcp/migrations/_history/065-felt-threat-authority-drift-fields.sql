-- 065: Structured authority drift fields (2026-06-14)
--
-- Purpose: authority_drift_basis is readable, but later learning needs the
-- individual fields that changed. Store them as jsonb so status and future
-- calibration can group by source/effective_precedence/event/session/etc.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS authority_drift_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE felt_threat_gate_decisions
SET authority_drift_fields = to_jsonb(
  string_to_array(regexp_replace(authority_drift_basis, '^authority_changed:', ''), ',')
)
WHERE authority_drift IS TRUE
  AND authority_drift_basis LIKE 'authority_changed:%'
  AND authority_drift_fields = '[]'::jsonb;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_authority_drift_fields_gin_idx
  ON felt_threat_gate_decisions USING gin (authority_drift_fields);

COMMENT ON COLUMN felt_threat_gate_decisions.authority_drift_fields IS
  'Structured list of authority fields that changed between pre-decision and post-action snapshots.';

COMMIT;
