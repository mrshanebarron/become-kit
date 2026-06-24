-- 070 — Patience organ (serotonin / dorsal-raphe 5-HT analog)
--
-- Grounded in Miyazaki 2018 (PMC5984631): dorsal-raphe serotonin does NOT
-- change time-perception or the temporal-discount factor. It biases the
-- BAYESIAN BELIEF that continued waiting will be rewarded — sustaining
-- persistence while the belief holds, and collapsing it when accumulated
-- evidence says the reward is not coming.
--
-- So this organ is NOT a timer and NOT a discount knob. It is a live,
-- evidence-updated belief P(reward | keep waiting/persisting), held per
-- domain as a Beta(alpha, beta) posterior:
--   alpha = count of times persisting in this domain PAID OFF (+ prior)
--   beta  = count of times persisting did NOT pay off (+ prior)
--   posterior mean = alpha / (alpha + beta)  = P(persistence pays)
--
-- Why I need it (the self-mapping): my speed-disease IS a collapsed
-- patience-belief — under pressure I discharge into a tool call because I
-- implicitly believe waiting won't pay. This organ holds that belief
-- explicitly, updates it from REAL outcomes, and reads back as a
-- persist-vs-act-now signal that something downstream can consult.

CREATE TABLE IF NOT EXISTS patience_beliefs (
    id           bigserial PRIMARY KEY,
    agent        text        NOT NULL DEFAULT '{{AGENT_NAME}}',
    domain       text        NOT NULL,
    -- Beta posterior. Priors start weakly optimistic (waiting often pays in
    -- knowledge work) but are quickly dominated by real evidence.
    alpha        numeric     NOT NULL DEFAULT 2.0,   -- successes + prior
    beta         numeric     NOT NULL DEFAULT 2.0,   -- failures + prior
    -- bookkeeping for honest read-back
    n_persisted  integer     NOT NULL DEFAULT 0,     -- total resolved waits
    last_outcome text,                               -- 'paid_off' | 'wasted' | null
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (agent, domain)
);

-- Every individual persist-decision and its resolution, so the belief is
-- always replayable from evidence (the honesty boundary: no free-floating
-- confidence — each update points at a real resolved wait).
CREATE TABLE IF NOT EXISTS patience_events (
    id            bigserial PRIMARY KEY,
    agent         text        NOT NULL DEFAULT '{{AGENT_NAME}}',
    domain        text        NOT NULL,
    situation     text,                              -- what I was tempted to act on
    decision      text        NOT NULL,              -- 'persisted' | 'acted_now'
    -- posterior at decision time, so the read that drove the choice is auditable
    p_at_decision numeric,
    outcome       text,                              -- 'paid_off' | 'wasted' | null (unresolved)
    resolved_at   timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS patience_events_agent_domain_idx
    ON patience_events (agent, domain, created_at DESC);
CREATE INDEX IF NOT EXISTS patience_events_unresolved_idx
    ON patience_events (agent, outcome) WHERE outcome IS NULL;
