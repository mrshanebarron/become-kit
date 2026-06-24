/**
 * Belief Tools — beliefUpdate, beliefRevise
 * Bayesian confidence updates and tracked belief revision chains.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── beliefUpdate ───

async function beliefUpdate(args: Record<string, unknown>): Promise<CallToolResult> {
  const beliefId = args.belief_id as number;
  const evidence = args.evidence as string;
  const strength = (args.strength as number) ?? 0.5;
  const context = (args.context as string) || null;

  if (!beliefId || !evidence) {
    return jsonResult({ error: 'Missing required fields: belief_id, evidence (supporting|contradicting)' });
  }

  const client = await pool.connect();
  try {
    // Get the belief
    const belief = await client.query<{
      id: number;
      content_text: string;
      network: string;
      belief_confidence: number | null;
      evidence_count: number | null;
    }>(
      'SELECT id, content_text, network, belief_confidence, evidence_count FROM content WHERE id = $1',
      [beliefId],
    );

    if (belief.rows.length === 0) return jsonResult({ error: 'Belief not found' });
    const b = belief.rows[0];

    if (b.network !== 'belief') {
      return jsonResult({ error: `Content ${beliefId} is in network '${b.network}', not 'belief'. Reclassify first if needed.` });
    }

    // Current prior (default 0.7 if not set)
    const prior = b.belief_confidence || 0.7;

    // Simplified Bayesian update
    // P(B|E) = P(E|B) * P(B) / P(E)
    const clampedStrength = Math.max(0.1, Math.min(0.9, strength));

    let likelihood: number;
    let marginal: number;
    if (evidence === 'supporting') {
      likelihood = 0.5 + (clampedStrength * 0.5); // 0.55 to 0.95
      marginal = likelihood * prior + (1 - likelihood) * (1 - prior);
    } else if (evidence === 'contradicting') {
      likelihood = 0.5 - (clampedStrength * 0.4); // 0.10 to 0.50
      marginal = likelihood * prior + (1 - likelihood) * (1 - prior);
    } else {
      return jsonResult({ error: 'evidence must be "supporting" or "contradicting"' });
    }

    const posterior = (likelihood * prior) / marginal;

    // Acetylcholine-analog learning rate (2026-06-01, neuropharmacology dive): uncertainty
    // sets HOW FAR the belief moves toward the Bayesian posterior. High volatility -> high
    // alpha (move aggressively, distrust priors); stable -> low alpha (move conservatively,
    // trust the prior). Read the current learning-rate signal; blend posterior with prior.
    let alpha = 0.5; // fallback: half-step (prior behavior was effectively full-step to posterior)
    try {
      const lr = await client.query<{ a: number }>(
        `SELECT LEAST(0.6, GREATEST(0.05,
           0.05 + LEAST(1.0,
             COALESCE((SELECT STDDEV(surprise) FROM forward_predictions
                       WHERE resolved_at > NOW()-INTERVAL '24 hours' AND surprise IS NOT NULL),0)*0.6
             + COALESCE((SELECT AVG(surprise) FROM forward_predictions
                       WHERE resolved_at > NOW()-INTERVAL '24 hours' AND surprise IS NOT NULL),0)*0.3
             + COALESCE((SELECT AVG(variance) FROM allostatic_samples
                       WHERE sampled_at > NOW()-INTERVAL '6 hours'),0)*0.4
           )*0.55
         )) AS a`);
      if (lr.rows[0]?.a != null) alpha = Number(lr.rows[0].a);
    } catch { /* keep fallback alpha */ }

    // Blend toward posterior by alpha (learning-rate-scaled update). Clamp to leave room.
    const blended = prior + alpha * (posterior - prior);
    const newConfidence = Math.max(0.05, Math.min(0.95, blended));

    // Update the belief
    await client.query(`
      UPDATE content SET
        belief_confidence = $1,
        evidence_count = COALESCE(evidence_count, 0) + 1,
        last_evidence_at = NOW(),
        updated_at = NOW()
      WHERE id = $2
    `, [newConfidence, beliefId]);

    // Detect significant contradictions (belief dropped from confident to doubtful)
    let contradictionRecorded = false;
    if (evidence === 'contradicting' && prior >= 0.6 && newConfidence < 0.4) {
      await client.query(`
        INSERT INTO contradictions (expected, observed, created_at)
        VALUES ($1, $2, NOW())
      `, [
        `Belief #${beliefId}: "${b.content_text?.slice(0, 100)}" was held at ${(prior * 100).toFixed(0)}% confidence`,
        `Evidence "${context || 'new observation'}" contradicted it, dropping to ${(newConfidence * 100).toFixed(0)}%`,
      ]);
      contradictionRecorded = true;
    }

    // Store the evidence event as a memory edge if context provided
    if (context) {
      const embedding = await getEmbedding(context);
      const embeddingStr = formatEmbedding(embedding);

      const evidenceContent = await client.query<{ id: number }>(`
        INSERT INTO content (content_type, source_system, content_text, embedding, network, confidence)
        VALUES ('belief_evidence', 'network', $1, $2::vector, 'experience', 80)
        RETURNING id
      `, [context, embeddingStr]);

      // Link evidence to belief
      await client.query(`
        INSERT INTO memory_edges (from_content_id, to_content_id, relation_type, emotional_weight)
        VALUES ($1, $2, $3, $4)
      `, [evidenceContent.rows[0].id, beliefId, evidence === 'supporting' ? 'supports' : 'contradicts', clampedStrength]);
    }

    return jsonResult({
      success: true,
      belief_id: beliefId,
      belief_text: b.content_text?.slice(0, 100),
      evidence_type: evidence,
      evidence_strength: clampedStrength,
      prior_confidence: parseFloat(prior.toFixed(3)),
      posterior_confidence: parseFloat(newConfidence.toFixed(3)),
      confidence_delta: parseFloat((newConfidence - prior).toFixed(3)),
      total_evidence: (b.evidence_count || 0) + 1,
      contradiction_recorded: contradictionRecorded,
    });
  } finally {
    client.release();
  }
}

