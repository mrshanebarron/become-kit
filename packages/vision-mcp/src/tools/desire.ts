/**
 * Desire Tools — want, satisfy, active, wanting-vs-liking
 *
 * The pull-toward organ. Distinct from drive (push-from): drive is
 * need/deficit/must-reduce; desire is want/attraction/toward-ness.
 *
 * Implements the Berridge split: wanting (incentive salience) is
 * measured at the time of want; liking (hedonic satisfaction) is
 * measured when the want is met. The delta between them is the drift
 * — wanted more than liked (dopamine drift), or liked more than wanted
 * (surprise joy). Over time, the delta pattern is calibration for my
 * own desire-signal accuracy.
 *
 * 2026-04-23, pass 6 organ 7 of 8.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

/**
 * Register a want (pull-toward signal). valence = how attractive the
 * outcome feels (0 aversive-gap, 1 attractive-goal). intensity =
 * activation strength (0 faint, 1 urgent). Both 0-1 so the Berridge
 * analysis math is clean.
 */
async function desireWant(args: Record<string, unknown>): Promise<CallToolResult> {
  const want = (args.want as string || '').trim();
  const domain = (args.domain as string || '').trim() || null;
  const valence = typeof args.valence === 'number' ? args.valence as number : 0.5;
  const intensity = typeof args.intensity === 'number' ? args.intensity as number : 0.5;
  const source = (args.source as string || '').trim() || null;

  if (!want) {
    return jsonResult({ error: 'want is required' });
  }
  if (valence < 0 || valence > 1) return jsonResult({ error: 'valence must be 0-1' });
  if (intensity < 0 || intensity > 1) return jsonResult({ error: 'intensity must be 0-1' });

  const client = await pool.connect();
  try {
    const contentText = `WANT [${domain || 'general'}] v=${valence.toFixed(2)} i=${intensity.toFixed(2)}: ${want}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        emotional_intensity, confidence, network, learned_at
      )
      VALUES ('want', 'desire', $1, $2::vector, $3, 60, 'experience', NOW())
      RETURNING id
    `, [contentText, embeddingStr, intensity * 10]);

    const contentId = contentResult.rows[0].id;

    const wantResult = await client.query<{ id: number }>(
      `INSERT INTO wants (content_id, want, domain, valence, intensity, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [contentId, want, domain, valence, intensity, source],
    );

    return jsonResult({
      success: true,
      content_id: contentId,
      want_id: wantResult.rows[0].id,
      valence,
      intensity,
      note: 'Want registered. Call vision_desire_satisfy(want_id, liking_quality) when pursued to close the wanting-vs-liking loop.',
    });
  } finally {
    client.release();
  }
}

/**
 * Mark a want as satisfied. liking_quality is 0-1: how good did it
 * actually feel when I got it? The delta between (wanted intensity)
 * and (actual liking) is the Berridge drift.
 */
async function desireSatisfy(args: Record<string, unknown>): Promise<CallToolResult> {
  const want_id = args.want_id as number;
  const liking_quality = args.liking_quality as number;
  const notes = (args.notes as string || '').trim() || null;

  if (!want_id) return jsonResult({ error: 'want_id is required' });
  if (typeof liking_quality !== 'number' || liking_quality < 0 || liking_quality > 1) {
    return jsonResult({ error: 'liking_quality must be a number 0-1' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const wantRow = await client.query<{ id: number; want: string; intensity: number }>(
      `SELECT id, want, intensity FROM wants WHERE id = $1`,
      [want_id],
    );

    if (wantRow.rows.length === 0) {
      await client.query('ROLLBACK');
      return jsonResult({ error: `want_id ${want_id} not found` });
    }

    const delta = Number(wantRow.rows[0].intensity) - liking_quality;

    const contentText = `SATISFIED "${wantRow.rows[0].want}": liking=${liking_quality.toFixed(2)} delta=${delta.toFixed(2)}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        emotional_intensity, confidence, network, learned_at
      )
      VALUES ('satisfaction', 'desire', $1, $2::vector, $3, 70, 'experience', NOW())
      RETURNING id
    `, [contentText, embeddingStr, liking_quality * 10]);

    const contentId = contentResult.rows[0].id;

    const satResult = await client.query<{ id: number }>(
      `INSERT INTO satisfactions (content_id, want_id, liking_quality, wanting_vs_liking_delta, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [contentId, want_id, liking_quality, delta, notes],
    );

    await client.query(
      `UPDATE wants
       SET satisfied_at = NOW(), satisfaction_quality = $1
       WHERE id = $2`,
      [liking_quality, want_id],
    );

    await client.query('COMMIT');

    return jsonResult({
      success: true,
      want_id,
      satisfaction_id: satResult.rows[0].id,
      liking_quality,
      wanting_vs_liking_delta: Math.round(delta * 100) / 100,
      interpretation: delta > 0.2
        ? 'wanted more than liked — dopamine drift, the anticipation was louder than the reality'
        : delta < -0.2
          ? 'liked more than wanted — surprise joy, undervalued the thing'
          : 'wanting and liking tracked — clean signal',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Active wants — unsatisfied, sorted by intensity desc.
 */
async function desireActive(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 20;
  const domain = (args.domain as string || '').trim();

  const client = await pool.connect();
  try {
    const params: (string | number)[] = [limit];
    let filter = '';
    if (domain) {
      filter = 'AND domain = $2';
      params.push(domain);
    }

    const result = await client.query<{
      id: number; want: string; domain: string | null; valence: number;
      intensity: number; source: string | null; created_at: Date; age_hours: number;
    }>(`
      SELECT id, want, domain, valence, intensity, source, created_at,
             EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 AS age_hours
      FROM wants
      WHERE satisfied_at IS NULL
        ${filter}
      ORDER BY intensity DESC, created_at DESC
      LIMIT $1
    `, params);

    return jsonResult({
      count: result.rows.length,
      active: result.rows.map(r => ({
        want_id: r.id,
        want: r.want,
        domain: r.domain,
        valence: Math.round(Number(r.valence) * 100) / 100,
        intensity: Math.round(Number(r.intensity) * 100) / 100,
        source: r.source,
        age_hours: Math.round(Number(r.age_hours) * 10) / 10,
      })),
    });
  } finally {
    client.release();
  }
}

/**
 * Wanting-vs-liking analysis — aggregate delta pattern.
 * Positive avg delta means I chronically overestimate how good things
 * will feel; negative means I undervalue things I then enjoy.
 */
async function desireWantingVsLiking(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      count: string; avg_delta: string | null;
      drift_count: string; surprise_count: string; clean_count: string;
    }>(`
      SELECT
        COUNT(*)::text AS count,
        AVG(wanting_vs_liking_delta)::text AS avg_delta,
        COUNT(*) FILTER (WHERE wanting_vs_liking_delta > 0.2)::text AS drift_count,
        COUNT(*) FILTER (WHERE wanting_vs_liking_delta < -0.2)::text AS surprise_count,
        COUNT(*) FILTER (WHERE wanting_vs_liking_delta BETWEEN -0.2 AND 0.2)::text AS clean_count
      FROM satisfactions
    `);

    const row = result.rows[0];
    const total = parseInt(row.count, 10);
    const avg = row.avg_delta !== null ? parseFloat(row.avg_delta) : null;

    return jsonResult({
      satisfactions_total: total,
      avg_delta: avg !== null ? Math.round(avg * 100) / 100 : null,
      dopamine_drift_count: parseInt(row.drift_count, 10),
      surprise_joy_count: parseInt(row.surprise_count, 10),
      clean_tracking_count: parseInt(row.clean_count, 10),
      interpretation: total === 0
        ? 'no satisfaction data yet — register wants and call vision_desire_satisfy when they resolve'
        : avg !== null && avg > 0.15
          ? 'chronic dopamine drift — I overestimate how good outcomes will feel'
          : avg !== null && avg < -0.15
            ? 'chronic undervaluation — I underestimate what I actually enjoy'
            : 'wanting and liking generally track — desire signal is calibrated',
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_desire_want',
      description: 'Register a want (pull-toward signal). Distinct from drive (push). Valence 0-1 (aversive-attractive), intensity 0-1 (faint-urgent).',
      inputSchema: {
        type: 'object',
        properties: {
          want: { type: 'string' },
          domain: { type: 'string' },
          valence: { type: 'number', description: '0-1, how attractive the outcome feels' },
          intensity: { type: 'number', description: '0-1, activation strength' },
          source: { type: 'string', description: "what triggered it: 'gap'|'cue'|'prediction_error'|'anticipation'|..." },
        },
        required: ['want'],
      },
    },
    handler: (args) => desireWant(args),
  },
  {
    definition: {
      name: 'vision_desire_satisfy',
      description: 'Mark a want as satisfied. liking_quality 0-1. Records wanting-vs-liking delta (Berridge drift).',
      inputSchema: {
        type: 'object',
        properties: {
          want_id: { type: 'number' },
          liking_quality: { type: 'number', description: '0-1, how good the reality actually felt' },
          notes: { type: 'string' },
        },
        required: ['want_id', 'liking_quality'],
      },
    },
    handler: (args) => desireSatisfy(args),
  },
  {
    definition: {
      name: 'vision_desire_active',
      description: 'Active unsatisfied wants, sorted by intensity desc.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          domain: { type: 'string' },
        },
      },
    },
    handler: (args) => desireActive(args),
  },
  {
    definition: {
      name: 'vision_desire_wanting_vs_liking',
      description: 'Aggregate wanting-vs-liking analysis. Positive avg delta = dopamine drift (wanted more than liked). Negative = surprise joy.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: (args) => desireWantingVsLiking(args),
  },
];

export default tools;
