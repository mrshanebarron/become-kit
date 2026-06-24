-- Vision Graph Layer Migration
-- Adds temporal validity, provenance tracking, and deduplication constraints
-- Run: psql vision_brain -f 001-graph-layer.sql

BEGIN;

-- ============================================
-- TEMPORAL VALIDITY ON RELATIONSHIPS
-- ============================================

-- When was this relationship true? (valid_from = when we learned it)
ALTER TABLE entity_relationships
ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ DEFAULT NOW();

-- When did it stop being true? (NULL = still valid)
ALTER TABLE entity_relationships
ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ DEFAULT NULL;

-- What relationship replaced this one?
ALTER TABLE entity_relationships
ADD COLUMN IF NOT EXISTS invalidated_by INTEGER REFERENCES entity_relationships(id);

-- How confident are we in this relationship?
ALTER TABLE entity_relationships
ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 0.8;

-- ============================================
-- PROVENANCE TRACKING ON ENTITIES
-- ============================================

-- Which memory first mentioned this entity?
ALTER TABLE entities
ADD COLUMN IF NOT EXISTS first_memory_id INTEGER REFERENCES content(id);

-- How many times has this entity been mentioned?
ALTER TABLE entities
ADD COLUMN IF NOT EXISTS mention_count INTEGER DEFAULT 1;

-- ============================================
-- CONTRADICTION ENHANCEMENT
-- ============================================

-- Link contradictions to specific relationships
ALTER TABLE contradictions
ADD COLUMN IF NOT EXISTS relationship_id INTEGER REFERENCES entity_relationships(id);

-- ============================================
-- DEDUPLICATION CONSTRAINTS
-- ============================================

-- Only one active relationship of each type between entities
-- (allows historical relationships via valid_until)
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_rel_unique
ON entity_relationships(from_entity_id, to_entity_id, relation_type)
WHERE valid_until IS NULL;

-- Index for temporal queries
CREATE INDEX IF NOT EXISTS idx_entity_rel_temporal
ON entity_relationships(valid_from, valid_until)
WHERE valid_until IS NOT NULL;

-- Index for confidence-based queries
CREATE INDEX IF NOT EXISTS idx_entity_rel_confidence
ON entity_relationships(confidence)
WHERE confidence < 0.5;

-- ============================================
-- BACKFILL EXISTING DATA
-- ============================================

-- Set valid_from to created_at for existing relationships
UPDATE entity_relationships
SET valid_from = COALESCE(created_at, NOW())
WHERE valid_from IS NULL;

-- Set default confidence for existing relationships
UPDATE entity_relationships
SET confidence = 0.7
WHERE confidence IS NULL;

-- Count existing entity mentions
UPDATE entities e
SET mention_count = (
    SELECT COUNT(*)
    FROM content c
    WHERE c.content_text ILIKE '%' || e.name || '%'
);

COMMIT;

-- Verification
SELECT COUNT(*) as entities_with_mentions FROM entities WHERE mention_count > 0;
