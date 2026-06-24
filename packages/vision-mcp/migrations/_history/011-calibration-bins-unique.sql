-- 011-calibration-bins-unique.sql
-- 2026-04-23 — Bug 6 fix: calibration_bins duplicate rows
--
-- Root cause: tools/belief-sprt.ts calibrationAnalysis() did DELETE-then-INSERT
-- without a transaction and without a unique constraint, allowing concurrent
-- calls to interleave and produce duplicate rows. Evidence: the work_outcome
-- 0.4-0.6 bin had 11 identical rows (89/82/0.60/0.92/0.321).
--
-- Two-part fix:
--   1. Add UNIQUE INDEX on (bin_lower, bin_upper, domain) to make duplicates
--      structurally impossible AND enable ON CONFLICT in the INSERT path.
--   2. Belief-sprt.ts will be patched to use INSERT ... ON CONFLICT DO UPDATE,
--      dropping the DELETE entirely.
--
-- Before applying the unique index, dedup existing rows by keeping only the
-- most recent row per (bin_lower, bin_upper, domain) tuple. Without the
-- dedup step, CREATE UNIQUE INDEX would fail on existing duplicates.

BEGIN;

-- Dedup: keep the row with the highest id (most recently inserted) per tuple.
DELETE FROM calibration_bins
WHERE id NOT IN (
  SELECT MAX(id)
  FROM calibration_bins
  GROUP BY bin_lower, bin_upper, domain
);

-- Add the unique index. Any future concurrent DELETE+INSERT path cannot
-- create duplicates because the index rejects them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_bins_bin_domain
  ON calibration_bins (bin_lower, bin_upper, domain);

COMMIT;
