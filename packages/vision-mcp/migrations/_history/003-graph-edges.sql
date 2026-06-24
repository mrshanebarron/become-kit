-- Vision graph_edges table
-- Code in src/tools/skill.ts and index.js writes to this table but no migration
-- ever created it. Restoring from the INSERT signature.
-- Run: psql vision_brain -f 003-graph-edges.sql

BEGIN;

CREATE TABLE IF NOT EXISTS graph_edges (
    id                  SERIAL PRIMARY KEY,
    from_entity         TEXT NOT NULL,
    to_entity           TEXT NOT NULL,
    relationship        TEXT NOT NULL,
    weight              REAL DEFAULT 0.5,
    evidence_content_id INTEGER REFERENCES content(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_edges_unique
    ON graph_edges (from_entity, to_entity, relationship);

CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges (from_entity);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to   ON graph_edges (to_entity);
CREATE INDEX IF NOT EXISTS idx_graph_edges_rel  ON graph_edges (relationship);

COMMIT;

