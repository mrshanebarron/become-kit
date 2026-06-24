/**
 * Network Tools — networkSearch, networkClassify
 * Cognitive network search and classification.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, askLocalLLM } from '../db/embeddings.js';
import { classifyNetwork } from '../lib/classify.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── networkSearch ───

async function networkSearch(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  const network = (args.network as string) || 'all';
  const limit = (args.limit as number) || 20;

  if (!query || query.length < 2) return jsonResult({ query, results: [] });

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(query);
    if (!embedding) {
      return jsonResult(await textSearchFallback(client, query, limit));
    }

    const embeddingStr = formatEmbedding(embedding);

    // Get current emotional state for resonance scoring
    const stateResult = await client.query<{ value: string }>(
      "SELECT value FROM state WHERE key = 'current_emotional_state'",
    );
    const currentEmotionalState = stateResult.rows.length > 0
      ? parseFloat(stateResult.rows[0].value)
      : null;

    // Build network filter
    const validNetworks = ['world', 'experience', 'belief', 'skill'];
    const networkFilter = (network !== 'all' && validNetworks.includes(network))
      ? `AND c.network = '${network}'`
      : '';

    const result = await client.query(`
      WITH semantic_scores AS (
        SELECT c.id, 1 - (c.embedding <=> $1::vector) as semantic_sim
        FROM content c
        WHERE c.embedding IS NOT NULL
          AND c.superseded_by IS NULL
          ${networkFilter}
      )
      SELECT
        c.id, c.content_type, c.source_system, c.content_text,
        c.content_json, c.confidence, c.emotional_intensity,
        c.network, c.belief_confidence, c.evidence_count,
        c.skill_success_count, c.skill_fail_count,
        ss.semantic_sim,
        CASE
          WHEN c.emotional_intensity IS NOT NULL AND $3::numeric IS NOT NULL THEN
            (1.0::numeric - ABS(c.emotional_intensity::numeric - $3::numeric) / 10.0::numeric) * 0.4::numeric
          ELSE 0.0::numeric
        END as emotional_resonance_score,
        LEAST(COALESCE(c.consolidation_strength, 1.0::numeric), 2.5::numeric) as consolidation_score
      FROM content c
      JOIN semantic_scores ss ON ss.id = c.id
      WHERE c.embedding IS NOT NULL
        AND c.superseded_by IS NULL
        AND ss.semantic_sim > 0.3
        ${networkFilter}
      ORDER BY (
        ss.semantic_sim::numeric * 0.40::numeric +
        CASE
          WHEN c.emotional_intensity IS NOT NULL AND $3::numeric IS NOT NULL THEN
            (1.0::numeric - ABS(c.emotional_intensity::numeric - $3::numeric) / 10.0::numeric) * 0.4::numeric
          ELSE 0.0::numeric
        END * 0.20::numeric +
        LEAST(COALESCE(c.consolidation_strength, 1.0::numeric), 2.5::numeric) * 0.15::numeric +
        CASE
          WHEN c.network = 'belief' AND c.belief_confidence IS NOT NULL THEN c.belief_confidence::numeric * 0.15::numeric
          WHEN c.network = 'skill' AND c.skill_success_count > 0 THEN
            LEAST(1.0::numeric, c.skill_success_count::numeric / GREATEST(1, c.skill_success_count + c.skill_fail_count)::numeric) * 0.15::numeric
          ELSE 0.10::numeric
        END +
        LEAST(0.8::numeric, EXP(GREATEST(-20.0::numeric, -0.1::numeric * EXTRACT(EPOCH FROM (NOW() - COALESCE(c.accessed_at, c.created_at)))::numeric / 86400::numeric))) * 0.10::numeric
      ) DESC
      LIMIT $2
    `, [embeddingStr, limit, currentEmotionalState]);

    return jsonResult({
      query,
      network,
      search_type: 'network-aware',
      result_count: result.rows.length,
      results: result.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        type: r.content_type,
        network: r.network,
        source: r.source_system,
        text: r.content_text,
        data: r.content_json,
        confidence: r.confidence,
        emotional_intensity: r.emotional_intensity,
        similarity: parseFloat(Number(r.semantic_sim || 0).toFixed(3)),
        // Network-specific metadata
        ...((r.network as string) === 'belief' ? {
          belief_confidence: r.belief_confidence,
          evidence_count: r.evidence_count,
        } : {}),
        ...((r.network as string) === 'skill' ? {
          skill_success_count: r.skill_success_count,
          skill_fail_count: r.skill_fail_count,
          skill_success_rate: (r.skill_success_count as number) > 0
            ? parseFloat(((r.skill_success_count as number) / Math.max(1, (r.skill_success_count as number) + (r.skill_fail_count as number))).toFixed(2))
            : null,
        } : {}),
      })),
    });
  } finally {
    client.release();
  }
}

async function textSearchFallback(
  client: import('pg').PoolClient,
  queryText: string,
  limit: number,
) {
  const parts = queryText.toLowerCase().split(/\s+/);
  const includes = parts.filter((p) => !p.startsWith('-') && p.length > 0);
  if (includes.length === 0) return { query: queryText, results: [] };

  const result = await client.query(`
    SELECT
      c.id, c.content_type, c.source_system, c.content_text,
      c.content_json, c.confidence, c.network,
      1.0 as combined_score
    FROM content c
    WHERE lower(c.content_text) LIKE $1
      AND c.superseded_by IS NULL
    ORDER BY c.created_at DESC
    LIMIT $2
  `, [`%${includes[0]}%`, limit]);

  return {
    query: queryText,
    search_type: 'text',
    results: result.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      type: r.content_type,
      source: r.source_system,
      text: r.content_text,
      data: r.content_json,
      confidence: r.confidence,
      similarity: 1.0,
    })),
  };
}

// ─── networkClassify ───

async function networkClassify(args: Record<string, unknown>): Promise<CallToolResult> {
  const batchSize = (args.batch_size as number) || 100;
  const execute = (args.execute as boolean) || false;

  const client = await pool.connect();
  try {
    // Find records to classify based on their content_type
    const unclassified = await client.query<{
      id: number;
      content_type: string;
      content_text: string;
      network: string;
    }>(`
      SELECT id, content_type, content_text, network
      FROM content
      WHERE superseded_by IS NULL
      ORDER BY id
      LIMIT $1
    `, [batchSize]);

    const reclassifications: Array<{
      id: number;
      content_type: string;
      text_preview: string;
      from_network: string;
      to_network: string;
    }> = [];
    const networkCounts: Record<string, number> = { world: 0, experience: 0, belief: 0, skill: 0 };

    for (const row of unclassified.rows) {
      const correctNetwork = classifyNetwork(row.content_type, row.content_text);
      networkCounts[correctNetwork]++;

      if (correctNetwork !== row.network) {
        reclassifications.push({
          id: row.id,
          content_type: row.content_type,
          text_preview: row.content_text?.slice(0, 80) || '',
          from_network: row.network,
          to_network: correctNetwork,
        });
      }
    }

    if (!execute) {
      return jsonResult({
        mode: 'preview',
        scanned: unclassified.rows.length,
        would_reclassify: reclassifications.length,
        current_distribution: networkCounts,
        sample_reclassifications: reclassifications.slice(0, 20),
      });
    }

    // Execute reclassifications
    let reclassified = 0;
    for (const r of reclassifications) {
      await client.query('UPDATE content SET network = $1 WHERE id = $2', [r.to_network, r.id]);
      reclassified++;
    }

    // Also set belief_confidence for newly classified beliefs
    await client.query(`
      UPDATE content SET belief_confidence = 0.7
      WHERE network = 'belief' AND belief_confidence IS NULL AND superseded_by IS NULL
    `);

    // Set skill counters from access_count for newly classified skills
    await client.query(`
      UPDATE content SET skill_success_count = COALESCE(access_count, 0)
      WHERE network = 'skill' AND skill_success_count = 0 AND COALESCE(access_count, 0) > 0 AND superseded_by IS NULL
    `);

    return jsonResult({
      mode: 'execute',
      scanned: unclassified.rows.length,
      reclassified,
      distribution: networkCounts,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_network_search',
      description: 'Network-aware search. Query specific cognitive networks: world (facts), experience (events), belief (opinions/predictions with confidence), skill (proven patterns with success rates). Use network="all" for unified search.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          network: {
            type: 'string',
            enum: ['world', 'experience', 'belief', 'skill', 'all'],
            description: 'Which cognitive network to search (default: all)',
          },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
    handler: (args) => networkSearch(args),
  },
  {
    definition: {
      name: 'vision_network_classify',
      description: 'Classify content into cognitive networks (world/experience/belief/skill). Preview mode shows what would change, execute mode applies. Run after backfill or periodically.',
      inputSchema: {
        type: 'object',
        properties: {
          batch_size: { type: 'number', description: 'Records to process (default 100)' },
          execute: { type: 'boolean', description: 'If true, apply classifications. If false, preview only.' },
        },
      },
    },
    handler: (args) => networkClassify(args),
  },
];

export default tools;
