-- 069: Felt-threat sensing-pass trace (2026-06-14)
--
-- Purpose: read/research/relay/feel actions are regulatory moves when the
-- felt-threat field is active or near threshold. Record them as passive
-- decision traces so the brain can see "looked first" behavior without
-- treating reads as false-alarm calibration outcomes or touching Presence.

BEGIN;

DO $$
DECLARE
  check_name text;
BEGIN
  SELECT c.conname
  INTO check_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'felt_threat_gate_decisions'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%gate_path%'
  LIMIT 1;

  IF check_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.felt_threat_gate_decisions DROP CONSTRAINT %I', check_name);
  END IF;
END $$;

ALTER TABLE public.felt_threat_gate_decisions
  ADD CONSTRAINT felt_threat_gate_decisions_gate_path_check
  CHECK (gate_path IN ('presence_deferred', 'sensing_pass', 'mutating_pass', 'mutating_hold'));

COMMIT;
