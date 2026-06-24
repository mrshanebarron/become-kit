/**
 * Bond Tools — value, summary
 * Core values and relationship preferences.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── bondValue ───

async function bondValue(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = args.name as string;
  const description = args.description as string;
  const evidence = args.evidence as string;
  const importance = (args.importance as number) || 5;

  const client = await pool.connect();
  try {
    const contentText = `${name}: ${description}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('core_value', 'bond', $1, $2::vector)
      RETURNING id
    `, [contentText, embeddingStr]);

    await client.query(`
      INSERT INTO core_values (content_id, name, description, evidence, importance)
      VALUES ($1, $2, $3, $4, $5)
    `, [contentResult.rows[0].id, name, description, evidence, importance]);

    return jsonResult({ success: true, name, importance });
  } finally {
    client.release();
  }
}

// ─── bondSummary ───

async function bondSummary(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const values = await client.query<{
      name: string;
      description: string;
      importance: number;
    }>('SELECT name, description, importance FROM core_values ORDER BY importance DESC LIMIT 10');

    const prefs = await client.query<{
      category: string;
      preference: string;
      strength: number;
    }>('SELECT category, preference, strength FROM preferences ORDER BY strength DESC LIMIT 10');

    return jsonResult({
      core_values: values.rows,
      preferences: prefs.rows,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_bond_value',
      description: 'Record a core value with evidence and importance',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string', description: 'Evidence supporting this value' },
          importance: { type: 'number', description: '1-10 importance (default 5)' },
        },
        required: ['name', 'description', 'evidence'],
      },
    },
    handler: (args) => bondValue(args),
  },
  {
    definition: {
      name: 'vision_bond_summary',
      description: 'Get summary of core values and preferences',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => bondSummary(),
  },
];

export default tools;
