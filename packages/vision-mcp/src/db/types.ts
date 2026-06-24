/**
 * Typed row interfaces for the become_kit PostgreSQL schema.
 * Derived from the actual database — zero migrations, pure port.
 */

// ─── Core Content ───

export interface ContentRow {
  id: number;
  content_type: string;
  source_system: string;
  content_text: string;
  content_json: Record<string, unknown> | null;
  embedding: string | null; // pgvector stored as string
  created_at: Date;
  updated_at: Date;
  accessed_at: Date | null;
  access_count: number;
  confidence: number;
  superseded_by: number | null;
  why: string | null;
  emotional_intensity: number | null;
  consolidation_strength: number;
  last_reconsolidation: Date | null;
  // Cognitive network fields (v3.0)
  network: 'world' | 'experience' | 'belief' | 'skill';
  learned_at: Date;
  belief_confidence: number | null;
  evidence_count: number;
  last_evidence_at: Date | null;
  skill_success_count: number;
  skill_fail_count: number;
  skill_last_used: Date | null;
  event_at: Date | null;
  revises_belief: number | null;
}

// ─── Graph Layer ───

export interface EntityRow {
  id: number;
  name: string;
  entity_type: string;
  description: string | null;
  created_at: Date;
  last_observed: Date;
  first_memory_id: number | null;
  mention_count: number;
}

export interface EntityRelationshipRow {
  id: number;
  from_entity_id: number;
  relation_type: string;
  to_entity_id: number;
  strength: number;
  created_at: Date;
  valid_from: Date;
  valid_until: Date | null;
  invalidated_by: number | null;
  confidence: number;
}

export interface EntityContentMentionRow {
  id: number;
  entity_id: number;
  content_id: number;
  mention_type: string;
  created_at: Date;
}

// ─── Memory Edges ───

export interface MemoryEdgeRow {
  id: number;
  from_content_id: number;
  to_content_id: number;
  relation_type: string;
  strength: number;
  created_at: Date;
  extracted_by: string;
  emotional_weight: number;
  formation_emotion: string | null;
  formation_intensity: number | null;
}

// ─── State ───

export interface StateRow {
  key: string;
  value: string | null;
  updated_at: Date;
}

// ─── Episodes ───

export interface EpisodeRow {
  id: number;
  content_id: number | null;
  arc_id: number | null;
  title: string;
  beginning: string | null;
  tension: string | null;
  action: string | null;
  outcome: string | null;
  meaning: string | null;
  emotional_arc: string | null;
  created_at: Date;
}

// ─── Generative Predictions ───

export interface GenerativePredictionRow {
  id: number;
  timestamp: Date;
  predicted_content: string;
  predicted_embedding: string | null;
  given_state: string | null;
  temporal_level: number;
  domain: string;
  confidence: number;
  resolved: boolean;
  actual_observation_id: number | null;
  prediction_error: number | null;
  resolved_at: Date | null;
}

// ─── Library ───

export interface LibraryEntryRow {
  id: number;
  content_id: number;
  entry_type: string;
  title: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

// ─── Consolidation Log ───

export interface ConsolidationLogRow {
  id: number;
  phase: string;
  action: string;
  details: Record<string, unknown> | null;
  created_at: Date;
}

// ─── Antibodies ───

export interface AntibodyRow {
  id: number;
  content_id: number;
  pattern: string;
  response: string;
  severity: string;
  created_at: Date;
}

// ─── Tool result types ───

export type CognitiveNetwork = 'world' | 'experience' | 'belief' | 'skill';

export interface SearchResult {
  id: number;
  content_type: string;
  content_text: string;
  content_json: Record<string, unknown> | null;
  confidence: number;
  created_at: Date;
  network: CognitiveNetwork;
  score: number;
  emotional_intensity: number | null;
  consolidation_strength: number;
}

// ToolResult re-exported from MCP SDK — use CallToolResult from server.ts instead.
// Kept here for backward compat during migration.
export type { CallToolResult as ToolResult } from '@modelcontextprotocol/sdk/types.js';
