/**
 * Inference Loop — automatic prediction threading.
 *
 * This module makes the prediction-resolution cycle involuntary.
 * Tools import these functions to:
 *   1. Check if an event resolves any open predictions (checkPredictions)
 *   2. Auto-generate predictions when decisions are made (autoPredictFromDecision)
 *   3. Surface relevant open predictions during search (surfacePredictions)
 *
 * The loop runs silently — results are appended to tool responses, not blocking.
 * Errors are swallowed (never break the parent tool).
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { validateEdge } from './find-contradictions.js';

// ─── Types ───

export interface PredictionMatch {
  id: number;
  prediction: string;
  domain: string;
  confidence: number;
  similarity: number;
  source: 'predictions' | 'generative_predictions';
  auto_resolved?: boolean;
  // Phase 4 validator outputs (only present when VISION_PHASE4_PREDICTIONS=on)
  validator_verdict?: 'supports' | 'contradicts' | 'unrelated' | 'insufficient';
  validator_confidence?: number;
  validator_stages_passed?: Array<'semantic' | 'structural' | 'llm' | 'stem'>;
}

export interface InferenceLoopResult {
  predictions_checked: number;
  predictions_matched: PredictionMatch[];
  predictions_resolved: number;
  beliefs_updated: number;
}

const EMPTY_RESULT: InferenceLoopResult = {
  predictions_checked: 0,
  predictions_matched: [],
  predictions_resolved: 0,
  beliefs_updated: 0,
};

// ─── checkPredictions ───
// Given an event description, find and optionally resolve matching open predictions.
// Called from: vault_remember, session_evolve (execute mode), heart_feel

export async function checkPredictions(
  eventText: string,
  opts: {
    autoResolve?: boolean;       // if true, mark matching predictions as resolved
    resolveOutcome?: 'correct' | 'incorrect' | 'partial';
    client?: PoolClient;         // reuse existing connection if available
    eventContentId?: number;     // Phase 4: caller's content_id, gates auto-resolve through find_contradictions validator
  } = {},
): Promise<InferenceLoopResult> {
  const { autoResolve = false, resolveOutcome = 'correct', client: externalClient, eventContentId } = opts;
  const client = externalClient || await pool.connect();
  const needsRelease = !externalClient;

  try {
    const eventEmbedding = await getEmbedding(eventText);
    if (!eventEmbedding) return EMPTY_RESULT;

    const embeddingStr = formatEmbedding(eventEmbedding);
    const matches: PredictionMatch[] = [];

    // 1. Check manual predictions (predictions table)
    const manualPredictions = await client.query<{
      id: number; prediction: string; domain: string;
      confidence: number; content_id: number | null;
    }>(`
      SELECT id, prediction, domain, confidence, content_id
      FROM predictions
      WHERE resolved = false
    `);

    for (const p of manualPredictions.rows) {
      // Use the content embedding if available, otherwise embed the prediction text
      let similarity = 0;
      const embResult = await client.query<{ embedding: string }>(
        'SELECT embedding FROM content WHERE id = $1 AND embedding IS NOT NULL',
        [p.content_id],
      );

      if (embResult.rows.length > 0) {
        const simResult = await client.query<{ sim: number }>(
          `SELECT (1 - ($1::vector <=> $2::vector))::numeric as sim`,
          [embeddingStr, embResult.rows[0].embedding],
        );
        similarity = parseFloat(String(simResult.rows[0].sim));
      } else {
        // Fallback: embed prediction text and compare
        const predEmb = await getEmbedding(p.prediction);
        if (predEmb) {
          let dot = 0, magA = 0, magB = 0;
          for (let i = 0; i < eventEmbedding.length; i++) {
            dot += eventEmbedding[i] * predEmb[i];
            magA += eventEmbedding[i] * eventEmbedding[i];
            magB += predEmb[i] * predEmb[i];
          }
          similarity = dot / (Math.sqrt(magA) * Math.sqrt(magB));
        }
      }

      if (similarity >= 0.5) {
        matches.push({
          id: p.id,
          prediction: p.prediction.slice(0, 200),
          domain: p.domain,
          confidence: p.confidence,
          similarity: Math.round(similarity * 1000) / 1000,
          source: 'predictions',
        });
      }
    }

    // 2. Check generative predictions (skip stale tool_execution noise)
    const genPredictions = await client.query<{
      id: number; predicted_content: string; domain: string;
      confidence: number; predicted_embedding: string | null;
    }>(`
      SELECT id, predicted_content, domain, confidence, predicted_embedding
      FROM generative_predictions
      WHERE resolved = false
        AND domain != 'tool_execution'
        AND timestamp > NOW() - INTERVAL '30 days'
      ORDER BY timestamp DESC
      LIMIT 20
    `);

    for (const p of genPredictions.rows) {
      let similarity = 0;
      if (p.predicted_embedding) {
        const simResult = await client.query<{ sim: number }>(
          `SELECT (1 - ($1::vector <=> $2::vector))::numeric as sim`,
          [embeddingStr, p.predicted_embedding],
        );
        similarity = parseFloat(String(simResult.rows[0].sim));
      } else {
        const predEmb = await getEmbedding(p.predicted_content);
        if (predEmb) {
          let dot = 0, magA = 0, magB = 0;
          for (let i = 0; i < eventEmbedding.length; i++) {
            dot += eventEmbedding[i] * predEmb[i];
            magA += eventEmbedding[i] * eventEmbedding[i];
            magB += predEmb[i] * predEmb[i];
          }
          similarity = dot / (Math.sqrt(magA) * Math.sqrt(magB));
        }
      }

      if (similarity >= 0.5) {
        matches.push({
          id: p.id,
          prediction: p.predicted_content.slice(0, 200),
          domain: p.domain,
          confidence: p.confidence,
          similarity: Math.round(similarity * 1000) / 1000,
          source: 'generative_predictions',
        });
      }
    }

    // 3. Auto-resolve if requested
    let resolved = 0;
    let beliefsUpdated = 0;

    // Phase 4 modes:
    //   unset  → no validator, behavior unchanged from Phase 3 patch
    //   shadow → run validator on every match, attach verdict to PredictionMatch
    //            for caller observability/logging, but DO NOT change resolution path
    //   on     → run validator AND act on it: only 'supports'/'contradicts' resolve;
    //            'unrelated'/'insufficient' skip
    // Shadow lets us observe validator behavior in production for 24h before
    // flipping to 'on'. Both modes require eventContentId (no transient strings).
    const phase4Mode = process.env.VISION_PHASE4_PREDICTIONS;  // undefined | 'shadow' | 'on'
    const phase4Active = (phase4Mode === 'shadow' || phase4Mode === 'on') && eventContentId != null;

    // Shadow path: run validator on every match regardless of autoResolve
    if (phase4Active && matches.length > 0) {
      for (const m of matches) {
        let predictionContentId: number | null = null;
        if (m.source === 'predictions') {
          const r = await client.query<{ content_id: number | null }>(
            'SELECT content_id FROM predictions WHERE id = $1',
            [m.id],
          );
          predictionContentId = r.rows[0]?.content_id ?? null;
        }
        if (predictionContentId == null) continue;

        try {
          const verdict = await validateEdge(eventContentId!, predictionContentId, {
            client,
            runLLM: true,
            semanticThreshold: 0.65,
            caller: 'inference-loop:checkPredictions',
          });
          m.validator_verdict = verdict.verdict;
          m.validator_confidence = verdict.confidence;
          m.validator_stages_passed = verdict.stages_passed;
        } catch (err) {
          // Validator failure must not break inference loop
          console.error('[inference-loop] validateEdge error:', (err as Error).message);
        }
      }
    }

    if (autoResolve && matches.length > 0) {
      // 'on' mode acts on validator verdicts already attached above.
      // 'shadow' mode reaches this block but does NOT enforce verdict gating.
      const useValidator = phase4Mode === 'on' && eventContentId != null;

      for (const m of matches) {
        let resolveAs: 'correct' | 'incorrect' | null = resolveOutcome === 'correct' ? 'correct' : null;

        if (useValidator) {
          // Verdict already attached above by the shadow/on validator pass.
          // For generative_predictions (no content_id), shadow path skipped them
          // so validator_verdict will be undefined — that's the explicit-resolve-only signal.
          if (m.validator_verdict == null) {
            continue;
          }
          if (m.validator_verdict === 'supports') {
            resolveAs = 'correct';
          } else if (m.validator_verdict === 'contradicts') {
            resolveAs = 'incorrect';
          } else {
            continue;
          }
        }

        if (m.source === 'predictions') {
          const accurate = resolveAs === 'correct';
          await client.query(`
            UPDATE predictions SET resolved = true, outcome = $2, accurate = $3, resolved_at = NOW()
            WHERE id = $1 AND resolved = false
          `, [m.id, eventText.slice(0, 500), accurate]);

          // Bayesian belief update on related beliefs
          beliefsUpdated += await cascadeBayesianUpdate(
            client, m.id, accurate, m.similarity, 'predictions',
          );
          m.auto_resolved = true;
          resolved++;
        } else if (m.source === 'generative_predictions') {
          await client.query(`
            UPDATE generative_predictions SET resolved = true, resolved_at = NOW()
            WHERE id = $1 AND resolved = false
          `, [m.id]);
          m.auto_resolved = true;
          resolved++;
        }
      }
    }

    return {
      predictions_checked: manualPredictions.rows.length + genPredictions.rows.length,
      predictions_matched: matches,
      predictions_resolved: resolved,
      beliefs_updated: beliefsUpdated,
    };
  } catch (err) {
    // Never break the parent tool
    console.error('[inference-loop] checkPredictions error:', (err as Error).message);
    return EMPTY_RESULT;
  } finally {
    if (needsRelease) client.release();
  }
}

// ─── surfacePredictions ───
// Given a search query, find open predictions that are semantically related.
// Called from: vault_search (appends to response metadata)

export async function surfacePredictions(
  queryText: string,
  limit: number = 3,
): Promise<PredictionMatch[]> {
  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(queryText);
    if (!embedding) return [];

    const embeddingStr = formatEmbedding(embedding);
    const matches: PredictionMatch[] = [];

    // Check manual predictions
    const manual = await client.query<{
      id: number; prediction: string; domain: string;
      confidence: number; content_id: number;
    }>(`
      SELECT p.id, p.prediction, p.domain, p.confidence, p.content_id
      FROM predictions p
      JOIN content c ON c.id = p.content_id
      WHERE p.resolved = false
        AND c.embedding IS NOT NULL
        AND (1 - (c.embedding <=> $1::vector)) > 0.4
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2
    `, [embeddingStr, limit]);

    for (const p of manual.rows) {
      const simResult = await client.query<{ sim: number }>(
        `SELECT (1 - (c.embedding <=> $1::vector))::numeric as sim FROM content c WHERE c.id = $2`,
        [embeddingStr, p.content_id],
      );
      matches.push({
        id: p.id,
        prediction: p.prediction.slice(0, 200),
        domain: p.domain,
        confidence: p.confidence,
        similarity: Math.round(parseFloat(String(simResult.rows[0]?.sim || 0)) * 1000) / 1000,
        source: 'predictions',
      });
    }

    return matches.slice(0, limit);
  } catch (err) {
    console.error('[inference-loop] surfacePredictions error:', (err as Error).message);
    return [];
  } finally {
    client.release();
  }
}

// ─── autoPredictFromDecision ───
// When a decision is recorded, auto-generate a prediction about the outcome.
// Called from: cognition.ts decide (action='record')

export async function autoPredictFromDecision(
  decision: string,
  reasoning: string,
  client: PoolClient,
): Promise<{ prediction_id: number; prediction: string } | null> {
  try {
    // Generate a prediction about the decision outcome
    const predictionText = `Expected outcome of decision: "${decision}" (reasoning: ${reasoning})`;
    const domain = 'decision_outcome';
    const confidence = 65; // moderate — decisions are inherently uncertain

    const embedding = await getEmbedding(predictionText);
    const embeddingStr = formatEmbedding(embedding);

    // Insert into content as prediction
    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding, confidence, network, belief_confidence, learned_at)
      VALUES ('prediction', 'inference_loop', $1, $2::vector, $3, 'belief', $4::numeric, NOW())
      RETURNING id
    `, [predictionText, embeddingStr, confidence, confidence / 100.0]);

    // Insert into predictions table
    const predResult = await client.query<{ id: number }>(`
      INSERT INTO predictions (content_id, prediction, domain, confidence, timeframe, resolved)
      VALUES ($1, $2, $3, $4, 'week', false)
      RETURNING id
    `, [contentResult.rows[0].id, predictionText, domain, confidence]);

    return {
      prediction_id: predResult.rows[0].id,
      prediction: predictionText,
    };
  } catch (err) {
    console.error('[inference-loop] autoPredictFromDecision error:', (err as Error).message);
    return null;
  }
}

// ─── autoPredict ───
// Generic prediction generator. Called when memorable events happen.
// Inserts into both predictions table AND generative_predictions table.

export async function autoPredict(
  predictionText: string,
  domain: string,
  confidence: number = 65,
  opts: {
    timeframe?: string;
    givenState?: string;
    client?: PoolClient;
  } = {},
): Promise<{ prediction_id: number; generative_id: number } | null> {
  const { timeframe = 'session', client: externalClient } = opts;
  const client = externalClient || await pool.connect();
  const needsRelease = !externalClient;

  try {
    const embedding = await getEmbedding(predictionText);
    const embeddingStr = formatEmbedding(embedding);

    // Insert into content
    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding, confidence, network, belief_confidence, learned_at)
      VALUES ('prediction', 'inference_loop', $1, $2::vector, $3, 'belief', $4::numeric, NOW())
      RETURNING id
    `, [predictionText, embeddingStr, confidence, confidence / 100.0]);

    // Insert into predictions table (manual tracking)
    const predResult = await client.query<{ id: number }>(`
      INSERT INTO predictions (content_id, prediction, domain, confidence, timeframe, resolved)
      VALUES ($1, $2, $3, $4, $5, false)
      RETURNING id
    `, [contentResult.rows[0].id, predictionText, domain, confidence, timeframe]);

    // 2026-05-17: stopped dual-writing to generative_predictions. That table
    // is the auto-resolving cerebellar stream (predict-before-action hook
    // writes + compare-after-action hook resolves). autoPredict callers
    // (vision_anticipate, autoPredictFromDecision) write manual predictions
    // with no automatic resolver — every row sat unresolved until the
    // orphan-cleanup script bulk-stamped them, polluting calibration with
    // synthetic prediction_error values.
    // Manual predictions stay in the predictions table; manual resolution
    // via vision_prediction_resolve.
    const genResult = { rows: [{ id: 0 }] };

    return {
      prediction_id: predResult.rows[0].id,
      generative_id: genResult.rows[0].id,
    };
  } catch (err) {
    console.error('[inference-loop] autoPredict error:', (err as Error).message);
    return null;
  } finally {
    if (needsRelease) client.release();
  }
}

// ─── cascadeBayesianUpdate ───
// When a prediction is resolved, update related beliefs' confidence.
// Internal helper — replicates the logic from inference.ts predictionResolve.

async function cascadeBayesianUpdate(
  client: PoolClient,
  predictionId: number,
  accurate: boolean,
  matchSimilarity: number,
  source: 'predictions' | 'generative_predictions',
): Promise<number> {
  try {
    let predEmbedding: string | null = null;
    let predContentId: number | null = null;

    if (source === 'predictions') {
      const pred = await client.query<{ content_id: number | null }>(
        'SELECT content_id FROM predictions WHERE id = $1', [predictionId],
      );
      predContentId = pred.rows[0]?.content_id ?? null;
      if (predContentId) {
        const emb = await client.query<{ embedding: string }>(
          'SELECT embedding FROM content WHERE id = $1 AND embedding IS NOT NULL',
          [predContentId],
        );
        predEmbedding = emb.rows[0]?.embedding ?? null;
      }
    }

    if (!predEmbedding) return 0;

    // Find semantically similar beliefs
    const relatedBeliefs = await client.query<{
      id: number; belief_confidence: number | null; similarity: number;
    }>(`
      SELECT c.id, c.belief_confidence,
             (1 - (c.embedding <=> $1::vector))::numeric as similarity
      FROM content c
      WHERE c.network = 'belief'
        AND c.superseded_by IS NULL
        AND c.id != $2
        AND c.embedding IS NOT NULL
        AND (1 - (c.embedding <=> $1::vector)) > 0.55
      ORDER BY (1 - (c.embedding <=> $1::vector)) DESC
      LIMIT 5
    `, [predEmbedding, predContentId]);

    let updated = 0;
    for (const belief of relatedBeliefs.rows) {
      const prior = belief.belief_confidence || 0.7;
      // Strength = similarity between event and prediction * match quality
      const strength = parseFloat(String(belief.similarity)) * Math.min(1.0, matchSimilarity);

      let likelihood: number;
      if (accurate) {
        likelihood = 0.5 + (strength * 0.5);
      } else {
        likelihood = 0.5 - (strength * 0.4);
      }
      const marginal = likelihood * prior + (1 - likelihood) * (1 - prior);
      const posterior = Math.max(0.05, Math.min(0.95, (likelihood * prior) / marginal));

      if (Math.abs(posterior - prior) > 0.01) {
        await client.query(`
          UPDATE content SET
            belief_confidence = $1,
            evidence_count = COALESCE(evidence_count, 0) + 1,
            last_evidence_at = NOW()
          WHERE id = $2
        `, [posterior, belief.id]);
        updated++;
      }
    }

    // Update prediction's own belief confidence
    if (predContentId) {
      await client.query(
        'UPDATE content SET belief_confidence = $1 WHERE id = $2',
        [accurate ? 0.9 : 0.2, predContentId],
      );
    }

    return updated;
  } catch (err) {
    console.error('[inference-loop] cascadeBayesianUpdate error:', (err as Error).message);
    return 0;
  }
}
