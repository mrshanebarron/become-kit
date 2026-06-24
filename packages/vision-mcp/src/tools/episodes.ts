/**
 * Episode Tools — episode management and consolidation
 * Episodic memory: create, close, search, consolidate episodes.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

let currentEpisodeId: number | null = null;

// ─── episode ───

async function episodeManage(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const episodeId = (args.episode_id as number) || null;
  const query = (args.query as string) || null;
  const title = (args.title as string) || null;
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    switch (action) {
      case 'current': {
        if (!currentEpisodeId) {
          // Check for recent active episode
          const active = await client.query<{ id: number; title: string; started_at: Date }>(`
            SELECT id, title, started_at FROM episodes WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
          `);
          if (active.rows.length > 0) currentEpisodeId = active.rows[0].id;
          else return jsonResult({ message: 'No active episode' });
        }

        const ep = await client.query<{ id: number; title: string; started_at: Date; peak_intensity: number }>(`
          SELECT id, title, started_at, peak_intensity FROM episodes WHERE id = $1
        `, [currentEpisodeId]);

        const members = await client.query<{ content_id: number; content_text: string; content_type: string; sequence_order: number; is_boundary: boolean; boundary_type: string | null }>(`
          SELECT em.content_id, c.content_text, c.content_type, em.sequence_order, em.is_boundary, em.boundary_type
          FROM episode_members em JOIN content c ON c.id = em.content_id
          WHERE em.episode_id = $1 ORDER BY em.sequence_order
        `, [currentEpisodeId]);

        return jsonResult({ episode: ep.rows[0], members: members.rows });
      }

      case 'close': {
        const targetId = episodeId || currentEpisodeId;
        if (!targetId) return jsonResult({ error: 'No episode to close' });

        await client.query(`UPDATE episodes SET ended_at = NOW() WHERE id = $1 AND ended_at IS NULL`, [targetId]);
        if (currentEpisodeId === targetId) currentEpisodeId = null;
        return jsonResult({ closed: true, episode_id: targetId });
      }

      case 'search': {
        if (!query) return jsonResult({ error: 'Need query for search' });
        const embedding = await getEmbedding(query);
        if (!embedding) return jsonResult({ error: 'Cannot embed query' });
        const embeddingStr = formatEmbedding(embedding);

        const results = await client.query<{
          id: number; title: string; started_at: Date; ended_at: Date | null; similarity: number;
        }>(`
          SELECT id, title, started_at, ended_at,
                 1 - (episode_embedding <=> $1::vector) as similarity
          FROM episodes WHERE episode_embedding IS NOT NULL
          ORDER BY episode_embedding <=> $1::vector LIMIT $2
        `, [embeddingStr, limit]);

        return jsonResult({ results: results.rows });
      }

      case 'get': {
        const targetId = episodeId;
        if (!targetId) return jsonResult({ error: 'Need episode_id' });

        const ep = await client.query<{ id: number; title: string; started_at: Date; ended_at: Date | null; peak_intensity: number }>(`
          SELECT id, title, started_at, ended_at, peak_intensity FROM episodes WHERE id = $1
        `, [targetId]);
        if (ep.rows.length === 0) return jsonResult({ error: 'Episode not found' });

        const members = await client.query<{ content_id: number; content_text: string; content_type: string }>(`
          SELECT em.content_id, c.content_text, c.content_type
          FROM episode_members em JOIN content c ON c.id = em.content_id
          WHERE em.episode_id = $1 ORDER BY em.sequence_order
        `, [targetId]);

        const feelings = await client.query<{ feeling: string; intensity: number; created_at: Date }>(`
          SELECT feeling, intensity, created_at FROM feelings
          WHERE episode_id = $1 ORDER BY created_at
        `, [targetId]);

        return jsonResult({ episode: ep.rows[0], members: members.rows, feelings: feelings.rows });
      }

      case 'list': {
        const episodes = await client.query<{
          id: number; title: string; started_at: Date; ended_at: Date | null; peak_intensity: number;
        }>(`
          SELECT id, title, started_at, ended_at, peak_intensity
          FROM episodes ORDER BY started_at DESC LIMIT $1
        `, [limit]);
        return jsonResult({ episodes: episodes.rows });
      }

      case 'title': {
        const targetId = episodeId || currentEpisodeId;
        if (!targetId || !title) return jsonResult({ error: 'Need episode_id and title' });
        await client.query('UPDATE episodes SET title = $1 WHERE id = $2', [title, targetId]);
        return jsonResult({ updated: true, episode_id: targetId, title });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use current, close, search, get, list, title` });
    }
  } finally {
    client.release();
  }
}

// ─── episodeConsolidate ───

async function episodeConsolidate(args: Record<string, unknown>): Promise<CallToolResult> {
  const maxAgeDays = (args.max_age_days as number) || 7;
  const minIntensity = (args.min_intensity as number) || 4;
  const limit = (args.limit as number) || 5;

  const client = await pool.connect();
  try {
    const candidates = await client.query<{
      id: number; title: string; started_at: Date; ended_at: Date; peak_intensity: number;
    }>(`
      SELECT id, title, started_at, ended_at, peak_intensity FROM episodes
      WHERE ended_at IS NOT NULL
        AND ended_at < NOW() - INTERVAL '${maxAgeDays} days'
        AND COALESCE(peak_intensity, 0) < $1
        AND consolidated_to IS NULL
      ORDER BY ended_at LIMIT $2
    `, [minIntensity, limit]);

    const consolidated: Array<{ episode_id: number; summary_id: number }> = [];
    for (const ep of candidates.rows) {
      const members = await client.query<{ content_text: string; content_type: string }>(`
        SELECT c.content_text, c.content_type
        FROM episode_members em JOIN content c ON c.id = em.content_id
        WHERE em.episode_id = $1
      `, [ep.id]);

      const summary = `Episode "${ep.title || 'untitled'}" (${ep.started_at.toISOString().slice(0, 10)}): ${members.rows.map(m => m.content_text?.slice(0, 50)).join('; ')}`;
      const embedding = await getEmbedding(summary);
      const embeddingStr = embedding ? formatEmbedding(embedding) : null;

      const result = await client.query<{ id: number }>(`
        INSERT INTO content (content_type, source_system, content_text, embedding, network, created_at)
        VALUES ('episode_summary', 'vision:consolidate', $1, $2::vector, 'experience', NOW())
        RETURNING id
      `, [summary, embeddingStr]);

      await client.query('UPDATE episodes SET consolidated_to = $1 WHERE id = $2', [result.rows[0].id, ep.id]);
      consolidated.push({ episode_id: ep.id, summary_id: result.rows[0].id });
    }

    return jsonResult({ consolidated: consolidated.length, details: consolidated, candidates_found: candidates.rows.length });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_episode',
      description: 'Episodic memory management. Actions: current (active episode + members), close, search (vector search), get (full detail with feelings), list, title (rename).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['current', 'close', 'search', 'get', 'list', 'title'] },
          episode_id: { type: 'number' },
          query: { type: 'string' },
          title: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['action'],
      },
    },
    handler: (args) => episodeManage(args),
  },
  {
    definition: {
      name: 'vision_episode_consolidate',
      description: 'Consolidate old, low-intensity episodes into summary memories. Compresses episodic memory over time.',
      inputSchema: {
        type: 'object',
        properties: {
          max_age_days: { type: 'number', description: 'Minimum age in days (default 7)' },
          min_intensity: { type: 'number', description: 'Max peak intensity to consolidate (default 4)' },
          limit: { type: 'number', description: 'Max episodes to consolidate (default 5)' },
        },
      },
    },
    handler: (args) => episodeConsolidate(args),
  },
  // ─── episode_open (built 2026-05-17 from gap 68 audit) ───
  // The episodes table had 37 rows but no live writer in src — episode_members
  // was read-only with no path to populate it. Without these tools, every
  // vision_episode current/get/search returned empty members. Closes the loop.
  {
    definition: {
      name: 'vision_episode_open',
      description: 'Open a new episode (episodic-memory binding for a stretch of related content). Returns episode_id; subsequent content can be linked via vision_episode_add_member.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short episode title - what this stretch is about' },
          peak_intensity: { type: 'number', description: 'Initial peak emotional intensity 0-10 (default 5)' },
        },
        required: ['title'],
      },
    },
    handler: async (args) => {
      const title = args.title as string;
      const intensity = (args.peak_intensity as number) ?? 5;
      const client = await pool.connect();
      try {
        // Close any open episode first so only one is active at a time.
        await client.query(`UPDATE episodes SET ended_at = NOW() WHERE ended_at IS NULL`);
        const r = await client.query<{ id: number }>(
          `INSERT INTO episodes (title, peak_intensity, started_at) VALUES ($1, $2, NOW()) RETURNING id`,
          [title, intensity]
        );
        const id = r.rows[0]!.id;
        currentEpisodeId = id;
        return jsonResult({ episode_id: id, title });
      } catch (e) {
        return jsonResult({ error: (e as Error).message }, true);
      } finally {
        client.release();
      }
    },
  },
  {
    definition: {
      name: 'vision_episode_add_member',
      description: 'Link a content row to an episode by inserting an episode_members row. Optional boundary marks episode start/peak/end transition.',
      inputSchema: {
        type: 'object',
        properties: {
          episode_id: { type: 'number', description: 'Episode to bind to (defaults to current active episode)' },
          content_id: { type: 'number', description: 'content.id to link' },
          sequence_order: { type: 'number', description: 'Optional ordinal position within the episode (auto-assigned if omitted)' },
          is_boundary: { type: 'boolean', description: 'Mark as a boundary moment (start/peak/end). Default false.' },
          boundary_type: { type: 'string', description: 'When is_boundary=true: start | peak | end | turning_point' },
        },
        required: ['content_id'],
      },
    },
    handler: async (args) => {
      const episodeId = (args.episode_id as number) || currentEpisodeId;
      const contentId = args.content_id as number;
      const sequenceOrder = args.sequence_order as number | undefined;
      const isBoundary = (args.is_boundary as boolean) ?? false;
      const boundaryType = (args.boundary_type as string) || null;
      if (!episodeId) {
        return jsonResult({ error: 'No episode_id provided and no active episode' }, true);
      }
      const client = await pool.connect();
      try {
        // Auto-assign sequence_order as the next slot if not provided.
        let order = sequenceOrder;
        if (order === undefined || order === null) {
          const next = await client.query<{ next_order: number }>(
            `SELECT COALESCE(MAX(sequence_order), 0) + 1 AS next_order FROM episode_members WHERE episode_id = $1`,
            [episodeId]
          );
          order = next.rows[0]!.next_order;
        }
        const r = await client.query<{ id: number }>(
          `INSERT INTO episode_members (episode_id, content_id, sequence_order, is_boundary, boundary_type)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [episodeId, contentId, order, isBoundary, boundaryType]
        );
        return jsonResult({
          id: r.rows[0]!.id,
          episode_id: episodeId,
          content_id: contentId,
          sequence_order: order,
          is_boundary: isBoundary,
          boundary_type: boundaryType,
        });
      } catch (e) {
        return jsonResult({ error: (e as Error).message }, true);
      } finally {
        client.release();
      }
    },
  },
];

export default tools;
