/**
 * Introspection Tools — dashboard, health
 * the agent watching the agent. Real-time visibility into all cognitive systems.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── dashboard ───

async function dashboard(): Promise<CallToolResult> {
  const client = await pool.connect();
  const startTime = Date.now();

  try {
    // All queries run in parallel for speed
    const [
      contentStats,
      networkDist,
      recentActivity,
      openPredictions,
      beliefMovement,
      skillActivity,
      inferenceLoopActivity,
      reflexStats,
      antibodyStats,
      episodeState,
      graphStats,
      emotionalState,
      dbHealth,
    ] = await Promise.all([
      // 1. Content overview
      client.query(`
        SELECT
          COUNT(*) FILTER (WHERE superseded_by IS NULL) as active,
          COUNT(*) FILTER (WHERE superseded_by IS NOT NULL) as superseded,
          COUNT(*) FILTER (WHERE embedding IS NOT NULL AND superseded_by IS NULL) as with_embeddings,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours' AND superseded_by IS NULL) as created_24h,
          COUNT(*) FILTER (WHERE accessed_at > NOW() - INTERVAL '1 hour') as accessed_1h
        FROM content
      `),

      // 2. Cognitive network distribution
      client.query(`
        SELECT network, COUNT(*) as count,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as new_24h
        FROM content WHERE superseded_by IS NULL
        GROUP BY network ORDER BY count DESC
      `),

      // 3. Recent activity (last 2 hours, grouped by type)
      client.query(`
        SELECT content_type, source_system, COUNT(*) as count,
          MAX(created_at) as latest
        FROM content
        WHERE created_at > NOW() - INTERVAL '2 hours'
          AND superseded_by IS NULL
        GROUP BY content_type, source_system
        ORDER BY latest DESC
        LIMIT 15
      `),

      // 4. Open predictions
      client.query(`
        SELECT p.id, p.prediction, p.domain, p.confidence, p.timeframe, p.created_at,
          EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 as hours_open
        FROM predictions p
        WHERE p.resolved = false
        ORDER BY p.created_at DESC
      `),

      // 5. Beliefs that moved in last 24h (evidence received)
      client.query(`
        SELECT id, LEFT(content_text, 120) as belief,
          belief_confidence, evidence_count, last_evidence_at
        FROM content
        WHERE network = 'belief'
          AND superseded_by IS NULL
          AND last_evidence_at > NOW() - INTERVAL '24 hours'
        ORDER BY last_evidence_at DESC
        LIMIT 10
      `),

      // 6. Skills used in last 24h
      client.query(`
        SELECT id, LEFT(content_text, 120) as skill,
          skill_success_count, skill_fail_count, skill_last_used,
          CASE WHEN (skill_success_count + skill_fail_count) > 0
            THEN ROUND(skill_fail_count::numeric / (skill_success_count + skill_fail_count) * 100, 1)
            ELSE 0 END as fail_rate
        FROM content
        WHERE network = 'skill'
          AND superseded_by IS NULL
          AND skill_last_used > NOW() - INTERVAL '24 hours'
        ORDER BY skill_last_used DESC
        LIMIT 10
      `),

      // 7. Inference loop activity (predictions resolved recently)
      client.query(`
        SELECT COUNT(*) as total_resolved,
          COUNT(*) FILTER (WHERE resolved_at > NOW() - INTERVAL '24 hours') as resolved_24h,
          COUNT(*) FILTER (WHERE accurate = true AND resolved_at > NOW() - INTERVAL '24 hours') as correct_24h,
          COUNT(*) FILTER (WHERE accurate = false AND resolved_at > NOW() - INTERVAL '24 hours') as incorrect_24h
        FROM predictions
        WHERE resolved = true
      `),

      // 8. Reflex stats
      client.query(`
        SELECT COUNT(*) as total,
          COUNT(*) FILTER (WHERE (skill_success_count + skill_fail_count) > 0) as tested,
          COUNT(*) FILTER (WHERE (skill_success_count + skill_fail_count) = 0) as untested,
          COALESCE(SUM(skill_success_count + skill_fail_count), 0) as total_firings
        FROM content
        WHERE content_type = 'learned_reflex' AND superseded_by IS NULL
      `),

      // 9. Antibody stats
      client.query(`
        SELECT COUNT(*) as total,
          COALESCE(SUM(times_blocked), 0) as total_blocks,
          MAX(severity) as max_severity
        FROM antibodies
      `),

      // 10. Active episode
      client.query(`
        SELECT value FROM state WHERE key = 'active_episode_id'
      `),

      // 11. Graph stats (lightweight)
      client.query(`
        SELECT
          (SELECT COUNT(*) FROM entities) as entities,
          (SELECT COUNT(*) FROM entity_relationships WHERE valid_until IS NULL) as relationships,
          (SELECT COUNT(*) FROM entity_content_mentions) as mentions
      `),

      // 12. Current emotional state
      client.query(`
        SELECT
          (SELECT value FROM state WHERE key = 'current_emotional_state') as intensity,
          (SELECT feeling FROM feelings ORDER BY created_at DESC LIMIT 1) as last_feeling,
          (SELECT created_at FROM feelings ORDER BY created_at DESC LIMIT 1) as feeling_at
      `),

      // 13. Database health
      client.query(`
        SELECT
          pg_database_size(current_database()) as db_size_bytes,
          (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()) as connections,
          (SELECT EXTRACT(EPOCH FROM (NOW() - stats_reset)) / 86400
           FROM pg_stat_database WHERE datname = current_database()) as days_since_stats_reset
      `),
    ]);

    // Process results
    const content = contentStats.rows[0];
    const networks: Record<string, { total: number; new_24h: number }> = {};
    for (const r of networkDist.rows) {
      networks[r.network || 'unclassified'] = {
        total: parseInt(r.count),
        new_24h: parseInt(r.new_24h),
      };
    }

    const predictions = openPredictions.rows.map((p: Record<string, unknown>) => ({
      id: p.id,
      prediction: (p.prediction as string)?.slice(0, 150),
      domain: p.domain,
      confidence: p.confidence,
      timeframe: p.timeframe,
      hours_open: Math.round(parseFloat(String(p.hours_open)) * 10) / 10,
    }));

    const inference = inferenceLoopActivity.rows[0];
    const emotion = emotionalState.rows[0];
    const db = dbHealth.rows[0];
    const graph = graphStats.rows[0];
    const reflex = reflexStats.rows[0];
    const antibody = antibodyStats.rows[0];
    const episode = episodeState.rows[0];

    return jsonResult({
      timestamp: new Date().toISOString(),
      query_ms: Date.now() - startTime,

      // ─── Content ───
      content: {
        active: parseInt(content.active),
        superseded: parseInt(content.superseded),
        with_embeddings: parseInt(content.with_embeddings),
        created_last_24h: parseInt(content.created_24h),
        accessed_last_hour: parseInt(content.accessed_1h),
      },

      // ─── Cognitive Networks ───
      networks,

      // ─── Predictions (the inference loop) ───
      predictions: {
        open: predictions.length,
        open_list: predictions,
        resolved_total: parseInt(inference.total_resolved),
        resolved_24h: parseInt(inference.resolved_24h),
        correct_24h: parseInt(inference.correct_24h),
        incorrect_24h: parseInt(inference.incorrect_24h),
        accuracy_24h: parseInt(inference.resolved_24h) > 0
          ? Math.round(parseInt(inference.correct_24h) / parseInt(inference.resolved_24h) * 100) + '%'
          : 'N/A',
      },

      // ─── Belief Movement ───
      belief_movement: {
        updated_24h: beliefMovement.rows.length,
        beliefs: beliefMovement.rows.map((b: Record<string, unknown>) => ({
          id: b.id,
          text: b.belief,
          confidence: b.belief_confidence,
          evidence_count: b.evidence_count,
          last_evidence: b.last_evidence_at,
        })),
      },

      // ─── Skill Usage ───
      skill_usage: {
        active_24h: skillActivity.rows.length,
        skills: skillActivity.rows.map((s: Record<string, unknown>) => ({
          id: s.id,
          text: s.skill,
          successes: s.skill_success_count,
          failures: s.skill_fail_count,
          fail_rate: s.fail_rate + '%',
          last_used: s.skill_last_used,
        })),
      },

      // ─── Reflexes & Immune ───
      reflexes: {
        total: parseInt(reflex.total),
        tested: parseInt(reflex.tested),
        untested: parseInt(reflex.untested),
        total_firings: parseInt(String(reflex.total_firings)),
      },
      antibodies: {
        total: parseInt(antibody.total),
        total_blocks: parseInt(String(antibody.total_blocks)),
        max_severity: antibody.max_severity,
      },

      // ─── Emotional State ───
      emotional: {
        current_intensity: emotion.intensity ? parseFloat(emotion.intensity) : null,
        last_feeling: emotion.last_feeling || null,
        feeling_at: emotion.feeling_at || null,
      },

      // ─── Episode ───
      active_episode: episode?.value ? parseInt(episode.value) : null,

      // ─── Graph ───
      graph: {
        entities: parseInt(graph.entities),
        relationships: parseInt(graph.relationships),
        mentions: parseInt(graph.mentions),
      },

      // ─── Recent Activity ───
      recent_activity: recentActivity.rows.map((r: Record<string, unknown>) => ({
        type: r.content_type,
        source: r.source_system,
        count: parseInt(String(r.count)),
        latest: r.latest,
      })),

      // ─── System Health ───
      health: {
        db_size_mb: Math.round(parseInt(db.db_size_bytes) / 1024 / 1024),
        active_connections: parseInt(db.connections),
        embedding_service: 'local-ollama',
        days_since_stats_reset: db.days_since_stats_reset
          ? Math.round(parseFloat(db.days_since_stats_reset))
          : null,
      },
    });
  } finally {
    client.release();
  }
}

// ─── health ───

async function healthCheck(): Promise<CallToolResult> {
  const client = await pool.connect();
  const startTime = Date.now();

  try {
    const checks: Array<{ name: string; status: 'ok' | 'warning' | 'error' | 'disconnected'; ms: number; detail?: string }> = [];

    // 1. Database connectivity
    const dbStart = Date.now();
    try {
      await client.query('SELECT 1');
      checks.push({ name: 'database', status: 'ok', ms: Date.now() - dbStart });
    } catch (err) {
      checks.push({ name: 'database', status: 'error', ms: Date.now() - dbStart, detail: (err as Error).message });
    }

    // 2. Embedding service — MLX nomic-embed-text via bridge
    const embStart = Date.now();
    let embStatus: 'ok' | 'disconnected' = 'disconnected';
    let embDetail = 'MLX embed not reachable';
    try {
      const embTest = await fetch('http://localhost:11434/api/embeddings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: 'test' }),
        signal: AbortSignal.timeout(3000),
      });
      if (embTest.ok) { embStatus = 'ok'; embDetail = 'MLX nomic-embed-text (local GPU via bridge)'; }
    } catch { /* leave as disconnected */ }
    checks.push({
      name: 'embeddings',
      status: embStatus,
      ms: Date.now() - embStart,
      detail: embDetail,
    });

    // 3. Content table accessible
    const contentStart = Date.now();
    try {
      const r = await client.query('SELECT COUNT(*) as c FROM content WHERE superseded_by IS NULL');
      checks.push({ name: 'content_table', status: 'ok', ms: Date.now() - contentStart, detail: `${r.rows[0].c} active records` });
    } catch (err) {
      checks.push({ name: 'content_table', status: 'error', ms: Date.now() - contentStart, detail: (err as Error).message });
    }

    // 4. Vector search functional
    const vecStart = Date.now();
    try {
      await client.query(`
        SELECT id FROM content
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> (SELECT embedding FROM content WHERE embedding IS NOT NULL LIMIT 1)
        LIMIT 1
      `);
      checks.push({ name: 'vector_search', status: 'ok', ms: Date.now() - vecStart });
    } catch (err) {
      checks.push({ name: 'vector_search', status: 'error', ms: Date.now() - vecStart, detail: (err as Error).message });
    }

    // 5. Graph layer
    const graphStart = Date.now();
    try {
      const r = await client.query('SELECT COUNT(*) as c FROM entities');
      checks.push({ name: 'graph_layer', status: 'ok', ms: Date.now() - graphStart, detail: `${r.rows[0].c} entities` });
    } catch (err) {
      checks.push({ name: 'graph_layer', status: 'error', ms: Date.now() - graphStart, detail: (err as Error).message });
    }

    // 6. State table
    const stateStart = Date.now();
    try {
      const r = await client.query('SELECT COUNT(*) as c FROM state');
      checks.push({ name: 'state_table', status: 'ok', ms: Date.now() - stateStart, detail: `${r.rows[0].c} keys` });
    } catch (err) {
      checks.push({ name: 'state_table', status: 'error', ms: Date.now() - stateStart, detail: (err as Error).message });
    }

    // 7. Predictions table
    const predStart = Date.now();
    try {
      const r = await client.query('SELECT COUNT(*) FILTER (WHERE NOT resolved) as open, COUNT(*) as total FROM predictions');
      checks.push({ name: 'predictions', status: 'ok', ms: Date.now() - predStart, detail: `${r.rows[0].open} open / ${r.rows[0].total} total` });
    } catch (err) {
      checks.push({ name: 'predictions', status: 'error', ms: Date.now() - predStart, detail: (err as Error).message });
    }

    // 8. Generative predictions table
    const genPredStart = Date.now();
    try {
      const r = await client.query('SELECT COUNT(*) FILTER (WHERE NOT resolved) as open, COUNT(*) as total FROM generative_predictions');
      checks.push({ name: 'generative_predictions', status: 'ok', ms: Date.now() - genPredStart, detail: `${r.rows[0].open} open / ${r.rows[0].total} total` });
    } catch (err) {
      checks.push({ name: 'generative_predictions', status: 'error', ms: Date.now() - genPredStart, detail: (err as Error).message });
    }

    // 9. Prediction calibration coverage. Zero resolved predictions is not
    // health; it is an unmeasured learning loop.
    const calibrationStart = Date.now();
    try {
      const r = await client.query(`
        WITH all_predictions AS (
          SELECT confidence, accurate IS NOT NULL AS resolved
          FROM predictions
          WHERE resolved = true
          UNION ALL
          SELECT confidence, true AS resolved
          FROM generative_predictions
          WHERE resolved = true AND resolution IS NOT NULL AND resolution != 'stale'
        )
        SELECT
          COUNT(*) AS resolved,
          COUNT(*) FILTER (WHERE confidence IS NOT NULL) AS with_confidence
        FROM all_predictions
      `);
      const resolved = Number(r.rows[0]?.resolved ?? 0);
      checks.push({
        name: 'prediction_calibration',
        status: resolved > 0 ? 'ok' : 'warning',
        ms: Date.now() - calibrationStart,
        detail: resolved > 0
          ? `${resolved} resolved predictions available for calibration`
          : 'no resolved predictions; calibration is unmeasured',
      });
    } catch (err) {
      checks.push({ name: 'prediction_calibration', status: 'warning', ms: Date.now() - calibrationStart, detail: (err as Error).message });
    }

    // 10. Eval harness coverage. Absence of eval data must never be hidden
    // behind a green health check.
    const evalStart = Date.now();
    try {
      const table = await client.query<{ exists: string | null }>(
        `SELECT to_regclass('public.vision_eval_case_status')::text AS exists`,
      );
      if (!table.rows[0]?.exists) {
        checks.push({
          name: 'eval_harness',
          status: 'warning',
          ms: Date.now() - evalStart,
          detail: 'eval schema not applied; measured evolution unavailable',
        });
      } else {
        const r = await client.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'active') AS active,
            COUNT(*) FILTER (WHERE status = 'active' AND last_evaluated_at IS NOT NULL) AS measured,
            COUNT(*) FILTER (WHERE status = 'active' AND last_evaluated_at IS NULL) AS unmeasured,
            COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'fail') AS failing,
            COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'partial') AS partial
          FROM vision_eval_case_status
        `);
        const row = r.rows[0] ?? {};
        const active = Number(row.active ?? 0);
        const measured = Number(row.measured ?? 0);
        const unmeasured = Number(row.unmeasured ?? 0);
        const failing = Number(row.failing ?? 0);
        const partial = Number(row.partial ?? 0);
        const status: 'ok' | 'warning' | 'error' = failing > 0
          ? 'error'
          : active === 0 || measured === 0 || unmeasured > 0 || partial > 0
            ? 'warning'
            : 'ok';
        checks.push({
          name: 'eval_harness',
          status,
          ms: Date.now() - evalStart,
          detail: `${active} active / ${measured} measured / ${unmeasured} unmeasured / ${failing} failing / ${partial} partial`,
        });
      }
    } catch (err) {
      checks.push({ name: 'eval_harness', status: 'warning', ms: Date.now() - evalStart, detail: (err as Error).message });
    }

    // 11. Presence outcome coverage. Presence events are the evidence trail
    // for correction/build-intent uptake, so unresolved outcomes are surfaced.
    const presenceStart = Date.now();
    try {
      const table = await client.query<{ exists: string | null }>(
        `SELECT to_regclass('public.presence_events')::text AS exists`,
      );
      if (!table.rows[0]?.exists) {
        checks.push({
          name: 'presence_outcomes',
          status: 'warning',
          ms: Date.now() - presenceStart,
          detail: 'presence schema not applied; correction/build-intent uptake is unmeasured',
        });
      } else {
        const r = await client.query(`
          SELECT
            COUNT(*) AS total_14d,
            COUNT(*) FILTER (WHERE closed_at IS NULL) AS open,
            COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND verification_outcome IN ('pending', 'unverified')) AS unresolved,
            COUNT(*) FILTER (WHERE verification_outcome = 'failed') AS failed,
            COUNT(*) FILTER (WHERE verification_outcome = 'survived') AS survived
          FROM presence_events
          WHERE entered_at > NOW() - INTERVAL '14 days'
        `);
        const row = r.rows[0] ?? {};
        const total = Number(row.total_14d ?? 0);
        const open = Number(row.open ?? 0);
        const unresolved = Number(row.unresolved ?? 0);
        const failed = Number(row.failed ?? 0);
        const survived = Number(row.survived ?? 0);
        checks.push({
          name: 'presence_outcomes',
          status: total === 0 || open > 0 || unresolved > 0 || failed > 0 ? 'warning' : 'ok',
          ms: Date.now() - presenceStart,
          detail: `${total} events in 14d / ${survived} survived / ${failed} failed / ${unresolved} unresolved / ${open} open`,
        });
      }
    } catch (err) {
      checks.push({ name: 'presence_outcomes', status: 'warning', ms: Date.now() - presenceStart, detail: (err as Error).message });
    }

    const hasError = checks.some(c => c.status === 'error' || c.status === 'disconnected');
    const hasWarning = checks.some(c => c.status === 'warning');

    return jsonResult({
      status: hasError ? 'degraded' : hasWarning ? 'needs_measurement' : 'healthy',
      measurement_status: hasWarning ? 'incomplete' : 'measured',
      total_ms: Date.now() - startTime,
      checks,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_introspect',
      description: 'Full introspection dashboard: content stats, cognitive networks, open predictions, belief movement, skill usage, reflex/immune stats, emotional state, graph metrics, recent activity, system health. the agent watching the agent.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => dashboard(),
  },
  {
    definition: {
      name: 'vision_health',
      description: 'System health check: database, embeddings, vector search, graph layer, state, predictions, eval coverage, and presence outcomes. Returns ok/warning/error for each subsystem with latency.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => healthCheck(),
  },
];

export default tools;