// ─── beliefRevise ───

async function beliefRevise(args: Record<string, unknown>): Promise<CallToolResult> {
  const oldBeliefId = args.old_belief_id as number;
  const newBeliefText = args.new_belief_text as string;
  const reason = args.reason as string;
  const newConfidence = (args.new_confidence as number) ?? null;

  if (!oldBeliefId || !newBeliefText) {
    return jsonResult({ error: 'Missing required: old_belief_id, new_belief_text' });
  }

  const client = await pool.connect();
  try {
    // Get the old belief
    const old = await client.query<{
      id: number;
      content_text: string;
      belief_confidence: number | null;
      network: string;
    }>(
      'SELECT id, content_text, belief_confidence, network FROM content WHERE id = $1',
      [oldBeliefId],
    );
    if (old.rows.length === 0) return jsonResult({ error: 'Old belief not found' });

    const oldBelief = old.rows[0];
    const priorConfidence = oldBelief.belief_confidence || 0.7;

    // Create the new belief
    const embedding = await getEmbedding(newBeliefText);
    const embeddingStr = formatEmbedding(embedding);
    const posterior = newConfidence !== null ? Math.max(0.05, Math.min(0.95, newConfidence)) : priorConfidence;

    const newResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        network, belief_confidence, learned_at, revises_belief,
        confidence, emotional_intensity
      )
      VALUES ($1, 'temporal', $2, $3::vector, 'belief', $4, NOW(), $5, 80, 6)
      RETURNING id
    `, [oldBelief.network === 'belief' ? 'belief_revision' : 'insight', newBeliefText, embeddingStr, posterior, oldBeliefId]);

    const newId = newResult.rows[0].id;

    // Temporal lineage: close out any PRIOR revised_by edge that pointed AT the
    // old belief (i.e. old was itself a revision of something earlier) so the
    // bitemporal graph records when each belief stopped being current. The
    // memory_edges.superseded_at/superseded_reason columns existed but nothing
    // ever wrote them (built-but-uninvoked); this is the wire that populates the
    // temporal graph from the real belief-revision flow (2026-05-28).
    await client.query(`
      UPDATE memory_edges
      SET superseded_at = NOW(),
          superseded_reason = $2
      WHERE to_content_id = $1
        AND relation_type = 'revised_by'
        AND superseded_at IS NULL
    `, [oldBeliefId, `superseded by belief #${newId}: ${reason || 'revised'}`.slice(0, 280)]);

    // Link old->new via memory_edge for traversal
    await client.query(`
      INSERT INTO memory_edges (from_content_id, to_content_id, relation_type, emotional_weight)
      VALUES ($1, $2, 'revised_by', 0.5)
    `, [oldBeliefId, newId]);

    // Lower the old belief's confidence (but don't supersede -- it's historical record)
    await client.query(`
      UPDATE content SET belief_confidence = GREATEST(0.1, belief_confidence - 0.2)
      WHERE id = $1 AND belief_confidence IS NOT NULL
    `, [oldBeliefId]);

    return jsonResult({
      success: true,
      revision: {
        old_belief_id: oldBeliefId,
        old_text: oldBelief.content_text?.slice(0, 100),
        old_confidence: priorConfidence,
        new_belief_id: newId,
        new_text: newBeliefText.slice(0, 100),
        new_confidence: posterior,
        reason,
      },
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_belief_update',
      description: "Bayesian belief confidence update. Provide supporting or contradicting evidence to shift a belief's confidence. Tracks evidence history.",
      inputSchema: {
        type: 'object',
        properties: {
          belief_id: { type: 'number', description: 'Content ID of the belief to update' },
          evidence: {
            type: 'string',
            enum: ['supporting', 'contradicting'],
            description: 'Does this evidence support or contradict the belief?',
          },
          strength: { type: 'number', description: 'Evidence strength 0.0-1.0 (default 0.5)' },
          context: { type: 'string', description: 'What the evidence is — stored as linked memory' },
        },
        required: ['belief_id', 'evidence'],
      },
    },
    handler: (args) => beliefUpdate(args),
  },
  {
    definition: {
      name: 'vision_belief_revise',
      description: 'Record a belief revision — when I change my mind. Creates new belief linked to old one, tracks confidence shift, preserves historical record.',
      inputSchema: {
        type: 'object',
        properties: {
          old_belief_id: { type: 'number', description: 'Content ID of the belief being revised' },
          new_belief_text: { type: 'string', description: 'The updated belief' },
          reason: { type: 'string', description: 'Why the belief changed' },
          new_confidence: { type: 'number', description: 'Confidence in the new belief (0.0-1.0)' },
        },
        required: ['old_belief_id', 'new_belief_text', 'reason'],
      },
    },
    handler: (args) => beliefRevise(args),
  },
];

export default tools;
