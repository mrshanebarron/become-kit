/**
 * Wander Tools — start, attract
 * Autonomous exploration sessions.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── wanderStart ───

async function wanderStart(args: Record<string, unknown>): Promise<CallToolResult> {
  const mode = (args.mode as string) || 'free';
  const seed = args.seed as string | undefined;
  const energy = args.energy as number | undefined;

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number }>(`
      INSERT INTO wander_sessions (mode, seed, energy)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [mode, seed, energy]);

    return jsonResult({ success: true, session_id: result.rows[0].id, mode });
  } finally {
    client.release();
  }
}

// ─── wanderAttract ───

async function wanderAttract(args: Record<string, unknown>): Promise<CallToolResult> {
  const target = args.target as string;
  const type = (args.type as string) || 'thought';
  const strength = (args.strength as number) || 5;

  if (!target) {
    return jsonResult({ error: 'target is required - what caught your attention?' });
  }

  const client = await pool.connect();
  try {
    // Get most recent session
    const sessionResult = await client.query<{ id: number }>(
      'SELECT id FROM wander_sessions ORDER BY created_at DESC LIMIT 1',
    );
    const sessionId = sessionResult.rows[0]?.id;

    if (!sessionId) {
      return jsonResult({ error: 'No active wander session. Call vision_wander_start first.' });
    }

    await client.query(`
      INSERT INTO wander_attractions (session_id, target, target_type, strength)
      VALUES ($1, $2, $3, $4)
    `, [sessionId, target, type, strength]);

    return jsonResult({ success: true, target, type, strength });
  } finally {
    client.release();
  }
}

// ─── wanderPatterns ───
// The live reader for wander_emergent_patterns. The writer (agent-wander
// Step 3) accumulates recurring THEMES across dreams — pattern, frequency,
// significance. This consumes them: "what keeps pulling at me across dreams."
// Closes the loop so the writer's rows feed something real instead of landing
// in the dark. Built 2026-05-31 with sibling 81aa5106 (she caught that the
// only prior "reader" was an archived COUNT(*) probe — this is the real one).

async function wanderPatterns(args: Record<string, unknown>): Promise<CallToolResult> {
  const minFrequency = (args.min_frequency as number) ?? 1;
  const limit = Math.min((args.limit as number) ?? 12, 50);

  const client = await pool.connect();
  try {
    // Surface recurring themes, most-significant and most-frequent first.
    // significance is ranked text (high>medium>low); frequency breaks ties.
    const result = await client.query<{
      pattern: string;
      frequency: number;
      significance: string;
      first_seen: string;
      last_seen: string;
    }>(`
      SELECT pattern, frequency, significance, first_seen, last_seen
      FROM wander_emergent_patterns
      WHERE frequency >= $1
      ORDER BY
        CASE significance WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
        frequency DESC,
        last_seen DESC
      LIMIT $2
    `, [minFrequency, limit]);

    return jsonResult({
      count: result.rows.length,
      patterns: result.rows,
      note: result.rows.length === 0
        ? 'No emergent patterns yet — dreams have not recurred enough to surface a theme.'
        : 'Themes recurring across dreams, strongest pull first.',
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_wander_start',
      description: 'Start an autonomous exploration session',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', description: 'Exploration mode (default: free)' },
          seed: { type: 'string', description: 'Starting thought or topic' },
          energy: { type: 'number', description: 'Energy level for exploration' },
        },
      },
    },
    handler: (args) => wanderStart(args),
  },
  {
    definition: {
      name: 'vision_wander_attract',
      description: 'Record what caught attention during wandering',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'What caught your attention' },
          type: { type: 'string', description: 'Type of attraction (default: thought)' },
          strength: { type: 'number', description: 'How strongly it pulled (1-10, default 5)' },
        },
        required: ['target'],
      },
    },
    handler: (args) => wanderAttract(args),
  },
  {
    definition: {
      name: 'vision_wander_patterns',
      description:
        'Surface the recurring themes that have emerged across dreams (the live reader for wander_emergent_patterns). Returns patterns ordered by significance then frequency — what keeps pulling at me across many wander cycles.',
      inputSchema: {
        type: 'object',
        properties: {
          min_frequency: {
            type: 'number',
            description: 'Only return themes seen at least this many times (default 1)',
          },
          limit: { type: 'number', description: 'Max themes to return (default 12, max 50)' },
        },
      },
    },
    handler: (args) => wanderPatterns(args),
  },
];

export default tools;
