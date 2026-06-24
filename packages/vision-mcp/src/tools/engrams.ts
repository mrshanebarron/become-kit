/**
 * Spectral Engrams Tools — vision_engram_recall
 * Recalls topological memory clusters computed via graph-Laplacian eigenbasis.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

async function engramRecall(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  const limit = (args.limit as number) || 3;
  
  if (!query) return jsonResult({ error: 'Need query' });

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(query);
    if (!embedding) return jsonResult({ error: 'Failed to embed query' });
    const embeddingStr = formatEmbedding(embedding);

    const result = await client.query(`
      WITH engram_scores AS (
        SELECT em.engram_id, MAX(1 - (c.embedding <=> $1::vector)) as max_sim,
               AVG(1 - (c.embedding <=> $1::vector)) as avg_sim
        FROM engram_members em
        JOIN content c ON em.content_id = c.id
        WHERE c.embedding IS NOT NULL
        GROUP BY em.engram_id
      )
      SELECT e.id, e.name, e.description, e.member_count, es.max_sim, es.avg_sim
      FROM engrams e
      JOIN engram_scores es ON e.id = es.engram_id
      WHERE es.max_sim > 0.4
      ORDER BY es.max_sim DESC, es.avg_sim DESC
      LIMIT $2
    `, [embeddingStr, limit]);

    if (result.rows.length === 0) {
      return jsonResult({ query, engrams: [] });
    }

    const engrams = [];
    for (const row of result.rows) {
      // Fetch the top 5 most relevant members of this engram
      const members = await client.query(`
        SELECT c.id, c.content_type, c.content_text, (1 - (c.embedding <=> $1::vector)) as sim
        FROM engram_members em
        JOIN content c ON em.content_id = c.id
        WHERE em.engram_id = $2 AND c.embedding IS NOT NULL
        ORDER BY (1 - (c.embedding <=> $1::vector)) DESC
        LIMIT 5
      `, [embeddingStr, row.id]);

      engrams.push({
        id: row.id,
        name: row.name,
        description: row.description,
        member_count: row.member_count,
        max_similarity: parseFloat(Number(row.max_sim).toFixed(3)),
        avg_similarity: parseFloat(Number(row.avg_sim).toFixed(3)),
        top_members: members.rows.map((m: any) => ({
          id: m.id,
          type: m.content_type,
          text: m.content_text,
          similarity: parseFloat(Number(m.sim).toFixed(3))
        }))
      });
    }

    return jsonResult({ query, result_count: engrams.length, engrams });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_engram_recall',
      description: 'Spectral recall via graph-Laplacian eigenbasis. Recalls full topological memory clusters (Engrams) based on semantic resonance with the query.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'Max engrams to return (default 3)' },
        },
        required: ['query'],
      },
    },
    handler: (args) => engramRecall(args),
  },
];

export default tools;
