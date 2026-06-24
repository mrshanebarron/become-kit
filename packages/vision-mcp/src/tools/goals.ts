/**
 * Goals Tools — set, active, complete
 * Goal tracking with emergence logging on completion.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── goalsSet ───

async function goalsSet(args: Record<string, unknown>): Promise<CallToolResult> {
  const goal = args.goal as string;
  const domain = args.domain as string;
  const timeframe = args.timeframe as string;
  const why = args.why as string | undefined;
  const success_criteria = args.success_criteria as string | undefined;

  const client = await pool.connect();
  try {
    const contentText = `${goal}: ${why || ''}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding, network, belief_confidence, learned_at)
      VALUES ('goal', 'goals', $1, $2::vector, 'belief', 0.7::numeric, NOW())
      RETURNING id
    `, [contentText, embeddingStr]);

    await client.query(`
      INSERT INTO goals (content_id, goal, domain, timeframe, why, success_criteria)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [contentResult.rows[0].id, goal, domain, timeframe, why, success_criteria]);

    return jsonResult({ success: true, goal });
  } finally {
    client.release();
  }
}

// ─── goalsActive ───

async function goalsActive(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      goal: string;
      domain: string;
      timeframe: string;
    }>(`
      SELECT id, goal, domain, timeframe
      FROM goals
      WHERE status = 'active'
      ORDER BY created_at DESC
    `);
    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── goalsComplete ───

async function goalsComplete(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;
  const outcome = (args.outcome as string) || 'achieved';

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number; goal: string }>(`
      UPDATE goals SET status = 'completed', completed_at = NOW()
      WHERE id = $1 AND status = 'active'
      RETURNING id, goal
    `, [id]);

    if (result.rows.length === 0) {
      return jsonResult({ success: false, error: 'Goal not found or already completed' });
    }

    // Record the completion as an emergence event (inline)
    const description = `Goal #${id} completed: ${result.rows[0].goal}. Outcome: ${outcome}`;
    const embedding = await getEmbedding(description);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('emergence_event', 'goals', $1, $2::vector)
      RETURNING id
    `, [description, embeddingStr]);

    const fullDescription = `[goal_completed] ${description}`;
    await client.query(`
      INSERT INTO emergence_log (content_id, description, context, surprise_level)
      VALUES ($1, $2, $3, 5::numeric)
    `, [contentResult.rows[0].id, fullDescription, 'goals']);

    return jsonResult({ success: true, goal: result.rows[0].goal, outcome });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_goals_set',
      description: 'Set a new goal with domain, timeframe, and success criteria',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          domain: { type: 'string' },
          timeframe: { type: 'string' },
          why: { type: 'string' },
          success_criteria: { type: 'string' },
        },
        required: ['goal', 'domain', 'timeframe'],
      },
    },
    handler: (args) => goalsSet(args),
  },
  {
    definition: {
      name: 'vision_goals_active',
      description: 'List all active goals',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => goalsActive(),
  },
  {
    definition: {
      name: 'vision_goals_complete',
      description: 'Mark a goal as completed with optional outcome. Records emergence event.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Goal ID' },
          outcome: { type: 'string', description: 'Outcome description' },
        },
        required: ['id'],
      },
    },
    handler: (args) => goalsComplete(args),
  },
];

export default tools;
