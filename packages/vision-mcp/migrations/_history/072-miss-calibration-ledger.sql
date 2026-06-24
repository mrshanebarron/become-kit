-- 072 — Miss-calibration ledger (durable idempotency for the persistence executor)
--
-- The persistence executor (persistMissCalibration) is the FIRST DB-write in the
-- predict→evaluate loop: when review_prediction_miss promotes a real prediction
-- miss, it punishes my own patience/RPE organs (patience 'wasted' → belief
-- collapses toward act_now; negative RPE). This is exactly where the disease
-- could be re-encoded BACKWARDS through a careless write, so the write is
-- falsified-first AND idempotency must survive process restarts and replays —
-- the planner's in-memory lastPlanKey is not enough for a durable mutation.
--
-- This ledger is that durable guard. The executor INSERTs the composite
-- idempotency key (assertion-identity + actual-observation-identity hash, the
-- same key planMissCalibration computes — peer_agent's composite-key sharpening,
-- 2026-06-14) inside the SAME transaction as the patience/RPE writes, with
-- ON CONFLICT (key) DO NOTHING. Zero rows inserted = this exact miss has already
-- been punished → abort the punishment, write nothing else. The guard is shared
-- across BOTH organ writes, not coupled to one organ's table.
--
-- A row here is a permanent record that "this assertion+observation miss was
-- calibrated once" — the audit trail that makes the punishment replay-safe.
--
-- 2026-06-15, persistence executor (the first WRITE in the loop), falsified-first.

CREATE TABLE IF NOT EXISTS miss_calibrations (
    id              bigserial   PRIMARY KEY,
    agent           text        NOT NULL DEFAULT '{{AGENT_NAME}}',
    -- Composite idempotency key: sha256(assertion identity + observation identity),
    -- exactly what planMissCalibration.idempotency_key returns. UNIQUE so two
    -- DIFFERENT misses in one domain BOTH record (distinct keys), but the SAME
    -- assertion+observation calibrated twice collides and the 2nd is a no-op.
    key             text        NOT NULL,
    domain          text        NOT NULL,
    -- what the executor actually wrote, for audit (never trusted for dedup —
    -- the key is the guard).
    patience_outcome text       NOT NULL,              -- 'wasted' (direction guard: never 'paid_off')
    rpe_delta       numeric     NOT NULL,              -- negative (direction guard: never > 0)
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent, key)
);

CREATE INDEX IF NOT EXISTS miss_calibrations_domain_idx
    ON miss_calibrations (agent, domain, created_at DESC);
