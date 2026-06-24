-- Shared Library Database Schema
-- Database: vision_shared
-- Purpose: Shared knowledge base accessible by both agent and peer_agent
-- Non-personal reference material: patterns, research, procedures, client knowledge

CREATE TABLE IF NOT EXISTS shared_content (
  id SERIAL PRIMARY KEY,
  content_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_text TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  source_ref TEXT,
  author TEXT NOT NULL,
  embedding vector(1536),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  accessed_at TIMESTAMPTZ DEFAULT now(),
  access_count INTEGER DEFAULT 0,

  CONSTRAINT unique_source UNIQUE (content_type, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_shared_embedding ON shared_content USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_shared_type ON shared_content (content_type);
CREATE INDEX IF NOT EXISTS idx_shared_tags ON shared_content USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_shared_text_search ON shared_content USING gin (to_tsvector('english', title || ' ' || content_text));
CREATE INDEX IF NOT EXISTS idx_shared_text_trgm ON shared_content USING gin (content_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_shared_source ON shared_content (source_ref);
CREATE INDEX IF NOT EXISTS idx_shared_created ON shared_content (created_at DESC);
