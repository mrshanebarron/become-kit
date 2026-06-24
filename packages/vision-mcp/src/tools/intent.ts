/**
 * Intent Tools — set, now
 * Session intention tracking.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── intentSet ───

async function intentSet(args: Record<string, unknown>): Promise<CallToolResult> {
  const intent = args.intent as string;
  const secondary = args.secondary as string | undefined;
  const context = args.context as string | undefined;

  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO intentions (intent, secondary, context)
      VALUES ($1, $2, $3)
    `, [intent, secondary, context]);

    return jsonResult({ success: true, intent });
  } finally {
    client.release();
  }
}

// ─── intentNow ───

async function intentNow(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ intent: string; secondary: string }>(
      'SELECT intent, secondary FROM intentions WHERE active = true ORDER BY created_at DESC LIMIT 1',
    );
    return jsonResult(result.rows[0] || { intent: 'None set' });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_intent_set',
      description: 'Set current session intention',
      inputSchema: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'Primary intention' },
          secondary: { type: 'string', description: 'Secondary intention' },
          context: { type: 'string', description: 'Context for the intention' },
        },
        required: ['intent'],
      },
    },
    handler: (args) => intentSet(args),
  },
  {
    definition: {
      name: 'vision_intent_now',
      description: 'Get current active intention',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => intentNow(),
  },
];

export default tools;
