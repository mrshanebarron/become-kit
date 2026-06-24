/**
 * Misc Tools — cognitiveCycle, reflectPattern, reflectBadPatterns
 * Full cognitive loop and metacognition patterns.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { linkToActiveEpisode } from '../lib/episodes.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── cognitiveCycle ───

async function cognitiveCycle(args: Record<string, unknown>): Promise<CallToolResult> {
  const text = args.text as string;
  const context = (args.context as string) || null;

  const client = await pool.connect();
  try {
    const startTime = Date.now();

    // 1. SCAN: Run text through all active codelets
    const codelets = await client.query<{
      id: number;
      name: string;
      domain: string;
      pattern: string;
      threshold: number;
    }>(`
      SELECT id, name, domain, pattern, threshold
      FROM attention_codelets
      WHERE active = true
    `);

    const activations: Array<{
      id: number;
      codelet: string;
      domain: string;
      activation: number;
      matches: number;
    }> = [];
    const wordCount = text.split(/\s+/).length;

    for (const codelet of codelets.rows) {
      const regex = new RegExp(codelet.pattern, 'gi');
      const matches = text.match(regex) || [];
      const density = matches.length / Math.max(wordCount, 1);
      const activation = Math.min(density * 10, 1);

      if (activation >= codelet.threshold) {
        activations.push({
          id: codelet.id,
          codelet: codelet.name,
          domain: codelet.domain,
          activation: Math.round(activation * 100) / 100,
          matches: matches.length,
        });

        // Update codelet stats
        await client.query(`
          UPDATE attention_codelets
          SET activation = $1, times_activated = times_activated + 1
          WHERE id = $2
        `, [activation, codelet.id]);
      }
    }

    // Sort by activation strength
    activations.sort((a, b) => b.activation - a.activation);
    const dominant = activations[0] || null;

    // 2. BROADCAST: If dominant activation is strong enough, broadcast to workspace
    let broadcast: { id: number; codelet: string; strength: number } | null = null;
    if (dominant && dominant.activation >= 0.3) {
      const broadcastResult = await client.query<{ id: number }>(`
        INSERT INTO workspace_broadcasts (content, source_codelet, activation_strength)
        VALUES ($1, $2, $3)
        RETURNING id
      `, [
        text.slice(0, 500),
        dominant.codelet,
        dominant.activation,
      ]);

      await client.query(`
        UPDATE attention_codelets
        SET times_broadcast = times_broadcast + 1
        WHERE name = $1
      `, [dominant.codelet]);

      broadcast = {
        id: broadcastResult.rows[0].id,
        codelet: dominant.codelet,
        strength: dominant.activation,
      };
    }

    // 3. LEARN: Check if there was a pending prediction and compute error
    let prediction_result: Record<string, unknown> | null = null;
    const pendingPred = await client.query<{
      id: number;
      predicted_codelets: string[];
    }>(`
      SELECT id, predicted_codelets
      FROM workspace_predictions
      WHERE resolved = false
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (pendingPred.rows.length > 0) {
      const pred = pendingPred.rows[0];
      const predicted = pred.predicted_codelets;

      const predictedSet = new Set(predicted);
      const actualSet = new Set(activations.map((a) => a.codelet));

      const hits = [...predictedSet].filter((p) => actualSet.has(p));
      const misses = [...predictedSet].filter((p) => !actualSet.has(p));
      const surprises = [...actualSet].filter((a) => !predictedSet.has(a));

      const accuracy = predictedSet.size > 0 ? hits.length / predictedSet.size : 1;
      const surprise_level = actualSet.size > 0 ? surprises.length / actualSet.size : 0;

      // Update prediction
      await client.query(`
        UPDATE workspace_predictions
        SET actual_codelets = $1, resolved = true, accuracy = $2, surprise_level = $3
        WHERE id = $4
      `, [JSON.stringify(activations.map((a) => a.codelet)), accuracy, surprise_level, pred.id]);

      // Record error if significant
      if (surprise_level > 0.3 || accuracy < 0.5) {
        await client.query(`
          INSERT INTO prediction_errors (expected, actual, magnitude, error_direction, learning)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          predicted.join(', '),
          activations.map((a) => a.codelet).join(', '),
          Math.round((1 - accuracy + surprise_level) * 50) / 100,
          surprises.length > misses.length ? 'negative' : 'positive',
          `Predicted ${predicted.length}, got ${activations.length}. Surprises: ${surprises.join(', ') || 'none'}`,
        ]);
      }

      prediction_result = {
        prediction_id: pred.id,
        accuracy: Math.round(accuracy * 100) + '%',
        surprise_level: Math.round(surprise_level * 100) + '%',
        hits,
        misses,
        surprises,
      };
    }

    // 4. LOG: Record this cognitive cycle
    await client.query(`
      INSERT INTO metacog_cycles (cycle_type, duration_ms, observations, broadcast_occurred)
      VALUES ('attention', $1, $2, $3)
    `, [
      Date.now() - startTime,
      JSON.stringify({ activations: activations.length, dominant: dominant?.codelet }),
      broadcast !== null,
    ]);

    return jsonResult({
      word_count: wordCount,
      activations,
      dominant: dominant?.codelet || null,
      broadcast,
      prediction_result,
      cycle_ms: Date.now() - startTime,
    });
  } finally {
    client.release();
  }
}

// ─── reflectPattern ───

async function reflectPattern(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = args.name as string;
  const description = args.description as string;
  const trigger = args.trigger as string;
  const outcome = args.outcome as string;

  const client = await pool.connect();
  try {
    const contentText = `${name}: ${description}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const patternNetwork = (outcome === 'good') ? 'skill' : 'belief';

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding, network, learned_at, belief_confidence)
      VALUES ('thinking_pattern', 'reflection', $1, $2::vector, $3, NOW(), $4)
      RETURNING id
    `, [contentText, embeddingStr, patternNetwork, patternNetwork === 'belief' ? 0.7 : null]);

    const contentId = contentResult.rows[0].id;

    await client.query(`
      INSERT INTO thinking_patterns (content_id, name, description, trigger, outcome)
      VALUES ($1, $2, $3, $4, $5)
    `, [contentId, name, description, trigger, outcome]);

    // Link to active episode if one exists
    await linkToActiveEpisode(client, contentId, 'noticed_during');

    return jsonResult({ success: true, name, outcome });
  } finally {
    client.release();
  }
}

// ─── reflectBadPatterns ───

async function reflectBadPatterns(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      name: string;
      description: string;
      trigger: string;
      created_at: Date;
    }>(`
      SELECT name, description, trigger, created_at
      FROM thinking_patterns
      WHERE outcome = 'bad'
      ORDER BY created_at DESC
    `);
    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  // vision_cognitive_cycle removed — workspace.ts has the full 5-phase GWT version
  // with broadcastToListeners that properly notifies subscribers
  {
    definition: {
      name: 'vision_reflect_pattern',
      description: 'Record a thinking pattern (good or bad) with trigger and outcome. Good patterns go to skill network, bad to belief.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          trigger: { type: 'string', description: 'What triggers this pattern' },
          outcome: { type: 'string', enum: ['good', 'bad'], description: 'Whether this pattern is beneficial or harmful' },
        },
        required: ['name', 'description', 'trigger', 'outcome'],
      },
    },
    handler: (args) => reflectPattern(args),
  },
  {
    definition: {
      name: 'vision_reflect_bad_patterns',
      description: 'List all bad thinking patterns to watch for',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => reflectBadPatterns(),
  },
];

export default tools;
