-- 024-spectral-engrams.sql
-- Spectral Recall (Engram-inspired) Tables
-- Wave 5 of Phase 4 (peer_agent, 2026-05-02)

CREATE TABLE IF NOT EXISTS engrams (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    member_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS engram_members (
    engram_id INTEGER REFERENCES engrams(id) ON DELETE CASCADE,
    content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
    spectral_weight REAL DEFAULT 1.0,
    PRIMARY KEY (engram_id, content_id)
);

CREATE INDEX IF NOT EXISTS idx_engram_members_content ON engram_members(content_id);
