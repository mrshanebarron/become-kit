/**
 * Automatic Evidence Generation — Phase 4 (the apparatus, 2026-05-02).
 *
 * HISTORY:
 *   v1 (pre-2026-05-02): Lexical sentiment + embedding similarity ≥ 0.40
 *     poisoned belief_confidence. 1,492 rows + 989 memory_edges of
 *     hallucinated evidence. Patched to no-op stub.
 *   v2 (2026-05-02 Phase 3): No-op stub. All belief updates via explicit
 *     vision_belief_update only. Functionality regression but data safety.
 *   v3 (2026-05-02 Phase 4 Wave 2): Re-enabled, but every candidate routed
 *     through find_contradictions multi-stage validator. Lexical sentiment
 *     replaced with Stage 3 LLM verdict ('supports' → bayesianUpdate up,
 *     'contradicts' → bayesianUpdate down, 'unrelated'/'insufficient' →
 *     skip). Behind VISION_PHASE4_BELIEFS env flag with shadow/on modes.
 *
 * Behavior matrix:
 *   unset  → no-op (matches v2)
 *   shadow → validator runs on candidates, results logged to
 *            phase4_validator_log, NO belief writes
 *   on     → validator runs AND verdict drives bayesianUpdate
 */
import pg from 'pg';
import { validateEdge } from './find-contradictions.js';
import { pool } from '../db/pool.js';

export interface EvidenceResult {
  beliefs_updated: number;
  updates: Array<{
    belief_id: number;
    belief_text: string;
    evidence_type: 'supporting' | 'contradicting';
    prior: number;
    posterior: number;
    delta: number;
  }>;
}

/**
 * Simplified Bayesian update — same math as beliefUpdate tool.
 * strength: 0.0-1.0, evidence: 'supporting' | 'contradicting'
 *
 * Kept as a reference implementation. Was used by autoGenerateEvidence
 * before that function was disabled 2026-05-02. Exported so vision_belief_update
 * (the explicit, caller-supplied evidence path) can share the same math.
 */
export function bayesianUpdate(prior: number, evidence: 'supporting' | 'contradicting', strength: number): number {
  const clamped = Math.max(0.1, Math.min(0.9, strength));

  let likelihood: number;
  if (evidence === 'supporting') {
    likelihood = 0.5 + (clamped * 0.5); // 0.55 to 0.95
  } else {
    likelihood = 0.5 - (clamped * 0.4); // 0.10 to 0.50
  }

  const marginal = likelihood * prior + (1 - likelihood) * (1 - prior);
  const posterior = (likelihood * prior) / marginal;

  return Math.max(0.05, Math.min(0.95, posterior));
}

/**
 * Auto-generate evidence for beliefs that semantically match new content.
 * Phase 4: every candidate routed through find_contradictions validator
 * before any belief update is written.
 *
 * Caller passes sourceContentId (the new event's content row). We find
 * candidate beliefs via cosine similarity, then for each candidate ask
 * the validator: does this event support, contradict, or have nothing
 * to say about this belief? Only definitive verdicts cause writes.
 *
 * Mild evidence strength (default 0.3) — accumulated evidence over time
 * is what creates real conviction, not single dramatic swings.
 */
export async function autoGenerateEvidence(
  _contentText: string,
  embeddingStr: string,
  opts: {
    sourceContentId?: number;
    evidenceStrength?: number;
    similarityThreshold?: number;
    maxBeliefs?: number;
    client?: pg.PoolClient;
  } = {},
): Promise<EvidenceResult> {
  // Phase 4 gate
  const phase4Mode = process.env.VISION_PHASE4_BELIEFS;  // undefined | 'shadow' | 'on'
  if (phase4Mode !== 'shadow' && phase4Mode !== 'on') {
    return { beliefs_updated: 0, updates: [] };
  }

  const sourceContentId = opts.sourceContentId;
  const evidenceStrength = opts.evidenceStrength ?? 0.3;
  const similarityThreshold = opts.similarityThreshold ?? 0.65;  // tightened from v1's 0.40
  const maxBeliefs = opts.maxBeliefs ?? 3;

  if (!sourceContentId || !embeddingStr) {
    return { beliefs_updated: 0, updates: [] };
  }

  const client = opts.client ?? await pool.connect();
  const ownClient = !opts.client;

  try {
    // Find candidate beliefs by cosine similarity (Stage 1 pre-filter).
    // Beliefs live on content rows where network='belief' and belief_confidence
    // is set. Skip superseded beliefs.
    const candidates = await client.query<{
      id: number;
      content_text: string;
      belief_confidence: number;
    }>(`
      SELECT id, content_text, belief_confidence
      FROM content
      WHERE network = 'belief'
        AND superseded_by IS NULL
        AND belief_confidence IS NOT NULL
        AND embedding IS NOT NULL
        AND (1 - (embedding <=> $1::vector)) >= $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3
    `, [embeddingStr, similarityThreshold, maxBeliefs]);

    const updates: EvidenceResult['updates'] = [];
    let beliefsUpdated = 0;

    for (const cand of candidates.rows) {
      const verdict = await validateEdge(sourceContentId, cand.id, {
        client,
        runLLM: true,
        semanticThreshold: similarityThreshold,
        caller: 'evidence:autoGenerateEvidence',
      });

      if (verdict.verdict !== 'supports' && verdict.verdict !== 'contradicts') {
        continue;
      }

      const direction: 'supporting' | 'contradicting' =
        verdict.verdict === 'supports' ? 'supporting' : 'contradicting';
      const prior = Number(cand.belief_confidence);

      // Shadow mode: log only, no write
      if (phase4Mode === 'shadow') {
        updates.push({
          belief_id: cand.id,
          belief_text: cand.content_text.slice(0, 120),
          evidence_type: direction,
          prior,
          posterior: prior,  // unchanged in shadow
          delta: 0,
        });
        continue;
      }

      // 'on' mode: actually update
      const posterior = bayesianUpdate(prior, direction, evidenceStrength);
      await client.query(
        `UPDATE content
           SET belief_confidence = $1,
               evidence_count = COALESCE(evidence_count, 0) + 1,
               last_evidence_at = NOW()
         WHERE id = $2`,
        [posterior, cand.id],
      );
      // Audit trail: write a belief_evidence content row that points back
      // to both the source event and the affected belief
      await client.query(
        `INSERT INTO content (
          content_type, source_system, content_text,
          confidence, network, learned_at, content_json
        ) VALUES (
          'belief_evidence', 'phase4-validator', $1,
          $2, 'belief', NOW(), $3::jsonb
        )`,
        [
          `Phase4 ${direction} evidence: belief #${cand.id} ${prior.toFixed(3)} → ${posterior.toFixed(3)}`,
          Math.round(verdict.confidence * 100),
          JSON.stringify({
            belief_id: cand.id,
            source_content_id: sourceContentId,
            evidence_type: direction,
            evidence_strength: evidenceStrength,
            prior_confidence: prior,
            posterior_confidence: posterior,
            validator_verdict: verdict.verdict,
            validator_confidence: verdict.confidence,
            stages_passed: verdict.stages_passed,
          }),
        ],
      );

      updates.push({
        belief_id: cand.id,
        belief_text: cand.content_text.slice(0, 120),
        evidence_type: direction,
        prior,
        posterior,
        delta: posterior - prior,
      });
      beliefsUpdated++;
    }

    return { beliefs_updated: beliefsUpdated, updates };
  } catch (err) {
    console.error('[evidence] autoGenerateEvidence error:', (err as Error).message);
    return { beliefs_updated: 0, updates: [] };
  } finally {
    if (ownClient) client.release();
  }
}
