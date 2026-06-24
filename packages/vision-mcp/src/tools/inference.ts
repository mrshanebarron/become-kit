/**
 * Inference Tools — inferenceCycle, predictionMake, predictionOpen, predictionResolve, predictionSurprises
 * Active inference loop: predictions, resolution, Bayesian belief updates, learning dashboard.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── inferenceCycle ───

async function inferenceCycle(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const report: Record<string, unknown> = {};

    // 1. Prediction accuracy by domain (merges both prediction tables)
    const domainAccuracy = await client.query(`
      WITH all_predictions AS (
        SELECT domain, confidence,
          CASE WHEN accurate THEN 'correct' WHEN accurate = false THEN 'incorrect' ELSE 'unknown' END as resolution
        FROM predictions WHERE resolved = true
        UNION ALL
        SELECT domain, confidence,
          COALESCE(resolution, 'unknown') as resolution
        FROM generative_predictions WHERE resolved = true AND resolution IS NOT NULL AND resolution != 'stale'
      )
      SELECT domain,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE resolution = 'correct') as correct,
        COUNT(*) FILTER (WHERE resolution = 'incorrect') as incorrect,
        COUNT(*) FILTER (WHERE resolution = 'partial') as partial,
        ROUND(COUNT(*) FILTER (WHERE resolution = 'correct')::numeric / GREATEST(1, COUNT(*) FILTER (WHERE resolution IN ('correct', 'incorrect'))) * 100, 1) as accuracy_pct,
        ROUND(AVG(confidence)::numeric, 1) as avg_predicted_confidence
      FROM all_predictions
      GROUP BY domain
      HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC
    `);
    report.prediction_accuracy = domainAccuracy.rows;

    // 2. Calibration check — are my confidence levels accurate?
    const calibration = await client.query(`
      WITH all_predictions AS (
        SELECT confidence,
          CASE WHEN accurate THEN 'correct' WHEN accurate = false THEN 'incorrect' ELSE 'unknown' END as resolution
        FROM predictions WHERE resolved = true
        UNION ALL
        SELECT confidence,
          COALESCE(resolution, 'unknown') as resolution
        FROM generative_predictions WHERE resolved = true AND resolution IS NOT NULL AND resolution != 'stale'
      )
      SELECT
        CASE
          WHEN confidence >= 0.8 THEN 'high (80-100)'
          WHEN confidence >= 0.5 THEN 'medium (50-79)'
          ELSE 'low (0-49)'
        END as confidence_tier,
        COUNT(*) as total,
        ROUND(COUNT(*) FILTER (WHERE resolution = 'correct')::numeric / GREATEST(1, COUNT(*) FILTER (WHERE resolution IN ('correct', 'incorrect'))) * 100, 1) as actual_accuracy
      FROM all_predictions
      GROUP BY 1
      ORDER BY 1
    `);
    report.calibration = calibration.rows;

    // 2b. Advanced calibration: Pearson correlation (sensitivity) and Brier score
    const calibrationAdvanced = await client.query(`
      WITH all_preds AS (
        SELECT confidence,
          CASE WHEN accurate THEN 1.0 ELSE 0.0 END as hit
        FROM predictions WHERE resolved = true AND accurate IS NOT NULL
      ),
      stats AS (
        SELECT
          COUNT(*) as n,
          AVG(confidence / 100.0) as avg_conf,
          AVG(hit) as avg_hit,
          STDDEV_POP(confidence / 100.0) as std_conf,
          STDDEV_POP(hit) as std_hit,
          AVG(POWER(confidence / 100.0 - hit, 2)) as brier_score,
          COALESCE(CORR(confidence / 100.0, hit), 0) as pearson_r
        FROM all_preds WHERE (SELECT COUNT(*) FROM all_preds) >= 5
      )
      SELECT
        n::int,
        ROUND(pearson_r::numeric, 3) as sensitivity,
        ROUND(brier_score::numeric, 3) as brier_score,
        ROUND(avg_conf::numeric, 3) as mean_confidence,
        ROUND(avg_hit::numeric, 3) as mean_accuracy,
        ROUND((avg_conf - avg_hit)::numeric, 3) as overconfidence_gap
      FROM stats
      WHERE n > 0
    `);
    if (calibrationAdvanced.rows.length > 0) {
      const cal = calibrationAdvanced.rows[0];
      report.calibration_metrics = {
        ...cal,
        interpretation: {
          sensitivity: parseFloat(cal.sensitivity) > 0.5 ? 'good' :
            parseFloat(cal.sensitivity) > 0.2 ? 'moderate' :
            parseFloat(cal.sensitivity) > 0 ? 'weak' : 'inverted',
          brier: parseFloat(cal.brier_score) < 0.15 ? 'well-calibrated' :
            parseFloat(cal.brier_score) < 0.25 ? 'moderate' : 'poorly-calibrated',
          overconfidence: parseFloat(cal.overconfidence_gap) > 0.1 ? 'overconfident' :
            parseFloat(cal.overconfidence_gap) < -0.1 ? 'underconfident' : 'calibrated',
        },
      };
    }

    // 3. Belief confidence distribution
    const beliefHealth = await client.query(`
      SELECT
        CASE
          WHEN belief_confidence >= 0.8 THEN 'strong (0.8-1.0)'
          WHEN belief_confidence >= 0.5 THEN 'moderate (0.5-0.79)'
          WHEN belief_confidence >= 0.2 THEN 'weak (0.2-0.49)'
          ELSE 'very weak (0.0-0.19)'
        END as confidence_tier,
        COUNT(*) as count,
        ROUND(AVG(evidence_count)::numeric, 1) as avg_evidence
      FROM content
      WHERE network = 'belief' AND superseded_by IS NULL AND belief_confidence IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `);
    report.belief_health = beliefHealth.rows;

    // 4. Skills with declining performance
    const degradingSkills = await client.query(`
      SELECT id, LEFT(content_text, 100) as skill,
        skill_success_count, skill_fail_count,
        ROUND(skill_fail_count::numeric / GREATEST(1, skill_success_count + skill_fail_count) * 100, 1) as fail_rate
      FROM content
      WHERE network = 'skill' AND superseded_by IS NULL
        AND (skill_success_count + skill_fail_count) >= 3
        AND skill_fail_count::numeric / GREATEST(1, skill_success_count + skill_fail_count) > 0.3
      ORDER BY fail_rate DESC
      LIMIT 10
    `);
    report.degrading_skills = degradingSkills.rows;

    // 5. Beliefs that have been updated most (most evidence)
    const mostUpdated = await client.query(`
      SELECT id, LEFT(content_text, 100) as belief,
        belief_confidence, evidence_count, last_evidence_at
      FROM content
      WHERE network = 'belief' AND superseded_by IS NULL
        AND evidence_count > 0
      ORDER BY evidence_count DESC
      LIMIT 10
    `);
    report.most_evidenced_beliefs = mostUpdated.rows;

    // 6. Recent belief revisions
    const revisions = await client.query(`
      SELECT c.id, LEFT(c.content_text, 100) as new_belief,
        c.belief_confidence as new_confidence,
        c.revises_belief as old_belief_id,
        LEFT(old.content_text, 100) as old_belief,
        old.belief_confidence as old_confidence,
        c.learned_at
      FROM content c
      LEFT JOIN content old ON c.revises_belief = old.id
      WHERE c.revises_belief IS NOT NULL
      ORDER BY c.learned_at DESC
      LIMIT 10
    `);
    report.recent_revisions = revisions.rows;

    // 7. Unresolved predictions that may be stale
    const stalePredictions = await client.query(`
      SELECT id, prediction, domain, confidence, timeframe, created_at
      FROM predictions
      WHERE resolved = false
        AND created_at < NOW() - INTERVAL '7 days'
      ORDER BY created_at ASC
      LIMIT 10
    `);
    report.stale_predictions = stalePredictions.rows;

    // 8. Eval coverage. Absence of eval data is not health; it is unmeasured.
    let evalCoverage: Record<string, unknown> = {
      status: 'not_wired',
      active_cases: 0,
      measured_cases: 0,
      unmeasured_cases: 0,
      failing_cases: 0,
      partial_cases: 0,
      avg_score: null,
      detail: 'vision_eval_cases table not found; apply migration 041 to enable measured evolution.',
    };
    const evalTable = await client.query<{ exists: string | null }>(
      `SELECT to_regclass('public.vision_eval_cases')::text AS exists`,
    );
    if (evalTable.rows[0]?.exists) {
      const evalSummary = await client.query<{
        active_cases: string;
        measured_cases: string;
        unmeasured_cases: string;
        failing_cases: string;
        partial_cases: string;
        avg_score: string | null;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active') AS active_cases,
          COUNT(*) FILTER (WHERE status = 'active' AND last_evaluated_at IS NOT NULL) AS measured_cases,
          COUNT(*) FILTER (WHERE status = 'active' AND last_evaluated_at IS NULL) AS unmeasured_cases,
          COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'fail') AS failing_cases,
          COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'partial') AS partial_cases,
          ROUND(AVG(last_score) FILTER (WHERE status = 'active' AND last_score IS NOT NULL), 3) AS avg_score
        FROM vision_eval_case_status
      `);
      const evalRow = evalSummary.rows[0];
      const active = parseInt(evalRow.active_cases);
      const measured = parseInt(evalRow.measured_cases);
      const failing = parseInt(evalRow.failing_cases);
      const partial = parseInt(evalRow.partial_cases);
      evalCoverage = {
        status: active === 0
          ? 'unmeasured'
          : measured === 0
            ? 'unmeasured'
            : failing > 0
              ? 'degraded'
              : partial > 0
                ? 'partial'
                : 'measured',
        active_cases: active,
        measured_cases: measured,
        unmeasured_cases: parseInt(evalRow.unmeasured_cases),
        failing_cases: failing,
        partial_cases: partial,
        avg_score: evalRow.avg_score === null ? null : parseFloat(evalRow.avg_score),
      };
    }
    report.eval_coverage = evalCoverage;

    // Summary
    const totalPredictions = await client.query<{ resolved: string; open: string }>(
      'SELECT COUNT(*) FILTER (WHERE resolved) as resolved, COUNT(*) FILTER (WHERE NOT resolved) as open FROM predictions',
    );
    const tp = totalPredictions.rows[0];
    const measurementGaps: string[] = [];
    if (domainAccuracy.rows.length === 0) {
      measurementGaps.push('no prediction domains have enough resolved predictions for accuracy');
    }
    if (calibration.rows.length === 0) {
      measurementGaps.push('no calibration tiers have resolved data');
    }
    const evalStatus = evalCoverage.status as string;
    if (evalStatus === 'not_wired') {
      measurementGaps.push('eval harness schema is not applied');
    } else if (evalStatus === 'unmeasured') {
      measurementGaps.push('eval harness has no measured active cases');
    } else if (evalStatus === 'degraded') {
      measurementGaps.push('eval harness has failing active cases');
    }

    report.summary = {
      predictions_resolved: parseInt(tp.resolved),
      predictions_open: parseInt(tp.open),
      domains_tracked: domainAccuracy.rows.length,
      degrading_skills_count: degradingSkills.rows.length,
      stale_predictions_count: stalePredictions.rows.length,
      measurement_status: measurementGaps.length > 0 ? 'incomplete' : 'measured',
      measurement_gaps: measurementGaps,
      recommendation: degradingSkills.rows.length > 0
        ? `${degradingSkills.rows.length} skill(s) have >30% failure rate — review and potentially revise`
        : stalePredictions.rows.length > 0
          ? `${stalePredictions.rows.length} prediction(s) are >7 days old and unresolved — resolve or discard`
          : measurementGaps.length > 0
            ? `Measurement incomplete: ${measurementGaps.join('; ')}.`
            : 'Systems measured and healthy. Keep predicting, resolving, and running evals.',
    };

    return jsonResult(report);
  } finally {
    client.release();
  }
}

// ─── predictionMake ───

async function predictionMake(args: Record<string, unknown>): Promise<CallToolResult> {
  const prediction = args.prediction as string;
  const domain = args.domain as string;
  let confidence = (args.confidence as number) ?? 70;
  const timeframe = (args.timeframe as string) || 'session';

  const client = await pool.connect();
  try {
    // CALIBRATION CHECK: Compare stated confidence to historical accuracy
    let calibrationWarning: string | null = null;
    let suggestedConfidence: number | null = null;

    const historicalAccuracy = await client.query<{
      confidence_tier: string;
      total: string;
      actual_accuracy: string;
    }>(`
      SELECT
        CASE
          WHEN confidence >= 80 THEN 'high'
          WHEN confidence >= 50 THEN 'medium'
          ELSE 'low'
        END as confidence_tier,
        COUNT(*) as total,
        ROUND(AVG(CASE WHEN accurate THEN 1 ELSE 0 END)::numeric * 100, 1) as actual_accuracy
      FROM predictions
      WHERE resolved = true AND domain = $1
      GROUP BY 1
      HAVING COUNT(*) >= 3
    `, [domain]);

    // Check if my confidence tier has poor calibration
    const tier = confidence >= 80 ? 'high' : confidence >= 50 ? 'medium' : 'low';
    const tierData = historicalAccuracy.rows.find(r => r.confidence_tier === tier);

    if (tierData) {
      const actualAcc = parseFloat(tierData.actual_accuracy);
      const tierMidpoint = tier === 'high' ? 90 : tier === 'medium' ? 65 : 25;

      // If actual accuracy differs from tier midpoint by more than 20 points, warn
      if (Math.abs(actualAcc - tierMidpoint) > 20) {
        calibrationWarning = `Calibration alert: Your ${tier}-confidence predictions in domain "${domain}" have ${actualAcc}% actual accuracy (based on ${tierData.total} resolved predictions). `;
        if (actualAcc < tierMidpoint) {
          suggestedConfidence = Math.max(1, Math.round(confidence * (actualAcc / tierMidpoint)));
          calibrationWarning += `Consider lower confidence (~${suggestedConfidence}%).`;
        } else {
          suggestedConfidence = Math.min(99, Math.round(confidence * (actualAcc / tierMidpoint)));
          calibrationWarning += `You may be underconfident — actual accuracy supports ~${suggestedConfidence}%.`;
        }
      }
    }

    // Domain-specific calibration: behavior predictions have 0% accuracy historically
    if (domain === 'behavior') {
      const behaviorCheck = await client.query<{ total: string; accuracy: string }>(`
        SELECT COUNT(*) as total,
               ROUND(AVG(CASE WHEN accurate THEN 1 ELSE 0 END)::numeric * 100, 1) as accuracy
        FROM predictions WHERE resolved = true AND domain = 'behavior'
      `);
      if (parseInt(behaviorCheck.rows[0]?.total || '0') >= 2) {
        const behaviorAcc = parseFloat(behaviorCheck.rows[0]?.accuracy || '0');
        if (behaviorAcc < 20 && confidence > 40) {
          calibrationWarning = `Behavior prediction warning: Historical accuracy in this domain is ${behaviorAcc}% (${behaviorCheck.rows[0].total} predictions). Your stated ${confidence}% confidence may be overconfident. Consider graduated success criteria instead of binary outcomes.`;
          suggestedConfidence = Math.min(40, confidence);
        }
      }
    }

    const embedding = await getEmbedding(prediction);
    const embeddingStr = formatEmbedding(embedding);

    // Insert into content first — predictions are beliefs about the future
    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding, confidence, network, belief_confidence, learned_at)
      VALUES ('prediction', 'anticipation', $1, $2::vector, $3, 'belief', $4, NOW())
      RETURNING id
    `, [prediction, embeddingStr, confidence, confidence / 100.0]);

    const result = await client.query<{ id: number }>(`
      INSERT INTO predictions (content_id, prediction, domain, confidence, timeframe, resolved)
      VALUES ($1, $2, $3, $4, $5, false)
      RETURNING id
    `, [contentResult.rows[0].id, prediction, domain, confidence, timeframe]);

    // Also insert into generative_predictions so session_evolve's inference loop can find it
    await client.query(`
      INSERT INTO generative_predictions (predicted_content, predicted_embedding, domain, confidence, temporal_level, resolved)
      VALUES ($1, $2::vector, $3, $4, 1, false)
    `, [prediction, embeddingStr, domain, confidence]);

    const response: Record<string, unknown> = {
      success: true,
      id: result.rows[0].id,
      prediction,
      confidence,
      dual_tracked: true,
    };

    if (calibrationWarning) {
      response.calibration_warning = calibrationWarning;
      response.suggested_confidence = suggestedConfidence;
    }

    return jsonResult(response);
  } finally {
    client.release();
  }
}

// ─── predictionResolve ───

async function predictionResolve(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;
  const outcome = args.outcome as string;
  const actual = args.actual as string;
  const surprise_level = (args.surprise_level as number) ?? 0;

  const client = await pool.connect();
  try {
    // Determine if prediction was accurate
    const accurate = outcome === 'correct';

    await client.query(`
      UPDATE predictions
      SET resolved = true, outcome = $2, accurate = $3, resolved_at = NOW()
      WHERE id = $1
    `, [id, actual, accurate]);

    // Get prediction details for belief update
    const predResult = await client.query<{
      prediction: string;
      domain: string;
      content_id: number | null;
      confidence: number;
    }>('SELECT prediction, domain, content_id, confidence FROM predictions WHERE id = $1', [id]);
    const pred = predResult.rows[0];
    const beliefUpdates: Array<{
      belief_id: number;
      text: string;
      prior: number;
      posterior: number;
      delta: number;
      evidence: string;
    }> = [];

    // Record prediction error if there was surprise
    if (surprise_level > 0 && pred) {
      const errorText = `Expected: ${pred.prediction}. Actual: ${actual}`;
      const embedding = await getEmbedding(errorText);
      const embeddingStr = formatEmbedding(embedding);

      const contentResult = await client.query<{ id: number }>(`
        INSERT INTO content (content_type, source_system, content_text, embedding, network, belief_confidence, learned_at)
        VALUES ('prediction_error', 'anticipation', $1, $2::vector, 'belief', 0.5, NOW())
        RETURNING id
      `, [errorText, embeddingStr]);

      // Map surprise_level (1-10) to error_direction
      const errorDirection = outcome === 'correct' ? 'positive' : (outcome === 'incorrect' ? 'negative' : 'neutral');

      await client.query(`
        INSERT INTO prediction_errors (content_id, expected, actual, error_direction, magnitude, learning)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [contentResult.rows[0].id, pred.prediction, actual, errorDirection, surprise_level / 10.0, `Surprise level: ${surprise_level}`]);
    }

    // ACTIVE INFERENCE: Update related beliefs based on prediction outcome
    if (pred && pred.content_id) {
      // Find semantically similar beliefs and update their confidence
      const predEmbedding = await client.query<{ embedding: string }>(
        'SELECT embedding FROM content WHERE id = $1 AND embedding IS NOT NULL',
        [pred.content_id],
      );

      if (predEmbedding.rows.length > 0 && predEmbedding.rows[0].embedding) {
        const relatedBeliefs = await client.query<{
          id: number;
          content_text: string;
          belief_confidence: number | null;
          similarity: number;
        }>(`
          SELECT c.id, c.content_text, c.belief_confidence,
                 1 - (c.embedding <=> $1::vector) as similarity
          FROM content c
          WHERE c.network = 'belief'
            AND c.superseded_by IS NULL
            AND c.id != $2
            AND c.embedding IS NOT NULL
            AND (1 - (c.embedding <=> $1::vector)) > 0.6
          ORDER BY (1 - (c.embedding <=> $1::vector)) DESC
          LIMIT 5
        `, [predEmbedding.rows[0].embedding, pred.content_id]);

        for (const belief of relatedBeliefs.rows) {
          const prior = belief.belief_confidence || 0.7;
          const evidenceType = accurate ? 'supporting' : 'contradicting';
          // Strength scaled by similarity and surprise
          const strength = parseFloat(String(belief.similarity)) * (surprise_level > 0 ? Math.min(1.0, surprise_level / 10.0) : 0.3);

          let likelihood: number;
          if (evidenceType === 'supporting') {
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

            beliefUpdates.push({
              belief_id: belief.id,
              text: belief.content_text?.slice(0, 80) || '',
              prior: parseFloat(prior.toFixed(3)),
              posterior: parseFloat(posterior.toFixed(3)),
              delta: parseFloat((posterior - prior).toFixed(3)),
              evidence: evidenceType,
            });
          }
        }
      }

      // Update the prediction's own belief_confidence
      await client.query(`
        UPDATE content SET belief_confidence = $1 WHERE id = $2
      `, [accurate ? 0.9 : 0.2, pred.content_id]);
    }

    return jsonResult({
      success: true,
      id,
      outcome,
      accurate,
      surprise_level,
      active_inference: {
        beliefs_updated: beliefUpdates.length,
        updates: beliefUpdates,
      },
    });
  } finally {
    client.release();
  }
}

// ─── predictionOpen ───

async function predictionOpen(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      prediction: string;
      domain: string;
      confidence: number;
      timeframe: string;
      created_at: Date;
    }>(`
      SELECT id, prediction, domain, confidence, timeframe, created_at
      FROM predictions
      WHERE resolved = false
      ORDER BY created_at DESC
    `);
    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── predictionSurprises ───

async function predictionSurprises(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    const result = await client.query<{
      expected: string;
      actual: string;
      surprise_level: number;
      error_direction: string;
      learning: string;
      created_at: Date;
    }>(`
      SELECT pe.expected, pe.actual, pe.magnitude as surprise_level, pe.error_direction, pe.learning, pe.created_at
      FROM prediction_errors pe
      ORDER BY pe.magnitude DESC, pe.created_at DESC
      LIMIT $1
    `, [limit]);
    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_inference_cycle',
      description: 'Run active inference analysis: prediction accuracy by domain, calibration check, belief health, degrading skills, recent revisions, stale predictions. The learning-from-experience dashboard.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => inferenceCycle(),
  },
  {
    definition: {
      name: 'vision_prediction_make',
      description: 'Make a prediction to track',
      inputSchema: {
        type: 'object',
        properties: {
          prediction: { type: 'string' },
          domain: { type: 'string' },
          confidence: { type: 'number', description: '0-100' },
          timeframe: { type: 'string', description: 'session, day, week, month' },
        },
        required: ['prediction', 'domain'],
      },
    },
    handler: (args) => predictionMake(args),
  },
  {
    definition: {
      name: 'vision_prediction_resolve',
      description: 'Resolve a prediction with outcome',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          outcome: { type: 'string', description: 'correct, incorrect, partial' },
          actual: { type: 'string' },
          surprise_level: { type: 'number', description: '0-10, how surprising was the result' },
        },
        required: ['id', 'outcome', 'actual'],
      },
    },
    handler: (args) => predictionResolve(args),
  },
  {
    definition: {
      name: 'vision_prediction_open',
      description: 'Get open predictions awaiting resolution',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => predictionOpen(),
  },
  {
    definition: {
      name: 'vision_prediction_surprises',
      description: 'Get prediction errors sorted by surprise',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => predictionSurprises(args),
  },
];

export default tools;
