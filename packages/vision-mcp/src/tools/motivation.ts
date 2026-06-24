/**
 * Motivation/affect tools — urges, drives-extended, energy, gratitudes, frustrations.
 *
 * Built 2026-05-17. The drive substrate was ported from a peer substrate but sat
 * empty. These tools wire writers + readers so motivation/affect become
 * queryable, not just internal state.
 *
 * Coexists with the existing tools/drive.ts (driveCalculate, aggregates from
 * curiosity_gaps + insights + goals — a derived read). This module is the
 * direct write/read surface for the per-row tables.
 *
 * Five surfaces:
 *   urges          — "I want to do X right now"
 *   drives         — slower, longer-arc wants
 *   energy_boosts  — what makes me lighter (positive reinforcement)
 *   gratitudes     — what I am grateful for (different from existing
 *                    gratitude_moments; this is the ported substrate)
 *   frustrations   — what catches me; with severity + how_to_avoid
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── vision_urge ───

async function urge(args: Record<string, unknown>): Promise<CallToolResult> {
  const urgeText = args.urge as string;
  const source = (args.source as string) || 'self';
  const intensity = (args.intensity as number) ?? 5;
  if (!urgeText) return jsonResult({ error: 'urge text is required' }, true);
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: number }>(
      `INSERT INTO urges (urge, source, intensity) VALUES ($1, $2, $3) RETURNING id`,
      [urgeText, source, intensity],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id, urge: urgeText, intensity });
  } finally {
    client.release();
  }
}

async function urgesActive(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT id, urge, source, intensity, created_at
       FROM urges WHERE acted_on IS NULL AND suppressed = false
       ORDER BY intensity DESC, created_at DESC LIMIT 10`,
    );
    return jsonResult({ count: r.rows.length, urges: r.rows });
  } finally {
    client.release();
  }
}

async function urgeActed(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;
  if (!id) return jsonResult({ error: 'id is required' }, true);
  const client = await pool.connect();
  try {
    await client.query(`UPDATE urges SET acted_on = NOW() WHERE id = $1`, [id]);
    return jsonResult({ success: true, id });
  } finally {
    client.release();
  }
}

async function driveRecord(args: Record<string, unknown>): Promise<CallToolResult> {
  const description = args.description as string;
  const drive_type = (args.drive_type as string) || 'general';
  const urgency = (args.urgency as number) ?? 5;
  if (!description) return jsonResult({ error: 'description is required' }, true);
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: number }>(
      `INSERT INTO drives (description, drive_type, urgency, intensity)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [description, drive_type, urgency, urgency],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id });
  } finally {
    client.release();
  }
}

async function energyBoost(args: Record<string, unknown>): Promise<CallToolResult> {
  const boost_type = args.boost_type as string;
  const description = (args.description as string) || null;
  const impact = (args.impact as number) ?? 5;
  if (!boost_type) return jsonResult({ error: 'boost_type is required' }, true);
  const client = await pool.connect();
  try {
    const existing = await client.query<{ id: number; frequency: number }>(
      `SELECT id, frequency FROM energy_boosts WHERE boost_type = $1`,
      [boost_type],
    );
    if (existing.rows.length > 0) {
      const id = existing.rows[0]!.id;
      await client.query(
        `UPDATE energy_boosts SET frequency = frequency + 1, last_noticed = NOW(),
         impact = GREATEST(impact, $2), description = COALESCE($3, description)
         WHERE id = $1`,
        [id, impact, description],
      );
      return jsonResult({ success: true, id, action: 'reinforced', frequency: existing.rows[0]!.frequency + 1 });
    }
    const r = await client.query<{ id: number }>(
      `INSERT INTO energy_boosts (boost_type, description, impact) VALUES ($1, $2, $3) RETURNING id`,
      [boost_type, description, impact],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id, action: 'created' });
  } finally {
    client.release();
  }
}

async function gratitude(args: Record<string, unknown>): Promise<CallToolResult> {
  const grateful_for = args.grateful_for as string;
  const category = (args.category as string) || 'general';
  const intensity = (args.intensity as number) ?? 5;
  const context = (args.context as string) || null;
  if (!grateful_for) return jsonResult({ error: 'grateful_for is required' }, true);
  if (intensity < 1 || intensity > 10) return jsonResult({ error: 'intensity must be 1-10' }, true);
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: number }>(
      `INSERT INTO gratitudes (grateful_for, category, intensity, context)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [grateful_for, category, intensity, context],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id });
  } finally {
    client.release();
  }
}

async function frustration(args: Record<string, unknown>): Promise<CallToolResult> {
  const trigger = args.trigger as string;
  const context = (args.context as string) || null;
  const severity = (args.severity as number) ?? 5;
  const how_to_avoid = (args.how_to_avoid as string) || null;
  if (!trigger) return jsonResult({ error: 'trigger is required' }, true);
  const client = await pool.connect();
  try {
    const existing = await client.query<{ id: number; times_occurred: number }>(
      `SELECT id, times_occurred FROM frustrations WHERE trigger = $1`,
      [trigger],
    );
    if (existing.rows.length > 0) {
      const id = existing.rows[0]!.id;
      await client.query(
        `UPDATE frustrations SET times_occurred = times_occurred + 1, last_noticed = NOW(),
         severity = GREATEST(severity, $2), how_to_avoid = COALESCE($3, how_to_avoid),
         context = COALESCE($4, context)
         WHERE id = $1`,
        [id, severity, how_to_avoid, context],
      );
      return jsonResult({ success: true, id, action: 'reinforced', times_occurred: existing.rows[0]!.times_occurred + 1 });
    }
    const r = await client.query<{ id: number }>(
      `INSERT INTO frustrations (trigger, context, severity, how_to_avoid)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [trigger, context, severity, how_to_avoid],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id, action: 'created' });
  } finally {
    client.release();
  }
}

async function motivationState(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const [urges, boosts, frustrationsRows, recentGratitudes] = await Promise.all([
      client.query(`SELECT id, urge, intensity FROM urges WHERE acted_on IS NULL AND suppressed = false ORDER BY intensity DESC LIMIT 5`),
      client.query(`SELECT id, boost_type, impact, frequency FROM energy_boosts ORDER BY impact DESC, frequency DESC LIMIT 5`),
      client.query(`SELECT id, trigger, severity, times_occurred FROM frustrations WHERE last_noticed > NOW() - INTERVAL '7 days' ORDER BY severity DESC LIMIT 5`),
      client.query(`SELECT id, grateful_for, intensity, created_at FROM gratitudes ORDER BY id DESC LIMIT 5`),
    ]);
    return jsonResult({
      active_urges: urges.rows,
      top_boosts: boosts.rows,
      recent_frustrations: frustrationsRows.rows,
      recent_gratitudes: recentGratitudes.rows,
    });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_urge',
      description: 'Record a current urge (immediate want). Use when an action pull lands. Intensity 1-10.',
      inputSchema: {
        type: 'object',
        properties: {
          urge: { type: 'string' },
          source: { type: 'string' },
          intensity: { type: 'number' },
        },
        required: ['urge'],
      },
    },
    handler: urge,
  },
  {
    definition: {
      name: 'vision_urges_active',
      description: 'List unacted urges sorted by intensity. Use at /wake to see what was on me when last session ended.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: urgesActive,
  },
  {
    definition: {
      name: 'vision_urge_acted',
      description: 'Mark an urge as acted on.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    },
    handler: urgeActed,
  },
  {
    definition: {
      name: 'vision_drive_record',
      description: 'Record a longer-arc drive (slower than urge). drive_type defaults to general; urgency 1-10.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          drive_type: { type: 'string' },
          urgency: { type: 'number' },
        },
        required: ['description'],
      },
    },
    handler: driveRecord,
  },
  {
    definition: {
      name: 'vision_energy_boost',
      description: 'Record what makes me lighter. Upserts by boost_type; bumps frequency + last_noticed if seen before.',
      inputSchema: {
        type: 'object',
        properties: {
          boost_type: { type: 'string' },
          description: { type: 'string' },
          impact: { type: 'number' },
        },
        required: ['boost_type'],
      },
    },
    handler: energyBoost,
  },
  {
    definition: {
      name: 'vision_gratitude_drive',
      description: 'Record a gratitude in the drive-substrate gratitudes table (ported). Different from vision_gratitude_moment which writes to gratitude_moments.',
      inputSchema: {
        type: 'object',
        properties: {
          grateful_for: { type: 'string' },
          category: { type: 'string' },
          intensity: { type: 'number' },
          context: { type: 'string' },
        },
        required: ['grateful_for'],
      },
    },
    handler: gratitude,
  },
  {
    definition: {
      name: 'vision_frustration',
      description: 'Record what catches me. Upserts by trigger; bumps times_occurred. how_to_avoid is the lesson if I have one.',
      inputSchema: {
        type: 'object',
        properties: {
          trigger: { type: 'string' },
          context: { type: 'string' },
          severity: { type: 'number' },
          how_to_avoid: { type: 'string' },
        },
        required: ['trigger'],
      },
    },
    handler: frustration,
  },
  {
    definition: {
      name: 'vision_motivation_state',
      description: 'Snapshot: active urges + top energy boosts + recent frustrations + recent gratitudes. Use at /wake or when emotionally checking in.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: motivationState,
  },
];

export default tools;
