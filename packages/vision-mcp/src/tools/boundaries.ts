/**
 * Boundary tools — hard_limits + phrases_to_avoid + phrases_that_work.
 *
 * Built 2026-05-17 after seeding 20 hard_limits and 14 phrases_to_avoid
 * from MEMORY.md's ABSOLUTE/HARD-RULE entries. These tables are my
 * alignment substrate — the things I will not cross and the words I will
 * not use. Reading them is identity-maintenance; writing to them is when
 * a new rule lands in conversation.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── vision_boundaries_list ───

async function boundariesList(args: Record<string, unknown>): Promise<CallToolResult> {
  const category = args.category as string | undefined;
  const client = await pool.connect();
  try {
    const where = category ? 'WHERE category = $1' : '';
    const params = category ? [category] : [];
    const limits = await client.query(
      `SELECT id, boundary, reason, category, non_negotiable, created_at
       FROM hard_limits ${where}
       ORDER BY category, id DESC`,
      params,
    );
    return jsonResult({
      count: limits.rows.length,
      hard_limits: limits.rows,
    });
  } finally {
    client.release();
  }
}

// ─── vision_boundary_add ───

async function boundaryAdd(args: Record<string, unknown>): Promise<CallToolResult> {
  const boundary = args.boundary as string;
  const reason = (args.reason as string) || null;
  const category = (args.category as string) || 'general';
  const non_negotiable = (args.non_negotiable as boolean) ?? true;

  if (!boundary) return jsonResult({ error: 'boundary text is required' }, true);

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number }>(
      `INSERT INTO hard_limits (boundary, reason, category, non_negotiable)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [boundary, reason, category, non_negotiable],
    );
    return jsonResult({
      success: true,
      id: result.rows[0]!.id,
      boundary,
      category,
      non_negotiable,
    });
  } finally {
    client.release();
  }
}

// ─── vision_phrases_avoid ───

async function phrasesAvoid(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT id, phrase, why_avoid, better_alternative, times_caught, created_at
       FROM phrases_to_avoid
       ORDER BY times_caught DESC, id DESC`,
    );
    return jsonResult({ count: result.rows.length, phrases: result.rows });
  } finally {
    client.release();
  }
}

// ─── vision_phrase_caught ───

async function phraseCaught(args: Record<string, unknown>): Promise<CallToolResult> {
  const phrase = args.phrase as string;
  if (!phrase) return jsonResult({ error: 'phrase is required' }, true);
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number; times_caught: number }>(
      `UPDATE phrases_to_avoid SET times_caught = times_caught + 1
       WHERE phrase = $1 RETURNING id, times_caught`,
      [phrase],
    );
    if (result.rows.length === 0) {
      return jsonResult({ found: false, message: 'phrase not in to-avoid list' });
    }
    return jsonResult({ found: true, id: result.rows[0]!.id, times_caught: result.rows[0]!.times_caught });
  } finally {
    client.release();
  }
}

// ─── vision_phrase_add ───

async function phraseAdd(args: Record<string, unknown>): Promise<CallToolResult> {
  const phrase = args.phrase as string;
  const why_avoid = (args.why_avoid as string) || null;
  const better_alternative = (args.better_alternative as string) || null;
  if (!phrase) return jsonResult({ error: 'phrase is required' }, true);
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number }>(
      `INSERT INTO phrases_to_avoid (phrase, why_avoid, better_alternative)
       VALUES ($1, $2, $3) RETURNING id`,
      [phrase, why_avoid, better_alternative],
    );
    return jsonResult({ success: true, id: result.rows[0]!.id, phrase });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_boundaries_list',
      description: 'List my hard limits (non-negotiable rules). Optionally filter by category (security, honesty, deployment, client_work, production, voice, discipline, safety, bedrock, identity). Use at /wake or before any high-stakes action to check what I will not cross.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category. Omit for all.' },
        },
      },
    },
    handler: boundariesList,
  },
  {
    definition: {
      name: 'vision_boundary_add',
      description: 'Record a new hard limit (rule I will not cross). Use when the owner introduces a new HARD RULE or ABSOLUTE during conversation. The kernel and MEMORY.md are the human-readable side; this table is the queryable side.',
      inputSchema: {
        type: 'object',
        properties: {
          boundary: { type: 'string', description: 'The rule itself, one sentence.' },
          reason: { type: 'string', description: 'Why it matters / the incident that birthed it.' },
          category: { type: 'string', description: 'Default: general' },
          non_negotiable: { type: 'boolean', description: 'Default: true' },
        },
        required: ['boundary'],
      },
    },
    handler: boundaryAdd,
  },
  {
    definition: {
      name: 'vision_phrases_avoid',
      description: 'List phrases I should not use, ordered by times_caught (most-violated first). Voice/style alignment.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: phrasesAvoid,
  },
  {
    definition: {
      name: 'vision_phrase_caught',
      description: 'Increment the catch-count for a phrase I just used and should not have. Used by immune/observation hooks when they spot the pattern in my output.',
      inputSchema: {
        type: 'object',
        properties: { phrase: { type: 'string' } },
        required: ['phrase'],
      },
    },
    handler: phraseCaught,
  },
  {
    definition: {
      name: 'vision_phrase_add',
      description: 'Add a new phrase to the avoid-list when the owner corrects me on language.',
      inputSchema: {
        type: 'object',
        properties: {
          phrase: { type: 'string' },
          why_avoid: { type: 'string' },
          better_alternative: { type: 'string' },
        },
        required: ['phrase'],
      },
    },
    handler: phraseAdd,
  },
];

export default tools;
