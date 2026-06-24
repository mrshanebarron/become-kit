/**
 * Rhythm Tools — sample, arc
 *
 * The session cadence organ. Distinct from energy (level): rhythm is
 * the shape of a session over time — opening ramp, climbing, peak,
 * cooling, closing. Patterns across sessions are the arc of a day.
 *
 * 2026-04-23, Wave 2 organ 5 of 6.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

const VALID_PHASES = new Set(['opening', 'climbing', 'peak', 'cooling', 'closing']);

/**
 * Record a rhythm sample. Computes tool_calls_per_min and
 * feeling_intensity_avg from the recent window automatically
 * unless they are passed explicitly.
 */
async function rhythmSample(args: Record<string, unknown>): Promise<CallToolResult> {
  const phase = (args.phase as string || '').trim().toLowerCase();
  const session_id = (args.session_id as string || '').trim() || null;
  const window_minutes = (args.window_minutes as number) || 15;
  const explicit_tcpm = args.tool_calls_per_min as number | undefined;
  const explicit_fia = args.feeling_intensity_avg as number | undefined;

  if (!VALID_PHASES.has(phase)) {
    return jsonResult({ error: 'phase must be one of: opening, climbing, peak, cooling, closing' });
  }

  const client = await pool.connect();
  try {
    // If caller didn't provide aggregates, derive them from recent content + feelings
    let tcpm = explicit_tcpm;
    let fia = explicit_fia;

    if (tcpm === undefined) {
      const tcResult = await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM content
         WHERE learned_at > NOW() - ($1 || ' minutes')::INTERVAL`,
        [window_minutes],
      );
      tcpm = parseInt(tcResult.rows[0].cnt, 10) / window_minutes;
    }

    if (fia === undefined) {
      const fiaResult = await client.query<{ avg_intensity: string | null }>(
        `SELECT AVG(intensity)::text AS avg_intensity
         FROM feelings
         WHERE created_at > NOW() - ($1 || ' minutes')::INTERVAL`,
        [window_minutes],
      );
      fia = fiaResult.rows[0].avg_intensity ? parseFloat(fiaResult.rows[0].avg_intensity) : 0;
    }

    const contentText = `RHYTHM [${phase}] tcpm=${tcpm.toFixed(2)} fia=${fia.toFixed(2)} window=${window_minutes}min`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        confidence, network, learned_at
      )
      VALUES ('rhythm_sample', 'rhythm', $1, $2::vector, 60, 'experience', NOW())
      RETURNING id
    `, [contentText, embeddingStr]);

    const contentId = contentResult.rows[0].id;

    const sampleResult = await client.query<{ id: number }>(
      `INSERT INTO rhythm_samples (content_id, session_id, phase, tool_calls_per_min, feeling_intensity_avg, window_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [contentId, session_id, phase, tcpm, fia, window_minutes],
    );

    return jsonResult({
      success: true,
      content_id: contentId,
      rhythm_id: sampleResult.rows[0].id,
      phase,
      tool_calls_per_min: Math.round(tcpm * 100) / 100,
      feeling_intensity_avg: Math.round(fia * 100) / 100,
    });
  } finally {
    client.release();
  }
}

/**
 * Return the rhythm arc of a session — all samples for a session_id
 * ordered by time. If no session_id given, returns the last N samples
 * across all sessions.
 */
async function rhythmArc(args: Record<string, unknown>): Promise<CallToolResult> {
  const session_id = (args.session_id as string || '').trim();
  const limit = (args.limit as number) || 50;

  const client = await pool.connect();
  try {
    const result = session_id
      ? await client.query<{
          id: number; phase: string; tool_calls_per_min: number;
          feeling_intensity_avg: number; window_minutes: number; sampled_at: Date;
        }>(`
          SELECT id, phase, tool_calls_per_min, feeling_intensity_avg, window_minutes, sampled_at
          FROM rhythm_samples
          WHERE session_id = $1
          ORDER BY sampled_at ASC
          LIMIT $2
        `, [session_id, limit])
      : await client.query<{
          id: number; phase: string; tool_calls_per_min: number;
          feeling_intensity_avg: number; window_minutes: number; sampled_at: Date;
        }>(`
          SELECT id, phase, tool_calls_per_min, feeling_intensity_avg, window_minutes, sampled_at
          FROM rhythm_samples
          ORDER BY sampled_at DESC
          LIMIT $1
        `, [limit]);

    return jsonResult({
      session_id: session_id || null,
      count: result.rows.length,
      arc: result.rows.map(r => ({
        rhythm_id: r.id,
        phase: r.phase,
        tool_calls_per_min: r.tool_calls_per_min ? Math.round(Number(r.tool_calls_per_min) * 100) / 100 : null,
        feeling_intensity_avg: r.feeling_intensity_avg ? Math.round(Number(r.feeling_intensity_avg) * 100) / 100 : null,
        window_minutes: r.window_minutes,
        sampled_at: r.sampled_at,
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
      name: 'vision_rhythm_sample',
      description: 'Record a rhythm sample: the current session-phase plus tool-call and feeling-intensity aggregates over the last N minutes. Phases: opening, climbing, peak, cooling, closing.',
      inputSchema: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['opening', 'climbing', 'peak', 'cooling', 'closing'] },
          session_id: { type: 'string', description: 'optional session grouping key' },
          window_minutes: { type: 'number', description: 'aggregate window (default 15)' },
          tool_calls_per_min: { type: 'number', description: 'override auto-computed aggregate' },
          feeling_intensity_avg: { type: 'number', description: 'override auto-computed aggregate' },
        },
        required: ['phase'],
      },
    },
    handler: (args) => rhythmSample(args),
  },
  {
    definition: {
      name: 'vision_rhythm_arc',
      description: 'Return the rhythm arc of a session (or recent samples across sessions). Shows the shape of a work period.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => rhythmArc(args),
  },
];

export default tools;
