/**
 * Shared Content Tools — shared_store, shared_search, shared_browse
 * Cross-agent knowledge base in task DB.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { sharedPool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

const SHARED_AUTHOR = process.env.VISION_AGENT || 'agent';

// ─── sharedStore ───

async function sharedStore(args: Record<string, unknown>): Promise<CallToolResult> {
  const contentType = args.content_type as string;
  const title = args.title as string;
  const content = args.content as string;
  const metadata = (args.metadata as Record<string, unknown>) || null;
  const tags = (args.tags as string[]) || [];
  const sourceRef = (args.source_ref as string) || null;

  if (!contentType || !title || !content) {
    return jsonResult({ error: 'Need content_type, title, content' });
  }

  const client = await sharedPool.connect();
  try {
    const embedding = await getEmbedding(content);
    const embeddingStr = embedding ? formatEmbedding(embedding) : null;

    if (sourceRef) {
      // Upsert by source_ref
      const existing = await client.query<{ id: number }>(`
        SELECT id FROM shared_content WHERE content_type = $1 AND source_ref = $2
      `, [contentType, sourceRef]);

      if (existing.rows.length > 0) {
        await client.query(`
          UPDATE shared_content SET title = $1, content_text = $2, metadata = $3, tags = $4,
                 embedding = $5::vector, author = $6, updated_at = NOW()
          WHERE id = $7
        `, [title, content, metadata ? JSON.stringify(metadata) : null, `{${tags.map(t => `"${t}"`).join(',')}}`, embeddingStr, SHARED_AUTHOR, existing.rows[0].id]);
        return jsonResult({ updated: true, id: existing.rows[0].id });
      }
    }

    const result = await client.query<{ id: number }>(`
      INSERT INTO shared_content (content_type, title, content_text, metadata, tags, embedding, author, source_ref)
      VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8) RETURNING id
    `, [contentType, title, content, metadata ? JSON.stringify(metadata) : null, `{${tags.map(t => `"${t}"`).join(',')}}`, embeddingStr, SHARED_AUTHOR, sourceRef]);

    return jsonResult({ stored: true, id: result.rows[0].id, content_type: contentType, title });
  } finally {
    client.release();
  }
}

// ─── sharedSearch ───

async function sharedSearch(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  const contentType = (args.content_type as string) || null;
  const tags = (args.tags as string[]) || null;
  const limit = (args.limit as number) || 10;

  if (!query) return jsonResult({ error: 'Need query' });

  const client = await sharedPool.connect();
  try {
    const embedding = await getEmbedding(query);

    if (embedding) {
      const embeddingStr = formatEmbedding(embedding);
      const conditions = ['embedding IS NOT NULL'];
      const params: unknown[] = [embeddingStr];

      if (contentType) {
        params.push(contentType);
        conditions.push(`content_type = $${params.length}`);
      }
      if (tags && tags.length > 0) {
        params.push(tags);
        conditions.push(`tags && $${params.length}`);
      }
      params.push(limit);

      const results = await client.query(`
        SELECT id, content_type, title, LEFT(content_text, 300) as preview, tags, author, source_ref,
               access_count, created_at,
               1 - (embedding <=> $1::vector) as similarity
        FROM shared_content
        WHERE ${conditions.join(' AND ')}
        ORDER BY embedding <=> $1::vector
        LIMIT $${params.length}
      `, params);

      // Update access counts
      for (const r of results.rows) {
        await client.query('UPDATE shared_content SET access_count = access_count + 1, accessed_at = NOW() WHERE id = $1', [(r as { id: number }).id]);
      }

      return jsonResult({ results: results.rows, total: results.rows.length });
    }

    // Fallback: text search
    const conditions = [`(title ILIKE $1 OR content_text ILIKE $1)`];
    const params: unknown[] = [`%${query}%`];

    if (contentType) {
      params.push(contentType);
      conditions.push(`content_type = $${params.length}`);
    }
    params.push(limit);

    const results = await client.query(`
      SELECT id, content_type, title, LEFT(content_text, 300) as preview, tags, author, created_at
      FROM shared_content WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${params.length}
    `, params);

    return jsonResult({ results: results.rows, total: results.rows.length, mode: 'text_fallback' });
  } finally {
    client.release();
  }
}

// ─── sharedBrowse ───

async function sharedBrowse(args: Record<string, unknown>): Promise<CallToolResult> {
  const contentType = (args.content_type as string) || null;
  const limit = (args.limit as number) || 20;
  const offset = (args.offset as number) || 0;

  const client = await sharedPool.connect();
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (contentType) {
      params.push(contentType);
      conditions.push(`content_type = $${params.length}`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit, offset);

    const results = await client.query(`
      SELECT id, content_type, title, LEFT(content, 200) as preview, tags, author, access_count, created_at
      FROM shared_content ${where}
      ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    const typeCounts = await client.query<{ content_type: string; count: string }>(`
      SELECT content_type, COUNT(*) as count FROM shared_content GROUP BY content_type ORDER BY count DESC
    `);

    return jsonResult({
      items: results.rows,
      type_summary: typeCounts.rows,
      total: results.rows.length,
      offset,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_shared_store',
      description: 'Store content in the shared cross-agent knowledge base. Supports upsert via source_ref.',
      inputSchema: {
        type: 'object',
        properties: {
          content_type: { type: 'string', description: 'pattern, research, procedure, client_knowledge, project, job_filter, genome' },
          title: { type: 'string' },
          content: { type: 'string' },
          metadata: { type: 'object' },
          tags: { type: 'array', items: { type: 'string' } },
          source_ref: { type: 'string', description: 'Dedup key for upsert' },
        },
        required: ['content_type', 'title', 'content'],
      },
    },
    handler: (args) => sharedStore(args),
  },
  {
    definition: {
      name: 'vision_shared_search',
      description: 'Semantic search the shared knowledge base. Falls back to text search if embedding unavailable.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          content_type: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
    handler: (args) => sharedSearch(args),
  },
  {
    definition: {
      name: 'vision_shared_browse',
      description: 'Browse shared knowledge base with optional content_type filter and pagination.',
      inputSchema: {
        type: 'object',
        properties: {
          content_type: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
    handler: (args) => sharedBrowse(args),
  },
];

export default tools;
