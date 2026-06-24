-- 053: Felt-threat calibration status view (2026-06-14)
--
-- Purpose: the felt-threat gate now writes outcomes, fingerprints, trace links,
-- and cross-organ feedback. This view gives the brain a read-side status
-- surface so it can tell live calibration from synthetic proof-only state.

BEGIN;

CREATE OR REPLACE VIEW felt_threat_calibration_status AS
SELECT
  agent,
  COUNT(*) AS total_outcomes,
  COUNT(*) FILTER (WHERE is_synthetic IS TRUE) AS synthetic_outcomes,
  COUNT(*) FILTER (WHERE is_synthetic IS NOT TRUE) AS live_outcomes,
  COUNT(*) FILTER (WHERE resolved_at IS NULL) AS unresolved_outcomes,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved_outcomes,
  COUNT(*) FILTER (WHERE action_trace_key IS NOT NULL AND action_trace_key <> '') AS trace_linked_outcomes,
  COUNT(*) FILTER (WHERE last_cross_organ_scan_at IS NOT NULL) AS cross_organ_scanned_outcomes,
  ROUND(AVG(base_false_alarm_probability) FILTER (WHERE base_false_alarm_probability IS NOT NULL), 3) AS avg_base_false_alarm_probability,
  ROUND(AVG(false_alarm_probability) FILTER (WHERE false_alarm_probability IS NOT NULL), 3) AS avg_adjusted_false_alarm_probability,
  MAX(created_at) FILTER (WHERE is_synthetic IS NOT TRUE) AS last_live_outcome_at,
  MAX(created_at) FILTER (WHERE is_synthetic IS TRUE) AS last_synthetic_outcome_at,
  CASE
    WHEN COUNT(*) FILTER (WHERE is_synthetic IS NOT TRUE) = 0 THEN 'synthetic_only'
    WHEN COUNT(*) FILTER (WHERE resolved_at IS NULL AND is_synthetic IS NOT TRUE) > 0 THEN 'live_pending'
    WHEN COUNT(*) FILTER (WHERE last_cross_organ_scan_at IS NOT NULL AND is_synthetic IS NOT TRUE) > 0 THEN 'live_cross_calibrated'
    ELSE 'live_immediate_only'
  END AS calibration_state
FROM felt_threat_outcomes
GROUP BY agent;

COMMENT ON VIEW felt_threat_calibration_status IS
  'Read-side status surface for felt-threat outcome learning: separates live calibration from synthetic proof rows and shows trace/cross-organ coverage.';

COMMIT;

