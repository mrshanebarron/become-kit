/**
 * Binding Tools — Theta-Gamma working memory binding: bind, unbind, bound, release
 *
 * The neuroscience: working memory holds 4–7 items by nesting each in a
 * gamma cycle inside a theta cycle. The brain treats those items as
 * bound — part of the same current thought — even though each is a
 * separable representation.
 *
 * Vision already had working_memory for single-item activation. These tools
 * add explicit bindings: "these N content rows are held together right now
 * as the current task / deliberation / comparison / argument-under-assembly."
 *
 * Use cases:
 *   - Current multi-threaded task ("a multi-part build task")
 *   - Deliberation under way (3 candidate approaches being compared)
 *   - Argument being assembled (premises in a conclusion)
 *   - Memory recall set (the 5 memories surfaced for current question)
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── bindingCreate ───
// Create a binding with N items. Items can be existing content_id values or
// new strings (which will be inserted as ephemeral content rows).
async function bindingCreate(args: Record<string, unknown>): Promise<CallToolResult> {
  const label = args.label as string;
  const purpose = (args.purpose as string) || null;
  const items = (args.items as Array<number | string>) || [];
  const ttlMinutes = (args.ttl_minutes as number) ?? 60;

  if (!label) return jsonResult({ error: 'Missing required: label' });
  if (items.length === 0) return jsonResult({ error: 'Binding must contain at least one item' });
  if (items.length > 7) {
    return jsonResult({
      error: 'Binding holds max 7 items (theta-gamma working memory capacity)',
      hint: 'Create a second binding or release less-important items first',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const bindingRes = await client.query<{ id: number }>(`
      INSERT INTO working_memory_bindings (binding_label, purpose, expires_at, strength)
      VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, 1.0)
      RETURNING id
    `, [label, purpose, String(ttlMinutes)]);

    const bindingId = bindingRes.rows[0].id;
    const resolvedMembers: { content_id: number; text: string }[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      let contentId: number;
      let text = '';

      if (typeof item === 'number') {
        const check = await client.query<{ content_text: string }>(`
          SELECT content_text FROM content WHERE id = $1
        `, [item]);
        if (check.rows.length === 0) {
          await client.query('ROLLBACK');
          return jsonResult({ error: `content_id ${item} not found` });
        }
        contentId = item;
        text = check.rows[0].content_text;
      } else {
        // Ephemeral content — inserted with binding_ephemeral type so sleep
        // dedup can clean them up later if not promoted.
        const embedding = await getEmbedding(item);
        const insRes = await client.query<{ id: number }>(`
          INSERT INTO content (content_type, source_system, content_text, embedding)
          VALUES ('binding_ephemeral', 'binding', $1, $2::vector)
          RETURNING id
        `, [item, formatEmbedding(embedding)]);
        contentId = insRes.rows[0].id;
        text = item;
      }

      await client.query(`
        INSERT INTO working_memory_binding_members (binding_id, content_id, position)
        VALUES ($1, $2, $3)
        ON CONFLICT (binding_id, content_id) DO NOTHING
      `, [bindingId, contentId, i]);

      // Also touch working_memory so single-item queries still see these
      await client.query(`
        INSERT INTO working_memory (content_id, activation_level, last_refreshed)
        VALUES ($1, 1.0, NOW())
        ON CONFLICT (content_id) DO UPDATE
          SET activation_level = LEAST(1.0, working_memory.activation_level + 0.3),
              last_refreshed = NOW()
      `, [contentId]);

      resolvedMembers.push({ content_id: contentId, text: text.slice(0, 120) });
    }

    await client.query('COMMIT');

    return jsonResult({
      created: true,
      binding_id: bindingId,
      label,
      purpose,
      members: resolvedMembers,
      expires_in_minutes: ttlMinutes,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── bindingList ───
// List active (non-released, non-expired) bindings with their members.
async function bindingList(args: Record<string, unknown>): Promise<CallToolResult> {
  const includeExpired = (args.include_expired as boolean) ?? false;
  const limit = (args.limit as number) ?? 20;

  const client = await pool.connect();
  try {
    const whereClause = includeExpired
      ? 'released_at IS NULL'
      : 'released_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())';

    const bindingsRes = await client.query<{
      id: number;
      binding_label: string;
      purpose: string | null;
      created_at: string;
      expires_at: string | null;
      strength: number;
    }>(`
      SELECT id, binding_label, purpose, created_at, expires_at, strength
      FROM working_memory_bindings
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);

    const bindings = [];
    for (const b of bindingsRes.rows) {
      const membersRes = await client.query<{
        content_id: number;
        content_text: string;
        content_type: string;
        position: number;
      }>(`
        SELECT m.content_id, c.content_text, c.content_type, m.position
        FROM working_memory_binding_members m
        JOIN content c ON c.id = m.content_id
        WHERE m.binding_id = $1
        ORDER BY m.position NULLS LAST, m.bound_at
      `, [b.id]);

      bindings.push({
        binding_id: b.id,
        label: b.binding_label,
        purpose: b.purpose,
        created_at: b.created_at,
        expires_at: b.expires_at,
        strength: Number(b.strength.toFixed(2)),
        members: membersRes.rows.map((m) => ({
          content_id: m.content_id,
          text: m.content_text.slice(0, 120),
          type: m.content_type,
          position: m.position,
        })),
      });
    }

    return jsonResult({ active_bindings: bindings.length, bindings });
  } finally {
    client.release();
  }
}

// ─── bindingAdd ───
// Add an item to an existing binding (refreshes the binding).
async function bindingAdd(args: Record<string, unknown>): Promise<CallToolResult> {
  const bindingId = args.binding_id as number;
  const item = args.item as number | string;

  if (!bindingId) return jsonResult({ error: 'Missing required: binding_id' });
  if (item === undefined || item === null) return jsonResult({ error: 'Missing required: item' });

  const client = await pool.connect();
  try {
    const b = await client.query<{ id: number; released_at: string | null }>(`
      SELECT id, released_at FROM working_memory_bindings WHERE id = $1
    `, [bindingId]);
    if (b.rows.length === 0) return jsonResult({ error: `binding ${bindingId} not found` });
    if (b.rows[0].released_at) return jsonResult({ error: 'binding already released' });

    const countRes = await client.query<{ cnt: number }>(`
      SELECT COUNT(*)::int as cnt FROM working_memory_binding_members WHERE binding_id = $1
    `, [bindingId]);
    if (countRes.rows[0].cnt >= 7) {
      return jsonResult({
        error: 'binding at theta-gamma capacity (7 items)',
        hint: 'Release an item first or create a new binding',
      });
    }

    let contentId: number;
    if (typeof item === 'number') {
      contentId = item;
    } else {
      const embedding = await getEmbedding(item);
      const insRes = await client.query<{ id: number }>(`
        INSERT INTO content (content_type, source_system, content_text, embedding)
        VALUES ('binding_ephemeral', 'binding', $1, $2::vector)
        RETURNING id
      `, [item, formatEmbedding(embedding)]);
      contentId = insRes.rows[0].id;
    }

    await client.query(`
      INSERT INTO working_memory_binding_members (binding_id, content_id, position)
      VALUES ($1, $2, $3)
      ON CONFLICT (binding_id, content_id) DO NOTHING
    `, [bindingId, contentId, countRes.rows[0].cnt]);

    await client.query(`
      UPDATE working_memory_bindings
      SET strength = LEAST(1.0, strength + 0.1)
      WHERE id = $1
    `, [bindingId]);

    return jsonResult({ added: true, binding_id: bindingId, content_id: contentId });
  } finally {
    client.release();
  }
}

// ─── bindingRelease ───
// Explicitly release a binding. Analog to letting items fall out of working
// memory when a task completes.
async function bindingRelease(args: Record<string, unknown>): Promise<CallToolResult> {
  const bindingId = args.binding_id as number;

  if (!bindingId) return jsonResult({ error: 'Missing required: binding_id' });

  const client = await pool.connect();
  try {
    const res = await client.query(`
      UPDATE working_memory_bindings
      SET released_at = NOW()
      WHERE id = $1 AND released_at IS NULL
      RETURNING id, binding_label
    `, [bindingId]);

    if (res.rows.length === 0) {
      return jsonResult({ error: `binding ${bindingId} not found or already released` });
    }

    return jsonResult({
      released: true,
      binding_id: bindingId,
      label: (res.rows[0] as { binding_label: string }).binding_label,
    });
  } finally {
    client.release();
  }
}

// ─── tools array ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_binding_create',
      description:
        'Bind 1-7 items together in working memory (theta-gamma binding). ' +
        'Items can be existing content_ids or new strings. Use for current tasks, ' +
        'deliberations, or comparison sets — explicit "these belong together right now."',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short tag, e.g. "elgg-tailwind-scaffold"' },
          purpose: { type: 'string', description: 'Why bound (task/deliberation/comparison)' },
          items: {
            type: 'array',
            description: 'Up to 7 items: content_ids (numbers) or new strings',
            items: { type: ['number', 'string'] },
          },
          ttl_minutes: { type: 'number', description: 'Auto-expire after N minutes (default 60)' },
        },
        required: ['label', 'items'],
      },
    },
    handler: (args) => bindingCreate(args),
  },
  {
    definition: {
      name: 'vision_binding_list',
      description: 'List active working-memory bindings with their members. Shows what is currently "held together."',
      inputSchema: {
        type: 'object',
        properties: {
          include_expired: { type: 'boolean', description: 'Include expired-but-not-released (default false)' },
          limit: { type: 'number', description: 'Max bindings (default 20)' },
        },
      },
    },
    handler: (args) => bindingList(args),
  },
  {
    definition: {
      name: 'vision_binding_add',
      description: 'Add an item to an existing binding. Refuses at 7-item theta-gamma capacity.',
      inputSchema: {
        type: 'object',
        properties: {
          binding_id: { type: 'number' },
          item: { type: ['number', 'string'], description: 'content_id or new string' },
        },
        required: ['binding_id', 'item'],
      },
    },
    handler: (args) => bindingAdd(args),
  },
  {
    definition: {
      name: 'vision_binding_release',
      description: 'Release a binding (items drop out of bound-set working memory).',
      inputSchema: {
        type: 'object',
        properties: { binding_id: { type: 'number' } },
        required: ['binding_id'],
      },
    },
    handler: (args) => bindingRelease(args),
  },
];

export default tools;
