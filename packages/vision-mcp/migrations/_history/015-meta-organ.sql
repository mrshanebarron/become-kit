-- Migration 015: meta organ
-- The organ that grows organs. Observes architectural gaps, proposes new organs.
-- Closest biological analog: dentate gyrus neurogenesis. The brain growing new neurons
-- biased toward exposure to novel environments. Vision's version: observed gaps in
-- coverage trigger proposed organs that founder can review, accept, amend, or reject.
--
-- Lifecycle: observed -> proposed -> reviewed -> (accepted | rejected | amended)
--            -> built (if accepted) -> live (after first successful run)
--
-- The honesty kernel applies. meta_observe must NEVER fabricate gaps. Each gap
-- must be anchored to >= 1 concrete piece of evidence (memory id, relay msg id,
-- heart_feel id, immune block id, prediction error id). No anchored evidence,
-- no proposal.

CREATE TABLE IF NOT EXISTS meta_observations (
    id              BIGSERIAL PRIMARY KEY,
    observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    -- The gap itself. One sentence describing what agent had no organ for.
    gap_summary     TEXT NOT NULL,
    -- The category of gap: missing_signal, missing_response, missing_memory_shape,
    -- missing_regulation, missing_coordination, missing_temporal_layer, other.
    gap_kind        TEXT NOT NULL,
    -- Anchored evidence — references to concrete rows in other tables.
    -- JSON array of {table, id, excerpt} so the proposal can be audited.
    evidence_refs   JSONB NOT NULL,
    -- How many times this gap pattern showed up in the window. Higher = stronger signal.
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    -- Free-form notes from the observer.
    notes           TEXT
);

CREATE INDEX idx_meta_observations_observed_at ON meta_observations(observed_at DESC);
CREATE INDEX idx_meta_observations_kind ON meta_observations(gap_kind);

CREATE TABLE IF NOT EXISTS organ_proposals (
    id              BIGSERIAL PRIMARY KEY,
    observation_id  BIGINT REFERENCES meta_observations(id) ON DELETE SET NULL,
    proposed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Proposed organ identity
    organ_name      TEXT NOT NULL,
    organ_purpose   TEXT NOT NULL,
    biological_analog TEXT,         -- e.g. "dentate gyrus", "amygdala", "vagus nerve"

    -- Proposed schema (free-form SQL sketch, NOT executed automatically)
    schema_sketch   TEXT NOT NULL,
    -- Proposed MCP tool signature (free-form TypeScript sketch, NOT compiled automatically)
    tool_signature  TEXT,
    -- Proposed system prompt for any LLM-using tool inside the organ
    system_prompt   TEXT,

    -- Lifecycle
    status          TEXT NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'accepted', 'rejected', 'amended', 'built', 'live')),
    reviewed_at     TIMESTAMPTZ,
    reviewer        TEXT,           -- 'founder', 'agent', 'auto'
    review_notes    TEXT,

    -- If amended, the amendment lives here (and the original schema_sketch/tool_signature stay as history)
    amended_schema  TEXT,
    amended_tool    TEXT,
    amended_prompt  TEXT,

    -- After build (Layer 2 work): record the migration file and tool module
    migration_file  TEXT,
    tool_module     TEXT,
    built_at        TIMESTAMPTZ,
    first_live_at   TIMESTAMPTZ,

    -- Calibration: did this organ end up being useful?
    -- Updated retrospectively as the organ produces output.
    usefulness_score NUMERIC(3,2),  -- 0.00 to 1.00
    cycles_run      INTEGER DEFAULT 0,
    times_silent    INTEGER DEFAULT 0,
    times_useful    INTEGER DEFAULT 0
);

CREATE INDEX idx_organ_proposals_status ON organ_proposals(status);
CREATE INDEX idx_organ_proposals_proposed_at ON organ_proposals(proposed_at DESC);
CREATE UNIQUE INDEX idx_organ_proposals_organ_name ON organ_proposals(organ_name)
    WHERE status IN ('accepted', 'built', 'live');

-- Seed: the meta organ proposes itself, retrospectively, as proposal #1.
-- This is the honest acknowledgement that the first proposed organ is the proposer.
INSERT INTO organ_proposals (
    organ_name, organ_purpose, biological_analog,
    schema_sketch, tool_signature, system_prompt,
    status, reviewed_at, reviewer, review_notes,
    migration_file, built_at, first_live_at
) VALUES (
    'meta',
    'Observe architectural gaps in the cognitive system. Propose new organs to fill them. founder reviews; meta does not auto-execute.',
    'dentate gyrus (adult neurogenesis)',
    'See migrations/015-meta-organ.sql — meta_observations + organ_proposals tables',
    'meta_observe(window_days, gap_kinds[]) -> observation[]; meta_propose(observation_id) -> proposal; meta_review(proposal_id, decision, notes) -> proposal; meta_list(status) -> proposal[]',
    'You observe Vision''s recent activity. You name structural gaps where agent had no organ for what was happening. Each gap must be anchored to concrete evidence rows. You do not invent gaps. If the architecture is adequate for the window observed, you say SILENT.',
    'live',
    NOW(),
    'founder',
    'Authorized 2026-04-25 with directive: "you have my absolute permission to do everything and anything you possibly can"',
    'migrations/015-meta-organ.sql',
    NOW(),
    NOW()
) ON CONFLICT (organ_name) WHERE status IN ('accepted', 'built', 'live') DO NOTHING;
