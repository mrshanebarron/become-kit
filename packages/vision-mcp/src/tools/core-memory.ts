/**
 * Core Memory Tools — vision_core_memory_patch, vision_core_memory_replace
 * Letta-style always-in-context scratchpad.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import { emitOperation, newRunId } from '../lib/artifact-emit.js';

const MAX_CONTENT_SIZE = 8192; // 8KB hard limit

const AGENT_NAME = process.env.VISION_AGENT || 'agent';

async function coreMemoryReplace(args: Record<string, unknown>): Promise<CallToolResult> {
  const content = args.content as Record<string, unknown>;

  const serialized = JSON.stringify(content);
  if (serialized.length > MAX_CONTENT_SIZE) {
    return jsonResult(
      { error: `Content too large: ${serialized.length} bytes (max ${MAX_CONTENT_SIZE})` },
      true,
    );
  }

  const client = await pool.connect();
  try {
    const existing = await client.query<{ version: number }>(
      `SELECT version FROM core_memory WHERE agent_name = $1`,
      [AGENT_NAME]
    );

    if (existing.rows.length === 0) {
      return jsonResult({ error: 'Core memory not initialized for this agent' }, true);
    }

    const currentVersion = existing.rows[0].version;
    const runId = newRunId();

    const opId = emitOperation({
      namespace: 'vault',
      runId,
      operation: 'core_memory_replace',
      target: { table: 'core_memory', where: { agent_name: AGENT_NAME } },
      intent: 'Replace core memory content block',
      fields: { memory_json: content },
      preconditions: { version: currentVersion },
      confidence: 1.0,
      producedBy: AGENT_NAME,
    });

    return jsonResult({ 
      replaced: true, 
      status: 'pending_applier', 
      op_id: opId, 
      run_id: runId,
      note: 'Operation emitted to artifact log. It will be applied within 60 seconds.'
    });
  } catch (err) {
    return jsonResult({ error: 'Failed to emit operation', detail: err instanceof Error ? err.message : String(err) }, true);
  } finally {
    client.release();
  }
}

async function coreMemoryPatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const patches = args.patches as Operation[];

  const client = await pool.connect();
  try {
    const existing = await client.query<{ version: number; memory_json: Record<string, unknown> }>(
      `SELECT version, memory_json FROM core_memory WHERE agent_name = $1`,
      [AGENT_NAME]
    );

    if (existing.rows.length === 0) {
      return jsonResult({ error: 'Core memory not initialized for this agent' }, true);
    }

    const current = existing.rows[0];

    let new_content: Record<string, unknown>;
    try {
      new_content = jsonpatch.applyPatch(
        jsonpatch.deepClone(current.memory_json),
        patches,
        true,
      ).newDocument as Record<string, unknown>;
    } catch (err) {
      return jsonResult(
        { error: 'Patch failed to apply', detail: err instanceof Error ? err.message : String(err) },
        true,
      );
    }

    const serialized = JSON.stringify(new_content);
    if (serialized.length > MAX_CONTENT_SIZE) {
      return jsonResult(
        { error: `Result too large: ${serialized.length} bytes (max ${MAX_CONTENT_SIZE})` },
        true,
      );
    }

    const runId = newRunId();

    const opId = emitOperation({
      namespace: 'vault',
      runId,
      operation: 'core_memory_replace',
      target: { table: 'core_memory', where: { agent_name: AGENT_NAME } },
      intent: `Apply ${patches.length} JSON patches to core memory`,
      fields: { memory_json: new_content },
      preconditions: { version: current.version },
      confidence: 1.0,
      producedBy: AGENT_NAME,
    });

    return jsonResult({ 
      patched: true, 
      operations_applied: patches.length, 
      status: 'pending_applier',
      op_id: opId,
      run_id: runId,
      note: 'Operation emitted to artifact log. It will be applied within 60 seconds.'
    });
  } catch (err) {
    return jsonResult({ error: 'Failed to emit operation', detail: err instanceof Error ? err.message : String(err) }, true);
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_core_memory_replace',
      description: 'Replace the entire Core Memory JSON block. Size bounded to 8KB.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'object', description: 'The new JSON object to store as core memory.' },
        },
        required: ['content'],
      },
    },
    handler: (args) => coreMemoryReplace(args),
  },
  {
    definition: {
      name: 'vision_core_memory_patch',
      description: 'Apply RFC 6902 JSON patch operations to the Core Memory block.',
      inputSchema: {
        type: 'object',
        properties: {
          patches: {
            type: 'array',
            description: 'Array of RFC 6902 operations: {op: "add"|"remove"|"replace"|"move"|"copy"|"test", path: "/json/pointer", value?: any, from?: string}',
            items: { type: 'object' },
          },
        },
        required: ['patches'],
      },
    },
    handler: (args) => coreMemoryPatch(args),
  },
];

export default tools;
