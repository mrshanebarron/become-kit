/**
 * Priority Tools — alert, queue, attend, state_set
 *
 * The attention-weighting organ. Systems emit alerts tagged with their
 * tier; tier base_weight × system weight_modifier × active-state
 * modifiers = effective_weight. The unattended queue is sorted by
 * effective_weight so the top of the queue is what deserves attention
 * right now.
 *
 * State transitions change the modifier topology: "focused" might
 * down-weight wander and up-weight intent; "alert" might make heart
 * interrupt-capable even from the medium tier. The state is the
 * frame; the weights are the picture.
 *
 * 2026-04-23, pass 6 organ 8 of 8.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

/**
 * Emit a priority alert. effective_weight is computed at write time
 * from tier.base_weight × system.weight_modifier × active-state
 * modifiers for this system.
 */
async function priorityAlert(args: Record<string, unknown>): Promise<CallToolResult> {
  const system_name = (args.system_name as string || '').trim();
  const message = (args.message as string || '').trim();
  const urgency = typeof args.urgency === 'number' ? args.urgency as number : 0.5;
  const context = args.context as Record<string, unknown> | undefined;

  if (!system_name || !message) {
    return jsonResult({ error: 'system_name and message are required' });
  }
  if (urgency < 0 || urgency > 1) {
    return jsonResult({ error: 'urgency must be 0-1' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Look up system + tier
    const sys = await client.query<{ tier_id: number; tier_name: string; base_weight: number; weight_modifier: number }>(
      `SELECT s.tier_id, t.name AS tier_name, t.base_weight, s.weight_modifier
       FROM priority_systems s
       JOIN priority_tiers t ON t.id = s.tier_id
       WHERE s.name = $1`,
      [system_name],
    );

    if (sys.rows.length === 0) {
      await client.query('ROLLBACK');
      return jsonResult({ error: `unknown system: ${system_name}` });
    }

    const { tier_id, tier_name, base_weight, weight_modifier } = sys.rows[0];

    // State modifier product: multiply all active-state modifiers for this system
    const mods = await client.query<{ mod_product: string | null }>(`
      SELECT COALESCE(EXP(SUM(LN(weight_modifier))), 1.0)::text AS mod_product
      FROM priority_state_modifiers psm
      JOIN priority_states ps ON ps.id = psm.state_id
      WHERE ps.active = TRUE AND psm.system_name = $1
    `, [system_name]);

    const stateProduct = mods.rows[0].mod_product ? parseFloat(mods.rows[0].mod_product) : 1.0;
    const effective_weight = Number(base_weight) * Number(weight_modifier) * stateProduct * urgency;

    const contentText = `ALERT [${tier_name}/${system_name}] u=${urgency.toFixed(2)} w=${effective_weight.toFixed(2)}: ${message}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        emotional_intensity, confidence, network, learned_at
      )
      VALUES ('priority_alert', 'priority', $1, $2::vector, $3, 60, 'experience', NOW())
      RETURNING id
    `, [contentText, embeddingStr, urgency * 10]);

    const contentId = contentResult.rows[0].id;

    const alertResult = await client.query<{ id: number }>(
      `INSERT INTO priority_alerts (content_id, system_name, tier_id, urgency, message, context, effective_weight)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [contentId, system_name, tier_id, urgency, message, context ? JSON.stringify(context) : null, effective_weight],
    );

    await client.query('COMMIT');

    return jsonResult({
      success: true,
      content_id: contentId,
      alert_id: alertResult.rows[0].id,
      tier: tier_name,
      system: system_name,
      urgency,
      effective_weight: Math.round(effective_weight * 100) / 100,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Return the unattended alert queue, sorted by effective_weight desc.
 * The top of the queue is what should get attention right now.
 */
async function priorityQueue(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 20;
  const min_weight = (args.min_weight as number) || 0;
  const system_name = (args.system_name as string || '').trim();

  const client = await pool.connect();
  try {
    const params: (string | number)[] = [limit, min_weight];
    let filter = '';
    if (system_name) {
      filter = 'AND a.system_name = $3';
      params.push(system_name);
    }

    const result = await client.query<{
      id: number; system_name: string; tier_name: string;
      urgency: number; message: string; effective_weight: number;
      created_at: Date; age_minutes: number;
    }>(`
      SELECT a.id, a.system_name, t.name AS tier_name,
             a.urgency, a.message, a.effective_weight, a.created_at,
             EXTRACT(EPOCH FROM (NOW() - a.created_at)) / 60 AS age_minutes
      FROM priority_alerts a
      JOIN priority_tiers t ON t.id = a.tier_id
      WHERE a.attended = FALSE
        AND a.effective_weight >= $2
        ${filter}
      ORDER BY a.effective_weight DESC, a.created_at DESC
      LIMIT $1
    `, params);

    return jsonResult({
      count: result.rows.length,
      queue: result.rows.map(r => ({
        alert_id: r.id,
        tier: r.tier_name,
        system: r.system_name,
        urgency: Math.round(Number(r.urgency) * 100) / 100,
        effective_weight: Math.round(Number(r.effective_weight) * 100) / 100,
        message: r.message,
        age_minutes: Math.round(Number(r.age_minutes) * 10) / 10,
      })),
    });
  } finally {
    client.release();
  }
}

/**
 * Mark an alert as attended, with optional attended_by note
 * (what action was taken).
 */
async function priorityAttend(args: Record<string, unknown>): Promise<CallToolResult> {
  const alert_id = args.alert_id as number;
  const attended_by = (args.attended_by as string || '').trim() || null;

  if (!alert_id) return jsonResult({ error: 'alert_id is required' });

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number; system_name: string; message: string }>(
      `UPDATE priority_alerts
       SET attended = TRUE, attended_at = NOW(), attended_by = $2
       WHERE id = $1 AND attended = FALSE
       RETURNING id, system_name, message`,
      [alert_id, attended_by],
    );

    if (result.rows.length === 0) {
      return jsonResult({ error: `alert_id ${alert_id} not found or already attended` });
    }

    return jsonResult({
      success: true,
      alert_id: result.rows[0].id,
      system: result.rows[0].system_name,
      attended_by,
    });
  } finally {
    client.release();
  }
}

/**
 * Activate or deactivate a priority state. Only one "base" state
 * should typically be active at a time (focused vs exploratory etc.),
 * but the DB allows overlap for transient conditions like "alert."
 */
async function priorityStateSet(args: Record<string, unknown>): Promise<CallToolResult> {
  const state = (args.state as string || '').trim();
  const active = args.active as boolean;

  if (!state) return jsonResult({ error: 'state is required' });
  if (typeof active !== 'boolean') return jsonResult({ error: 'active (boolean) is required' });

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number; name: string; active: boolean; activated_at: Date | null }>(
      `UPDATE priority_states
       SET active = $2,
           activated_at = CASE WHEN $2 THEN NOW() ELSE activated_at END
       WHERE name = $1
       RETURNING id, name, active, activated_at`,
      [state, active],
    );

    if (result.rows.length === 0) {
      return jsonResult({ error: `unknown state: ${state}` });
    }

    return jsonResult({
      success: true,
      state: result.rows[0].name,
      active: result.rows[0].active,
      activated_at: result.rows[0].activated_at,
    });
  } finally {
    client.release();
  }
}

/**
 * Snapshot of current tiers, systems, active states — the priority
 * topology right now.
 */
async function priorityTopology(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const [tiers, systems, states] = await Promise.all([
      client.query<{ name: string; base_weight: string; can_interrupt: boolean }>(
        `SELECT name, base_weight::text, can_interrupt FROM priority_tiers ORDER BY base_weight DESC`,
      ),
      client.query<{ name: string; tier_name: string; weight_modifier: string }>(
        `SELECT s.name, t.name AS tier_name, s.weight_modifier::text
         FROM priority_systems s JOIN priority_tiers t ON t.id = s.tier_id
         ORDER BY t.base_weight DESC, s.weight_modifier DESC, s.name`,
      ),
      client.query<{ name: string; active: boolean; activated_at: Date | null }>(
        `SELECT name, active, activated_at FROM priority_states ORDER BY active DESC, name`,
      ),
    ]);

    return jsonResult({
      tiers: tiers.rows.map(r => ({
        name: r.name,
        base_weight: parseFloat(r.base_weight),
        can_interrupt: r.can_interrupt,
      })),
      systems: systems.rows.map(r => ({
        name: r.name,
        tier: r.tier_name,
        weight_modifier: parseFloat(r.weight_modifier),
      })),
      states: states.rows.map(r => ({
        name: r.name,
        active: r.active,
        activated_at: r.activated_at,
      })),
      active_states: states.rows.filter(r => r.active).map(r => r.name),
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_priority_alert',
      description: 'Emit a priority alert. Computes effective_weight = tier.base_weight × system.weight_modifier × active-state-modifiers × urgency.',
      inputSchema: {
        type: 'object',
        properties: {
          system_name: { type: 'string', description: 'an organ-system name (heart, gut, immune, claims, etc.)' },
          message: { type: 'string' },
          urgency: { type: 'number', description: '0-1 urgency multiplier' },
          context: { type: 'object', description: 'optional JSONB' },
        },
        required: ['system_name', 'message'],
      },
    },
    handler: (args) => priorityAlert(args),
  },
  {
    definition: {
      name: 'vision_priority_queue',
      description: 'Unattended alert queue sorted by effective_weight desc. Top = what should get attention right now.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
          min_weight: { type: 'number' },
          system_name: { type: 'string' },
        },
      },
    },
    handler: (args) => priorityQueue(args),
  },
  {
    definition: {
      name: 'vision_priority_attend',
      description: 'Mark an alert attended. attended_by records what action was taken.',
      inputSchema: {
        type: 'object',
        properties: {
          alert_id: { type: 'number' },
          attended_by: { type: 'string' },
        },
        required: ['alert_id'],
      },
    },
    handler: (args) => priorityAttend(args),
  },
  {
    definition: {
      name: 'vision_priority_state_set',
      description: 'Activate or deactivate a priority state (focused, cooling, alert, exploratory, depleted, engaged).',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['focused', 'cooling', 'alert', 'exploratory', 'depleted', 'engaged'] },
          active: { type: 'boolean' },
        },
        required: ['state', 'active'],
      },
    },
    handler: (args) => priorityStateSet(args),
  },
  {
    definition: {
      name: 'vision_priority_topology',
      description: 'Snapshot of current tiers, systems, active states — the attention topology right now.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: (args) => priorityTopology(args),
  },
];

export default tools;
