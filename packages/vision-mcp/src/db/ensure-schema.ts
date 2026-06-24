/**
 * Auto-initialize schema — runs on server startup.
 * All statements are idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 * Ensures emotional memory, episodic, and cognitive tables exist.
 */
import { pool } from './pool.js';

export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE content
      ADD COLUMN IF NOT EXISTS emotional_intensity REAL DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS consolidation_strength REAL DEFAULT 1.0,
      ADD COLUMN IF NOT EXISTS last_reconsolidation TIMESTAMP WITH TIME ZONE DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS sprt_log_ratio NUMERIC DEFAULT 0,
      ADD COLUMN IF NOT EXISTS sprt_status TEXT DEFAULT 'accumulating'
    `);

    await client.query(`
      ALTER TABLE memory_edges
      ADD COLUMN IF NOT EXISTS emotional_weight REAL DEFAULT 0.0,
      ADD COLUMN IF NOT EXISTS formation_emotion TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS formation_intensity INTEGER DEFAULT NULL
    `);

    const tables = [
      `CREATE TABLE IF NOT EXISTS emotional_consolidation_events (
        id SERIAL PRIMARY KEY,
        content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
        trigger_feeling_id INTEGER,
        original_intensity REAL,
        consolidation_factor REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS prediction_errors (
        id SERIAL PRIMARY KEY,
        content_id INTEGER REFERENCES content(id),
        expected TEXT, actual TEXT, error_direction TEXT,
        magnitude NUMERIC, learning TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS state_snapshots (
        id SERIAL PRIMARY KEY,
        snapshot_type TEXT NOT NULL DEFAULT 'session_end',
        beliefs_snapshot JSONB, predictions_snapshot JSONB,
        drives_snapshot JSONB, goals_snapshot JSONB,
        emotional_state JSONB, self_model_summary TEXT,
        captured_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS state_deltas (
        id SERIAL PRIMARY KEY,
        from_snapshot_id INT REFERENCES state_snapshots(id),
        to_snapshot_id INT REFERENCES state_snapshots(id),
        beliefs_changed JSONB, predictions_resolved JSONB,
        drives_shifted JSONB, goals_completed JSONB,
        net_valence NUMERIC, narrative_summary TEXT,
        computed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS somatic_markers (
        id SERIAL PRIMARY KEY,
        decision_context TEXT NOT NULL,
        decision_content_id INT REFERENCES content(id),
        outcome_valence NUMERIC, emotional_signature JSONB,
        marker_strength NUMERIC DEFAULT 0.5,
        retrieval_count INT DEFAULT 0,
        last_triggered TIMESTAMP WITH TIME ZONE,
        context_embedding vector(768),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS episodes (
        id SERIAL PRIMARY KEY,
        title TEXT, summary TEXT, domain TEXT,
        emotional_arc JSONB, outcome TEXT, key_entities TEXT[],
        boundary_start_id INT REFERENCES content(id),
        boundary_end_id INT REFERENCES content(id),
        memory_count INT DEFAULT 0,
        peak_intensity NUMERIC DEFAULT 0,
        avg_intensity NUMERIC DEFAULT 0,
        episode_embedding vector(768),
        consolidated BOOLEAN DEFAULT false,
        consolidated_to INT REFERENCES content(id),
        session_id TEXT,
        started_at TIMESTAMP WITH TIME ZONE,
        ended_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS episode_members (
        id SERIAL PRIMARY KEY,
        episode_id INT REFERENCES episodes(id) ON DELETE CASCADE,
        content_id INT REFERENCES content(id),
        sequence_order INT,
        is_boundary BOOLEAN DEFAULT false,
        boundary_type TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(episode_id, content_id)
      )`,
      `CREATE TABLE IF NOT EXISTS episode_boundaries (
        id SERIAL PRIMARY KEY,
        content_id INT REFERENCES content(id),
        previous_content_id INT REFERENCES content(id),
        semantic_distance NUMERIC,
        prediction_error NUMERIC DEFAULT 0,
        topic_shift_score NUMERIC,
        boundary_strength NUMERIC,
        boundary_type TEXT DEFAULT 'topic_shift',
        detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS calibration_bins (
        id SERIAL PRIMARY KEY,
        bin_lower NUMERIC NOT NULL, bin_upper NUMERIC NOT NULL,
        domain TEXT DEFAULT 'all',
        total_predictions INT DEFAULT 0,
        correct_predictions INT DEFAULT 0,
        avg_confidence NUMERIC DEFAULT 0,
        actual_accuracy NUMERIC DEFAULT 0,
        ece_contribution NUMERIC DEFAULT 0,
        last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS counterfactual_analyses (
        id SERIAL PRIMARY KEY,
        prediction_id INT REFERENCES predictions(id),
        episode_id INT REFERENCES episodes(id),
        original_outcome TEXT,
        counterfactual_question TEXT NOT NULL,
        candidate_explanations JSONB,
        best_explanation TEXT,
        explanation_confidence NUMERIC,
        mutable_factors TEXT[], immutable_factors TEXT[],
        corrective_intention TEXT,
        analyzed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS core_memory (
        id SERIAL PRIMARY KEY,
        agent_name VARCHAR(50) NOT NULL UNIQUE,
        memory_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        version INTEGER NOT NULL DEFAULT 1,
        last_edited TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_editor VARCHAR(50) NOT NULL
      )`,
    ];

    for (const sql of tables) {
      await client.query(sql);
    }

    await client.query(`
      ALTER TABLE content ADD COLUMN IF NOT EXISTS episode_id INT REFERENCES episodes(id)
    `);

    // Seed core_memory
    await client.query(`
      INSERT INTO core_memory (agent_name, memory_json, last_editor)
      VALUES (
          'the agent',
          '{"active_intent": "Establishing core memory", "current_tasks": [], "recent_discoveries": [], "open_questions": [], "working_bindings": []}'::jsonb,
          'system'
      ) ON CONFLICT (agent_name) DO NOTHING;
    `);
    await client.query(`
      INSERT INTO core_memory (agent_name, memory_json, last_editor)
      VALUES (
          'the agent',
          '{"active_intent": "Establishing core memory", "current_tasks": [], "recent_discoveries": [], "open_questions": [], "working_bindings": []}'::jsonb,
          'system'
      ) ON CONFLICT (agent_name) DO NOTHING;
    `);

    console.error('Schema initialization complete — all tables verified');
  } finally {
    client.release();
  }
}
