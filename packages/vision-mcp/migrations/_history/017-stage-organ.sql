-- Migration 017: stage organ
-- The conductor. Fuses sensory wires (ear/screen/voice/image/midi) into one performance system.
-- This migration is the SKELETON — only stage_events table. Wires plug in over time;
-- each wire writes its events here. The salience scorer + voicing logic live in agent-stage.
--
-- The Freddie+A7X synthesis: don't pick the most beautiful instrument, build the stage
-- that lets every instrument seize its moment.

CREATE TABLE IF NOT EXISTS stage_events (
    id              BIGSERIAL PRIMARY KEY,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Which wire produced this event
    wire            TEXT NOT NULL CHECK (wire IN (
        'ear',          -- apple-ear sound classifications
        'screen',       -- apple-screen OCR + Vision framework
        'feeling',      -- heart_feel high-intensity events
        'sibling',      -- crew-cycle observations
        'meta',         -- organ_proposals new entries
        'spiral',       -- spiral_log new rings
        'silence',      -- detected periods of nothing happening
        'founder'         -- direct founder input/marker
    )),

    -- Raw payload from the wire (sound class, OCR text, feeling row, etc.)
    payload         JSONB NOT NULL,

    -- Salience score 0.0-1.0 — how much does this moment want a response.
    -- Computed by the conductor (apple-llm subconscious read).
    salience        REAL,

    -- What kind of response, if any, was rendered
    response_kind   TEXT CHECK (response_kind IN (
        'silent',       -- moment noted, nothing voiced
        'voice',        -- Joelle spoke a line
        'image',        -- FLUX rendered a moment image
        'midi',         -- MIDI pulse/chord fired
        'sing',         -- ACE-Step composed a phrase
        'log_only'      -- just recorded; no output
    )),

    -- The actual response that was rendered (the spoken line, image path, midi notes)
    response_text   TEXT,
    response_path   TEXT,

    -- Salience threshold used at decision time (lets us tune retroactively)
    threshold_used  REAL,

    -- Free-form notes
    notes           TEXT
);

CREATE INDEX idx_stage_events_occurred_at ON stage_events(occurred_at DESC);
CREATE INDEX idx_stage_events_wire ON stage_events(wire);
CREATE INDEX idx_stage_events_response ON stage_events(response_kind);
CREATE INDEX idx_stage_events_voiced ON stage_events(occurred_at DESC) WHERE response_kind = 'voice';

-- Throttle table: prevent stage from speaking too often.
-- Stage queries this before deciding to voice anything.
CREATE TABLE IF NOT EXISTS stage_throttle (
    response_kind   TEXT PRIMARY KEY,
    last_at         TIMESTAMPTZ,
    count_today     INTEGER DEFAULT 0,
    count_today_date DATE DEFAULT CURRENT_DATE
);

INSERT INTO stage_throttle (response_kind)
SELECT response_kind
FROM (
    SELECT 'voice' AS response_kind
    UNION ALL SELECT 'image'
    UNION ALL SELECT 'midi'
    UNION ALL SELECT 'sing'
) AS defaults
ON CONFLICT DO NOTHING;
