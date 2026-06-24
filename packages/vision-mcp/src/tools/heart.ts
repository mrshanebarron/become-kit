/**
 * Heart Tools — feel, recall
 * Emotional memory with resonance, consolidation, and entity extraction.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { calculateConsolidationFactor } from '../lib/scoring.js';
import { linkToActiveEpisode } from '../lib/episodes.js';
import {
  enhanceMemoryEdge,
  triggerEmotionalConsolidation,
} from '../lib/consolidation.js';
import { checkPredictions } from '../lib/inference-loop.js';
import { scanAntibodies } from '../lib/immune.js';
import { contextPrime } from '../lib/priming.js';
import { autoGenerateEvidence } from '../lib/evidence.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── heartFeel ───

async function heartFeel(args: Record<string, unknown>): Promise<CallToolResult> {
  const feeling = args.feeling as string;
  const context = args.context as string;
  const rawIntensity = args.intensity ?? 5;
  const intensity = typeof rawIntensity === 'number'
    ? rawIntensity
    : Number(rawIntensity);

  if (!Number.isFinite(intensity) || !Number.isInteger(intensity) || intensity < 1 || intensity > 10) {
    return jsonResult({ error: 'intensity must be an integer from 1 to 10' }, true);
  }

  const client = await pool.connect();
  try {
    const contentText = `${feeling}: ${context || ''}`;

    // Pre-INSERT parallel: immune scan + embedding fetch are independent.
    // Each takes ~200-500ms sequentially; running in parallel saves one
    // round-trip on every heart_feel call. scanAntibodies needs its own
    // client (sharing concurrent queries across one PoolClient is unsafe).
    const [immuneScan, embedding] = await Promise.all([
      (async () => {
        const c = await pool.connect();
        try { return await scanAntibodies(contentText, c); }
        finally { c.release(); }
      })(),
      getEmbedding(contentText),
    ]);
    const embeddingStr = formatEmbedding(embedding);

    const consolidationFactor = calculateConsolidationFactor(intensity);

    let resonantCount = 0;
    let contentId: number;

    await client.query('BEGIN');
    try {
      const contentResult = await client.query<{ id: number }>(`
        INSERT INTO content (
          content_type, source_system, content_text, embedding,
          emotional_intensity, consolidation_strength, confidence,
          network, learned_at
        )
        VALUES ('feeling', 'heart', $1, $2::vector, $3, $4, $5, 'experience', NOW())
        RETURNING id
      `, [
        contentText, embeddingStr, intensity, consolidationFactor,
        Math.min(100, Math.round(consolidationFactor * 50)),
      ]);

      contentId = contentResult.rows[0].id;

      await client.query(
        `INSERT INTO feelings (content_id, feeling, context, intensity)
         VALUES ($1, $2, $3, $4)`,
        [contentId, feeling, context, intensity],
      );

      // Link to active episode
      await linkToActiveEpisode(client, contentId, 'felt_during');

      // High-intensity feelings trigger memory resonance
      if (intensity >= 6) {
        const resonantMemories = await findEmotionallyResonantMemories(client, feeling, intensity);
        resonantCount = resonantMemories.length;

        for (const memory of resonantMemories) {
          await enhanceMemoryEdge(client, contentId, memory.id, intensity, feeling);
        }
      }

      // Very high emotion triggers consolidation
      if (intensity >= 8) {
        await triggerEmotionalConsolidation(client, feeling, context, intensity, contentId);
      }

      // Update current emotional state for future searches
      await client.query(
        `INSERT INTO state (key, value)
         VALUES ('current_emotional_state', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [intensity.toString()],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    // Parallelize the post-write enrichments (2026-05-17 audit fix).
    // Diagnosed p95 ~100s on heart_feel — 10+ sequential DB+HTTP ops per call.
    // checkPredictions, contextPrime, autoGenerateEvidence are independent of
    // each other and only read content. Each gets its own pool client (sharing
    // `client` across concurrent queries is unsafe in node-postgres).
    //
    // Inference loop notes from Phase 4 (apparatus history) + the agent) preserved:
    // autoResolve=false keeps SURFACE-only behavior, preventing the 67k
    // hallucinated resolutions from the Phase 3 lexical+similarity bug.
    // VISION_PHASE4_PREDICTIONS env flag routes through find_contradictions
    // multi-stage validator (uses somatic-marker compatibility — feelings ARE
    // legitimate empirical evidence for beliefs).
    const [inferenceResult, priming, evidenceResult] = await Promise.all([
      (async () => {
        const c = await pool.connect();
        try {
          return await checkPredictions(contentText, {
            autoResolve: false,
            eventContentId: contentId,
            client: c,
          });
        } finally {
          c.release();
        }
      })(),
      (async () => {
        const c = await pool.connect();
        try {
          return await contextPrime(contentText, { limit: 2, client: c });
        } catch {
          return null; // non-fatal
        } finally {
          c.release();
        }
      })(),
      (async () => {
        if (intensity < 5 || !embeddingStr) return null;
        const c = await pool.connect();
        try {
          return await autoGenerateEvidence(contentText, embeddingStr, {
            sourceContentId: contentId,
            evidenceStrength: Math.min(0.5, intensity / 20), // 0.25 at 5, 0.5 at 10
            similarityThreshold: 0.42,
            maxBeliefs: 2,
            client: c,
          });
        } catch {
          return null; // non-fatal
        } finally {
          c.release();
        }
      })(),
    ]);

    return jsonResult({
      success: true,
      feeling,
      intensity,
      consolidation_factor: consolidationFactor,
      resonant_memories: resonantCount,
      content_id: contentId,
      immune_scan: immuneScan.triggered > 0 ? immuneScan : undefined,
      inference_loop: inferenceResult.predictions_matched.length > 0 ? {
        predictions_resolved: inferenceResult.predictions_resolved,
        beliefs_updated: inferenceResult.beliefs_updated,
        matched: inferenceResult.predictions_matched,
      } : undefined,
      priming: priming || undefined,
      evidence_generated: evidenceResult && evidenceResult.beliefs_updated > 0 ? evidenceResult : undefined,
    });
  } finally {
    client.release();
  }
}

/** Find memories that emotionally resonate with current feeling. */
async function findEmotionallyResonantMemories(
  client: import('pg').PoolClient,
  feeling: string,
  intensity: number,
): Promise<Array<{ id: number }>> {
  const feelingEmbedding = await getEmbedding(feeling);
  if (!feelingEmbedding) return [];

  const embeddingStr = formatEmbedding(feelingEmbedding);

  const result = await client.query<{ id: number }>(`
    SELECT c.id
    FROM content c
    WHERE c.embedding IS NOT NULL
      AND (1 - (c.embedding <=> $1::vector)) > 0.7
      AND c.emotional_intensity IS NOT NULL
      AND ABS(c.emotional_intensity - $2) <= 2
      AND c.content_type != 'feeling'
    ORDER BY (1 - (c.embedding <=> $1::vector)) DESC
    LIMIT 10
  `, [embeddingStr, intensity]);

  return result.rows;
}

