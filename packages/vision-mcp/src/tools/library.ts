/**
 * Library Tools — store, search
 * External knowledge with semantic search. A durable store for references and
 * patterns the agent wants to recall by meaning, deduped by source_ref.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── libraryStore ───

async function libraryStore(args: Record<string, unknown>): Promise<CallToolResult> {
  const entryType = args.entry_type as string;
  const title = args.title as string;
  const content = args.content as string;
  const metadata = (args.metadata as Record<string, unknown>) || {};
  const sourceRef = (args.source_ref as string) || null;

  if (!entryType || !title || !content) {
    return textResult('Missing required fields: entry_type, title, content', true);
  }

  const client = await pool.connect();
  try {
    // Update in place if an entry with this source_ref already exists.
    if (sourceRef) {
      const existing = await client.query<{ id: number; content_id: number }>(
        'SELECT l.id, l.content_id FROM library_entries l WHERE l.entry_type = $1 AND l.source_ref = $2',
        [entryType, sourceRef],
      );

      if (existing.rows.length > 0) {
        const contentId = existing.rows[0].content_id;
        const embedding = await getEmbedding(content);
        const embeddingStr = formatEmbedding(embedding);

        await client.query(`
          UPDATE content SET content_text = $1, content_json = $2, embedding = $3::vector, updated_at = NOW()
          WHERE id = $4
        `, [content, JSON.stringify(metadata), embeddingStr, contentId]);

        await client.query(`
          UPDATE library_entries SET title = $1, metadata = $2, updated_at = NOW()
          WHERE id = $3
        `, [title, JSON.stringify(metadata), existing.rows[0].id]);

        return jsonResult({ success: true, id: contentId, updated: true, has_embedding: !!embedding });
      }
    }

    const embedding = await getEmbedding(content);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, content_json, embedding, confidence)
      VALUES ($1, 'library', $2, $3, $4::vector, 80)
      RETURNING id
    `, [entryType, content, JSON.stringify(metadata), embeddingStr]);

    const contentId = contentResult.rows[0].id;

    await client.query(`
      INSERT INTO library_entries (content_id, entry_type, source_ref, title, metadata)
      VALUES ($1, $2, $3, $4, $5)
    `, [contentId, entryType, sourceRef, title, JSON.stringify(metadata)]);

    return jsonResult({ success: true, id: contentId, updated: false, has_embedding: !!embedding });
  } finally {
    client.release();
  }
}

// ─── librarySearch ───

async function librarySearch(args: Record<string, unknown>): Promise<CallToolResult> {
  const queryText = args.query as string;
  const entryType = (args.entry_type as string) || null;
  const limit = (args.limit as number) || 10;

  if (!queryText) {
    return textResult('Missing query', true);
  }

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(queryText);

    if (embedding) {
      const embeddingStr = formatEmbedding(embedding);

      let sql = `
        SELECT l.id, l.entry_type, l.source_ref, l.title, l.metadata,
               c.content_text, 1 - (c.embedding <=> $1::vector) as similarity
        FROM library_entries l
        JOIN content c ON l.content_id = c.id
        WHERE c.embedding IS NOT NULL
      `;
      const params: unknown[] = [embeddingStr];

      if (entryType) {
        sql += ' AND l.entry_type = $2';
        params.push(entryType);
      }

      sql += ` ORDER BY c.embedding <=> $1::vector LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await client.query(sql, params);
      return jsonResult(result.rows);
    } else {
      // Fallback to text search when no embedding model is available.
      let sql = `
        SELECT l.id, l.entry_type, l.source_ref, l.title, l.metadata,
               c.content_text, 0.5::numeric as similarity
        FROM library_entries l
        JOIN content c ON l.content_id = c.id
        WHERE c.content_text ILIKE $1
      `;
      const params: unknown[] = [`%${queryText}%`];

      if (entryType) {
        sql += ' AND l.entry_type = $2';
        params.push(entryType);
      }

      sql += ` LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await client.query(sql, params);
      return jsonResult(result.rows);
    }
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_library_store',
      description: 'Store an external knowledge entry with semantic embedding. Updates existing if source_ref matches.',
      inputSchema: {
        type: 'object',
        properties: {
          entry_type: { type: 'string', description: 'Type of entry (e.g. reference, pattern, snippet)' },
          title: { type: 'string' },
          content: { type: 'string', description: 'Full content text for embedding' },
          metadata: { type: 'object', description: 'Additional structured data' },
          source_ref: { type: 'string', description: 'Unique reference for dedup (e.g. a URL or external id)' },
        },
        required: ['entry_type', 'title', 'content'],
      },
    },
    handler: (args) => libraryStore(args),
  },
  {
    definition: {
      name: 'vision_library_search',
      description: 'Semantic search across library entries. Optionally filter by entry_type.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          entry_type: { type: 'string', description: 'Filter by type (e.g. reference, pattern)' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
    handler: (args) => librarySearch(args),
  },
];

export default tools;
