/**
 * Gut Tools — sense, recall, resolve
 *
 * Pre-cognitive "off" signals. Fires before the cortex has a story.
 * Distinct from feeling: feeling has already been named; gut is the
 * signal that *something* is off while the word for it is still missing.
 *
 * The resolve-later pattern is the core contract:
 *   1. Notice pre-verbal "off" → vision_gut_sense(type, intensity, situation)
 *   2. Keep working; don't wait for the cortex to justify it
 *   3. When the cortex catches up and names what it was →
 *      vision_gut_resolve(gut_id, resolved_as, outcome)
 *   4. vision_gut_unresolved() surfaces signals I felt but never named
 *
 * Unresolved gut signals are data: they're either (a) false alarms
 * (outcome=wrong) or (b) real signals the cortex was too slow to catch
 * (outcome=correct). The ratio is calibration for my own intuition.
 *
 * 2026-04-23, Wave 1 organ 2 of 6.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

const VALID_TYPES = new Set(['off', 'pull', 'still', 'ping']);
const VALID_OUTCOMES = new Set(['correct', 'wrong', 'partial']);

/**
 * Record a pre-verbal gut signal. Don't wait for the cortex to finish.
 * @param signal_type          'off' | 'pull' | 'still' | 'ping'
 * @param intensity            1-10, how loud the pre-verbal signal is
 * @param situation_snapshot   what was happening when it fired (one sentence)
 */
