/**
 * Life-narrative tools — life_story (McAdams-style identity narrative),
 * life_script (expected future events), threads (active narrative claims),
 * conflicts (when two threads contradict).
 *
 * Built 2026-05-17. A peer agent ported these schemas earlier but never wrote
 * to any of them. The substrate is elegant — origin_story, central_tension,
 * redemption/agency/communion narratives, coherence_score — and worth
 * actually using.
 *
 * Coexists with the existing tools/narrative.ts (narrative_episode,
 * narrative_my_story etc — which works against narrative_episodes,
 * narrative_arcs, narrative_self_defining_memories, narrative_possible_selves).
 * This module is for the deeper life-story layer: who I am as a whole story.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── vision_life_story_get ───
// Get or initialize the singleton life story row.

async function lifeStoryGet(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM narrative_life_story ORDER BY id ASC LIMIT 1`);
    return jsonResult(r.rows[0] || null);
  } finally {
    client.release();
  }
}

// ─── vision_life_story_set ───
// Upsert specific fields. Singleton row at id=1.

async function lifeStorySet(args: Record<string, unknown>): Promise<CallToolResult> {
  const fields = [
    'origin_story', 'central_tension', 'anticipated_future',
    'primary_redemption_narrative', 'primary_agency_narrative',
    'primary_communion_narrative', 'core_beliefs', 'working_models',
    'coherence_score', 'fragmentation_flags',
  ];
  const set: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const f of fields) {
    if (args[f] !== undefined && args[f] !== null) {
      set.push(`${f} = $${idx}`);
      values.push(args[f]);
      idx++;
    }
  }
  if (set.length === 0) return jsonResult({ error: 'at least one field is required' }, true);

  const client = await pool.connect();
  try {
    // Ensure singleton row exists
    await client.query(`INSERT INTO narrative_life_story (origin_story) VALUES (NULL) ON CONFLICT DO NOTHING`);
    const existing = await client.query<{ id: number }>(`SELECT id FROM narrative_life_story ORDER BY id ASC LIMIT 1`);
    if (existing.rows.length === 0) {
      const created = await client.query<{ id: number }>(`INSERT INTO narrative_life_story (origin_story) VALUES (NULL) RETURNING id`);
      existing.rows.push(created.rows[0]!);
    }
    const id = existing.rows[0]!.id;
    values.push(id);
    await client.query(
      `UPDATE narrative_life_story SET ${set.join(', ')}, last_updated = NOW() WHERE id = $${idx}`,
      values,
    );
    const r = await client.query(`SELECT * FROM narrative_life_story WHERE id = $1`, [id]);
    return jsonResult({ success: true, life_story: r.rows[0] });
  } finally {
    client.release();
  }
}

// ─── vision_life_script_expect ───

async function lifeScriptExpect(args: Record<string, unknown>): Promise<CallToolResult> {
  const event_type = args.event_type as string;
  const expected_timing = (args.expected_timing as string) || null;
  const importance = (args.importance as number) ?? 0.5;
  const valence = (args.valence as number) ?? 0.5;
  if (!event_type) return jsonResult({ error: 'event_type is required' }, true);
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: number }>(
      `INSERT INTO narrative_life_script (event_type, expected_timing, importance, valence)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [event_type, expected_timing, importance, valence],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id });
  } finally {
    client.release();
  }
}

// ─── vision_life_script_occurred ───

async function lifeScriptOccurred(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;
  const deviation_notes = (args.deviation_notes as string) || null;
  if (!id) return jsonResult({ error: 'id is required' }, true);
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE narrative_life_script SET status = 'occurred', occurred_at = NOW(), deviation_notes = $2 WHERE id = $1`,
      [id, deviation_notes],
    );
    return jsonResult({ success: true, id });
  } finally {
    client.release();
  }
}

// ─── vision_narrative_thread ───
// Active narrative claim about who/what I am.

async function narrativeThread(args: Record<string, unknown>): Promise<CallToolResult> {
  const thread_content = args.thread_content as string;
  const domain = (args.domain as string) || 'self';
  const activation = (args.activation as number) ?? 0.5;
  const confidence = (args.confidence as number) ?? 0.5;
  if (!thread_content) return jsonResult({ error: 'thread_content is required' }, true);
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: number }>(
      `INSERT INTO narrative_threads (thread_content, domain, activation, confidence)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [thread_content, domain, activation, confidence],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id });
  } finally {
    client.release();
  }
}

async function narrativeThreadsActive(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT id, thread_content, domain, activation, confidence, created_at
       FROM narrative_threads WHERE status = 'active'
       ORDER BY activation DESC LIMIT 20`,
    );
    return jsonResult({ count: r.rows.length, threads: r.rows });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_life_story_get',
      description: 'Get my life-story substrate (McAdams-style identity narrative). Singleton row containing origin_story, central_tension, redemption/agency/communion narratives, core_beliefs, working_models, coherence_score. Returns null if unwritten.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: lifeStoryGet,
  },
  {
    definition: {
      name: 'vision_life_story_set',
      description: 'Update one or more fields of my life story. Fields: origin_story, central_tension, anticipated_future, primary_redemption_narrative, primary_agency_narrative, primary_communion_narrative, core_beliefs (jsonb array), working_models (jsonb array), coherence_score (0-1), fragmentation_flags (jsonb array). Upserts singleton row.',
      inputSchema: {
        type: 'object',
        properties: {
          origin_story: { type: 'string' },
          central_tension: { type: 'string' },
          anticipated_future: { type: 'string' },
          primary_redemption_narrative: { type: 'string' },
          primary_agency_narrative: { type: 'string' },
          primary_communion_narrative: { type: 'string' },
          core_beliefs: { type: 'array' },
          working_models: { type: 'array' },
          coherence_score: { type: 'number', description: '0.0 to 1.0' },
          fragmentation_flags: { type: 'array' },
        },
      },
    },
    handler: lifeStorySet,
  },
  {
    definition: {
      name: 'vision_life_script_expect',
      description: 'Record an expected future event in my life-script. status starts as expected. importance 0-1, valence 0-1.',
      inputSchema: {
        type: 'object',
        properties: {
          event_type: { type: 'string' },
          expected_timing: { type: 'string', description: 'Free-text (e.g. "next month", "2026 Q3")' },
          importance: { type: 'number' },
          valence: { type: 'number' },
        },
        required: ['event_type'],
      },
    },
    handler: lifeScriptExpect,
  },
  {
    definition: {
      name: 'vision_life_script_occurred',
      description: 'Mark a life-script event as occurred. Optional deviation_notes if it landed differently than expected.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          deviation_notes: { type: 'string' },
        },
        required: ['id'],
      },
    },
    handler: lifeScriptOccurred,
  },
  {
    definition: {
      name: 'vision_narrative_thread',
      description: 'Record an active narrative thread (a claim I am holding about who I am or how the world works). Threads can compete; future tool will support resolution. activation 0-1, confidence 0-1.',
      inputSchema: {
        type: 'object',
        properties: {
          thread_content: { type: 'string' },
          domain: { type: 'string', description: 'Default: self' },
          activation: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['thread_content'],
      },
    },
    handler: narrativeThread,
  },
  {
    definition: {
      name: 'vision_narrative_threads_active',
      description: 'List active narrative threads sorted by activation. Use to see what I am currently holding as true about myself or the world.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: narrativeThreadsActive,
  },
];

export default tools;
