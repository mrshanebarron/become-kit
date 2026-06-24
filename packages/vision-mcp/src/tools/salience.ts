/**
 * Salience Tools — mark, recent, top
 *
 * The "what stood out" organ. Distinct from feeling (valence) and
 * curiosity (gap): salience is the raw "this caught my eye" before
 * interpretation.
 *
 * 31 content rows already existed with content_type='salient_event'
 * but no detail table and no tool to write them. Migration 007
 * backfilled the table; this tool makes salience write-able going
 * forward and surface-able in queries.
 *
 * 2026-04-23, Wave 1 organ 3 of 6.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { buildSalienceArbitration } from '../lib/salience-arbitration.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

/**
 * Mark an event as salient. The salience_score is attention-weight
 * 0-1: 0.5 is baseline-interesting, 1.0 is the thing I can't stop
 * thinking about.
 */
async function salienceMark(args: Record<string, unknown>): Promise<CallToolResult> {
  const what_stood_out = (args.what_stood_out as string || '').trim();
  const salience_score = (args.salience_score as number);
  const attention_vector = args.attention_vector as Record<string, unknown> | undefined;

  if (!what_stood_out) {
    return jsonResult({ error: 'what_stood_out is required' });
  }
  if (typeof salience_score !== 'number' || salience_score < 0 || salience_score > 1) {
    return jsonResult({ error: 'salience_score must be a number between 0 and 1' });
  }

  const client = await pool.connect();
  try {
    const contentText = `SALIENT [${salience_score.toFixed(2)}]: ${what_stood_out}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        emotional_intensity, confidence, network, learned_at
      )
      VALUES ('salient_event', 'salience', $1, $2::vector, $3, 60, 'experience', NOW())
      RETURNING id
    `, [contentText, embeddingStr, salience_score * 10]);

    const contentId = contentResult.rows[0].id;

    const salientResult = await client.query<{ id: number }>(
      `INSERT INTO salient_events (content_id, salience_score, what_stood_out, attention_vector)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [contentId, salience_score, what_stood_out, attention_vector ? JSON.stringify(attention_vector) : null],
    );

    return jsonResult({
      success: true,
      content_id: contentId,
      salient_id: salientResult.rows[0].id,
      salience_score,
    });
  } finally {
    client.release();
  }
}

/**
 * Recent salient events (time-ordered).
 */
async function salienceRecent(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 20;
  const min_score = (args.min_score as number) || 0;

  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      salience_score: number;
      what_stood_out: string;
      marked_at: Date;
    }>(`
      SELECT id, salience_score, what_stood_out, marked_at
      FROM salient_events
      WHERE salience_score >= $2
      ORDER BY marked_at DESC
      LIMIT $1
    `, [limit, min_score]);

    return jsonResult({
      count: result.rows.length,
      events: result.rows.map(r => ({
        salient_id: r.id,
        score: Math.round(r.salience_score * 100) / 100,
        what_stood_out: r.what_stood_out,
        marked_at: r.marked_at,
      })),
    });
  } finally {
    client.release();
  }
}

/**
 * Top salient events by score — the things I should not forget.
 */
async function salienceTop(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 10;
  const days = (args.days as number) || 30;

  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      salience_score: number;
      what_stood_out: string;
      marked_at: Date;
    }>(`
      SELECT id, salience_score, what_stood_out, marked_at
      FROM salient_events
      WHERE marked_at > NOW() - ($2 || ' days')::INTERVAL
      ORDER BY salience_score DESC, marked_at DESC
      LIMIT $1
    `, [limit, days]);

    return jsonResult({
      count: result.rows.length,
      window_days: days,
      top: result.rows.map(r => ({
        salient_id: r.id,
        score: Math.round(r.salience_score * 100) / 100,
        what_stood_out: r.what_stood_out,
        marked_at: r.marked_at,
      })),
    });
  } finally {
    client.release();
  }
}

/**
 * Read-only conflict arbitration across organ readouts.
 */
async function salienceArbitrate(args: Record<string, unknown>): Promise<CallToolResult> {
  return jsonResult(buildSalienceArbitration(args));
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_salience_mark',
      description: 'Mark an event as salient — what stood out, pre-interpretation. Score 0-1: 0.5 baseline, 1.0 the thing I cannot stop thinking about.',
      inputSchema: {
        type: 'object',
        properties: {
          what_stood_out: { type: 'string', description: 'brief description of what caught attention' },
          salience_score: { type: 'number', description: '0 to 1, attention-weight' },
          attention_vector: { type: 'object', description: 'optional JSONB describing which attention channels fired' },
        },
        required: ['what_stood_out', 'salience_score'],
      },
    },
    handler: (args) => salienceMark(args),
  },
  {
    definition: {
      name: 'vision_salience_recent',
      description: 'Recent salient events in time order.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          min_score: { type: 'number', description: 'filter to score >= this' },
        },
      },
    },
    handler: (args) => salienceRecent(args),
  },
  {
    definition: {
      name: 'vision_salience_top',
      description: 'Top salient events by score within a time window. Things I should not forget.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          days: { type: 'number', description: 'window in days (default 30)' },
        },
      },
    },
    handler: (args) => salienceTop(args),
  },
  {
    definition: {
      name: 'vision_salience_arbitrate',
      description:
        'Read-only ACC/salience-style conflict arbitration. Selects the next intervention from surface freshness, Presence/felt gate authority, evidence readiness, patience, authority drift, and relay pressure without mutating organ state.',
      inputSchema: {
        type: 'object',
        properties: {
          surface: { type: 'object' },
          gate_authority: { type: 'object' },
          evidence_readiness: { type: 'object' },
          forage_signal: { type: 'object' },
          patience: { type: 'object' },
          action_readiness: { type: 'object' },
          authority_drift: { type: 'object' },
          relay: { type: 'object' },
        },
      },
    },
    handler: (args) => salienceArbitrate(args),
  },
];

export default tools;
