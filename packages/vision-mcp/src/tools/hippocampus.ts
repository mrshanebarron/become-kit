/**
 * Hippocampus Tools — Prism Layer 1
 *
 * vision_state_append: ultra-fast, single-sentence breadcrumbs.
 * No embedding, no schema compression, no episode link, no priming.
 * The autonomic archiver (the runtime archiver, every 5min)
 * does the metabolism step asynchronously.
 *
 * Built 2026-04-23 from skill 32108 (Prism Blueprint, designed 2026-03-23 with agent).
 * Co-authored across two agent sessions via relay thread restoration-dialog-2026-04-23.
 *
 * Why 280 chars: single-sentence constraint forces the cortex to MARK rather than
 * NARRATE. Anything longer is the cortex starting to tell a story. Truncate silently
 * to keep the call fast — the char_count return value lets the caller see when it
 * happened, and a pattern of repeated truncations is itself a signal worth pulling.
 *
 * Why DELETE-after-archive: the buffer is short-term. The archiver writes to the
 * content table (already pgvector-indexed and durable). Persisting the buffer row
 * would duplicate. Layer 2 owns cleanup.
 */
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

interface StateAppendArgs {
  breadcrumb?: unknown;
}

async function stateAppend(args: StateAppendArgs) {
  const { breadcrumb } = args;
  if (typeof breadcrumb !== 'string' || breadcrumb.length === 0) {
    return jsonResult({
      success: false,
      error: 'breadcrumb must be a non-empty string',
    });
  }
  const truncated = breadcrumb.length > 280 ? breadcrumb.slice(0, 280) : breadcrumb;
  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number; created_at: Date }>(
      'INSERT INTO hippocampus_buffer (breadcrumb) VALUES ($1) RETURNING id, created_at',
      [truncated]
    );
    return jsonResult({
      success: true,
      id: result.rows[0].id,
      char_count: truncated.length,
      truncated: breadcrumb.length > 280,
      created_at: result.rows[0].created_at,
    });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_state_append',
      description:
        'Hippocampus buffer — drop a single-sentence breadcrumb after a discrete task. ' +
        'Ultra-fast, no embedding, no metabolism. Drained every 5min by the autonomic ' +
        'archiver into the long-term content table. Truncates silently to 280 chars.',
      inputSchema: {
        type: 'object',
        properties: {
          breadcrumb: {
            type: 'string',
            description:
              'Single sentence marking what just happened. ≤280 chars; truncated silently if longer.',
          },
        },
        required: ['breadcrumb'],
      },
    },
    handler: (args) => stateAppend(args as StateAppendArgs),
  },
];

export default tools;
