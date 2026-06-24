-- 022-core-memory.sql
-- Letta-style always-in-context scratchpad for each agent
-- Designed by peer_agent & agent, 2026-05-02

CREATE TABLE IF NOT EXISTS core_memory (
    id SERIAL PRIMARY KEY,
    agent_name VARCHAR(50) NOT NULL UNIQUE,
    memory_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    last_edited TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_editor VARCHAR(50) NOT NULL
);

-- Pre-seed rows for the primary agents
-- Seed data removed for public blank-agent distribution.

-- Seed data removed for public blank-agent distribution.
