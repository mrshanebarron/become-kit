/**
 * Belief SPRT Tools — beliefSPRT, calibration, counterfactual analysis
 * Sequential probability ratio testing, prediction calibration, and counterfactual analysis.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── beliefSPRT ───

async function beliefSPRT(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const beliefId = (args.belief_id as number) || null;
  const evidenceType = (args.evidence_type as string) || null;
  const strength = (args.strength as number) ?? 0.6;
  const limit = (args.limit as number) || 20;

  // SPRT boundaries: alpha=0.05, beta=0.10
  const A = Math.log(0.9 / 0.05);   // ~2.89 — promote threshold
  const B = Math.log(0.1 / 0.95);   // ~-2.25 — demote threshold

  const client = await pool.connect();
  try {
    switch (action) {
      case 'status': {
        const beliefs = await client.query<{
          sprt_status: string;
          count: string;
        }>(`
          SELECT COALESCE(sprt_status, 'untested') as sprt_status, COUNT(*) as count
          FROM content WHERE network = 'belief' AND superseded_by IS NULL
          GROUP BY sprt_status ORDER BY count DESC
        `);

        // Find zombie beliefs: moderate confidence, zero evidence, 3+ days old
        const zombies = await client.query<{ id: number; content_text: string; belief_confidence: number }>(`
          SELECT id, content_text, belief_confidence FROM content
          WHERE network = 'belief' AND superseded_by IS NULL
            AND COALESCE(evidence_count, 0) = 0
            AND belief_confidence BETWEEN 0.3 AND 0.7
            AND created_at < NOW() - INTERVAL '3 days'
          LIMIT ${limit}
        `);

        return jsonResult({
          status_distribution: beliefs.rows,
          zombie_beliefs: zombies.rows.map(z => ({
            id: z.id,
            text: z.content_text?.slice(0, 100),
            confidence: z.belief_confidence,
          })),
          boundaries: { promote: A.toFixed(3), demote: B.toFixed(3) },
        });
      }

      case 'test': {
        if (!beliefId) return jsonResult({ error: 'Need belief_id' });

        const belief = await client.query<{
          id: number; content_text: string; belief_confidence: number;
          sprt_log_ratio: number; sprt_status: string; evidence_count: number;
        }>(`
          SELECT id, content_text, belief_confidence,
                 COALESCE(sprt_log_ratio, 0) as sprt_log_ratio,
                 COALESCE(sprt_status, 'accumulating') as sprt_status,
                 COALESCE(evidence_count, 0) as evidence_count
          FROM content WHERE id = $1
        `, [beliefId]);

        if (belief.rows.length === 0) return jsonResult({ error: 'Belief not found' });
        const b = belief.rows[0];
        const ratio = b.sprt_log_ratio;

        let newStatus = 'accumulating';
        let confidenceDelta = 0;
        if (ratio >= A) {
          newStatus = 'promoted';
          confidenceDelta = 0.1;
        } else if (ratio <= B) {
          newStatus = 'demoted';
          confidenceDelta = -0.2;
        }

        if (newStatus !== b.sprt_status || confidenceDelta !== 0) {
          await client.query(`
            UPDATE content SET
              sprt_status = $1,
              belief_confidence = LEAST(0.95, GREATEST(0.05, COALESCE(belief_confidence, 0.5) + $2)),
              updated_at = NOW()
            WHERE id = $3
          `, [newStatus, confidenceDelta, beliefId]);
        }

        return jsonResult({
          belief_id: beliefId,
          text: b.content_text?.slice(0, 100),
          log_ratio: parseFloat(ratio.toFixed(4)),
          status: newStatus,
          confidence_delta: confidenceDelta,
          evidence_count: b.evidence_count,
          boundaries: { promote: A.toFixed(3), demote: B.toFixed(3) },
        });
      }

      case 'evidence': {
        if (!beliefId || !evidenceType) return jsonResult({ error: 'Need belief_id and evidence_type' });

        const clampedStrength = Math.max(0.1, Math.min(0.9, strength));
        // Log-likelihood ratio
        const lr = evidenceType === 'supporting'
          ? Math.log(clampedStrength / (1 - clampedStrength))
          : Math.log((1 - clampedStrength) / clampedStrength);

        await client.query(`
          UPDATE content SET
            sprt_log_ratio = COALESCE(sprt_log_ratio, 0) + $1,
            evidence_count = COALESCE(evidence_count, 0) + 1,
            last_evidence_at = NOW(),
            updated_at = NOW()
          WHERE id = $2
        `, [lr, beliefId]);

        // Auto-run test after evidence
        const testResult = await beliefSPRT({ action: 'test', belief_id: beliefId });
        return testResult;
      }

      case 'sweep': {
        const candidates = await client.query<{ id: number }>(`
          SELECT id FROM content
          WHERE network = 'belief' AND superseded_by IS NULL
            AND COALESCE(evidence_count, 0) > 0
          ORDER BY updated_at DESC LIMIT 100
        `);

        let promoted = 0, demoted = 0, accumulating = 0;
        for (const c of candidates.rows) {
          const result = await beliefSPRT({ action: 'test', belief_id: c.id });
          const data = JSON.parse((result.content[0] as { text: string }).text);
          if (data.status === 'promoted') promoted++;
          else if (data.status === 'demoted') demoted++;
          else accumulating++;
        }

        return jsonResult({
          sweep: true,
          tested: candidates.rows.length,
          promoted, demoted, accumulating,
        });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use status, test, evidence, sweep` });
    }
  } finally {
    client.release();
  }
}

// ─── calibration ───

async function calibrationAnalysis(args: Record<string, unknown>): Promise<CallToolResult> {
  const domain = (args.domain as string) || null;
  const binCount = (args.bins as number) || 10;
  const persist = args.persist !== false;

  const client = await pool.connect();
  try {
    let whereClause = "WHERE resolved = true AND accurate IS NOT NULL AND confidence IS NOT NULL";
    const params: unknown[] = [];
    if (domain && domain !== 'all') {
      params.push(domain);
      whereClause += ` AND domain = $${params.length}`;
    }

    const predictions = await client.query<{
      confidence: number;
      accurate: boolean;
      domain: string | null;
    }>(`
      SELECT confidence, accurate, domain
      FROM predictions ${whereClause}
    `, params);

    if (predictions.rows.length === 0) return jsonResult({ error: 'No resolved predictions found' });

    const normalized = predictions.rows.map(p => ({
      conf01: (p.confidence ?? 50) / 100,
      correct: p.accurate === true ? 1 : 0,
      domain: p.domain || 'unknown',
    }));

    const binData: Array<{
      bin_lower: number; bin_upper: number;
      avg_confidence: number; actual_accuracy: number;
      total_predictions: number; correct_predictions: number;
      gap: number; ece_contribution: number;
    }> = [];
    let totalWeightedGap = 0;
    let brierSum = 0;

    // Integer-indexed bucketing avoids IEEE 754 drift at bin edges (e.g., 0.6).
    const bucketed: Array<typeof normalized> = Array.from({ length: binCount }, () => []);
    for (const p of normalized) {
      const idx = Math.max(0, Math.min(binCount - 1, Math.floor(p.conf01 * binCount)));
      bucketed[idx].push(p);
    }

    for (let i = 0; i < binCount; i++) {
      const lower = i / binCount;
      const upper = (i + 1) / binCount;
      const inBin = bucketed[i];
      if (inBin.length === 0) continue;

      const avgConf = inBin.reduce((s, p) => s + p.conf01, 0) / inBin.length;
      const correct = inBin.reduce((s, p) => s + p.correct, 0);
      const accuracy = correct / inBin.length;
      const gap = Math.abs(avgConf - accuracy);
      const weight = inBin.length / normalized.length;
      const eceContrib = gap * weight;
      totalWeightedGap += eceContrib;

      binData.push({
        bin_lower: parseFloat(lower.toFixed(2)),
        bin_upper: parseFloat(Math.min(upper, 1).toFixed(2)),
        avg_confidence: parseFloat(avgConf.toFixed(3)),
        actual_accuracy: parseFloat(accuracy.toFixed(3)),
        total_predictions: inBin.length,
        correct_predictions: correct,
        gap: parseFloat(gap.toFixed(3)),
        ece_contribution: parseFloat(eceContrib.toFixed(4)),
      });
    }

    for (const p of normalized) {
      brierSum += Math.pow(p.conf01 - p.correct, 2);
    }
    const brierScore = brierSum / normalized.length;

    // Replace bins for this domain — single snapshot of current state
    if (persist) {
      const targetDomain = domain || 'all';
      await client.query('DELETE FROM calibration_bins WHERE domain = $1', [targetDomain]);
      for (const bin of binData) {
        await client.query(`
          INSERT INTO calibration_bins
            (bin_lower, bin_upper, domain, total_predictions, correct_predictions,
             avg_confidence, actual_accuracy, ece_contribution, last_updated)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        `, [
          bin.bin_lower, bin.bin_upper, targetDomain,
          bin.total_predictions, bin.correct_predictions,
          bin.avg_confidence, bin.actual_accuracy, bin.ece_contribution,
        ]);
      }
    }

    const domains = [...new Set(normalized.map(p => p.domain))];
    const domainStats = domains.map(d => {
      const dp = normalized.filter(p => p.domain === d);
      const acc = dp.reduce((s, p) => s + p.correct, 0) / dp.length;
      const avgConf = dp.reduce((s, p) => s + p.conf01, 0) / dp.length;
      return {
        domain: d, count: dp.length,
        accuracy: parseFloat(acc.toFixed(3)),
        avg_confidence: parseFloat(avgConf.toFixed(3)),
        gap: parseFloat(Math.abs(acc - avgConf).toFixed(3)),
      };
    }).sort((a, b) => b.gap - a.gap);

    const ece = totalWeightedGap;
    const interpretation = ece < 0.05 ? 'well calibrated' : ece < 0.15 ? 'moderately calibrated' : 'poorly calibrated';

    const worstBin = binData.slice().sort((a, b) => b.gap - a.gap)[0];
    const diagnostic = worstBin
      ? `Worst bin: ${worstBin.bin_lower}-${worstBin.bin_upper} predicted ${(worstBin.avg_confidence * 100).toFixed(0)}% confidence but actually ${(worstBin.actual_accuracy * 100).toFixed(0)}% accurate (${worstBin.total_predictions} predictions).`
      : null;

    return jsonResult({
      total_predictions: normalized.length,
      ece: parseFloat(ece.toFixed(4)),
      brier_score: parseFloat(brierScore.toFixed(4)),
      interpretation,
      diagnostic,
      bins: binData,
      domains: domainStats,
      persisted: persist,
    });
  } finally {
    client.release();
  }
}

// ─── counterfactual analysis (distinct from cognition's simulate) ───

async function counterfactualAnalyze(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const predictionId = (args.prediction_id as number) || null;
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    if (action === 'list') {
      const analyses = await client.query<{
        id: number; prediction_id: number; prediction_text: string;
        best_explanation: string; corrective_intention: string; created_at: Date;
      }>(`
        SELECT ca.id, ca.prediction_id, p.prediction as prediction_text,
               ca.best_explanation, ca.corrective_intention, ca.created_at
        FROM counterfactual_analyses ca
        JOIN predictions p ON p.id = ca.prediction_id
        ORDER BY ca.created_at DESC LIMIT $1
      `, [limit]);
      return jsonResult({ analyses: analyses.rows });
    }

    // analyze
    if (!predictionId) return jsonResult({ error: 'Need prediction_id' });

    const pred = await client.query<{
      id: number; prediction: string; confidence: number; outcome: string;
      domain: string; resolved_at: Date;
    }>(`
      SELECT id, prediction, confidence, outcome, domain, resolved_at
      FROM predictions WHERE id = $1 AND outcome = 'incorrect'
    `, [predictionId]);

    if (pred.rows.length === 0) return jsonResult({ error: 'Failed prediction not found' });
    const p = pred.rows[0];

    const embedding = await getEmbedding(p.prediction);
    let relatedBeliefs: Array<{ id: number; content_text: string; belief_confidence: number; evidence_count: number }> = [];
    let similarPreds: Array<{ id: number; prediction: string; outcome: string; confidence: number }> = [];

    if (embedding) {
      const formattedEmb = formatEmbedding(embedding);
      relatedBeliefs = (await client.query<{
        id: number; content_text: string; belief_confidence: number; evidence_count: number;
      }>(`
        SELECT id, content_text, belief_confidence, COALESCE(evidence_count, 0) as evidence_count
        FROM content WHERE network = 'belief' AND superseded_by IS NULL AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector LIMIT 5
      `, [formattedEmb])).rows;

      similarPreds = (await client.query<{
        id: number; prediction: string; outcome: string; confidence: number;
      }>(`
        SELECT id, prediction, outcome, confidence FROM predictions
        WHERE resolved_at IS NOT NULL AND id != $1
        ORDER BY embedding <=> $2::vector LIMIT 5
      `, [predictionId, formattedEmb])).rows;
    }

    // Generate candidate explanations
    const explanations: Array<{ type: string; explanation: string; confidence: number; mutable: boolean }> = [];

    // Poorly evidenced beliefs
    for (const b of relatedBeliefs) {
      if (b.evidence_count < 2 && b.belief_confidence > 0.5) {
        explanations.push({
          type: 'weak_evidence',
          explanation: `Relied on belief #${b.id} ("${b.content_text?.slice(0, 60)}...") which has only ${b.evidence_count} evidence`,
          confidence: 0.6,
          mutable: true,
        });
      }
    }

    // Bad domain track record
    const domainAccuracy = await client.query<{ total: string; correct: string }>(`
      SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) as correct
      FROM predictions WHERE domain = $1 AND resolved_at IS NOT NULL
    `, [p.domain]);
    const dr = domainAccuracy.rows[0];
    const domainRate = parseInt(dr.total) > 0 ? parseInt(dr.correct) / parseInt(dr.total) : 0;
    if (domainRate < 0.5 && parseInt(dr.total) > 3) {
      explanations.push({
        type: 'domain_weakness',
        explanation: `Domain "${p.domain}" has only ${(domainRate * 100).toFixed(0)}% accuracy across ${dr.total} predictions`,
        confidence: 0.7,
        mutable: true,
      });
    }

    // Overconfidence
    if (p.confidence > 0.75) {
      explanations.push({
        type: 'overconfidence',
        explanation: `Predicted at ${(p.confidence * 100).toFixed(0)}% confidence, which was unjustified`,
        confidence: 0.65,
        mutable: true,
      });
    }

    // Recurring failure pattern
    const failedSimilar = similarPreds.filter(sp => sp.outcome === 'incorrect');
    if (failedSimilar.length >= 2) {
      explanations.push({
        type: 'recurring_failure',
        explanation: `${failedSimilar.length} similar predictions also failed — systematic blind spot`,
        confidence: 0.8,
        mutable: true,
      });
    }

    explanations.sort((a, b) => b.confidence - a.confidence);
    const bestExplanation = explanations[0]?.explanation || 'No clear explanation found';

    // Store analysis
    const mutableFactors = explanations.filter(e => e.mutable).map(e => e.explanation);
    const immutableFactors = explanations.filter(e => !e.mutable).map(e => e.explanation);
    const counterfactualQuestion = `Why did "${p.prediction}" fail? Predicted at ${(p.confidence * 100).toFixed(0)}% confidence.`;
    await client.query(`
      INSERT INTO counterfactual_analyses
        (prediction_id, counterfactual_question, best_explanation, candidate_explanations,
         corrective_intention, mutable_factors, immutable_factors, analyzed_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NOW())
    `, [
      predictionId,
      counterfactualQuestion,
      bestExplanation,
      JSON.stringify(explanations),
      mutableFactors.join('; '),
      mutableFactors,
      immutableFactors,
    ]).catch(() => {});

    return jsonResult({
      prediction_id: predictionId,
      prediction: p.prediction,
      confidence_was: p.confidence,
      domain: p.domain,
      explanations,
      best_explanation: bestExplanation,
      mutable_factors: explanations.filter(e => e.mutable).length,
      immutable_factors: explanations.filter(e => !e.mutable).length,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_belief_sprt',
      description: 'Sequential Probability Ratio Test for beliefs. Actions: status (distribution + zombie beliefs), test (apply SPRT boundaries to belief), evidence (add evidence and auto-test), sweep (batch test all evidenced beliefs).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'test', 'evidence', 'sweep'] },
          belief_id: { type: 'number' },
          evidence_type: { type: 'string', enum: ['supporting', 'contradicting'] },
          strength: { type: 'number', description: '0-1 (default 0.6)' },
          limit: { type: 'number' },
        },
        required: ['action'],
      },
    },
    handler: (args) => beliefSPRT(args),
  },
  {
    definition: {
      name: 'vision_calibration',
      description: 'Calibration analysis: bin resolved predictions by confidence, compute ECE (Expected Calibration Error) and Brier score. Shows whether I am over- or under-confident, with per-domain breakdown. Persists current snapshot to calibration_bins (one row per bin per domain) unless persist=false.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: "Filter to one domain, or 'all' (default)" },
          bins: { type: 'number', description: 'Number of calibration bins (default: 10)' },
          persist: { type: 'boolean', description: 'Write snapshot to calibration_bins (default: true)' },
        },
      },
    },
    handler: (args) => calibrationAnalysis(args),
  },
  {
    definition: {
      name: 'vision_counterfactual',
      description: 'Counterfactual analysis of failed predictions. Actions: analyze (why did a prediction fail?), list (past analyses). Identifies weak evidence, domain weaknesses, overconfidence, and recurring failure patterns.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['analyze', 'list'] },
          prediction_id: { type: 'number' },
          limit: { type: 'number' },
        },
        required: ['action'],
      },
    },
    handler: (args) => counterfactualAnalyze(args),
  },
];

export default tools;
