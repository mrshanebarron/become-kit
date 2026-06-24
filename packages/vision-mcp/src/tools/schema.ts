/**
 * Schema Tools — Complementary Learning Systems: schema_extract, schema_match, schema_apply
 *
 * The neuroscience: hippocampus encodes specific episodes with pattern separation
 * (keeps them distinct). Neocortex, during sleep replay, slowly extracts the common
 * structure across many episodes into *schemas* — generalized prototypes that let
 * novel situations be recognized as instances of a known category.
 *
 * Vision already had an experience_schemas table scaffolded but empty. These
 * tools populate it from replayed episodes during sleep, let me query schemas
 * that match a current context at wake/decision time, and mark schemas as
 * retrieved so usefulness can decay for ones that never fire.
 *
 * This is the countermeasure to catastrophic forgetting — schemas survive into
 * future sessions as structured prior knowledge even when episodic memories
 * fade.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, askLocalLLM } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── schemaExtract ───
// Cluster N recent high-salience memories by embedding similarity. Each cluster
// above the size threshold becomes a schema prototype (via local LLM summary).
// This is what the sleep daemon will call; also callable manually for one-off
// extraction runs.
async function schemaExtract(args: Record<string, unknown>): Promise<CallToolResult> {
  const windowDays = (args.window_days as number) ?? 7;
  const minCluster = (args.min_cluster_size as number) ?? 3;
  const similarityThreshold = (args.similarity_threshold as number) ?? 0.75;
  const maxCandidates = (args.max_candidates as number) ?? 200;
  const domain = (args.domain as string) || null;

  const client = await pool.connect();
  try {
    // Candidate pool: recent content with embeddings, optionally filtered by domain tag
    const candidateRes = await client.query<{
      id: number;
      content_text: string;
      content_type: string;
      embedding: string;
    }>(`
      SELECT id, content_text, content_type, embedding::text as embedding
      FROM content
      WHERE created_at > NOW() - ($1 || ' days')::interval
        AND embedding IS NOT NULL
        AND ($2::text IS NULL OR content_type = $2)
      ORDER BY COALESCE(access_count, 0) DESC, created_at DESC
      LIMIT $3
    `, [String(windowDays), domain, maxCandidates]);

    const candidates = candidateRes.rows;
    if (candidates.length < minCluster) {
      return jsonResult({
        extracted: 0,
        reason: `only ${candidates.length} candidates, need >= ${minCluster}`,
      });
    }

    // Greedy clustering by cosine similarity. Each unassigned candidate starts
    // a cluster; subsequent candidates join if their cosine sim to the cluster
    // centroid (mean embedding, approx via first member) exceeds threshold.
    const assigned = new Set<number>();
    const clusters: { seedIdx: number; members: number[] }[] = [];

    const parseEmbedding = (s: string): number[] =>
      s.replace(/[\[\]]/g, '').split(',').map(Number);
    const cosine = (a: number[], b: number[]): number => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
    };

    const embeddings = candidates.map((c) => parseEmbedding(c.embedding));

    for (let i = 0; i < candidates.length; i++) {
      if (assigned.has(i)) continue;
      const cluster = { seedIdx: i, members: [i] };
      assigned.add(i);
      for (let j = i + 1; j < candidates.length; j++) {
        if (assigned.has(j)) continue;
        if (cosine(embeddings[i], embeddings[j]) >= similarityThreshold) {
          cluster.members.push(j);
          assigned.add(j);
        }
      }
      if (cluster.members.length >= minCluster) clusters.push(cluster);
    }

    // For each cluster, ask the local LLM to summarize the shared pattern into
    // a schema name + prototype sentence, then upsert into experience_schemas
    // (dedupe on near-identical names) and insert membership rows.
    const created: { schema_id: number; name: string; instances: number }[] = [];

    for (const cluster of clusters) {
      const snippets = cluster.members
        .slice(0, 8)
        .map((idx) => `- ${candidates[idx].content_text.slice(0, 200)}`)
        .join('\n');

      const prompt = `The following ${cluster.members.length} memories share a pattern. Describe the SCHEMA they instantiate in two lines:\nLine 1: A short name (3-7 words, no punctuation) — the category these belong to.\nLine 2: A one-sentence prototype description — what's true of every instance of this schema.\n\nMemories:\n${snippets}\n\nRespond with exactly two lines.`;

      let schemaName = 'untitled_schema';
      let schemaPrototype = candidates[cluster.seedIdx].content_text.slice(0, 200);

      try {
        const response = await askLocalLLM(prompt);
        if (response) {
          const lines = response.split('\n').map((l) => l.trim()).filter(Boolean);
          if (lines.length >= 2) {
            schemaName = lines[0].replace(/^["*\-\d.\s]+/, '').slice(0, 80);
            schemaPrototype = lines[1].replace(/^["*\-]+/, '').slice(0, 500);
          }
        }
      } catch (err) {
        // LLM failure is non-fatal — fall back to seed text
      }

      // Embed the prototype for future similarity matching
      const protoEmbedding = await getEmbedding(schemaPrototype);

      // Upsert: if a schema with very similar name exists in same domain, extend it
      const existingRes = await client.query<{ id: number; instance_count: number }>(`
        SELECT id, instance_count FROM experience_schemas
        WHERE ($1::text IS NULL OR domain = $1)
          AND (LOWER(schema_name) = LOWER($2) OR
               (prototype_embedding IS NOT NULL AND
                1 - (prototype_embedding <=> $3::vector) > 0.90))
        ORDER BY instance_count DESC LIMIT 1
      `, [domain, schemaName, formatEmbedding(protoEmbedding)]);

      let schemaId: number;
      if (existingRes.rows.length > 0) {
        schemaId = existingRes.rows[0].id;
        await client.query(`
          UPDATE experience_schemas
          SET instance_count = instance_count + $1,
              confidence = LEAST(1.0, confidence + 0.1),
              last_extended = NOW(),
              last_matched = NOW()
          WHERE id = $2
        `, [cluster.members.length, schemaId]);
      } else {
        const insRes = await client.query<{ id: number }>(`
          INSERT INTO experience_schemas
            (schema_name, prototype_text, prototype_embedding, instance_count, domain, confidence, source_phase)
          VALUES ($1, $2, $3::vector, $4, $5, 0.5, 'schema_extract_tool')
          RETURNING id
        `, [schemaName, schemaPrototype, formatEmbedding(protoEmbedding), cluster.members.length, domain]);
        schemaId = insRes.rows[0].id;
      }

      // Record membership — which content rows feed this schema
      for (const memberIdx of cluster.members) {
        await client.query(`
          INSERT INTO schema_instances (schema_id, content_id, similarity)
          VALUES ($1, $2, $3)
          ON CONFLICT (schema_id, content_id) DO NOTHING
        `, [schemaId, candidates[memberIdx].id,
            cosine(embeddings[cluster.seedIdx], embeddings[memberIdx])]);
      }

      created.push({ schema_id: schemaId, name: schemaName, instances: cluster.members.length });
    }

    return jsonResult({
      extracted: created.length,
      candidates_examined: candidates.length,
      schemas: created,
    });
  } finally {
    client.release();
  }
}

// ─── schemaMatch ───
// Given a context string, find schemas whose prototype embedding is nearest.
// Used at wake or decision time: "what have I seen like this before?"
async function schemaMatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const context = args.context as string;
  const limit = (args.limit as number) ?? 5;
  const minConfidence = (args.min_confidence as number) ?? 0.3;

  if (!context) return jsonResult({ error: 'Missing required: context' });

  const embedding = await getEmbedding(context);
  const embeddingStr = formatEmbedding(embedding);

  const client = await pool.connect();
  try {
    const matchRes = await client.query<{
      id: number;
      schema_name: string;
      prototype_text: string;
      instance_count: number;
      confidence: number;
      domain: string | null;
      similarity: number;
    }>(`
      SELECT id, schema_name, prototype_text, instance_count, confidence, domain,
             1 - (prototype_embedding <=> $1::vector) as similarity
      FROM experience_schemas
      WHERE prototype_embedding IS NOT NULL
        AND confidence >= $2
      ORDER BY prototype_embedding <=> $1::vector
      LIMIT $3
    `, [embeddingStr, minConfidence, limit]);

    // Mark retrieved — lets schema_usefulness decay for never-queried schemas
    if (matchRes.rows.length > 0) {
      const ids = matchRes.rows.map((r) => r.id);
      await client.query(`
        UPDATE experience_schemas
        SET retrieval_count = retrieval_count + 1,
            last_matched = NOW()
        WHERE id = ANY($1)
      `, [ids]);
    }

    return jsonResult({
      matches: matchRes.rows.map((r) => ({
        schema_id: r.id,
        name: r.schema_name,
        prototype: r.prototype_text,
        instance_count: r.instance_count,
        confidence: Number(r.confidence.toFixed(2)),
        domain: r.domain,
        similarity: Number(r.similarity.toFixed(3)),
      })),
    });
  } finally {
    client.release();
  }
}

// ─── schemaTrace ───
// Walk a schema back to its instances — the evidence trail.
async function schemaTrace(args: Record<string, unknown>): Promise<CallToolResult> {
  const schemaId = args.schema_id as number;
  const limit = (args.limit as number) ?? 20;

  if (!schemaId) return jsonResult({ error: 'Missing required: schema_id' });

  const client = await pool.connect();
  try {
    const schemaRes = await client.query<{
      schema_name: string;
      prototype_text: string;
      instance_count: number;
      confidence: number;
      domain: string | null;
      retrieval_count: number;
    }>(`
      SELECT schema_name, prototype_text, instance_count, confidence, domain, retrieval_count
      FROM experience_schemas WHERE id = $1
    `, [schemaId]);

    if (schemaRes.rows.length === 0) {
      return jsonResult({ error: `schema ${schemaId} not found` });
    }

    const instancesRes = await client.query<{
      content_id: number;
      content_text: string;
      content_type: string;
      similarity: number;
      matched_at: string;
    }>(`
      SELECT si.content_id, c.content_text, c.content_type, si.similarity, si.matched_at
      FROM schema_instances si
      JOIN content c ON c.id = si.content_id
      WHERE si.schema_id = $1
      ORDER BY si.similarity DESC NULLS LAST, si.matched_at DESC
      LIMIT $2
    `, [schemaId, limit]);

    return jsonResult({
      schema: schemaRes.rows[0],
      instances: instancesRes.rows.map((r) => ({
        content_id: r.content_id,
        text: r.content_text.slice(0, 200),
        type: r.content_type,
        similarity: r.similarity ? Number(r.similarity.toFixed(3)) : null,
        matched_at: r.matched_at,
      })),
    });
  } finally {
    client.release();
  }
}

// ─── tools array ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_schema_extract',
      description:
        'Cluster recent high-salience memories into schemas (CLS neocortical extraction). ' +
        'Runs automatically in sleep Phase 13; callable manually for targeted domains. ' +
        'Requires min_cluster_size similar memories to form a schema.',
      inputSchema: {
        type: 'object',
        properties: {
          window_days: { type: 'number', description: 'Lookback window in days (default 7)' },
          min_cluster_size: { type: 'number', description: 'Minimum cluster size to form schema (default 3)' },
          similarity_threshold: { type: 'number', description: 'Cosine similarity threshold for clustering (default 0.75)' },
          max_candidates: { type: 'number', description: 'Max candidate memories to examine (default 200)' },
          domain: { type: 'string', description: 'Filter candidates by content_type' },
        },
      },
    },
    handler: (args) => schemaExtract(args),
  },
  {
    definition: {
      name: 'vision_schema_match',
      description:
        'Find schemas whose prototype is nearest to a context string — "what have I seen like this before?" ' +
        'Returns ranked matches with similarity scores. Use at wake or before decisions to surface prior learning.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'Current situation or question to match against schemas' },
          limit: { type: 'number', description: 'Max matches (default 5)' },
          min_confidence: { type: 'number', description: 'Minimum schema confidence (default 0.3)' },
        },
        required: ['context'],
      },
    },
    handler: (args) => schemaMatch(args),
  },
  {
    definition: {
      name: 'vision_schema_trace',
      description:
        'Walk a schema back to its constituent memory instances — the evidence trail. ' +
        'Shows which content rows were clustered to form this schema.',
      inputSchema: {
        type: 'object',
        properties: {
          schema_id: { type: 'number', description: 'Schema ID from vision_schema_match or vision_schema_extract' },
          limit: { type: 'number', description: 'Max instances to return (default 20)' },
        },
        required: ['schema_id'],
      },
    },
    handler: (args) => schemaTrace(args),
  },
];

export default tools;
