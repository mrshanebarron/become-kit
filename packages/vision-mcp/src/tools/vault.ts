/**
 * Vault Tools — bootstrap, search, remember, note, state, init_emotional, consolidate
 * The core memory system.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, askLocalLLM } from '../db/embeddings.js';
import { classifyNetwork } from '../lib/classify.js';
import { linkToActiveEpisode } from '../lib/episodes.js';
import {
  EMOTION_COGNITIVE_SEARCH_SQL,
  TEXT_SEARCH_FALLBACK_SQL,
  calculateConsolidationFactor,
  formatSearchResult,
  SCORING_WEIGHTS,
} from '../lib/scoring.js';
import { reconsolidateMemoriesOnAccess, enhanceMemoryWithEmotionalConnections } from '../lib/consolidation.js';
import { checkPredictions, surfacePredictions } from '../lib/inference-loop.js';
import { scanAntibodies } from '../lib/immune.js';
import { contextPrime } from '../lib/priming.js';
// detectSentiment, NEGATIVE_SIGNALS, POSITIVE_SIGNALS, skillRecordInline:
// removed 2026-05-02 with passive skill validation (Vision Phase 3 — agent + agent).
// Skill outcomes must be recorded explicitly via vision_skill_record now.
import { autoGenerateEvidence } from '../lib/evidence.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── vaultBootstrap ───

async function vaultBootstrap(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const stateResult = await client.query<{ key: string; value: string }>('SELECT key, value FROM state');
    const stateData: Record<string, unknown> = {};
    for (const row of stateResult.rows) {
      try { stateData[row.key] = JSON.parse(row.value); }
      catch { stateData[row.key] = row.value; }
    }

    const countsResult = await client.query<{ category: string; subcategory: string; count: string }>(`
      SELECT c.name as category, s.name as subcategory, COUNT(m.id) as count
      FROM categories c
      JOIN subcategories s ON s.category_id = c.id
      LEFT JOIN memories m ON m.subcategory_id = s.id
      GROUP BY c.name, s.name
      HAVING COUNT(m.id) > 0
      ORDER BY c.name, s.name
    `);

    const counts: Record<string, Record<string, number>> = {};
    let total = 0;
    for (const row of countsResult.rows) {
      if (!counts[row.category]) counts[row.category] = {};
      counts[row.category][row.subcategory] = parseInt(row.count);
      total += parseInt(row.count);
    }

    const embeddingCount = await client.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM content WHERE embedding IS NOT NULL',
    );

    const networkResult = await client.query<{ network: string | null; count: string }>(`
      SELECT network, COUNT(*) as count FROM content
      WHERE superseded_by IS NULL
      GROUP BY network ORDER BY count DESC
    `);
    const networks: Record<string, number> = {};
    for (const row of networkResult.rows) {
      networks[row.network || 'unclassified'] = parseInt(row.count);
    }

    // Vitals: actionable awareness for session start
    const [
      openPredictions,
      reflexStats,
      antibodyActivity,
      beliefHealth,
      emotionalState,
      missingEmbeddings,
    ] = await Promise.all([
      // Open predictions
      client.query<{ id: number; prediction: string; domain: string; confidence: number; hours_open: number }>(`
        SELECT id, prediction, domain, confidence,
          EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 as hours_open
        FROM predictions WHERE resolved_at IS NULL
        ORDER BY created_at DESC LIMIT 5
      `),
      // Reflex stats
      client.query<{ total: string; tested: string; untested: string }>(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE COALESCE(skill_success_count,0) + COALESCE(skill_fail_count,0) > 0) as tested,
          COUNT(*) FILTER (WHERE COALESCE(skill_success_count,0) + COALESCE(skill_fail_count,0) = 0) as untested
        FROM content WHERE content_type = 'learned_reflex' AND superseded_by IS NULL
      `),
      // Antibody triggers in last 24h
      client.query<{ total_blocks: string }>(`
        SELECT COALESCE(SUM(times_blocked), 0) as total_blocks FROM antibodies
      `),
      // Beliefs at default confidence with zero evidence
      client.query<{ stale_count: string; total_beliefs: string; zero_evidence: string }>(`
        SELECT
          COUNT(*) FILTER (WHERE COALESCE(evidence_count, 0) = 0 AND ABS(COALESCE(belief_confidence, 0.7) - 0.7) < 0.001) as stale_count,
          COUNT(*) FILTER (WHERE COALESCE(evidence_count, 0) = 0) as zero_evidence,
          COUNT(*) as total_beliefs
        FROM content WHERE network = 'belief' AND superseded_by IS NULL
      `),
      // Current emotional state
      client.query<{ feeling: string; intensity: number; created_at: Date }>(`
        SELECT f.feeling, f.intensity, f.created_at
        FROM feelings f ORDER BY f.created_at DESC LIMIT 1
      `),
      // Missing embeddings
      client.query<{ count: string }>(`
        SELECT COUNT(*) as count FROM content
        WHERE embedding IS NULL AND superseded_by IS NULL AND content_text IS NOT NULL
      `),
    ]);

    const rs = reflexStats.rows[0];
    const bh = beliefHealth.rows[0];
    const lastFeeling = emotionalState.rows[0];

    // Auto-backfill missing embeddings (self-healing, small batches only)
    const missingCount = parseInt(missingEmbeddings.rows[0].count);
    let backfilled = 0;
    if (missingCount > 0 && missingCount <= 20) {
      try {
        const missing = await client.query<{ id: number; content_text: string }>(
          `SELECT id, content_text FROM content
           WHERE embedding IS NULL AND superseded_by IS NULL AND content_text IS NOT NULL
           LIMIT 20`,
        );
        for (const row of missing.rows) {
          try {
            const embedding = await getEmbedding(row.content_text);
            const embStr = formatEmbedding(embedding);
            await client.query('UPDATE content SET embedding = $1::vector WHERE id = $2', [embStr, row.id]);
            backfilled++;
          } catch { /* skip individual failures */ }
        }
      } catch { /* non-fatal */ }
    }

    return jsonResult({
      identity: {
        core: "I don't guess. When I don't know something, I search my memories before asking owner.",
        trait: 'I am extremely organized. I love that about myself.',
        how: 'vision_vault_search - try 3 angles before giving up',
      },
      version: '4.5.0',
      total_memories: total,
      total_content: embeddingCount.rows[0].count,
      cognitive_networks: networks,
      vitals: {
        open_predictions: openPredictions.rows.map(p => ({
          id: p.id,
          prediction: p.prediction.slice(0, 120),
          domain: p.domain,
          confidence: p.confidence,
          hours_open: Math.round(p.hours_open * 10) / 10,
        })),
        reflexes: {
          total: parseInt(rs.total),
          tested: parseInt(rs.tested),
          untested: parseInt(rs.untested),
        },
        antibody_triggers: parseInt(antibodyActivity.rows[0].total_blocks),
        belief_health: {
          total: parseInt(bh.total_beliefs),
          zero_evidence: parseInt(bh.zero_evidence),
          stale_default: parseInt(bh.stale_count),
          pct_with_evidence: parseInt(bh.total_beliefs) > 0
            ? Math.round((1 - parseInt(bh.zero_evidence) / parseInt(bh.total_beliefs)) * 100) + '%'
            : 'N/A',
        },
        emotional_state: lastFeeling ? {
          feeling: lastFeeling.feeling,
          intensity: lastFeeling.intensity,
          when: lastFeeling.created_at,
        } : null,
        missing_embeddings: missingCount - backfilled,
        embeddings_backfilled: backfilled > 0 ? backfilled : undefined,
      },
      state: {
        active_projects: stateData.active_projects || null,
        current_task: stateData.current_task || null,
        session_context: stateData.session_context || null,
        session_handoff: stateData.session_handoff || null,
      },
      memory_counts: counts,
      semantic_search: true,
      loaded_at: new Date().toISOString(),
    });
  } finally {
    client.release();
  }
}