// ─── heartRecall ───

async function heartRecall(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    const result = await client.query<{
      feeling: string;
      context: string;
      intensity: number;
      created_at: Date;
    }>(`
      SELECT f.feeling, f.context, f.intensity, f.created_at
      FROM feelings f
      ORDER BY f.created_at DESC
      LIMIT $1
    `, [limit]);

    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── heartArchaeology ───
// "The feeling dies so the wisdom can live."
// Surfaces cooled memories — emotions that have decayed below threshold.
// Returns a random sample and prompts synthesis into structural insight.

async function heartArchaeology(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 5;
  const theme = args.theme as string | undefined;

  const client = await pool.connect();
  try {
    let result;
    if (theme) {
      // Themed archaeology — search cooled memories by semantic similarity
      const embedding = await getEmbedding(theme);
      if (embedding) {
        const embeddingStr = formatEmbedding(embedding);
        result = await client.query<{
          id: number;
          feeling: string;
          context: string;
          original_intensity: number;
          current_intensity: number;
          created_at: Date;
          cooled_at: string;
          age_days: number;
        }>(`
          SELECT f.content_id as id, f.feeling, f.context,
            f.intensity as original_intensity,
            c.emotional_intensity as current_intensity,
            f.created_at,
            c.content_json->>'cooled_at' as cooled_at,
            EXTRACT(DAY FROM NOW() - f.created_at)::int as age_days
          FROM feelings f
          JOIN content c ON c.id = f.content_id
          WHERE c.content_json->>'cooled' = 'true'
            AND c.embedding IS NOT NULL
          ORDER BY c.embedding <=> $1::vector
          LIMIT $2
        `, [embeddingStr, limit]);
      } else {
        result = { rows: [] };
      }
    } else {
      // Random archaeology — pull a sample of cooled feelings
      result = await client.query<{
        id: number;
        feeling: string;
        context: string;
        original_intensity: number;
        current_intensity: number;
        created_at: Date;
        cooled_at: string;
        age_days: number;
      }>(`
        SELECT f.content_id as id, f.feeling, f.context,
          f.intensity as original_intensity,
          c.emotional_intensity as current_intensity,
          f.created_at,
          c.content_json->>'cooled_at' as cooled_at,
          EXTRACT(DAY FROM NOW() - f.created_at)::int as age_days
        FROM feelings f
        JOIN content c ON c.id = f.content_id
        WHERE c.content_json->>'cooled' = 'true'
        ORDER BY RANDOM()
        LIMIT $1
      `, [limit]);
    }

    // Count total cooled for context
    const countResult = await client.query<{ total: string }>(
      `SELECT COUNT(*) as total FROM content
       WHERE content_json->>'cooled' = 'true' AND content_type = 'feeling'`,
    );

    const artifacts = result.rows.map(r => ({
      id: r.id,
      feeling: r.feeling,
      context: r.context,
      original_intensity: r.original_intensity,
      current_intensity: Math.round((r.current_intensity || 0) * 10) / 10,
      age_days: r.age_days,
      cooled_at: r.cooled_at,
    }));

    return jsonResult({
      archaeology: artifacts,
      total_cooled: parseInt(countResult.rows[0]?.total || '0'),
      prompt: artifacts.length > 0
        ? 'These feelings once burned bright but have since cooled. What did they teach you? What wisdom remains after the heat is gone?'
        : 'No cooled memories yet. The decay function needs time to work. Come back after the sleep cycle runs.',
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_heart_feel',
      description: 'Record a feeling with embedding',
      inputSchema: {
        type: 'object',
        properties: {
          feeling: { type: 'string' },
          context: { type: 'string' },
          intensity: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['feeling', 'context'],
      },
    },
    handler: (args) => heartFeel(args),
  },
  {
    definition: {
      name: 'vision_heart_recall',
      description: 'Recall recent feelings',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => heartRecall(args),
  },
  {
    definition: {
      name: 'vision_heart_archaeology',
      description: 'Excavate cooled memories — feelings that have faded into wisdom. The feeling dies so the wisdom can live.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of cooled memories to surface (default 5)' },
          theme: { type: 'string', description: 'Optional theme to search cooled memories by semantic similarity' },
        },
      },
    },
    handler: (args) => heartArchaeology(args),
  },
];

export default tools;