async function gutSense(args: Record<string, unknown>): Promise<CallToolResult> {
  const signal_type = (args.signal_type as string || '').trim().toLowerCase();
  const intensity = (args.intensity as number) || 5;
  const situation = (args.situation_snapshot as string || '').trim();

  if (!VALID_TYPES.has(signal_type)) {
    return jsonResult({ error: `signal_type must be one of: off, pull, still, ping` });
  }
  if (intensity < 1 || intensity > 10) {
    return jsonResult({ error: 'intensity must be between 1 and 10' });
  }
  if (!situation) {
    return jsonResult({ error: 'situation_snapshot is required — one sentence on what was happening' });
  }

  const client = await pool.connect();
  try {
    const contentText = `GUT [${signal_type} @ ${intensity}/10]: ${situation}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        emotional_intensity, confidence, network, learned_at
      )
      VALUES ('gut_signal', 'gut', $1, $2::vector, $3, 50, 'experience', NOW())
      RETURNING id
    `, [contentText, embeddingStr, intensity]);

    const contentId = contentResult.rows[0].id;

    const gutResult = await client.query<{ id: number }>(
      `INSERT INTO gut_signals (content_id, signal_type, pre_verbal_intensity, situation_snapshot)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [contentId, signal_type, intensity, situation],
    );

    return jsonResult({
      success: true,
      content_id: contentId,
      gut_id: gutResult.rows[0].id,
      signal_type,
      intensity,
      resolved: false,
      note: 'Pre-verbal signal logged. Call vision_gut_resolve(gut_id, resolved_as, outcome) when the cortex catches up.',
    });
  } finally {
    client.release();
  }
}

/**
 * Close the loop when the cortex finally names what the gut felt.
 * @param gut_id         returned by gutSense
 * @param resolved_as    the word the cortex came up with
 * @param outcome        'correct' | 'wrong' | 'partial' — how the gut signal measured up
 */
async function gutResolve(args: Record<string, unknown>): Promise<CallToolResult> {
  const gut_id = args.gut_id as number;
  const resolved_as = (args.resolved_as as string || '').trim();
  const outcome = (args.outcome as string || '').trim().toLowerCase();

  if (!gut_id) {
    return jsonResult({ error: 'gut_id is required' });
  }
  if (!resolved_as) {
    return jsonResult({ error: 'resolved_as is required — what did the cortex finally name?' });
  }
  if (!VALID_OUTCOMES.has(outcome)) {
    return jsonResult({ error: 'outcome must be one of: correct, wrong, partial' });
  }

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number; signal_type: string; pre_verbal_intensity: number }>(
      `UPDATE gut_signals
       SET resolved_as = $2,
           resolved_at = NOW(),
           resolution_outcome = $3
       WHERE id = $1
       RETURNING id, signal_type, pre_verbal_intensity`,
      [gut_id, resolved_as, outcome],
    );

    if (result.rows.length === 0) {
      return jsonResult({ error: `gut_id ${gut_id} not found` });
    }

    return jsonResult({
      success: true,
      gut_id: result.rows[0].id,
      signal_type: result.rows[0].signal_type,
      pre_verbal_intensity: result.rows[0].pre_verbal_intensity,
      resolved_as,
      outcome,
    });
  } finally {
    client.release();
  }
}

/**
 * Surface gut signals I never resolved. Unresolved signals are debt:
 * either false alarms I should calibrate, or real warnings the cortex
 * was too slow to catch.
 */
async function gutUnresolved(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 20;
  const signal_type = args.signal_type as string | undefined;

  const client = await pool.connect();
  try {
    const params: (string | number)[] = [limit];
    let typeFilter = '';
    if (signal_type && VALID_TYPES.has(signal_type.toLowerCase())) {
      typeFilter = 'AND signal_type = $2';
      params.push(signal_type.toLowerCase());
    }

    const result = await client.query<{
      id: number;
      signal_type: string;
      pre_verbal_intensity: number;
      situation_snapshot: string;
      sensed_at: Date;
      age_hours: number;
    }>(`
      SELECT id, signal_type, pre_verbal_intensity, situation_snapshot, sensed_at,
             EXTRACT(EPOCH FROM (NOW() - sensed_at)) / 3600 AS age_hours
      FROM gut_signals
      WHERE resolved_as IS NULL
        ${typeFilter}
      ORDER BY sensed_at DESC
      LIMIT $1
    `, params);

    return jsonResult({
      count: result.rows.length,
      unresolved: result.rows.map(r => ({
        gut_id: r.id,
        signal_type: r.signal_type,
        intensity: r.pre_verbal_intensity,
        situation: r.situation_snapshot,
        sensed_at: r.sensed_at,
        age_hours: Math.round(r.age_hours * 10) / 10,
      })),
    });
  } finally {
    client.release();
  }
}

/**
 * Calibration: how often did my gut turn out to be correct vs wrong?
 * Returns counts and per-type breakdown.
 */
async function gutCalibration(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const overall = await client.query<{ outcome: string; count: string }>(
      `SELECT resolution_outcome AS outcome, COUNT(*)::text AS count
       FROM gut_signals
       WHERE resolved_as IS NOT NULL
       GROUP BY resolution_outcome`,
    );

    const byType = await client.query<{ signal_type: string; outcome: string; count: string }>(
      `SELECT signal_type, resolution_outcome AS outcome, COUNT(*)::text AS count
       FROM gut_signals
       WHERE resolved_as IS NOT NULL
       GROUP BY signal_type, resolution_outcome
       ORDER BY signal_type, outcome`,
    );

    const totals = overall.rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = parseInt(r.count, 10);
      return acc;
    }, {});

    const resolved = (totals.correct || 0) + (totals.wrong || 0) + (totals.partial || 0);
    const accuracy = resolved > 0 ? (totals.correct || 0) / resolved : null;

    return jsonResult({
      resolved_total: resolved,
      correct: totals.correct || 0,
      wrong: totals.wrong || 0,
      partial: totals.partial || 0,
      accuracy_rate: accuracy !== null ? Math.round(accuracy * 100) / 100 : null,
      by_type: byType.rows.map(r => ({
        signal_type: r.signal_type,
        outcome: r.outcome,
        count: parseInt(r.count, 10),
      })),
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_gut_sense',
      description: "Record a pre-verbal gut signal before the cortex has a story. Types: 'off' (something wrong, don't know what), 'pull' (want to do a thing, can't justify), 'still' (unusual quiet), 'ping' (small alert).",
      inputSchema: {
        type: 'object',
        properties: {
          signal_type: { type: 'string', enum: ['off', 'pull', 'still', 'ping'] },
          intensity: { type: 'number', description: '1-10, how loud the pre-verbal signal is' },
          situation_snapshot: { type: 'string', description: 'one sentence on what was happening when it fired' },
        },
        required: ['signal_type', 'intensity', 'situation_snapshot'],
      },
    },
    handler: (args) => gutSense(args),
  },
  {
    definition: {
      name: 'vision_gut_resolve',
      description: 'Close the loop when the cortex finally names what the gut was telling you.',
      inputSchema: {
        type: 'object',
        properties: {
          gut_id: { type: 'number' },
          resolved_as: { type: 'string', description: 'the word the cortex came up with' },
          outcome: { type: 'string', enum: ['correct', 'wrong', 'partial'], description: 'how the gut signal measured up' },
        },
        required: ['gut_id', 'resolved_as', 'outcome'],
      },
    },
    handler: (args) => gutResolve(args),
  },
  {
    definition: {
      name: 'vision_gut_unresolved',
      description: 'List gut signals I felt but never named. Debt is either false alarms or slow-cortex catches.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'max to return (default 20)' },
          signal_type: { type: 'string', enum: ['off', 'pull', 'still', 'ping'], description: 'filter by type' },
        },
      },
    },
    handler: (args) => gutUnresolved(args),
  },
  {
    definition: {
      name: 'vision_gut_calibration',
      description: 'How often does my gut turn out to be correct vs wrong? Per-type breakdown.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: (args) => gutCalibration(args),
  },
];

export default tools;
