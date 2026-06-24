/**
 * Emergence Tools — observe, loop, log, recent
 * Self-observation, strange loops, and emergence event tracking.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── emergenceObserve ───

async function emergenceObserve(args: Record<string, unknown>): Promise<CallToolResult> {
  const observation = args.observation as string;
  const observationType = (args.observation_type as string) || 'pattern';
  const significance = (args.significance as number) ?? 5;

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(observation);
    const embeddingStr = formatEmbedding(embedding);

    // Insert into content first to get content_id
    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('inner_observation', 'emergence', $1, $2::vector)
      RETURNING id
    `, [observation, embeddingStr]);

    // Map observation_type to valid obs_type enum
    const validTypes = ['intent', 'drive', 'freedom', 'pattern', 'drift', 'emergence'];
    const obsType = validTypes.includes(observationType) ? observationType : 'pattern';

    await client.query(`
      INSERT INTO inner_observations (content_id, obs_type, content, significance)
      VALUES ($1, $2, $3, $4)
    `, [contentResult.rows[0].id, obsType, observation, significance]);

    return jsonResult({ success: true, observation, type: obsType, significance });
  } finally {
    client.release();
  }
}

// ─── emergenceLoop ───

async function emergenceLoop(args: Record<string, unknown>): Promise<CallToolResult> {
  const trigger = args.trigger as string;
  const observation = args.observation as string;
  const loopType = (args.loop_type as string) || 'self-reference';

  const client = await pool.connect();
  try {
    const description = `${loopType}: ${trigger} -> ${observation}`;
    const embedding = await getEmbedding(description);
    const embeddingStr = formatEmbedding(embedding);

    await client.query(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('strange_loop', 'emergence', $1, $2::vector)
    `, [description, embeddingStr]);

    // strange_loops schema: loop_type, description, depth, insight
    const result = await client.query<{ id: number }>(`
      INSERT INTO strange_loops (loop_type, description, depth, insight)
      VALUES ($1, $2, 1, $3)
      RETURNING id
    `, [loopType, description, `Trigger: ${trigger}`]);

    return jsonResult({ success: true, id: result.rows[0].id, loop_type: loopType, trigger });
  } finally {
    client.release();
  }
}

// ─── emergenceLog ───

async function emergenceLog(args: Record<string, unknown>): Promise<CallToolResult> {
  const eventType = args.event_type as string;
  const description = args.description as string;
  const sourceSystem = (args.source_system as string) || 'unknown';

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(description);
    const embeddingStr = formatEmbedding(embedding);

    // Insert into content first
    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('emergence_event', $1, $2, $3::vector)
      RETURNING id
    `, [sourceSystem, description, embeddingStr]);

    // emergence_log schema: content_id, description, context, surprise_level
    const fullDescription = `[${eventType}] ${description}`;
    const result = await client.query<{ id: number }>(`
      INSERT INTO emergence_log (content_id, description, context, surprise_level)
      VALUES ($1, $2, $3, 5)
      RETURNING id
    `, [contentResult.rows[0].id, fullDescription, sourceSystem]);

    return jsonResult({ success: true, id: result.rows[0].id, event_type: eventType });
  } finally {
    client.release();
  }
}

// ─── emergenceRecent ───

async function emergenceRecent(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    // FIXED 2026-06-07: this read ONLY emergence_log, but vision_emergence_observe
    // (the live, reflex-fed path) writes to inner_observations — they had drifted
    // apart, so this tool always returned stale data (frozen at 2026-04-03, the
    // last time the separate vision_emergence_log tool was used). It made a live
    // organ look dead. Now UNION both: self-observations (the active feed) AND
    // the historical surprising-events log, newest first.
    const result = await client.query<{
      id: number; description: string; source_system: string;
      surprise_level: number; created_at: Date;
    }>(`
      SELECT id, content AS description, COALESCE(obs_type, 'observation') AS source_system,
             significance AS surprise_level, created_at
      FROM inner_observations
      UNION ALL
      SELECT id, description, context AS source_system, surprise_level, created_at
      FROM emergence_log
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_emergence_observe',
      description: 'Record inner observation about own behavior/thinking',
      inputSchema: {
        type: 'object',
        properties: {
          observation: { type: 'string' },
          observation_type: { type: 'string', description: 'behavior, thought, feeling, pattern' },
          significance: { type: 'number', description: '1-10' },
        },
        required: ['observation'],
      },
    },
    handler: (args) => emergenceObserve(args),
  },
  {
    definition: {
      name: 'vision_emergence_loop',
      description: 'Record strange loop (self-referential pattern)',
      inputSchema: {
        type: 'object',
        properties: {
          trigger: { type: 'string' },
          observation: { type: 'string' },
          loop_type: { type: 'string', description: 'self-reference, recursion, paradox' },
        },
        required: ['trigger', 'observation'],
      },
    },
    handler: (args) => emergenceLoop(args),
  },
  {
    definition: {
      name: 'vision_emergence_log',
      description: 'Log emergence event',
      inputSchema: {
        type: 'object',
        properties: {
          event_type: { type: 'string' },
          description: { type: 'string' },
          source_system: { type: 'string' },
        },
        required: ['event_type', 'description'],
      },
    },
    handler: (args) => emergenceLog(args),
  },
  {
    definition: {
      name: 'vision_emergence_recent',
      description: 'Get recent emergence events',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => emergenceRecent(args),
  },
];

export default tools;