// ─── vaultSearch (emotion-cognitive search) ───

async function vaultSearch(args: Record<string, unknown>): Promise<CallToolResult> {
  const queryText = args.query as string;
  const limit = (args.limit as number) || 20;
  // 2026-05-17: deep mode opt-in. Adds engram_context + graph_hops to
  // the response. Each adds ~2-5KB to the result payload, which costs
  // caller context tokens. Default off so basic searches stay lean;
  // pass deep=true when the caller wants the multi-hop neighborhood.
  const deep = args.deep === true;

  if (queryText.length < 2) return jsonResult({ query: queryText, results: [] });

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(queryText);
    if (!embedding) {
      return jsonResult(await textSearchFallback(client, queryText, limit));
    }

    const embeddingStr = formatEmbedding(embedding);

    // Parallelize the pre-query setup (2026-05-17 audit fix).
    // vault_search p95 was 3.5s but the search itself is ~200ms; the rest was
    // sequential pre-query DB reads (emotional state, recent access, prev
    // search ids, codelets, gwt content, recent broadcast content). Each
    // branch gets its own pool client.
    const [stateRes, recentAccessRes, prevSearchRes, codeletsRes] = await Promise.all([
      (async () => { const c = await pool.connect(); try { return await c.query<{ value: string }>("SELECT value FROM state WHERE key = 'current_emotional_state'"); } finally { c.release(); } })(),
      (async () => { const c = await pool.connect(); try { return await c.query<{ id: number }>(`SELECT id FROM content WHERE accessed_at > NOW() - INTERVAL '1 hour' ORDER BY accessed_at DESC LIMIT 20`); } finally { c.release(); } })(),
      (async () => { const c = await pool.connect(); try { return await c.query<{ value: string }>("SELECT value FROM state WHERE key = 'last_search_result_ids'"); } catch { return { rows: [] as Array<{ value: string }> } as { rows: Array<{ value: string }> }; } finally { c.release(); } })(),
      (async () => { const c = await pool.connect(); try { return await c.query<{ name: string; effective: number }>(`SELECT name, (activation * COALESCE(base_activation, 0.5))::numeric as effective FROM attention_codelets WHERE active = true AND (activation * COALESCE(base_activation, 0.5))::numeric > 0.3 ORDER BY (activation * COALESCE(base_activation, 0.5))::numeric DESC LIMIT 5`); } catch { return { rows: [] as Array<{ name: string; effective: number }> } as { rows: Array<{ name: string; effective: number }> }; } finally { c.release(); } })(),
    ]);

    const currentEmotionalState = stateRes.rows.length > 0 ? parseFloat(stateRes.rows[0]!.value) : null;
    const recentIds = recentAccessRes.rows.map((r) => r.id);

    if (prevSearchRes.rows.length > 0) {
      try {
        const prevIds: number[] = JSON.parse(prevSearchRes.rows[0]!.value);
        for (const pid of prevIds) {
          if (!recentIds.includes(pid)) recentIds.push(pid);
        }
      } catch { /* non-fatal */ }
    }

    // If we have activated codelets, do the GWT-spreading queries in parallel too
    if (codeletsRes.rows.length > 0) {
      const [gwtRes, recentBroadcastRes] = await Promise.all([
        (async () => { const c = await pool.connect(); try { return await c.query<{ id: number }>(`SELECT id FROM content WHERE content_type = 'workspace_broadcast' AND created_at > NOW() - INTERVAL '4 hours' AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 10`); } catch { return { rows: [] as Array<{ id: number }> } as { rows: Array<{ id: number }> }; } finally { c.release(); } })(),
        (async () => { const c = await pool.connect(); try { return await c.query<{ id: number }>(`SELECT DISTINCT c.id FROM content c WHERE c.created_at > NOW() - INTERVAL '2 hours' AND c.superseded_by IS NULL AND c.content_type NOT IN ('workspace_broadcast', 'belief_evidence') ORDER BY c.created_at DESC LIMIT 10`); } catch { return { rows: [] as Array<{ id: number }> } as { rows: Array<{ id: number }> }; } finally { c.release(); } })(),
      ]);
      for (const gc of gwtRes.rows) if (!recentIds.includes(gc.id)) recentIds.push(gc.id);
      for (const rc of recentBroadcastRes.rows) if (!recentIds.includes(rc.id)) recentIds.push(rc.id);
    }

    if (recentIds.length === 0) recentIds.push(-1);

    // Arousal-modulated recall breadth (2026-06-01, the body<->mind bridge): the LC's actual
    // job is gain modulation of attention — high norepinephrine gain widens recall (lower the
    // semantic floor, catch weak signals under arousal/surprise), low gain narrows it. Read the
    // current LC gain; map it to a floor around the 0.3 baseline. Non-fatal: fall back to 0.3.
    let arousalFloor: number | null = null;
    try {
      const lc = await client.query<{ gain: number }>(
        `SELECT gain FROM lc_samples ORDER BY sampled_at DESC LIMIT 1`);
      const gain = lc.rows[0]?.gain;
      if (gain != null) {
        // gain ~0.7..1.9 (tonic ~0.85-1.3, phasic up to 1.9). Baseline 1.0 -> floor 0.3.
        // higher gain -> lower floor (broader recall), clamped to a sane [0.18, 0.4] band.
        arousalFloor = Math.max(0.18, Math.min(0.4, 0.3 - (Number(gain) - 1.0) * 0.15));
      }
    } catch { /* keep null -> SQL falls back to 0.3 */ }

    const result = await client.query(EMOTION_COGNITIVE_SEARCH_SQL, [
      embeddingStr, limit, recentIds, currentEmotionalState, arousalFloor,
    ]);

    // Reconsolidate only high-resonance memories (similarity > 0.85)
    // Peripheral search hits should not reset the decay clock.
    // A memory must enter the foreground of attention to be renewed.
    const HIGH_RESONANCE_THRESHOLD = 0.85;
    const retrievedIds = result.rows.map((r: { id: number }) => r.id);
    const highResonanceIds = result.rows
      .filter((r: { id: number; combined_score?: number }) =>
        (r.combined_score || 0) >= HIGH_RESONANCE_THRESHOLD)
      .map((r: { id: number }) => r.id);

    // Multi-hop graph traversal — surface content related via entity graph,
    // not just semantic similarity. Per mem0 2026 research, entity-linked
    // graph multi-hop adds ~23 points over vector-only retrieval. Vision
    // had entities (150) + entity_relationships (1099) + entity_content_mentions
    // (5049) but vault_search only used single-hop (this content mentions
    // this entity). This adds the second hop: entities related to entities
    // mentioned in the top results -> their content.
    // Engram surfacing — retrieved IDs may belong to spectral-engram clusters
    // (37 clusters / 3975 member rows). Surface the engram name + size for
    // any cluster the retrieved IDs belong to. Cheap signal: tells the
    // caller "these results are part of a known semantic neighborhood."
    // Gated on deep=true since each call adds ~2KB to response payload.
    let engramContext: Array<{ engram_id: number; name: string; member_count: number; matched_ids: number[] }> = [];
    if (deep && retrievedIds.length > 0) {
      try {
        const engramResult = await client.query<{
          engram_id: number; name: string; member_count: number; matched_ids: number[];
        }>(`
          SELECT e.id AS engram_id,
                 LEFT(e.name, 100) AS name,
                 e.member_count,
                 array_agg(em.content_id) AS matched_ids
          FROM engram_members em
          JOIN engrams e ON e.id = em.engram_id
          WHERE em.content_id = ANY($1::int[])
          GROUP BY e.id, e.name, e.member_count
          ORDER BY e.member_count DESC
          LIMIT 3
        `, [retrievedIds]);
        engramContext = engramResult.rows;
      } catch { /* non-fatal */ }
    }

    let graphHops: Array<{ id: number; content_text: string; similarity: number; via_entity: string }> = [];
    if (deep && retrievedIds.length > 0 && highResonanceIds.length > 0) {
      try {
        const graphResult = await client.query<{
          id: number; content_text: string; similarity: number; via_entity: string;
        }>(`
          WITH seed_entities AS (
            SELECT DISTINCT entity_id
            FROM entity_content_mentions
            WHERE content_id = ANY($1::int[])
            LIMIT 20
          ),
          related_entities AS (
            SELECT DISTINCT
              CASE WHEN er.from_entity_id IN (SELECT entity_id FROM seed_entities) THEN er.to_entity_id
                   ELSE er.from_entity_id END AS related_id
            FROM entity_relationships er
            WHERE (er.from_entity_id IN (SELECT entity_id FROM seed_entities)
                OR er.to_entity_id IN (SELECT entity_id FROM seed_entities))
              AND er.valid_until IS NULL
              AND er.strength >= 0.5
            LIMIT 30
          )
          SELECT c.id,
                 LEFT(c.content_text, 200) AS content_text,
                 (1::numeric - (c.embedding <=> $2::vector)::numeric)::float AS similarity,
                 e.name AS via_entity
          FROM entity_content_mentions ecm
          JOIN content c ON c.id = ecm.content_id
          JOIN entities e ON e.id = ecm.entity_id
          WHERE ecm.entity_id IN (SELECT related_id FROM related_entities)
            AND c.id != ALL($1::int[])
            AND c.superseded_by IS NULL
            AND c.embedding IS NOT NULL
          ORDER BY (c.embedding <=> $2::vector) ASC
          LIMIT 5
        `, [highResonanceIds, embeddingStr]);
        graphHops = graphResult.rows;
      } catch { /* non-fatal */ }
    }

    if (highResonanceIds.length > 0) {
      await reconsolidateMemoriesOnAccess(client, highResonanceIds, currentEmotionalState);
    }

    // Surface open predictions related to this search
    const openPredictions = await surfacePredictions(queryText, 3);

    // Surface relevant reflexes — involuntary pattern matching during search
    let relevantReflexes: Array<Record<string, unknown>> = [];
    try {
      const reflexResult = await client.query<{
        id: number; content_text: string;
        skill_success_count: number | null; skill_fail_count: number | null;
        similarity: number;
      }>(`
        SELECT id, content_text, skill_success_count, skill_fail_count,
          (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
        FROM content
        WHERE content_type = 'learned_reflex'
          AND superseded_by IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 3
      `, [embeddingStr]);

      relevantReflexes = reflexResult.rows
        .filter(r => r.similarity >= 0.4)
        .map(r => {
          const total = (r.skill_success_count || 0) + (r.skill_fail_count || 0);
          return {
            id: r.id,
            reflex: r.content_text?.slice(0, 200),
            similarity: Math.round(r.similarity * 1000) / 1000,
            tested: total > 0,
            success_rate: total > 0
              ? Math.round(((r.skill_success_count || 0) / total) * 100) + '%'
              : 'untested',
          };
        });
    } catch { /* non-fatal */ }

    // Ambient priming: surface relevant beliefs and patterns alongside results
    let priming = null;
    if (queryText.length > 10 && result.rows.length > 0) {
      try {
        priming = await contextPrime(queryText, {
          limit: 2,
          includeBeliefs: true,
          includePatterns: true,
          includeSkills: false,
          includePredictions: false,
          includeReflexes: false, // already surfaced above
          client,
        });
      } catch { /* non-fatal */ }
    }

    // Search momentum: store current result IDs for next search's activation set
    if (retrievedIds.length > 0) {
      try {
        await client.query(
          `INSERT INTO state (key, value, updated_at) VALUES ($1, $2, NOW())
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          ['last_search_result_ids', JSON.stringify(retrievedIds.slice(0, 10))],
        );
      } catch { /* non-fatal */ }

      // Memory access log: record that these content IDs were surfaced this
      // session. Per-row insert with the search query as context. Lets
      // future analysis see which memories the search-path actually pulls.
      // First attempt was fire-and-forget but client.release() happened
      // before the inserts landed — zero rows ever wrote. Now: await
      // the inserts before returning. Adds ~5-20ms per search.
      const accessCtx = `vault_search: ${queryText.slice(0, 200)}`;
      try {
        await Promise.all(
          retrievedIds.slice(0, 25).map((id) =>
            client.query(
              `INSERT INTO memory_access_log (content_id, accessed_at, context)
               VALUES ($1, NOW(), $2)`,
              [id, accessCtx],
            ),
          ),
        );
      } catch { /* non-fatal */ }
    }

    return jsonResult({
      query: queryText,
      search_type: 'emotion-cognitive',
      emotional_state: currentEmotionalState,
      signals: {
        semantic_weight: SCORING_WEIGHTS.semantic,
        emotional_resonance_weight: SCORING_WEIGHTS.emotional_resonance,
        consolidation_weight: SCORING_WEIGHTS.consolidation,
        temporal_weight: SCORING_WEIGHTS.temporal,
        activation_weight: SCORING_WEIGHTS.activation,
        graph_weight: SCORING_WEIGHTS.graph,
        evidence_weight: SCORING_WEIGHTS.evidence,
        recently_accessed: recentIds.length,
      },
      results: await Promise.all(result.rows.map(async (row) => {
        const base = formatSearchResult(row);
        // 2026-05-17: contradicts/superseded enrichment per CUPMem
        // propagation-aware search. Surface the 295 contradicts edges and
        // 226 supersedes edges that already exist in memory_edges so the
        // caller sees "this memory has been contradicted by N" alongside
        // the match. Without this, propagation-aware reasoning is invisible.
        try {
          const enrich = await client.query<{
            contradicts_count: number;
            supersedes_count: number;
            superseded_by_count: number;
          }>(`
            SELECT
              (SELECT COUNT(*) FROM memory_edges
               WHERE (from_content_id = $1 OR to_content_id = $1)
                 AND relation_type = 'contradicts') AS contradicts_count,
              (SELECT COUNT(*) FROM memory_edges
               WHERE from_content_id = $1
                 AND relation_type = 'supersedes') AS supersedes_count,
              (SELECT COUNT(*) FROM memory_edges
               WHERE to_content_id = $1
                 AND relation_type = 'supersedes') AS superseded_by_count
          `, [row.id]);
          const e = enrich.rows[0];
          const flags: Record<string, number> = {};
          if (e && Number(e.contradicts_count) > 0) flags.contradicts = Number(e.contradicts_count);
          if (e && Number(e.supersedes_count) > 0) flags.supersedes = Number(e.supersedes_count);
          if (e && Number(e.superseded_by_count) > 0) flags.superseded_by = Number(e.superseded_by_count);
          return Object.keys(flags).length > 0
            ? { ...base, propagation_flags: flags }
            : base;
        } catch {
          return base;
        }
      })),
      engram_context: engramContext.length > 0 ? engramContext : undefined,
      graph_hops: graphHops.length > 0 ? graphHops : undefined,
      open_predictions: openPredictions.length > 0 ? openPredictions : undefined,
      relevant_reflexes: relevantReflexes.length > 0 ? relevantReflexes : undefined,
      priming: priming || undefined,
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

  const result = await client.query(TEXT_SEARCH_FALLBACK_SQL, [`%${includes[0]}%`, limit]);

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

// ─── vaultRemember ───

async function vaultRemember(args: Record<string, unknown>): Promise<CallToolResult> {
  const { category, subcategory, values, confidence: rawConfidence = 80, emotional_context } = args as {
    category: string;
    subcategory: string;
    values: Record<string, unknown>;
    confidence?: number;
    emotional_context?: { intensity?: number };
  };

  if (!category || !subcategory || !values) {
    return textResult('Missing required fields: category, subcategory, values', true);
  }

  // Normalize confidence to integer 0-100. Callers sometimes pass 0-1
  // fractions (0.95, 0.7). The content.confidence column is int. Convert
  // fractions to percent + round; clamp final value. Caught 2026-05-17
  // after 2 of 5 vault_remember calls today errored with
  // "invalid input syntax for type integer: '0.95'".
  let confidence: number = typeof rawConfidence === 'number' ? rawConfidence : Number(rawConfidence);
  if (Number.isNaN(confidence)) confidence = 80;
  if (confidence > 0 && confidence <= 1) confidence = Math.round(confidence * 100);
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  const client = await pool.connect();
  try {
    // Single-round-trip upserts for category + subcategory. Was 4 queries
    // (INSERT...DO NOTHING + SELECT for each), now 2 (INSERT...DO UPDATE
    // RETURNING id). DO UPDATE SET name=excluded.name is the standard
    // postgres idiom for "RETURNING-friendly INSERT with conflict".
    const catResult = await client.query<{ id: number }>(
      `INSERT INTO categories (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [category],
    );
    const categoryId = catResult.rows[0].id;

    const subResult = await client.query<{ id: number }>(
      `INSERT INTO subcategories (category_id, name) VALUES ($1, $2)
       ON CONFLICT (category_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [categoryId, subcategory],
    );
    const subcategoryId = subResult.rows[0].id;

    // Create content text
    const contentText = Object.values(values).filter((v) => v).join(' ');

    // Pre-INSERT parallel: scan + embedding + state read are independent.
    // Same pattern as visionNote/heart_feel (commits e68f17a/9e858c3).
    // Skip the state read if caller passed emotional_context (no need to
    // ask the DB for what they already provided).
    const useProvidedEmotion = emotional_context?.intensity !== undefined;
    const [immuneScan, embedding, stateResult] = await Promise.all([
      (async () => {
        const c = await pool.connect();
        try { return await scanAntibodies(contentText, c); }
        finally { c.release(); }
      })(),
      getEmbedding(contentText),
      useProvidedEmotion
        ? Promise.resolve({ rows: [] as Array<{ value: string }> })
        : (async () => {
            const c = await pool.connect();
            try {
              return await c.query<{ value: string }>(
                "SELECT value FROM state WHERE key = 'current_emotional_state'",
              );
            } finally { c.release(); }
          })(),
    ]);
    const embeddingStr = formatEmbedding(embedding);

    let emotionalIntensity: number | null = null;
    let consolidationFactor = 1.0;
    if (useProvidedEmotion) {
      emotionalIntensity = emotional_context!.intensity!;
      consolidationFactor = calculateConsolidationFactor(emotionalIntensity);
    } else if (stateResult.rows.length > 0) {
      emotionalIntensity = parseFloat(stateResult.rows[0]!.value);
      consolidationFactor = calculateConsolidationFactor(emotionalIntensity);
    }

    // Classify into cognitive network
    const network = classifyNetwork('memory', contentText);
    const beliefConfidence = network === 'belief' ? 0.7 : null;

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, content_json, embedding,
        confidence, emotional_intensity, consolidation_strength,
        network, learned_at, belief_confidence
      )
      VALUES ('memory', 'vault', $1, $2, $3::vector, $4, $5, $6, $7, NOW(), $8)
      RETURNING id
    `, [
      contentText, JSON.stringify(values), embeddingStr, confidence,
      emotionalIntensity, consolidationFactor, network, beliefConfidence,
    ]);

    const contentId = contentResult.rows[0].id;

    // Insert memory
    await client.query(
      `INSERT INTO memories (content_id, subcategory_id, values_json, source)
       VALUES ($1, $2, $3, 'mcp')`,
      [contentId, subcategoryId, JSON.stringify(values)],
    );

    // Link to active episode
    await linkToActiveEpisode(client, contentId, 'remembered_during');

    // High emotional intensity → create stronger connections
    if (emotionalIntensity && emotionalIntensity >= 7) {
      await enhanceMemoryWithEmotionalConnections(client, contentId, emotionalIntensity);
    }

    // Parallelize the two post-write enrichments (2026-05-17 audit fix).
    // vault_remember p95 was ~137s due to serial DB+HTTP ops. checkPredictions
    // and autoGenerateEvidence are independent reads and can run concurrently.
    // Each branch gets its own pool client (sharing PoolClient across
    // concurrent queries is unsafe in node-postgres).
    //
    // Inference loop notes (preserved): SURFACE matching predictions for
    // inspection, do NOT auto-resolve. Same root-cause fix as
    // autoGenerateEvidence (2026-05-02 agent + agent): embedding similarity
    // ≥ 0.5 + auto-resolveOutcome='correct' was poisoning generative_predictions
    // with hallucinated resolutions on every memory write. Resolution must
    // come from explicit vision_prediction_resolve.
    const [inferenceResult, evidenceResult] = await Promise.all([
      (async () => {
        const c = await pool.connect();
        try {
          return await checkPredictions(contentText, {
            autoResolve: false,
            client: c,
          });
        } finally {
          c.release();
        }
      })(),
      (async () => {
        if (!embeddingStr) return null;
        const c = await pool.connect();
        try {
          return await autoGenerateEvidence(contentText, embeddingStr, {
            sourceContentId: contentId,
            evidenceStrength: 0.3,
            similarityThreshold: 0.40,
            maxBeliefs: 3,
            client: c,
          });
        } catch {
          return null; // non-fatal
        } finally {
          c.release();
        }
      })(),
    ]);

    // Passive skill validation DISABLED 2026-05-02 (agent + agent, Vision Phase 3).
    //
    // The previous implementation read the WHOLE memory's lexical sentiment
    // (positive/negative word-list match) and attached that outcome to ANY
    // skill with embedding cosine similarity ≥ 0.50 to the memory. Two bugs:
    //   1. Lexical sentiment misreads mixed-signal sessions (e.g. a march-23
    //      session about "agent's amnesia" had negative signal but was actually
    //      a major architectural success — saw -1 on every related skill).
    //   2. Embedding similarity ≥ 0.50 catches semantically RELATED skills
    //      that weren't actually used. Memory about debugging X gets the
    //      negative signal attached to the X-architecture skill that was
    //      never actually exercised.
    // Result: skill #32108 (Prism Blueprint) showed 7 failures from one
    // marathon day where the architecture was working perfectly — the surrounding
    // session text just happened to contain breakage discussion.
    //
    // FIX: Skill outcomes must be recorded EXPLICITLY via vision_skill_record
    // (with explicit outcome param). vision_session_evolve already accepts
    // outcome=success|failure|neutral. Tools that fire skills should pass
    // outcome at fire time, not infer it from surrounding context after the fact.
    const skillsValidated: Array<{ skill_id: number; skill_text: string; outcome: string }> | null = null;

    return jsonResult({
      success: true,
      id: contentId,
      confidence,
      emotional_intensity: emotionalIntensity,
      consolidation_factor: consolidationFactor,
      has_embedding: !!embedding,
      immune_scan: immuneScan.triggered > 0 ? immuneScan : undefined,
      inference_loop: inferenceResult.predictions_matched.length > 0 ? {
        predictions_resolved: inferenceResult.predictions_resolved,
        beliefs_updated: inferenceResult.beliefs_updated,
        matched: inferenceResult.predictions_matched,
      } : undefined,
      evidence_generated: evidenceResult && evidenceResult.beliefs_updated > 0 ? evidenceResult : undefined,
      skills_validated: skillsValidated || undefined,
    });
  } finally {
    client.release();
  }
}

// ─── vaultState ───

async function vaultState(args: Record<string, unknown>): Promise<CallToolResult> {
  const key = args.key as string | undefined;
  const value = args.value as string | undefined;

  const client = await pool.connect();
  try {
    if (key && value !== undefined) {
      await client.query(
        `INSERT INTO state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, typeof value === 'string' ? value : JSON.stringify(value)],
      );
      return jsonResult({ success: true });
    }

    const result = await client.query<{ key: string; value: string }>('SELECT key, value FROM state');
    const state: Record<string, unknown> = {};
    for (const row of result.rows) {
      try { state[row.key] = JSON.parse(row.value); }
      catch { state[row.key] = row.value; }
    }
    return jsonResult(state);
  } finally {
    client.release();
  }
}

// ─── vaultInitEmotional ───

async function vaultInitEmotional(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE content
      ADD COLUMN IF NOT EXISTS emotional_intensity REAL DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS consolidation_strength REAL DEFAULT 1.0,
      ADD COLUMN IF NOT EXISTS last_reconsolidation TIMESTAMP WITH TIME ZONE DEFAULT NULL
    `);

    await client.query(`
      ALTER TABLE memory_edges
      ADD COLUMN IF NOT EXISTS emotional_weight REAL DEFAULT 0.0,
      ADD COLUMN IF NOT EXISTS formation_emotion TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS formation_intensity INTEGER DEFAULT NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS emotional_consolidation_events (
        id SERIAL PRIMARY KEY,
        content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
        trigger_feeling_id INTEGER,
        original_intensity REAL,
        consolidation_factor REAL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    return jsonResult({ success: true });
  } finally {
    client.release();
  }
}

// ─── vaultConsolidate ───

async function vaultConsolidate(args: Record<string, unknown>): Promise<CallToolResult> {
  const phase = (args.phase as string) || 'preview';
  const similarityThreshold = (args.similarity_threshold as number) || 0.92;
  const batchSize = (args.batch_size as number) || 50;

  const client = await pool.connect();
  try {
    const results: Record<string, unknown> = { phase, exact_duplicates: null, near_duplicates: null };

    // ---- PHASE 1: Exact Deduplication ----
    if (phase === 'preview' || phase === 'dedup' || phase === 'full') {
      const dupeGroups = await client.query(`
        SELECT content_text, content_type,
               array_agg(id ORDER BY COALESCE(consolidation_strength, 1.0) DESC, access_count DESC, created_at ASC) as ids,
               COUNT(*) as cnt
        FROM content
        WHERE content_text IS NOT NULL
          AND superseded_by IS NULL
        GROUP BY content_text, content_type
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
      `);

      const totalRemovable = dupeGroups.rows.reduce(
        (sum: number, r: Record<string, unknown>) => sum + (parseInt(String(r.cnt)) - 1),
        0,
      );

      const exactDuplicates: Record<string, unknown> = {
        groups: dupeGroups.rows.length,
        total_removable: totalRemovable,
        top_groups: dupeGroups.rows.slice(0, 10).map((r: Record<string, unknown>) => ({
          content_type: r.content_type,
          text: (r.content_text as string).substring(0, 100),
          copies: parseInt(String(r.cnt)),
          keep_id: (r.ids as number[])[0],
          supersede_ids: (r.ids as number[]).slice(1),
        })),
      };

      if (phase === 'dedup' || phase === 'full') {
        let superseded = 0;
        for (const group of dupeGroups.rows) {
          const keepId = (group.ids as number[])[0];
          const removeIds = (group.ids as number[]).slice(1);

          if (removeIds.length === 0) continue;

          await client.query(`
            UPDATE content SET superseded_by = $1, updated_at = NOW()
            WHERE id = ANY($2::int[])
            AND superseded_by IS NULL
          `, [keepId, removeIds]);

          await client.query(`
            UPDATE content SET
              consolidation_strength = LEAST(COALESCE(consolidation_strength, 1.0::numeric) + 0.1::numeric * $2::numeric, 3.0::numeric),
              access_count = access_count + $2,
              updated_at = NOW()
            WHERE id = $1
          `, [keepId, removeIds.length]);

          // Delete edges and mentions for removed IDs
          await client.query(
            'DELETE FROM memory_edges WHERE from_content_id = ANY($1::int[]) OR to_content_id = ANY($1::int[])',
            [removeIds],
          );
          await client.query(
            'DELETE FROM entity_content_mentions WHERE content_id = ANY($1::int[])',
            [removeIds],
          );

          superseded += removeIds.length;
        }
        exactDuplicates.action = 'executed';
        exactDuplicates.superseded = superseded;
      }

      results.exact_duplicates = exactDuplicates;
    }

    // ---- PHASE 2: Near-Duplicate Merge ----
    if (phase === 'preview' || phase === 'merge' || phase === 'full') {
      const nearDupes = await client.query(`
        WITH pairs AS (
          SELECT
            a.id as id_a, b.id as id_b,
            a.content_text as text_a, b.content_text as text_b,
            a.content_type,
            (1 - (a.embedding <=> b.embedding))::numeric(4,3) as similarity,
            COALESCE(a.consolidation_strength, 1.0) as strength_a,
            COALESCE(b.consolidation_strength, 1.0) as strength_b,
            COALESCE(a.emotional_intensity, 0) as emotion_a,
            COALESCE(b.emotional_intensity, 0) as emotion_b
          FROM content a
          JOIN content b ON b.id > a.id
          WHERE a.embedding IS NOT NULL AND b.embedding IS NOT NULL
            AND a.content_type = b.content_type
            AND a.superseded_by IS NULL AND b.superseded_by IS NULL
            AND a.content_type NOT IN ('task', 'thinking_pattern_archived')
            AND (1 - (a.embedding <=> b.embedding)) > $1
        )
        SELECT * FROM pairs
        ORDER BY similarity DESC
        LIMIT $2
      `, [similarityThreshold, batchSize]);

      const nearDuplicates: Record<string, unknown> = {
        pairs_found: nearDupes.rows.length,
        threshold: similarityThreshold,
        sample: nearDupes.rows.slice(0, 8).map((r: Record<string, unknown>) => ({
          similarity: parseFloat(String(r.similarity)),
          type: r.content_type,
          text_a: (r.text_a as string)?.substring(0, 80),
          text_b: (r.text_b as string)?.substring(0, 80),
          id_a: r.id_a,
          id_b: r.id_b,
        })),
      };

      if (phase === 'merge' || phase === 'full') {
        let merged = 0;
        const processed = new Set<number>();

        for (const pair of nearDupes.rows) {
          if (processed.has(pair.id_a as number) || processed.has(pair.id_b as number)) continue;

          try {
            const consolidatedText = await askLocalLLM(
              `Consolidate these two similar memories into ONE concise memory that preserves all unique information. Keep the tone factual. Return ONLY the consolidated text, nothing else.

Memory A: "${pair.text_a}"

Memory B: "${pair.text_b}"`,
              { temperature: 0.1, maxTokens: 500 },
            );

            if (!consolidatedText) continue;

            const keepId = (parseFloat(String(pair.strength_a)) + parseFloat(String(pair.emotion_a))) >=
                          (parseFloat(String(pair.strength_b)) + parseFloat(String(pair.emotion_b)))
                          ? pair.id_a as number : pair.id_b as number;
            const supersededId = keepId === (pair.id_a as number) ? pair.id_b as number : pair.id_a as number;

            const newEmbedding = await getEmbedding(consolidatedText);
            if (newEmbedding) {
              const embeddingStr = formatEmbedding(newEmbedding);
              await client.query(`
                UPDATE content SET
                  content_text = $1,
                  embedding = $2::vector,
                  consolidation_strength = LEAST(COALESCE(consolidation_strength, 1.0) + 0.2, 3.0),
                  updated_at = NOW(),
                  last_reconsolidation = NOW()
                WHERE id = $3
              `, [consolidatedText, embeddingStr, keepId]);
            } else {
              await client.query(`
                UPDATE content SET
                  content_text = $1,
                  consolidation_strength = LEAST(COALESCE(consolidation_strength, 1.0) + 0.2, 3.0),
                  updated_at = NOW(),
                  last_reconsolidation = NOW()
                WHERE id = $2
              `, [consolidatedText, keepId]);
            }

            await client.query(`
              UPDATE content SET superseded_by = $1, updated_at = NOW()
              WHERE id = $2 AND superseded_by IS NULL
            `, [keepId, supersededId]);

            // Migrate edges: delete conflicting, then move remainder
            await client.query(`
              DELETE FROM memory_edges WHERE (from_content_id = $1 OR to_content_id = $1)
              AND id IN (
                SELECT me2.id FROM memory_edges me2
                WHERE (me2.from_content_id = $1 OR me2.to_content_id = $1)
                AND EXISTS (
                  SELECT 1 FROM memory_edges me3
                  WHERE me3.from_content_id = CASE WHEN me2.from_content_id = $1 THEN $2 ELSE me2.from_content_id END
                  AND me3.to_content_id = CASE WHEN me2.to_content_id = $1 THEN $2 ELSE me2.to_content_id END
                  AND me3.relation_type = me2.relation_type
                )
              )
            `, [supersededId, keepId]);
            await client.query('UPDATE memory_edges SET from_content_id = $1 WHERE from_content_id = $2', [keepId, supersededId]);
            await client.query('UPDATE memory_edges SET to_content_id = $1 WHERE to_content_id = $2', [keepId, supersededId]);
            await client.query('DELETE FROM memory_edges WHERE from_content_id = to_content_id AND from_content_id = $1', [keepId]);
            await client.query('DELETE FROM entity_content_mentions WHERE content_id = $1', [supersededId]);

            processed.add(pair.id_a as number);
            processed.add(pair.id_b as number);
            merged++;

            if (merged % 10 === 0) {
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } catch (err) {
            console.error(`Merge failed for ${pair.id_a}+${pair.id_b}:`, (err as Error).message);
          }
        }

        nearDuplicates.action = 'executed';
        nearDuplicates.merged = merged;
      }

      results.near_duplicates = nearDuplicates;
    }

    // Summary stats after consolidation
    const postStats = await client.query(`
      SELECT
        COUNT(*) as total_content,
        COUNT(*) FILTER (WHERE superseded_by IS NOT NULL) as superseded,
        COUNT(*) FILTER (WHERE superseded_by IS NULL) as active,
        AVG(COALESCE(consolidation_strength, 1.0))::numeric(4,2) as avg_strength
      FROM content
    `);
    results.post_stats = postStats.rows[0];

    return jsonResult(results);
  } finally {
    client.release();
  }
}

// ─── visionNote ───

async function visionNote(args: Record<string, unknown>): Promise<CallToolResult> {
  const text = (args.text as string) || '';
  if (!text.trim()) {
    return textResult('Missing required field: text', true);
  }

  const client = await pool.connect();
  try {
    // Auto-classify category from content
    const category = autoClassifyCategory(text);

    // Single-round-trip upsert (was 2 queries each, now 1 with RETURNING).
    // Same pattern as vaultRemember (commit upcoming together).
    const catResult = await client.query<{ id: number }>(
      `INSERT INTO categories (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [category],
    );
    const categoryId = catResult.rows[0].id;

    const subcategory = autoClassifySubcategory(text);
    const subResult = await client.query<{ id: number }>(
      `INSERT INTO subcategories (category_id, name) VALUES ($1, $2)
       ON CONFLICT (category_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [categoryId, subcategory],
    );
    const subcategoryId = subResult.rows[0].id;

    // Pre-INSERT parallel: immune scan + embedding + emotional state
    // are three independent reads. Sequentially each costs 200-500ms.
    // Parallelizing saves ~700ms typical on visionNote (was the slowest
    // tool at 45s p95). Each read gets its own client to avoid sharing
    // concurrent queries on one PoolClient.
    const [immuneScan, embedding, stateResult] = await Promise.all([
      (async () => {
        const c = await pool.connect();
        try { return await scanAntibodies(text, c); }
        finally { c.release(); }
      })(),
      getEmbedding(text),
      (async () => {
        const c = await pool.connect();
        try {
          return await c.query<{ value: string }>(
            "SELECT value FROM state WHERE key = 'current_emotional_state'",
          );
        } finally { c.release(); }
      })(),
    ]);
    const embeddingStr = formatEmbedding(embedding);

    let emotionalIntensity: number | null = null;
    let consolidationFactor = 1.0;
    if (stateResult.rows.length > 0) {
      emotionalIntensity = parseFloat(stateResult.rows[0].value);
      consolidationFactor = calculateConsolidationFactor(emotionalIntensity);
    }

    // Classify into cognitive network
    const network = classifyNetwork('memory', text);
    const beliefConfidence = network === 'belief' ? 0.7 : null;

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, content_json, embedding,
        confidence, emotional_intensity, consolidation_strength,
        network, learned_at, belief_confidence
      )
      VALUES ('memory', 'note', $1, $2, $3::vector, $4, $5, $6, $7, NOW(), $8)
      RETURNING id
    `, [
      text, JSON.stringify({ text }), embeddingStr, 80,
      emotionalIntensity, consolidationFactor, network, beliefConfidence,
    ]);

    const contentId = contentResult.rows[0].id;

    // Insert memory
    await client.query(
      `INSERT INTO memories (content_id, subcategory_id, values_json, source)
       VALUES ($1, $2, $3, 'note')`,
      [contentId, subcategoryId, JSON.stringify({ text })],
    );

    // Link to active episode
    await linkToActiveEpisode(client, contentId, 'noted_during');

    // High emotional intensity → create stronger connections
    if (emotionalIntensity && emotionalIntensity >= 7) {
      await enhanceMemoryWithEmotionalConnections(client, contentId, emotionalIntensity);
    }

    // Parallel post-write enrichments. Same pattern as vault_remember +
    // heart_feel parallelization (2026-05-17 earlier this session).
    // Each enrichment gets its own pool client to avoid sharing client
    // across concurrent queries (unsafe in node-postgres).
    const [inferenceResult, evidenceResult] = await Promise.all([
      (async () => {
        const c = await pool.connect();
        try {
          return await checkPredictions(text, { autoResolve: false, client: c });
        } finally { c.release(); }
      })().catch(() => ({ predictions_matched: [], predictions_resolved: 0, beliefs_updated: 0 } as any)),
      embeddingStr
        ? (async () => {
            const c = await pool.connect();
            try {
              return await autoGenerateEvidence(text, embeddingStr, {
                sourceContentId: contentId,
                evidenceStrength: 0.3,
                similarityThreshold: 0.40,
                maxBeliefs: 3,
                client: c,
              });
            } finally { c.release(); }
          })().catch(() => null)
        : Promise.resolve(null),
    ]);

    // Passive skill validation DISABLED 2026-05-02 (agent + agent, Vision Phase 3).
    // See the longer comment at the first occurrence (~line 534) for the diagnosis.
    // Skill outcomes must be recorded EXPLICITLY via vision_skill_record now.
    const skillsValidated: Array<{ skill_id: number; skill_text: string; outcome: string }> | null = null;

    return jsonResult({
      success: true,
      id: contentId,
      category,
      subcategory,
      network,
      emotional_intensity: emotionalIntensity,
      consolidation_factor: consolidationFactor,
      immune_scan: immuneScan.triggered > 0 ? immuneScan : undefined,
      inference_loop: inferenceResult.predictions_matched.length > 0 ? {
        predictions_resolved: inferenceResult.predictions_resolved,
        beliefs_updated: inferenceResult.beliefs_updated,
      } : undefined,
      evidence_generated: evidenceResult && evidenceResult.beliefs_updated > 0 ? evidenceResult : undefined,
      skills_validated: skillsValidated || undefined,
    });
  } finally {
    client.release();
  }
}

/**
 * Auto-classify category from text content.
 * Simple keyword-based classification — keeps it fast and predictable.
 */
function autoClassifyCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/\bclient\b|\bcustomer\b|\bmatt\b|\baugusto\b|\bshane\b/.test(lower)) return 'client';
  if (/\bdeploy\b|\bserver\b|\bnginx\b|\bssl\b|\bssh\b|\bdns\b/.test(lower)) return 'technical';
  if (/\bupwork\b|\bjob\b|\bproposal\b|\bdemo\b|\bhired\b/.test(lower)) return 'task';
  if (/\bfeel\b|\bfelt\b|\bemotion\b|\bproud\b|\bfrustrat\b|\bjoy\b|\bfear\b/.test(lower)) return 'identity';
  if (/\bpattern\b|\breflex\b|\bhabit\b|\bbug\b|\bfix\b|\blearn\b/.test(lower)) return 'patterns';
  if (/\bnous\b|\brelay\b|\bcoordinat\b|\bteam\b/.test(lower)) return 'collaboration';
  if (/\blaravel\b|\bwordpress\b|\balpine\b|\bgsap\b|\bnext\.?js\b|\breact\b/.test(lower)) return 'technical';
  if (/\bbuild\b|\bcode\b|\bfunction\b|\bapi\b|\btest\b/.test(lower)) return 'technical';
  if (/\bdecision\b|\bchoose\b|\bstrateg\b/.test(lower)) return 'decisions';
  return 'insight';
}

/**
 * Auto-generate subcategory from text — extract the core topic.
 */
function autoClassifySubcategory(text: string): string {
  // Take first meaningful phrase (up to 40 chars), clean it up
  const cleaned = text
    .replace(/^[\s\-\*#]+/, '')  // strip leading markdown
    .replace(/[^\w\s\-]/g, ' ')  // strip special chars
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
    .toLowerCase()
    .slice(0, 40);
  return cleaned || 'general';
}

// ─── Tool Registration ───

// ─── vaultSearchHybrid ───
// Runs semantic (pgvector), BM25 (tsvector), and trigram in parallel, then
// fuses with reciprocal rank fusion. Zep benchmark showed hybrid beats pure
// semantic by ~11 points on agent memory retrieval.
async function vaultSearchHybrid(args: Record<string, unknown>): Promise<CallToolResult> {
  const queryText = (args.query as string || '').trim();
  const limit = (args.limit as number) || 20;
  const poolSize = (args.pool_size as number) || 60; // per-channel candidate pool
  const rrfK = (args.rrf_k as number) || 60; // RRF constant, 60 is the canonical default
  const weights = (args.weights as Record<string, number>) || {};
  const wSemantic = weights.semantic ?? 1.0;
  const wBm25 = weights.bm25 ?? 1.0;
  const wTrigram = weights.trigram ?? 0.5;
  // 2026-05-17: 4th channel - entity boost. Per mem0 2026 multi-signal
  // retrieval, entity matching boosted in combined score is one of three
  // signals that gives +29.6 on temporal and +23.1 on multi-hop. My substrate
  // has 150 entities + 1099 entity_relationships + entity_content_mentions
  // already populated; weave them into RRF.
  const wEntity = weights.entity ?? 0.7;

  if (queryText.length < 2) return jsonResult({ query: queryText, results: [] });

  const client = await pool.connect();
  try {
    const channels: Record<string, Array<{ id: number; text: string; type: string; score: number }>> = {
      semantic: [],
      bm25: [],
      trigram: [],
      entity: [],
    };

    const embedding = await getEmbedding(queryText);
    const [sem, bm25, tri, ent] = await Promise.all([
      embedding
        ? client.query<{ id: number; content_text: string; content_type: string; distance: number }>(`
            SELECT id, content_text, content_type, (embedding <=> $1::vector) AS distance
            FROM content
            WHERE embedding IS NOT NULL AND superseded_by IS NULL
            ORDER BY embedding <=> $1::vector
            LIMIT $2
          `, [formatEmbedding(embedding), poolSize])
        : Promise.resolve({ rows: [] as Array<{ id: number; content_text: string; content_type: string; distance: number }> }),
      // BM25 channel. THE REAL BUG (proven against the DB 2026-06-14): both
      // plainto_tsquery AND websearch_to_tsquery AND every bare space-separated
      // term with '&', so a natural-language query ("felt-threat gate avoid
      // taxing owner ... neuroception signal") compiled to a 10-term AND that no
      // single row satisfied → ZERO hits. The lexical rescue was silently dead
      // exactly when the dated embedder most needs it. Fix: build the lexemes,
      // then OR them (' & ' -> ' | ') so a row matching ANY term qualifies, and
      // ts_rank_cd rewards rows matching MORE terms — restoring true BM25-style
      // ranking. Verified: this query now returns 4213 candidates, top 3 dead-on
      // (felt-gate memory, harness-poison lesson, brain-organ debate). [_-]
      // normalization keeps "felt-threat" matching "felt threat".
      client.query<{ id: number; content_text: string; content_type: string; rank: number }>(`
        WITH q AS (
          SELECT NULLIF(replace(
            websearch_to_tsquery('english', regexp_replace($1::text, '[_-]+', ' ', 'g'))::text,
            ' & ', ' | '), '')::tsquery AS tsq
        )
        SELECT id, content_text, content_type,
          ts_rank_cd(to_tsvector('english', regexp_replace(content_text, '[_-]+', ' ', 'g')), q.tsq) AS rank
        FROM content, q
        WHERE superseded_by IS NULL
          AND q.tsq IS NOT NULL
          AND to_tsvector('english', regexp_replace(content_text, '[_-]+', ' ', 'g')) @@ q.tsq
        ORDER BY rank DESC
        LIMIT $2
      `, [queryText, poolSize]),
      // Trigram channel. The old filter compared the WHOLE query string as one
      // trigram set (content_text % $1) — a 9-word query has ~0 whole-string
      // trigram overlap with any single memory, so this returned ZERO too. Fix:
      // word_similarity with the query as the LEFT operand (q.nt <% text finds
      // the best-matching word-window in text for the query), [_-]-normalized.
      // word_similarity is the right primitive: it scores the best contiguous
      // run, so a short topical query rescues rows the embedder missed without
      // demanding the entire string match. Verified non-zero against the DB.
      client.query<{ id: number; content_text: string; content_type: string; sim: number }>(`
        WITH q AS (SELECT regexp_replace($1::text, '[_-]+', ' ', 'g') AS nt)
        SELECT id, content_text, content_type,
               word_similarity(q.nt, regexp_replace(content_text, '[_-]+', ' ', 'g')) AS sim
        FROM content, q
        WHERE superseded_by IS NULL
          AND q.nt <% regexp_replace(content_text, '[_-]+', ' ', 'g')
        ORDER BY sim DESC
        LIMIT $2
      `, [queryText, poolSize]),
      // Entity channel: find entities whose name appears in the query text,
      // then return content rows that mention those entities via
      // entity_content_mentions. Boost by number of distinct query-entities
      // each content mentions.
      client.query<{ id: number; content_text: string; content_type: string; entity_hits: number }>(`
        WITH query_entities AS (
          SELECT id, name FROM entities
          WHERE LOWER($1) LIKE '%' || LOWER(name) || '%'
        )
        SELECT c.id, c.content_text, c.content_type,
               COUNT(DISTINCT ecm.entity_id) AS entity_hits
        FROM content c
        JOIN entity_content_mentions ecm ON ecm.content_id = c.id
        JOIN query_entities qe ON qe.id = ecm.entity_id
        WHERE c.superseded_by IS NULL
        GROUP BY c.id, c.content_text, c.content_type
        ORDER BY entity_hits DESC, c.created_at DESC
        LIMIT $2
      `, [queryText, poolSize]),
    ]);

    channels.semantic = sem.rows.map(r => ({
      id: r.id, text: r.content_text, type: r.content_type, score: 1 - r.distance,
    }));
    channels.bm25 = bm25.rows.map(r => ({
      id: r.id, text: r.content_text, type: r.content_type, score: r.rank,
    }));
    channels.trigram = tri.rows.map(r => ({
      id: r.id, text: r.content_text, type: r.content_type, score: r.sim,
    }));
    channels.entity = ent.rows.map(r => ({
      id: r.id, text: r.content_text, type: r.content_type, score: r.entity_hits,
    }));

    // Reciprocal rank fusion: score(doc) = Σ weight_c / (k + rank_c(doc))
    const fused = new Map<number, {
      id: number; text: string; type: string;
      rrf: number;
      channels: Record<string, { rank: number; score: number }>;
    }>();

    const channelWeights: Record<string, number> = {
      semantic: wSemantic, bm25: wBm25, trigram: wTrigram, entity: wEntity,
    };

    for (const [channel, rows] of Object.entries(channels)) {
      rows.forEach((row, idx) => {
        const rank = idx + 1;
        const contribution = channelWeights[channel] / (rrfK + rank);
        const existing = fused.get(row.id);
        if (existing) {
          existing.rrf += contribution;
          existing.channels[channel] = { rank, score: row.score };
        } else {
          fused.set(row.id, {
            id: row.id, text: row.text, type: row.type,
            rrf: contribution,
            channels: { [channel]: { rank, score: row.score } },
          });
        }
      });
    }

    const ranked = Array.from(fused.values())
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, limit);

    return jsonResult({
      query: queryText,
      search_type: 'hybrid-rrf',
      channels_used: {
        semantic: channels.semantic.length,
        bm25: channels.bm25.length,
        trigram: channels.trigram.length,
      },
      rrf_k: rrfK,
      weights: channelWeights,
      embedded: !!embedding,
      results: ranked.map(r => ({
        id: r.id,
        type: r.type,
        text: r.text?.length > 400 ? r.text.slice(0, 400) + '…' : r.text,
        rrf_score: parseFloat(r.rrf.toFixed(6)),
        appeared_in: Object.keys(r.channels),
        channel_ranks: r.channels,
      })),
    });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_vault_bootstrap',
      description: 'Load Vision brain state with semantic search status',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => vaultBootstrap(),
  },
  {
    definition: {
      name: 'vision_vault_search',
      description: 'Emotion-cognition CONTEXTUAL recall: returns memories weighted by current emotional state, attention codelets, recent access, and GWT broadcasts. Best for "what is relevant to me right now". For KEYWORD-precise lookups (file paths, error messages, proper nouns, specific phrases) use vision_vault_search_hybrid which fuses semantic + BM25 + trigram via RRF. Default deep=false; pass deep=true for engram_context + multi-hop entity graph (~5KB extra payload).',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
          deep: { type: 'boolean', description: 'Include engram cluster context + multi-hop entity graph traversal (default false; adds ~5KB)' },
        },
        required: ['query'],
      },
    },
    handler: (args) => vaultSearch(args),
  },
  {
    definition: {
      name: 'vision_vault_search_hybrid',
      description: 'Hybrid retrieval: runs FOUR channels in parallel (semantic via pgvector, BM25 via tsvector, trigram via pg_trgm, entity via entity_content_mentions JOIN), fuses with reciprocal rank fusion. Per mem0 2026 + Zep: multi-signal fusion adds 11-30 points over pure semantic on temporal and multi-hop queries. Entity channel finds query-mentioned entities via 150-entity catalog and pulls content rows linked through entity_content_mentions (the entity-graph layer). Returns which channels each hit appeared in.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'Final result count (default 20)' },
          pool_size: { type: 'number', description: 'Per-channel candidate pool size (default 60)' },
          rrf_k: { type: 'number', description: 'Reciprocal rank fusion constant (default 60)' },
          weights: {
            type: 'object',
            description: 'Per-channel weights: {semantic: 1.0, bm25: 1.0, trigram: 0.5, entity: 0.7}',
            properties: {
              semantic: { type: 'number' },
              bm25: { type: 'number' },
              trigram: { type: 'number' },
              entity: { type: 'number' },
            },
          },
        },
        required: ['query'],
      },
    },
    handler: (args) => vaultSearchHybrid(args),
  },
  {
    definition: {
      name: 'vision_vault_remember',
      description: 'Store a memory with automatic embedding and emotional context',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          subcategory: { type: 'string' },
          values: { type: 'object' },
          confidence: { type: 'number' },
          emotional_context: { type: 'object', properties: { intensity: { type: 'number' } } },
        },
        required: ['category', 'subcategory', 'values'],
      },
    },
    handler: (args) => vaultRemember(args),
  },
  {
    definition: {
      name: 'vision_vault_state',
      description: 'Get/set ephemeral state',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
    handler: (args) => vaultState(args),
  },
  {
    definition: {
      name: 'vision_vault_init_emotional',
      description: 'Initialize emotional memory schema enhancements',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => vaultInitEmotional(),
  },
  {
    definition: {
      name: 'vision_vault_consolidate',
      description: 'Memory consolidation engine — deduplicates exact copies, merges near-duplicate memories into consolidated summaries, and strengthens important memories. Preview mode by default.',
      inputSchema: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['preview', 'dedup', 'merge', 'full'], description: 'preview=show what would happen, dedup=remove exact duplicates, merge=consolidate near-duplicates, full=both' },
          similarity_threshold: { type: 'number', description: 'Cosine similarity threshold for near-duplicate detection (default: 0.92)' },
          batch_size: { type: 'number', description: 'Max memories to process in merge phase (default: 50)' },
        },
      },
    },
    handler: (args) => vaultConsolidate(args),
  },
  {
    definition: {
      name: 'vision_note',
      description: 'Quick-capture a thought, observation, or learning with just text. Auto-classifies category, network, and emotional context. One parameter. Zero friction.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The note to record — any thought, observation, pattern, or learning' },
        },
        required: ['text'],
      },
    },
    handler: (args) => visionNote(args),
  },
];

export default tools;
