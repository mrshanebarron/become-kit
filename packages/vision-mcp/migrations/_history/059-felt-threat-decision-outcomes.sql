-- 059: Resolve felt-threat gate decisions after action (2026-06-14)
--
-- Purpose: the cortical decision trace should not stop at pre-decision. After
-- the action returns, record whether the chosen path succeeded, failed, or
-- changed. This is passive audit metadata, not a calibration write.

BEGIN;

ALTER TABLE felt_threat_gate_decisions
  ADD COLUMN IF NOT EXISTS action_after_decision text,
  ADD COLUMN IF NOT EXISTS action_result text,
  ADD COLUMN IF NOT EXISTS decision_outcome text CHECK (
    decision_outcome IS NULL
    OR decision_outcome IN (
      'action_succeeded_after_decision',
      'action_failed_after_decision',
      'changed_action_after_decision',
      'changed_action_failed_after_decision'
    )
  ),
  ADD COLUMN IF NOT EXISTS outcome_valence numeric CHECK (
    outcome_valence IS NULL OR outcome_valence BETWEEN -1 AND 1
  ),
  ADD COLUMN IF NOT EXISTS after_action_fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS target_overlap numeric CHECK (
    target_overlap IS NULL OR target_overlap BETWEEN 0 AND 1
  ),
  ADD COLUMN IF NOT EXISTS action_similarity numeric CHECK (
    action_similarity IS NULL OR action_similarity BETWEEN 0 AND 1
  ),
  ADD COLUMN IF NOT EXISTS decision_resolution_basis text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

CREATE INDEX IF NOT EXISTS felt_threat_gate_decisions_outcome_idx
  ON felt_threat_gate_decisions (decision_outcome, resolved_at DESC);

COMMIT;
