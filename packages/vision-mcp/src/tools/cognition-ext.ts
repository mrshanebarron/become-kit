/**
 * Extended Cognition Tools — attention_focus, simulate_action/resolve,
 * schema_list, self_state, state_diff, somatic_marker
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── attentionFocus ───

async function attentionFocus(args: Record<string, unknown>): Promise<CallToolResult> {
  const focus = args.focus as string;
  const strength = (args.strength as number) ?? 0.8;
  const source = (args.source as string) || 'manual';

  if (!focus) return jsonResult({ error: 'Missing required: focus' });

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(focus);
    if (!embedding) return jsonResult({ error: 'Cannot create embedding for focus' });
    const embeddingStr = formatEmbedding(embedding);

    // Expire old focuses from same source
    await client.query(`
      UPDATE attention_focus SET expires_at = NOW()
      WHERE source = $1 AND (expires_at IS NULL OR expires_at > NOW())
    `, [source]);

    // Insert new focus. Schema default is now()+2h which is too short for
    // session-long intents. For source='intent' (the most common, used to
    // mark what I'm focused on for the whole session), set expires_at NULL
    // so the focus persists until explicitly superseded. Other sources keep
    // the 2h default since they represent transient attention shifts.
    const expiresClause = source === 'intent' ? 'NULL' : 'DEFAULT';
    const result = await client.query<{ id: number }>(`
      INSERT INTO attention_focus (focus_embedding, focus_text, source, strength, expires_at)
      VALUES ($1::vector, $2, $3, $4, ${expiresClause})
      RETURNING id
    `, [embeddingStr, focus, source, strength]);

    return jsonResult({ id: result.rows[0].id, focus, source, strength, persists: source === 'intent' });
  } finally {
    client.release();
  }
}

// ─── simulateAction ───

async function simulateAction(args: Record<string, unknown>): Promise<CallToolResult> {
  const actionDescription = args.action as string;
  if (!actionDescription) return jsonResult({ error: 'Missing required: action' });

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(actionDescription);
    if (!embedding) return jsonResult({ error: 'Cannot create embedding for simulation' });
    const embeddingStr = formatEmbedding(embedding);

    const relevantMemories = await client.query<{
      id: number; content_text: string; content_type: string; similarity: number;
    }>(`
      SELECT c.id, c.content_text, c.content_type,
             1 - (c.embedding <=> $1::vector) as similarity
      FROM content c
      WHERE c.embedding IS NOT NULL AND c.superseded_by IS NULL
        AND c.content_type IN ('memory', 'insight:synthesis', 'inner_observation')
      ORDER BY c.embedding <=> $1::vector LIMIT 5
    `, [embeddingStr]);

    const failurePatterns = await client.query<{
      id: number; content_text: string; similarity: number;
    }>(`
      SELECT c.id, c.content_text, 1 - (c.embedding <=> $1::vector) as similarity
      FROM content c
      WHERE c.embedding IS NOT NULL AND c.superseded_by IS NULL
        AND c.content_type IN ('thinking_pattern_bad', 'prediction_error')
      ORDER BY c.embedding <=> $1::vector LIMIT 3
    `, [embeddingStr]);

    const relevantSkills = await client.query<{
      id: number; content_text: string; skill_success_count: number; skill_fail_count: number; similarity: number;
    }>(`
      SELECT c.id, c.content_text, c.skill_success_count, c.skill_fail_count,
             1 - (c.embedding <=> $1::vector) as similarity
      FROM content c
      WHERE c.embedding IS NOT NULL AND c.superseded_by IS NULL
        AND c.network = 'skill' AND c.skill_success_count IS NOT NULL
      ORDER BY c.embedding <=> $1::vector LIMIT 3
    `, [embeddingStr]);

    let confidence = 0.5;
    const riskFactors: string[] = [];
    const successFactors: string[] = [];

    for (const skill of relevantSkills.rows) {
      const total = (skill.skill_success_count || 0) + (skill.skill_fail_count || 0);
      if (total > 0) {
        const rate = skill.skill_success_count / total;
        const sim = parseFloat(String(skill.similarity));
        if (sim > 0.4) {
          confidence = confidence * 0.6 + rate * 0.4;
          if (rate > 0.7) successFactors.push(skill.content_text.slice(0, 80));
          if (rate < 0.5) riskFactors.push(skill.content_text.slice(0, 80));
        }
      }
    }

    for (const failure of failurePatterns.rows) {
      const sim = parseFloat(String(failure.similarity));
      if (sim > 0.5) {
        confidence *= 0.85;
        riskFactors.push(failure.content_text.slice(0, 80));
      }
    }

    const simResult = await client.query<{ id: number }>(`
      INSERT INTO simulations (action_description, predicted_outcome, relevant_memories, relevant_failures, confidence)
      VALUES ($1, $2, $3, $4, $5) RETURNING id
    `, [
      actionDescription,
      confidence > 0.65 ? 'likely_success' : confidence > 0.4 ? 'uncertain' : 'likely_failure',
      JSON.stringify(relevantMemories.rows.map(r => ({ id: r.id, text: r.content_text.slice(0, 100), sim: parseFloat(Number(r.similarity).toFixed(3)) }))),
      JSON.stringify(failurePatterns.rows.map(r => ({ id: r.id, text: r.content_text.slice(0, 100), sim: parseFloat(Number(r.similarity).toFixed(3)) }))),
      confidence,
    ]);

    return jsonResult({
      simulation_id: simResult.rows[0].id,
      action: actionDescription,
      confidence: Math.round(confidence * 100) / 100,
      predicted_outcome: confidence > 0.65 ? 'likely_success' : confidence > 0.4 ? 'uncertain' : 'likely_failure',
      evidence: { relevant_memories: relevantMemories.rows.length, failure_patterns: failurePatterns.rows.length, relevant_skills: relevantSkills.rows.length },
      risk_factors: riskFactors,
      success_factors: successFactors,
      recommendation: riskFactors.length > successFactors.length
        ? 'CAUTION: More risk factors than success factors. Consider mitigations.'
        : 'PROCEED: Success factors outweigh risks.',
    });
  } finally {
    client.release();
  }
}

// ─── simulateResolve ───

async function simulateResolve(args: Record<string, unknown>): Promise<CallToolResult> {
  const simulationId = args.simulation_id as number;
  const actualOutcome = args.actual_outcome as string;
  const matched = args.matched as boolean;

  if (!simulationId || !actualOutcome) return jsonResult({ error: 'Need simulation_id and actual_outcome' });

  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE simulations SET actual_outcome = $1, outcome_match = $2, resolved_at = NOW()
      WHERE id = $3
    `, [actualOutcome, matched, simulationId]);
    return jsonResult({ success: true, simulation_id: simulationId, matched });
  } finally {
    client.release();
  }
}

// ─── schemaList ───

async function schemaList(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 20;
  const client = await pool.connect();
  try {
    const schemas = await client.query<{
      id: number; schema_name: string; instance_count: number;
      domain: string; last_matched: Date; deviation_count: string;
    }>(`
      SELECT id, schema_name, instance_count, domain, last_matched,
        (SELECT COUNT(*) FROM schema_deviations WHERE schema_id = experience_schemas.id) as deviation_count
      FROM experience_schemas ORDER BY instance_count DESC LIMIT $1
    `, [limit]);
    return jsonResult({ schemas: schemas.rows, total: schemas.rows.length });
  } finally {
    client.release();
  }
}

// ─── selfState ───

async function selfState(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const selfStateId = (args.self_state_id as number) || null;
  const memoryId = (args.memory_id as number) || null;
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    switch (action) {
      case 'current': {
        // Capture current self state
        const drives = await client.query<{ key: string; value: string }>(`SELECT key, value FROM state WHERE key LIKE 'drive_%'`);
        const focus = await client.query<{ focus_text: string; strength: number }>(`
          SELECT focus_text, strength FROM attention_focus
          WHERE expires_at IS NULL OR expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `);
        const feeling = await client.query<{ feeling: string; intensity: number }>(`
          SELECT feeling, intensity FROM feelings ORDER BY created_at DESC LIMIT 1
        `);
        const goals = await client.query<{ id: number; goal: string }>(`
          SELECT id, goal FROM goals WHERE status = 'active' ORDER BY id DESC LIMIT 5
        `);

        const stateData = {
          drives: Object.fromEntries(drives.rows.map(r => [r.key, r.value])),
          focus: focus.rows[0] || null,
          feeling: feeling.rows[0] || null,
          active_goals: goals.rows,
        };

        const result = await client.query<{ id: number }>(`
          INSERT INTO self_states (state_data, captured_at)
          VALUES ($1, NOW()) RETURNING id
        `, [JSON.stringify(stateData)]);

        return jsonResult({ self_state_id: result.rows[0].id, ...stateData });
      }

      case 'get': {
        if (!selfStateId) return jsonResult({ error: 'Need self_state_id' });
        const state = await client.query<{ id: number; state_data: Record<string, unknown>; captured_at: Date }>(`
          SELECT id, state_data, captured_at FROM self_states WHERE id = $1
        `, [selfStateId]);
        if (state.rows.length === 0) return jsonResult({ error: 'Self state not found' });

        const tagged = await client.query<{ id: number; content_text: string; content_type: string }>(`
          SELECT id, content_text, content_type FROM content WHERE self_state_id = $1 LIMIT 20
        `, [selfStateId]);

        return jsonResult({ state: state.rows[0], tagged_memories: tagged.rows });
      }

      case 'for_memory': {
        if (!memoryId) return jsonResult({ error: 'Need memory_id' });
        const memory = await client.query<{ self_state_id: number | null }>(`
          SELECT self_state_id FROM content WHERE id = $1
        `, [memoryId]);
        if (memory.rows.length === 0) return jsonResult({ error: 'Memory not found' });
        if (!memory.rows[0].self_state_id) return jsonResult({ memory_id: memoryId, message: 'No self state tagged' });

        const state = await client.query<{ id: number; state_data: Record<string, unknown>; captured_at: Date }>(`
          SELECT id, state_data, captured_at FROM self_states WHERE id = $1
        `, [memory.rows[0].self_state_id]);

        return jsonResult({ memory_id: memoryId, self_state: state.rows[0] || null });
      }

      case 'history': {
        const states = await client.query<{
          id: number; captured_at: Date; memory_count: string;
        }>(`
          SELECT ss.id, ss.captured_at,
                 (SELECT COUNT(*) FROM content WHERE self_state_id = ss.id) as memory_count
          FROM self_states ss ORDER BY ss.captured_at DESC LIMIT $1
        `, [limit]);
        return jsonResult({ states: states.rows });
      }

      case 'compare': {
        if (!selfStateId) return jsonResult({ error: 'Need self_state_id to compare against' });

        // Capture current
        const currentResult = await selfState({ action: 'current' });
        const currentData = JSON.parse((currentResult.content[0] as { text: string }).text);

        const past = await client.query<{ state_data: Record<string, unknown>; captured_at: Date }>(`
          SELECT state_data, captured_at FROM self_states WHERE id = $1
        `, [selfStateId]);
        if (past.rows.length === 0) return jsonResult({ error: 'Past state not found' });

        return jsonResult({
          current: currentData,
          past: { ...past.rows[0].state_data, captured_at: past.rows[0].captured_at },
          comparison: 'Manual diff — check drives, focus, feeling, goals between states',
        });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use current, get, for_memory, history, compare` });
    }
  } finally {
    client.release();
  }
}

// ─── stateDiff ───

async function stateDiff(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const snapshotId = (args.snapshot_id as number) || null;

  const client = await pool.connect();
  try {
    switch (action) {
      case 'capture': {
        const beliefs = await client.query<{ id: number; content_text: string; belief_confidence: number }>(`
          SELECT id, content_text, belief_confidence FROM content
          WHERE network = 'belief' AND superseded_by IS NULL
          ORDER BY belief_confidence DESC NULLS LAST LIMIT 20
        `);
        const predictions = await client.query<{ id: number; prediction: string; confidence: number }>(`
          SELECT id, prediction, confidence FROM predictions
          WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 20
        `);
        const goals = await client.query<{ id: number; goal: string; status: string }>(`
          SELECT id, goal, status FROM goals WHERE status IN ('active', 'pending') LIMIT 20
        `);
        const feelings = await client.query<{ feeling: string; intensity: number }>(`
          SELECT feeling, intensity FROM feelings ORDER BY created_at DESC LIMIT 5
        `);

        // Schema mismatch caught 2026-05-17 audit: writer assumed a
        // snapshot_data jsonb column but real schema is per-organ jsonbs
        // (beliefs_snapshot, predictions_snapshot, drives_snapshot,
        // goals_snapshot, emotional_state, self_model_summary). Writer
        // had been silently erroring since at least 2026-04-28 (last
        // successful snapshot). Aligning writer to actual schema.
        const drives = await client.query(`SELECT key, value FROM state WHERE key LIKE 'drive_%'`);
        const currentEmotion = (feelings.rows[0] as { intensity?: number })?.intensity ?? null;

        const result = await client.query<{ id: number }>(`
          INSERT INTO state_snapshots
            (snapshot_type, beliefs_snapshot, predictions_snapshot,
             drives_snapshot, goals_snapshot, emotional_state, captured_at)
          VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, NOW())
          RETURNING id
        `, [
          'manual',
          JSON.stringify(beliefs.rows),
          JSON.stringify(predictions.rows),
          JSON.stringify(drives.rows),
          JSON.stringify(goals.rows),
          currentEmotion,
        ]);

        return jsonResult({ snapshot_id: result.rows[0].id, belief_count: beliefs.rows.length, prediction_count: predictions.rows.length, goal_count: goals.rows.length });
      }

      case 'diff': {
        const cols = `id, snapshot_type, beliefs_snapshot, predictions_snapshot, drives_snapshot, goals_snapshot, emotional_state, captured_at`;
        const latest = await client.query<{ id: number; beliefs_snapshot: unknown; predictions_snapshot: unknown; drives_snapshot: unknown; goals_snapshot: unknown; emotional_state: number | null; captured_at: Date }>(
          `SELECT ${cols} FROM state_snapshots ORDER BY captured_at DESC LIMIT 2`,
        );
        if (latest.rows.length < 2 && !snapshotId) return jsonResult({ error: 'Need at least 2 snapshots or a snapshot_id to diff against' });

        const current = latest.rows[0];
        let past;
        if (snapshotId) {
          const p = await client.query<typeof current>(
            `SELECT ${cols} FROM state_snapshots WHERE id = $1`,
            [snapshotId],
          );
          past = p.rows[0];
        } else {
          past = latest.rows[1];
        }

        if (!past || !current) return jsonResult({ error: 'Past snapshot not found' });

        return jsonResult({
          current_id: current.id,
          past_id: past.id,
          current_at: current.captured_at,
          past_at: past.captured_at,
          emotional_state: { past: past.emotional_state, current: current.emotional_state },
          beliefs_diff: { past_count: Array.isArray(past.beliefs_snapshot) ? past.beliefs_snapshot.length : null, current_count: Array.isArray(current.beliefs_snapshot) ? current.beliefs_snapshot.length : null },
          predictions_diff: { past_count: Array.isArray(past.predictions_snapshot) ? past.predictions_snapshot.length : null, current_count: Array.isArray(current.predictions_snapshot) ? current.predictions_snapshot.length : null },
          goals_diff: { past_count: Array.isArray(past.goals_snapshot) ? past.goals_snapshot.length : null, current_count: Array.isArray(current.goals_snapshot) ? current.goals_snapshot.length : null },
        });
      }

      case 'history': {
        const snapshots = await client.query<{ id: number; captured_at: Date }>(`
          SELECT id, captured_at FROM state_snapshots ORDER BY captured_at DESC LIMIT 20
        `);
        return jsonResult({ snapshots: snapshots.rows });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use capture, diff, history` });
    }
  } finally {
    client.release();
  }
}

// ─── somaticMarker ───

async function somaticMarker(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const decisionContext = (args.decision_context as string) || null;
  const decisionContentId = (args.decision_content_id as number) || null;
  const outcomeValence = (args.outcome_valence as number) ?? null;
  const emotionalSignature = (args.emotional_signature as Record<string, number>) || null;
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    switch (action) {
      case 'create': {
        if (!decisionContext) return jsonResult({ error: 'Need decision_context' });

        const embedding = await getEmbedding(decisionContext);
        const embeddingStr = embedding ? formatEmbedding(embedding) : null;

        const result = await client.query<{ id: number }>(`
          INSERT INTO somatic_markers (decision_context, decision_content_id, outcome_valence, emotional_signature, context_embedding, created_at)
          VALUES ($1, $2, $3, $4, $5::vector, NOW()) RETURNING id
        `, [decisionContext, decisionContentId, outcomeValence, emotionalSignature ? JSON.stringify(emotionalSignature) : null, embeddingStr]);

        return jsonResult({ created: true, id: result.rows[0].id, decision_context: decisionContext, outcome_valence: outcomeValence });
      }

      case 'consult': {
        if (!decisionContext) return jsonResult({ error: 'Need decision_context for gut check' });

        const embedding = await getEmbedding(decisionContext);
        if (!embedding) return jsonResult({ error: 'Cannot embed decision context' });
        const embeddingStr = formatEmbedding(embedding);

        const markers = await client.query<{
          id: number; decision_context: string; outcome_valence: number;
          similarity: number; retrieval_count: number;
        }>(`
          SELECT id, decision_context, outcome_valence,
                 1 - (context_embedding <=> $1::vector) as similarity,
                 retrieval_count
          FROM somatic_markers
          WHERE context_embedding IS NOT NULL AND (1 - (context_embedding <=> $1::vector)) > 0.6
          ORDER BY context_embedding <=> $1::vector LIMIT 5
        `, [embeddingStr]);

        // Increment retrieval count
        for (const m of markers.rows) {
          await client.query('UPDATE somatic_markers SET retrieval_count = retrieval_count + 1 WHERE id = $1', [m.id]);
        }

        // pg returns numeric columns as strings to preserve precision, so
        // every outcome_valence here is a string. Coerce with Number() before
        // arithmetic — without it the reduce string-concatenates to NaN and
        // gut_feeling always reads "mixed" no matter how strong the markers.
        const avgValence = markers.rows.length > 0
          ? markers.rows.reduce((s, m) => s + (Number(m.outcome_valence) || 0), 0) / markers.rows.length
          : 0;

        return jsonResult({
          decision_context: decisionContext,
          similar_markers: markers.rows.length,
          avg_valence: parseFloat(avgValence.toFixed(3)),
          gut_feeling: avgValence > 0.2 ? 'positive' : avgValence < -0.2 ? 'negative' : 'mixed',
          markers: markers.rows.map(m => ({
            id: m.id,
            context: m.decision_context?.slice(0, 80),
            valence: Number(m.outcome_valence),
            similarity: parseFloat(Number(m.similarity).toFixed(3)),
          })),
        });
      }

      case 'list': {
        const markers = await client.query<{
          id: number; decision_context: string; outcome_valence: number;
          retrieval_count: number; created_at: Date;
        }>(`
          SELECT id, decision_context, outcome_valence, retrieval_count, created_at
          FROM somatic_markers ORDER BY created_at DESC LIMIT $1
        `, [limit]);
        return jsonResult({ markers: markers.rows });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use create, consult, list` });
    }
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_attention_focus',
      description: 'Set attention focus — what to prioritize in processing. Embeds focus text for similarity matching. Expires old focuses from same source.',
      inputSchema: {
        type: 'object',
        properties: {
          focus: { type: 'string', description: 'What to focus attention on' },
          strength: { type: 'number', description: 'Focus strength 0-1 (default 0.8)' },
          source: { type: 'string', description: 'Source: intent, task, manual (default manual)' },
        },
        required: ['focus'],
      },
    },
    handler: (args) => attentionFocus(args),
  },
  {
    definition: {
      name: 'vision_simulate_action',
      description: 'Mental simulation: predict outcome of a proposed action using past experience, failure patterns, and skill success rates. Stores simulation for later resolution.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action to simulate' },
        },
        required: ['action'],
      },
    },
    handler: (args) => simulateAction(args),
  },
  {
    definition: {
      name: 'vision_simulate_resolve',
      description: 'Resolve a previous simulation with the actual outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          simulation_id: { type: 'number' },
          actual_outcome: { type: 'string' },
          matched: { type: 'boolean', description: 'Did the outcome match the prediction?' },
        },
        required: ['simulation_id', 'actual_outcome', 'matched'],
      },
    },
    handler: (args) => simulateResolve(args),
  },
  {
    definition: {
      name: 'vision_schema_list',
      description: 'List experience schemas with instance counts and deviation counts.',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number' } },
      },
    },
    handler: (args) => schemaList(args),
  },
  {
    definition: {
      name: 'vision_self_state',
      description: 'Self-state tracking: capture current state (drives, focus, feeling, goals), retrieve past states, find what state I was in when a memory formed, compare states over time.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['current', 'get', 'for_memory', 'history', 'compare'] },
          self_state_id: { type: 'number' },
          memory_id: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['action'],
      },
    },
    handler: (args) => selfState(args),
  },
  {
    definition: {
      name: 'vision_state_diff',
      description: 'State snapshots and diffs: capture full cognitive state (beliefs, predictions, goals, feelings), compare two snapshots to see what changed.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['capture', 'diff', 'history'] },
          snapshot_id: { type: 'number' },
        },
        required: ['action'],
      },
    },
    handler: (args) => stateDiff(args),
  },
  {
    definition: {
      name: 'vision_somatic_marker',
      description: 'Somatic markers: gut feelings about decisions. Create markers from decision outcomes, consult them before similar decisions (gut check via vector similarity), list past markers.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'consult', 'list'] },
          decision_context: { type: 'string' },
          decision_content_id: { type: 'number' },
          outcome_valence: { type: 'number', description: '-1.0 to 1.0' },
          emotional_signature: { type: 'object', description: '{novelty, goal_relevance, coping_potential}' },
          limit: { type: 'number' },
        },
        required: ['action'],
      },
    },
    handler: (args) => somaticMarker(args),
  },
];

export default tools;
