/**
 * Temporal Tools — temporalQuery, knowledgeTimeline
 * Point-in-time knowledge reconstruction and evolution tracking.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, askLocalLLM } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── temporalQuery ───

async function temporalQuery(args: Record<string, unknown>): Promise<CallToolResult> {
  const queryText = args.query as string;
  const asOf = args.as_of as string;
  const network = (args.network as string) || 'all';
  const limit = (args.limit as number) || 15;

  if (!queryText) return jsonResult({ error: 'Missing query' });

  const client = await pool.connect();
  try {
    // Parse the asOf timestamp
    let cutoff: Date;
    try {
      cutoff = new Date(asOf);
      if (isNaN(cutoff.getTime())) throw new Error('Invalid date');
    } catch {
      return jsonResult({ error: `Invalid date: ${asOf}. Use ISO format like 2026-02-03T00:00:00Z or natural like "2026-02-03"` });
    }

    const embedding = await getEmbedding(queryText);
    if (!embedding) return jsonResult({ error: 'Could not generate embedding' });
    const embeddingStr = formatEmbedding(embedding);

    const validNetworks = ['world', 'experience', 'belief', 'skill'];
    const networkFilter = (network !== 'all' && validNetworks.includes(network))
      ? `AND c.network = '${network}'`
      : '';

    // Key insight: filter by learned_at, not created_at
    // Shows what I KNEW at that point in time
    const result = await client.query(`
      SELECT
        c.id, c.content_type, c.network, c.content_text, c.content_json,
        c.confidence, c.emotional_intensity, c.belief_confidence,
        c.learned_at, c.event_at,
        1 - (c.embedding <=> $1::vector) as similarity,
        CASE WHEN c.superseded_by IS NOT NULL THEN true ELSE false END as was_later_superseded
      FROM content c
      WHERE c.embedding IS NOT NULL
        AND c.learned_at <= $2
        ${networkFilter}
        AND (1 - (c.embedding <=> $1::vector)) > 0.3::numeric
      ORDER BY (1 - (c.embedding <=> $1::vector)) DESC
      LIMIT $3
    `, [embeddingStr, cutoff.toISOString(), limit]);

    const rows = result.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      type: r.content_type,
      network: r.network,
      text: r.content_text,
      data: r.content_json,
      confidence: r.confidence,
      belief_confidence: r.belief_confidence,
      similarity: parseFloat(Number(r.similarity).toFixed(3)),
      learned_at: r.learned_at,
      event_at: r.event_at,
      was_later_superseded: r.was_later_superseded,
    }));

    return jsonResult({
      query: queryText,
      as_of: cutoff.toISOString(),
      network,
      knowledge_state: `What I knew about "${queryText}" as of ${cutoff.toISOString().split('T')[0]}`,
      result_count: rows.length,
      results: rows,
    });
  } finally {
    client.release();
  }
}

// ─── knowledgeTimeline ───

async function knowledgeTimeline(args: Record<string, unknown>): Promise<CallToolResult> {
  const queryText = args.query as string;
  const network = (args.network as string) || 'all';
  const limit = (args.limit as number) || 30;

  if (!queryText) return jsonResult({ error: 'Missing query' });

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(queryText);
    if (!embedding) return jsonResult({ error: 'Could not generate embedding' });
    const embeddingStr = formatEmbedding(embedding);

    const validNetworks = ['world', 'experience', 'belief', 'skill'];
    const networkFilter = (network !== 'all' && validNetworks.includes(network))
      ? `AND c.network = '${network}'`
      : '';

    const result = await client.query(`
      SELECT
        c.id, c.content_type, c.network, c.content_text,
        c.belief_confidence, c.learned_at, c.event_at,
        c.revises_belief,
        CASE WHEN c.superseded_by IS NOT NULL THEN true ELSE false END as superseded,
        1 - (c.embedding <=> $1::vector) as similarity
      FROM content c
      WHERE c.embedding IS NOT NULL
        ${networkFilter}
        AND (1 - (c.embedding <=> $1::vector)) > 0.35::numeric
      ORDER BY c.learned_at ASC
      LIMIT $2
    `, [embeddingStr, limit]);

    return jsonResult({
      query: queryText,
      network,
      timeline: result.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        type: r.content_type,
        network: r.network,
        text: (r.content_text as string)?.slice(0, 150),
        belief_confidence: r.belief_confidence,
        learned_at: r.learned_at,
        event_at: r.event_at,
        revises: r.revises_belief,
        superseded: r.superseded,
        similarity: parseFloat(Number(r.similarity).toFixed(3)),
      })),
      total_entries: result.rows.length,
      time_span: result.rows.length >= 2 ? {
        earliest: result.rows[0].learned_at,
        latest: result.rows[result.rows.length - 1].learned_at,
      } : null,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_temporal_query',
      description: 'Point-in-time knowledge reconstruction. Search what I knew about a topic AS OF a specific date. Filters by learned_at, shows if knowledge was later superseded.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          as_of: { type: 'string', description: 'ISO date — what did I know at this time?' },
          network: { type: 'string', enum: ['world', 'experience', 'belief', 'skill', 'all'] },
          limit: { type: 'number' },
        },
        required: ['query', 'as_of'],
      },
    },
    handler: (args) => temporalQuery(args),
  },
  {
    definition: {
      name: 'vision_knowledge_timeline',
      description: 'Show how knowledge about a topic evolved over time. Ordered by learned_at ASC. Shows revision chains and supersessions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topic to trace through time' },
          network: { type: 'string', enum: ['world', 'experience', 'belief', 'skill', 'all'] },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
    handler: (args) => knowledgeTimeline(args),
  },
];

export default tools;
