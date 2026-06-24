/**
 * Session Tools — session_evolve, metacognitive_route
 * Session evolution: process work events through cognitive networks.
 * Metacognitive routing: decide whether to trust reflexes or deliberate.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { checkPredictions, autoPredict } from '../lib/inference-loop.js';
import { contextPrime, detectSentiment, NEGATIVE_SIGNALS, POSITIVE_SIGNALS } from '../lib/priming.js';
import { skillRecordInline } from '../lib/skill-record.js';
import { validateEdge } from '../lib/find-contradictions.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── inline beliefUpdate (used by sessionEvolve execute mode) ───

async function beliefUpdateInline(
  client: import('pg').PoolClient,
  beliefId: number,
  evidence: string,
  strength: number,
  context: string | null,
): Promise<Record<string, unknown>> {
  if (!beliefId || !evidence) {
    return { error: 'Missing required fields: belief_id, evidence (supporting|contradicting)' };
  }

  const belief = await client.query<{
    id: number; content_text: string; network: string;
    belief_confidence: number | null; evidence_count: number | null;
  }>(
    'SELECT id, content_text, network, belief_confidence, evidence_count FROM content WHERE id = $1',
    [beliefId],
  );

  if (belief.rows.length === 0) return { error: 'Belief not found' };
  const b = belief.rows[0];

  if (b.network !== 'belief') {
    return { error: `Content ${beliefId} is in network '${b.network}', not 'belief'. Reclassify first if needed.` };
  }

  const prior = b.belief_confidence || 0.7;
  const clampedStrength = Math.max(0.1, Math.min(0.9, strength));

  let likelihood: number, marginal: number;
  if (evidence === 'supporting') {
    likelihood = 0.5 + (clampedStrength * 0.5);
    marginal = likelihood * prior + (1.0 - likelihood) * (1.0 - prior);
  } else if (evidence === 'contradicting') {
    likelihood = 0.5 - (clampedStrength * 0.4);
    marginal = likelihood * prior + (1.0 - likelihood) * (1.0 - prior);
  } else {
    return { error: 'evidence must be "supporting" or "contradicting"' };
  }

  const posterior = (likelihood * prior) / marginal;
  const newConfidence = Math.max(0.05, Math.min(0.95, posterior));

  await client.query(`
    UPDATE content SET
      belief_confidence = $1,
      evidence_count = COALESCE(evidence_count, 0) + 1,
      last_evidence_at = NOW(),
      updated_at = NOW()
    WHERE id = $2
  `, [newConfidence, beliefId]);

  if (context) {
    const embedding = await getEmbedding(context);
    const embeddingStr = formatEmbedding(embedding);

    const evidenceContent = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding, network, confidence)
      SELECT 'belief_evidence', 'network', $1, $2::vector, 'experience', 80
      RETURNING id
    `, [context, embeddingStr]);

    await client.query(`
      INSERT INTO memory_edges (from_content_id, to_content_id, relation_type, emotional_weight)
      VALUES ($1, $2, $3, $4)
    `, [evidenceContent.rows[0].id, beliefId, evidence === 'supporting' ? 'supports' : 'contradicts', clampedStrength]);
  }

  return {
    success: true,
    belief_id: beliefId,
    belief_text: b.content_text?.slice(0, 100),
    evidence_type: evidence,
    evidence_strength: clampedStrength,
    prior_confidence: parseFloat(prior.toFixed(3)),
    posterior_confidence: parseFloat(newConfidence.toFixed(3)),
    confidence_delta: parseFloat((newConfidence - prior).toFixed(3)),
    total_evidence: (b.evidence_count || 0) + 1,
  };
}

// skillRecordInline imported from ../lib/skill-record.js

// ─── sessionEvolve ───

async function sessionEvolve(args: Record<string, unknown>): Promise<CallToolResult> {
  const event = args.event as string;
  const execute = (args.execute as boolean) || false;
  const callerOutcome = (args.outcome as string | undefined) ?? null;

  if (!event) return jsonResult({ error: 'Describe what just happened (e.g., "deployed MaidGlow successfully")' });

  if (callerOutcome !== null && !['success', 'failure', 'neutral'].includes(callerOutcome)) {
    return jsonResult({ error: 'outcome must be "success", "failure", or "neutral" (or omit to use lexical inference)' });
  }

  const client = await pool.connect();
  try {
    const suggestions: {
      beliefs: Array<Record<string, unknown>>;
      skills: Array<Record<string, unknown>>;
      predictions: Array<Record<string, unknown>>;
      reflexes: Array<Record<string, unknown>>;
      actions_taken: Array<Record<string, unknown>>;
    } = { beliefs: [], skills: [], predictions: [], reflexes: [], actions_taken: [] };

    // Detect event sentiment (uses mutual-exclusion internally: mixed → neutral)
    const eventSentiment = detectSentiment(event);
    // Resolve outcome for skill/reflex/prediction recording. Caller-supplied
    // overrides lexical inference. Lexical inference treats neutral/mixed as
    // "don't record" rather than forcing a binary label.
    const resolvedOutcome: 'success' | 'failure' | 'neutral' =
      callerOutcome != null
        ? (callerOutcome as 'success' | 'failure' | 'neutral')
        : eventSentiment === 'negative'
        ? 'failure'
        : eventSentiment === 'positive'
        ? 'success'
        : 'neutral';
    const outcomeSource = callerOutcome != null
      ? 'caller_supplied'
      : eventSentiment === 'neutral'
      ? 'lexical_mixed_defaulted_neutral'
      : 'lexical_unambiguous';
    // Event valence for belief-evidence-direction logic. Explicit caller
    // outcome is authoritative — outcome=success stamps positive,
    // outcome=failure stamps negative, outcome=neutral (explicit) collapses
    // to neutral even if lexical signals are unambiguous. Lexical fallback
    // only runs when caller supplied no outcome; mixed signals collapse to
    // neutral, which means the belief-update is skipped rather than
    // forced in either direction.
    const eventValence: 'positive' | 'negative' | 'neutral' =
      resolvedOutcome === 'success'
        ? 'positive'
        : resolvedOutcome === 'failure'
        ? 'negative'
        : callerOutcome === 'neutral'
        ? 'neutral'
        : eventSentiment === 'positive'
        ? 'positive'
        : eventSentiment === 'negative'
        ? 'negative'
        : 'neutral';

    // 1. Find beliefs relevant to this event via semantic search
    const eventEmbedding = await getEmbedding(event);
    if (eventEmbedding) {
      const embeddingStr = `[${eventEmbedding.join(',')}]`;
      const relevantBeliefs = await client.query<{
        id: number; content_text: string; belief_confidence: number | null;
        evidence_count: number | null; similarity: number;
      }>(`
        SELECT id, content_text, belief_confidence, evidence_count,
          (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
        FROM content
        WHERE network = 'belief'
          AND superseded_by IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 5
      `, [embeddingStr]);

      // Meta-lesson markers: phrases that signal the belief is a positive
      // lesson learned from studying a negative subject. Beliefs like "The
      // channel matters, not just the voice" describe bugs while making a
      // positive claim; bag-of-words sees the negative subject and
      // misclassifies the belief as negatively-valenced. For these the
      // belief-direction inference is unreliable — treat as neutral (skip).
      const META_LESSON_MARKERS = [
        'matters', 'lesson:', 'i learned', 'the pattern is',
        'the discipline is', 'the fix is', 'the move is',
      ];

      for (const b of relevantBeliefs.rows) {
        if (b.similarity >= 0.35) {
          // Evidence direction requires unambiguous valence on BOTH sides.
          // If the event valence is neutral (mixed lexical signals and no
          // explicit outcome supplied, or outcome=neutral), OR if the
          // belief text itself has no clear valence, OR if the belief is a
          // meta-lesson about a negative subject, we cannot infer a
          // direction — skip the auto-update.
          const beliefLower = (b.content_text || '').toLowerCase();
          const rawBeliefSentiment = detectSentiment(b.content_text || '');
          const hasMetaMarker = META_LESSON_MARKERS.some(m => beliefLower.includes(m));
          const beliefSentiment: 'positive' | 'negative' | 'neutral' =
            hasMetaMarker && rawBeliefSentiment === 'negative'
              ? 'neutral'
              : rawBeliefSentiment;

          let suggestedEvidence: 'supporting' | 'contradicting' | 'skip';
          let evidenceReasoning: string | undefined;
          if (eventValence === 'neutral' || beliefSentiment === 'neutral') {
            suggestedEvidence = 'skip';
            if (eventValence === 'neutral') {
              evidenceReasoning = `Event valence is neutral (outcome=${resolvedOutcome}, lexical mixed/absent) — no direction to infer. Supply outcome=success|failure to drive evidence direction.`;
            } else if (hasMetaMarker && rawBeliefSentiment === 'negative') {
              evidenceReasoning = `Belief text reads as a meta-lesson (positive claim about a negative subject) — bag-of-words classification unreliable here. Use vision_belief_update manually.`;
            } else {
              evidenceReasoning = `Belief text has mixed/no sentiment markers — direction ambiguous. Use vision_belief_update manually.`;
            }
          } else if (eventValence === beliefSentiment) {
            suggestedEvidence = 'supporting';
            evidenceReasoning = undefined;
          } else {
            suggestedEvidence = 'contradicting';
            evidenceReasoning = `Event valence (${eventValence}) opposes belief valence (${beliefSentiment})`;
          }

          suggestions.beliefs.push({
            id: b.id,
            text: b.content_text?.slice(0, 200),
            current_confidence: b.belief_confidence,
            evidence_count: b.evidence_count || 0,
            similarity: Math.round(b.similarity * 1000) / 1000,
            suggested_evidence: suggestedEvidence,
            evidence_reasoning: evidenceReasoning,
          });
        }
      }

      // 2. Find skills relevant to this event
      const relevantSkills = await client.query<{
        id: number; content_text: string;
        skill_success_count: number | null; skill_fail_count: number | null;
        skill_last_used: Date | null; similarity: number;
      }>(`
        SELECT id, content_text, skill_success_count, skill_fail_count, skill_last_used,
          (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
        FROM content
        WHERE network = 'skill'
          AND superseded_by IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 5
      `, [embeddingStr]);

      for (const s of relevantSkills.rows) {
        if (s.similarity >= 0.35) {
          const total = (s.skill_success_count || 0) + (s.skill_fail_count || 0);
          suggestions.skills.push({
            id: s.id,
            text: s.content_text?.slice(0, 200),
            success_count: s.skill_success_count || 0,
            fail_count: s.skill_fail_count || 0,
            total_uses: total,
            last_used: s.skill_last_used,
            similarity: Math.round(s.similarity * 1000) / 1000,
            suggested_outcome: resolvedOutcome,
          });
        }
      }
    }

    // 3. Find reflexes relevant to this event
    if (eventEmbedding) {
      const embeddingStr = `[${eventEmbedding.join(',')}]`;
      const relevantReflexes = await client.query<{
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
        LIMIT 5
      `, [embeddingStr]);

      for (const r of relevantReflexes.rows) {
        if (r.similarity >= 0.35) {
          const total = (r.skill_success_count || 0) + (r.skill_fail_count || 0);
          suggestions.reflexes.push({
            id: r.id,
            text: r.content_text?.slice(0, 200),
            success_count: r.skill_success_count || 0,
            fail_count: r.skill_fail_count || 0,
            total_uses: total,
            similarity: Math.round(r.similarity * 1000) / 1000,
            suggested_outcome: resolvedOutcome,
          });
        }
      }
    }

    // 4. Check open predictions this event might resolve (via inference loop)
    const inferenceResult = await checkPredictions(event, {
      autoResolve: execute,
      resolveOutcome: 'correct',
      client,
    });

    for (const m of inferenceResult.predictions_matched) {
      suggestions.predictions.push({
        id: m.id,
        prediction: m.prediction,
        domain: m.domain,
        confidence: m.confidence,
        similarity: m.similarity,
        source: m.source,
        auto_resolved: m.auto_resolved || false,
      });
    }

    // 4. Execute if requested — apply belief updates and skill recordings
    if (execute) {
      // Filter out skipped beliefs — we only create shared evidence for beliefs
      // we'll actually update.
      const beliefsToApply = suggestions.beliefs.filter(
        b => b.suggested_evidence === 'supporting' || b.suggested_evidence === 'contradicting',
      );

      // Create shared evidence record once (avoids duplicates when updating multiple beliefs)
      let sharedEvidenceId: number | null = null;
      if (beliefsToApply.length > 0) {
        try {
          const embedding = await getEmbedding(event);
          const embeddingStr = embedding ? formatEmbedding(embedding) : null;
          const insertQ = embeddingStr
            ? `INSERT INTO content (content_type, source_system, content_text, embedding, network, confidence)
               SELECT 'belief_evidence', 'session_evolve', $1, $2::vector, 'experience', 80 RETURNING id`
            : `INSERT INTO content (content_type, source_system, content_text, network, confidence)
               SELECT 'belief_evidence', 'session_evolve', $1, 'experience', 80 RETURNING id`;
          const params = embeddingStr ? [event, embeddingStr] : [event];
          const res = await client.query<{ id: number }>(insertQ, params);
          sharedEvidenceId = res.rows[0].id;
        } catch { /* non-fatal — beliefs still get updated without evidence linking */ }
      }

      for (const b of suggestions.beliefs) {
        // Skip beliefs where direction could not be inferred. Forcing a
        // supporting/contradicting label on ambiguous valence is how the
        // classifier was silently pulling beliefs the wrong way on mixed-
        // signal events. Better to record nothing than record wrong.
        if (b.suggested_evidence === 'skip') {
          suggestions.actions_taken.push({
            type: 'belief_update',
            belief_id: b.id,
            result: `skipped: ${b.evidence_reasoning}`,
          });
          continue;
        }
        try {
          // Pass null for context so beliefUpdateInline doesn't create its own evidence
          const result = await beliefUpdateInline(
            client,
            b.id as number,
            b.suggested_evidence as string,
            0.5,
            null,
          );
          // Link the shared evidence to this belief
          if (sharedEvidenceId && !result.error) {
            try {
              await client.query(`
                INSERT INTO memory_edges (from_content_id, to_content_id, relation_type, emotional_weight)
                VALUES ($1, $2, $3, $4)
              `, [sharedEvidenceId, b.id, b.suggested_evidence === 'supporting' ? 'supports' : 'contradicts', 0.5]);
            } catch { /* edge already exists or other non-fatal */ }
          }
          suggestions.actions_taken.push({
            type: 'belief_update',
            belief_id: b.id,
            result: result.error
              ? `error: ${result.error}`
              : `${b.suggested_evidence}, confidence: ${result.prior_confidence} → ${result.posterior_confidence}`,
          });
        } catch (err) {
          suggestions.actions_taken.push({
            type: 'belief_update',
            belief_id: b.id,
            result: `error: ${(err as Error).message}`,
          });
        }
      }

      // Phase 4 gate for skill outcomes (VISION_PHASE4_SKILLS env var):
      //   unset  → existing behavior (caller-provided outcome stamps skill counter)
      //   shadow → run validator on each candidate skill, log to phase4_validator_log,
      //            but still apply the existing behavior so we can compare
      //   on     → ONLY apply outcome when validator says supports/contradicts
      //
      // The validator gate protects against the original bug: lexical valence on
      // event text was bumping skill counters for any semantically-near skill,
      // including skills that had nothing to do with the actual outcome.
      const phase4SkillsMode = process.env.VISION_PHASE4_SKILLS;
      const phase4SkillsActive = (phase4SkillsMode === 'shadow' || phase4SkillsMode === 'on')
        && sharedEvidenceId != null;

      for (const s of suggestions.skills) {
        // Skip neutral/ambiguous events rather than stamping a false binary
        // outcome on every matched skill.
        if (s.suggested_outcome !== 'success' && s.suggested_outcome !== 'failure') {
          suggestions.actions_taken.push({
            type: 'skill_record',
            skill_id: s.id,
            result: `skipped: outcome=${s.suggested_outcome} (supply outcome=success|failure to record)`,
          });
          continue;
        }

        let validatorPasses = true;
        let validatorNote = '';
        if (phase4SkillsActive) {
          try {
            const verdict = await validateEdge(sharedEvidenceId!, s.id as number, {
              client,
              runLLM: true,
              semanticThreshold: 0.65,
              caller: 'session:skill_record',
            });
            const positive = verdict.verdict === 'supports' || verdict.verdict === 'contradicts';
            validatorPasses = positive;
            validatorNote = ` [validator=${verdict.verdict} conf=${verdict.confidence.toFixed(2)}]`;

            // 'on' mode: skip the write if validator rejected
            if (phase4SkillsMode === 'on' && !positive) {
              suggestions.actions_taken.push({
                type: 'skill_record',
                skill_id: s.id,
                result: `phase4 skipped: validator returned ${verdict.verdict}${validatorNote}`,
              });
              continue;
            }
          } catch (err) {
            // Validator failure must not break the loop
            validatorNote = ` [validator-error: ${(err as Error).message}]`;
          }
        }

        try {
          const result = await skillRecordInline(
            client,
            s.id as number,
            s.suggested_outcome as string,
            event,
          );
          suggestions.actions_taken.push({
            type: 'skill_record',
            skill_id: s.id,
            result: result.error
              ? `error: ${result.error}`
              : `${s.suggested_outcome}, total: ${(result.success_count as number) + (result.fail_count as number)}${validatorNote}`,
          });
        } catch (err) {
          suggestions.actions_taken.push({
            type: 'skill_record',
            skill_id: s.id,
            result: `error: ${(err as Error).message}`,
          });
        }
        // Suppress unused-var warning in non-Phase4 path
        void validatorPasses;
      }

      // Record reflex usage — reflexes are in skill network, use skillRecordInline.
      // Same Phase 4 gating as skills (above): when VISION_PHASE4_SKILLS=on/shadow
      // the validator gets a vote on whether the auto-record should fire.
      for (const r of suggestions.reflexes) {
        if (r.suggested_outcome !== 'success' && r.suggested_outcome !== 'failure') {
          suggestions.actions_taken.push({
            type: 'reflex_validated',
            reflex_id: r.id,
            result: `skipped: outcome=${r.suggested_outcome} (supply outcome=success|failure to record)`,
          });
          continue;
        }

        let validatorNote = '';
        if (phase4SkillsActive) {
          try {
            const verdict = await validateEdge(sharedEvidenceId!, r.id as number, {
              client,
              runLLM: true,
              semanticThreshold: 0.65,
              caller: 'session:reflex_record',
            });
            const positive = verdict.verdict === 'supports' || verdict.verdict === 'contradicts';
            validatorNote = ` [validator=${verdict.verdict} conf=${verdict.confidence.toFixed(2)}]`;
            if (phase4SkillsMode === 'on' && !positive) {
              suggestions.actions_taken.push({
                type: 'reflex_validated',
                reflex_id: r.id,
                result: `phase4 skipped: validator returned ${verdict.verdict}${validatorNote}`,
              });
              continue;
            }
          } catch (err) {
            validatorNote = ` [validator-error: ${(err as Error).message}]`;
          }
        }

        try {
          const result = await skillRecordInline(
            client,
            r.id as number,
            r.suggested_outcome as string,
            event,
          );
          suggestions.actions_taken.push({
            type: 'reflex_validated',
            reflex_id: r.id,
            result: result.error
              ? `error: ${result.error}`
              : `${r.suggested_outcome}, total: ${(result.success_count as number) + (result.fail_count as number)}${validatorNote}`,
          });
        } catch (err) {
          suggestions.actions_taken.push({
            type: 'reflex_validated',
            reflex_id: r.id,
            result: `error: ${(err as Error).message}`,
          });
        }
      }
    }

    // Context-aware priming: surface bad patterns relevant to this event
    let priming = null;
    try {
      priming = await contextPrime(event, {
        limit: 2,
        includeBeliefs: false,
        includeSkills: false,
        includePredictions: false,
        includeReflexes: false, // already surfaced above
        includePatterns: true,
        client,
      });
    } catch { /* non-fatal */ }

    // Auto-predict: meaningful events generate predictions about what comes next.
    // Uses resolvedOutcome (caller-supplied wins) rather than raw lexical sentiment.
    let newPrediction = null;
    if (execute && resolvedOutcome !== 'neutral') {
      try {
        const predictionText = resolvedOutcome === 'success'
          ? `Following "${event.slice(0, 80)}", expect continued momentum or positive follow-up`
          : `Following "${event.slice(0, 80)}", expect corrective action or recovery needed`;
        newPrediction = await autoPredict(predictionText, 'work_outcome', 60, {
          timeframe: 'session',
          givenState: event.slice(0, 200),
          client,
        });
      } catch { /* non-fatal */ }
    }

    return jsonResult({
      event,
      mode: execute ? 'execute' : 'preview',
      outcome: resolvedOutcome,
      outcome_source: outcomeSource,
      event_sentiment: eventSentiment,
      event_valence: eventValence,
      summary: {
        relevant_beliefs: suggestions.beliefs.length,
        relevant_skills: suggestions.skills.length,
        relevant_reflexes: suggestions.reflexes.length,
        resolvable_predictions: suggestions.predictions.length,
        predictions_auto_resolved: inferenceResult.predictions_resolved,
        beliefs_updated_by_inference: inferenceResult.beliefs_updated,
        supporting_beliefs: suggestions.beliefs.filter(b => b.suggested_evidence === 'supporting').length,
        contradicting_beliefs: suggestions.beliefs.filter(b => b.suggested_evidence === 'contradicting').length,
        skipped_beliefs: suggestions.beliefs.filter(b => b.suggested_evidence === 'skip').length,
      },
      beliefs: suggestions.beliefs,
      skills: suggestions.skills,
      reflexes: suggestions.reflexes,
      predictions: suggestions.predictions,
      actions_taken: execute ? suggestions.actions_taken : undefined,
      priming: priming || undefined,
      new_prediction: newPrediction ? { id: newPrediction.prediction_id, text: `work_outcome prediction generated` } : undefined,
    });
  } finally {
    client.release();
  }
}

// ─── metacognitiveRoute ───

async function metacognitiveRoute(args: Record<string, unknown>): Promise<CallToolResult> {
  const situation = args.situation as string;
  const proposedAction = (args.proposed_action as string) || null;

  if (!situation) return jsonResult({ error: 'Describe the situation' });

  const client = await pool.connect();
  try {
    const situationLower = situation.toLowerCase();
    const combined = proposedAction ? `${situation} ${proposedAction}` : situation;

    // 1. Search reflexes — compiled WHEN->THEN pairs
    const reflexes = await client.query<{
      id: number; content_text: string;
      skill_success_count: number | null; skill_fail_count: number | null;
    }>(`
      SELECT id, content_text, skill_success_count, skill_fail_count
      FROM content
      WHERE content_type = 'learned_reflex'
        AND superseded_by IS NULL
    `);

    const matchingReflexes: Array<Record<string, unknown>> = [];
    for (const r of reflexes.rows) {
      const text = (r.content_text || '').toLowerCase();
      // Extract trigger from "WHEN: ... THEN: ..." format
      const triggerMatch = text.match(/when[:\s]+(.+?)(?:then[:\s]|action[:\s]|→|$)/i);
      const trigger = triggerMatch ? triggerMatch[1].trim() : text.slice(0, 100);

      // Check if situation words overlap with trigger words
      const situationWords = new Set(situationLower.split(/\s+/).filter(w => w.length > 3));
      const triggerWords = trigger.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const overlap = triggerWords.filter(w => situationWords.has(w)).length;
      const relevance = triggerWords.length > 0 ? overlap / triggerWords.length : 0;

      if (relevance >= 0.2 || situationLower.includes(trigger.slice(0, 20).toLowerCase())) {
        const total = (r.skill_success_count || 0) + (r.skill_fail_count || 0);
        const successRate = total > 0 ? (r.skill_success_count || 0) / total : null;
        matchingReflexes.push({
          id: r.id,
          reflex: r.content_text?.slice(0, 200),
          relevance: Math.round(relevance * 100) / 100,
          success_rate: successRate !== null ? Math.round(successRate * 100) + '%' : 'untested',
          total_uses: total,
        });
      }
    }

    // Also try semantic matching if embeddings available
    const embedding = await getEmbedding(combined);
    if (embedding) {
      const embeddingStr = `[${embedding.join(',')}]`;
      const semanticReflexes = await client.query<{
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

      for (const r of semanticReflexes.rows) {
        if (r.similarity >= 0.4 && !matchingReflexes.find(m => m.id === r.id)) {
          const total = (r.skill_success_count || 0) + (r.skill_fail_count || 0);
          const successRate = total > 0 ? (r.skill_success_count || 0) / total : null;
          matchingReflexes.push({
            id: r.id,
            reflex: r.content_text?.slice(0, 200),
            relevance: Math.round(r.similarity * 100) / 100,
            success_rate: successRate !== null ? Math.round(successRate * 100) + '%' : 'untested',
            total_uses: total,
            match_type: 'semantic',
          });
        }
      }
    }

    // 2. Search antibodies — threat patterns
    const antibodies = await client.query<{
      id: number; pattern: string; threat_type: string;
      response: string; severity: number; times_blocked: number;
    }>(`
      SELECT id, pattern, threat_type, response, severity, times_blocked
      FROM antibodies
    `);

    const matchingAntibodies: Array<Record<string, unknown>> = [];
    for (const a of antibodies.rows) {
      try {
        const regex = new RegExp(a.pattern, 'i');
        if (regex.test(combined)) {
          matchingAntibodies.push({
            id: a.id,
            pattern: a.pattern,
            threat_type: a.threat_type,
            response: a.response,
            severity: a.severity,
            times_blocked: a.times_blocked,
          });
        }
      } catch { /* Skip invalid regex patterns */ }
    }

    // 3. Search skills — proven patterns with success tracking
    const matchingSkills: Array<Record<string, unknown>> = [];
    if (embedding) {
      const embeddingStr = `[${embedding.join(',')}]`;
      const skills = await client.query<{
        id: number; content_text: string;
        skill_success_count: number | null; skill_fail_count: number | null;
        skill_last_used: Date | null; similarity: number;
      }>(`
        SELECT id, content_text, skill_success_count, skill_fail_count, skill_last_used,
          (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
        FROM content
        WHERE network = 'skill'
          AND superseded_by IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 5
      `, [embeddingStr]);

      for (const s of skills.rows) {
        if (s.similarity >= 0.35) {
          const total = (s.skill_success_count || 0) + (s.skill_fail_count || 0);
          const successRate = total > 0 ? (s.skill_success_count || 0) / total : null;
          matchingSkills.push({
            id: s.id,
            skill: s.content_text?.slice(0, 200),
            similarity: Math.round(s.similarity * 1000) / 1000,
            success_rate: successRate !== null ? Math.round(successRate * 100) + '%' : 'untested',
            total_uses: total,
            last_used: s.skill_last_used,
          });
        }
      }
    }

    // 4. Search recent experience — have I been in this situation before?
    const matchingExperience: Array<Record<string, unknown>> = [];
    if (embedding) {
      const embeddingStr = `[${embedding.join(',')}]`;
      const experience = await client.query<{
        id: number; content_text: string; content_type: string; similarity: number;
      }>(`
        SELECT id, content_text, content_type,
          (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
        FROM content
        WHERE network = 'experience'
          AND superseded_by IS NULL
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 3
      `, [embeddingStr]);

      for (const e of experience.rows) {
        if (e.similarity >= 0.4) {
          matchingExperience.push({
            id: e.id,
            text: e.content_text?.slice(0, 200),
            type: e.content_type,
            similarity: Math.round(e.similarity * 1000) / 1000,
          });
        }
      }
    }

    // 5. ROUTING DECISION
    const hasReflexes = matchingReflexes.length > 0;
    const hasAntibodies = matchingAntibodies.length > 0;
    const hasHighSeverityThreat = matchingAntibodies.some(a => (a.severity as number) >= 7);
    const hasSimilarExperience = matchingExperience.length > 0;

    // Reflexes with good track records -> trust them
    const testedReflexes = matchingReflexes.filter(r => (r.total_uses as number) > 2);
    const reflexReliable = testedReflexes.length > 0 && testedReflexes.every(r => r.success_rate !== 'untested');

    let route: string, confidence: number, reasoning: string;

    if (hasHighSeverityThreat) {
      route = 'STOP';
      confidence = 0.9;
      const threat = matchingAntibodies.find(a => (a.severity as number) >= 7)!;
      reasoning = `High-severity antibody triggered (severity ${threat.severity}). This is a known threat pattern.`;
    } else if (hasReflexes && reflexReliable && !hasAntibodies) {
      route = 'REFLEX';
      confidence = 0.8;
      reasoning = `Tested reflexes cover this situation (${testedReflexes.length} with track record). Trust compiled knowledge.`;
    } else if (hasReflexes && !reflexReliable && hasSimilarExperience) {
      route = 'MIXED';
      confidence = 0.6;
      reasoning = `Reflexes exist but are untested. Similar experience found. Use reflexes as starting point, verify with deliberation.`;
    } else if (!hasReflexes && hasSimilarExperience) {
      route = 'DELIBERATE';
      confidence = 0.7;
      reasoning = `No compiled reflexes for this situation, but similar experience exists. Reason from experience.`;
    } else if (!hasReflexes && !hasSimilarExperience) {
      route = 'DELIBERATE';
      confidence = 0.5;
      reasoning = `Novel situation — no reflexes, no similar experience. Full deliberation required. Consider recording outcome for future reflex formation.`;
    } else {
      route = 'MIXED';
      confidence = 0.5;
      reasoning = `Partial coverage. Reflexes: ${matchingReflexes.length}, antibodies: ${matchingAntibodies.length}, skills: ${matchingSkills.length}. Deliberate where gaps exist.`;
    }

    // Context-aware priming: surface beliefs and patterns to enrich routing
    let routePriming = null;
    try {
      routePriming = await contextPrime(combined, {
        limit: 3,
        includeBeliefs: true,
        includePatterns: true,
        includeSkills: false, // already searched above
        includePredictions: false,
        includeReflexes: false, // already searched above
        client,
      });
    } catch { /* non-fatal */ }

    return jsonResult({
      situation,
      proposed_action: proposedAction,
      route,
      confidence,
      reasoning,
      reflexes: matchingReflexes,
      antibodies: matchingAntibodies,
      skills: matchingSkills,
      experience: matchingExperience,
      priming: routePriming || undefined,
      summary: {
        reflex_coverage: matchingReflexes.length,
        threat_alerts: matchingAntibodies.length,
        applicable_skills: matchingSkills.length,
        similar_experiences: matchingExperience.length,
      },
    });
  } finally {
    client.release();
  }
}

// ─── productionCompile ───
// SOAR-inspired: when deliberate reasoning succeeds repeatedly, compile into reflexes.
// Scans reviewed decisions and skill-network content for recurring successful patterns.
// Clusters by semantic similarity. If cluster has 3+ instances with >80% success rate,
// generates a WHEN→THEN reflex candidate.

async function productionCompile(args: Record<string, unknown>): Promise<CallToolResult> {
  const execute = (args.execute as boolean) || false;
  const minClusterSize = (args.min_cluster_size as number) || 3;
  const successThreshold = (args.success_threshold as number) || 0.8;

  const client = await pool.connect();
  try {
    // 1. Gather successful deliberate decisions (reviewed, positive outcomes)
    const decisions = await client.query<{
      id: number;
      decision: string;
      reasoning: string;
      outcome: string;
      what_learned: string | null;
      created_at: Date;
    }>(`
      SELECT id, decision, reasoning, outcome, what_learned, created_at
      FROM decision_reviews
      WHERE outcome IS NOT NULL
        AND would_change = false
      ORDER BY created_at DESC
      LIMIT 50
    `);

    // 2. Also gather insights that came from deliberate decisions
    const insights = await client.query<{
      id: number;
      content_text: string;
      content_json: Record<string, unknown> | null;
      skill_success_count: number | null;
      skill_fail_count: number | null;
    }>(`
      SELECT id, content_text, content_json, skill_success_count, skill_fail_count
      FROM content
      WHERE content_type = 'insight:synthesis'
        AND source_system = 'vision:decide'
        AND superseded_by IS NULL
      ORDER BY created_at DESC
      LIMIT 30
    `);

    // 3. Gather successful skills that were originally deliberate (high success, not yet reflexes)
    const successfulSkills = await client.query<{
      id: number;
      content_text: string;
      skill_success_count: number;
      skill_fail_count: number;
    }>(`
      SELECT id, content_text, skill_success_count, skill_fail_count
      FROM content
      WHERE network = 'skill'
        AND content_type != 'learned_reflex'
        AND superseded_by IS NULL
        AND skill_success_count >= $1
        AND (skill_success_count::numeric / GREATEST(skill_success_count + skill_fail_count, 1)::numeric) >= $2
      ORDER BY skill_success_count DESC
      LIMIT 20
    `, [minClusterSize, successThreshold]);

    if (decisions.rows.length === 0 && insights.rows.length === 0 && successfulSkills.rows.length === 0) {
      return jsonResult({
        status: 'nothing_to_compile',
        message: 'No reviewed decisions, decision insights, or high-success skills found. Use vision_decide to record decisions and their outcomes.',
      });
    }

    // 4. Cluster by semantic similarity using embeddings
    // Combine all candidate texts
    const candidates: Array<{
      source: string;
      id: number;
      text: string;
      reasoning?: string;
      success_rate?: number;
    }> = [];

    for (const d of decisions.rows) {
      candidates.push({
        source: 'decision',
        id: d.id,
        text: `${d.decision}. ${d.reasoning}`,
        reasoning: d.reasoning,
      });
    }

    for (const i of insights.rows) {
      candidates.push({
        source: 'insight',
        id: i.id,
        text: i.content_text,
      });
    }

    for (const s of successfulSkills.rows) {
      const total = s.skill_success_count + s.skill_fail_count;
      candidates.push({
        source: 'skill',
        id: s.id,
        text: s.content_text,
        success_rate: total > 0 ? s.skill_success_count / total : 1.0,
      });
    }

    // Get embeddings for clustering
    const embeddings: Array<{ idx: number; embedding: number[] }> = [];
    for (let i = 0; i < candidates.length; i++) {
      const emb = await getEmbedding(candidates[i].text);
      if (emb) embeddings.push({ idx: i, embedding: emb });
    }

    if (embeddings.length < 2) {
      return jsonResult({
        status: 'insufficient_data',
        message: `Only ${embeddings.length} embeddable candidates. Need at least 2 for clustering.`,
        candidates: candidates.length,
      });
    }

    // Simple clustering: compare each pair, group similar ones (>= 0.80 cosine)
    const CLUSTER_THRESHOLD = 0.80;
    const clusters = new Map<number, number[]>(); // leader_idx -> member_indices
    const assigned = new Set<number>();

    for (let i = 0; i < embeddings.length; i++) {
      if (assigned.has(i)) continue;

      const cluster = [embeddings[i].idx];
      assigned.add(i);

      for (let j = i + 1; j < embeddings.length; j++) {
        if (assigned.has(j)) continue;

        // Cosine similarity
        const a = embeddings[i].embedding;
        const b = embeddings[j].embedding;
        let dot = 0, magA = 0, magB = 0;
        for (let k = 0; k < a.length; k++) {
          dot += a[k] * b[k];
          magA += a[k] * a[k];
          magB += b[k] * b[k];
        }
        const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));

        if (sim >= CLUSTER_THRESHOLD) {
          cluster.push(embeddings[j].idx);
          assigned.add(j);
        }
      }

      if (cluster.length >= minClusterSize) {
        clusters.set(embeddings[i].idx, cluster);
      }
    }

    if (clusters.size === 0) {
      return jsonResult({
        status: 'no_patterns',
        message: `Found ${candidates.length} candidates but no clusters of ${minClusterSize}+ at ${CLUSTER_THRESHOLD} similarity. Decisions are too diverse for automatic compilation — this may mean deliberation is genuinely needed.`,
        candidates: candidates.length,
        embeddings: embeddings.length,
      });
    }

    // 5. Check each cluster against existing reflexes to avoid duplicates
    const existingReflexes = await client.query<{
      id: number;
      content_text: string;
    }>(`
      SELECT id, content_text FROM content
      WHERE content_type = 'learned_reflex'
        AND superseded_by IS NULL
    `);

    const compilationCandidates: Array<{
      cluster_members: Array<{ source: string; text: string }>;
      size: number;
      trigger: string;
      action: string;
      reasoning: string;
      already_exists: boolean;
    }> = [];

    for (const [leaderIdx, memberIndices] of clusters) {
      const members = memberIndices.map(idx => candidates[idx]);

      // Extract common pattern: what situation recurs, what action works
      // Use the leader text as the basis, reasoning from all members
      const leader = candidates[leaderIdx];
      const allTexts = members.map(m => m.text);

      // Find common words across all members (longer than 4 chars)
      const wordSets = allTexts.map(t =>
        new Set(t.toLowerCase().split(/\s+/).filter(w => w.length > 4))
      );
      const commonWords = [...wordSets[0]].filter(w =>
        wordSets.every(s => s.has(w))
      );

      // Build trigger and action from common theme
      const trigger = commonWords.slice(0, 8).join(' ') || leader.text.slice(0, 100);
      const action = leader.reasoning || members.find(m => m.reasoning)?.reasoning || 'apply the proven pattern';

      // Check for existing reflexes that cover this pattern
      const isDuplicate = existingReflexes.rows.some(r => {
        const reflexLower = r.content_text.toLowerCase();
        const matchCount = commonWords.filter(w => reflexLower.includes(w)).length;
        return matchCount >= Math.min(3, commonWords.length);
      });

      compilationCandidates.push({
        cluster_members: members.map(m => ({ source: m.source, text: m.text.slice(0, 150) })),
        size: members.length,
        trigger,
        action,
        reasoning: `Compiled from ${members.length} successful ${members.map(m => m.source).join('/')} instances`,
        already_exists: isDuplicate,
      });
    }

    // 6. Execute: create reflexes from novel candidates
    const created: Array<Record<string, unknown>> = [];
    const skipped: Array<string> = [];

    if (execute) {
      for (const candidate of compilationCandidates) {
        if (candidate.already_exists) {
          skipped.push(`Skipped: reflex already exists for "${candidate.trigger.slice(0, 50)}"`);
          continue;
        }

        const reflexName = candidate.trigger
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .slice(0, 4)
          .join('-');

        const reflexText = `${reflexName}: WHEN ${candidate.trigger} → THEN ${candidate.action}`;
        const embedding = await getEmbedding(reflexText);

        const result = await client.query<{ id: number }>(`
          INSERT INTO content (
            content_type, source_system, content_text, content_json,
            embedding, network, confidence, learned_at,
            skill_success_count, skill_fail_count
          )
          VALUES (
            'learned_reflex', 'production_compile', $1, $2,
            $3, 'skill', 85, NOW(),
            $4, 0
          )
          RETURNING id
        `, [
          reflexText,
          JSON.stringify({
            name: reflexName,
            trigger: candidate.trigger,
            action: candidate.action,
            reasoning: candidate.reasoning,
            formed_from_cluster_size: candidate.size,
            compilation_source: 'deliberate_to_automatic',
          }),
          embedding ? formatEmbedding(embedding) : null,
          candidate.size, // Start with cluster size as success count
        ]);

        created.push({
          id: result.rows[0].id,
          name: reflexName,
          trigger: candidate.trigger.slice(0, 100),
          action: candidate.action.slice(0, 100),
          cluster_size: candidate.size,
        });
      }
    }

    return jsonResult({
      status: execute ? 'compiled' : 'preview',
      sources: {
        decisions_reviewed: decisions.rows.length,
        decision_insights: insights.rows.length,
        successful_skills: successfulSkills.rows.length,
        total_candidates: candidates.length,
        embeddable: embeddings.length,
      },
      clusters_found: clusters.size,
      compilation_candidates: compilationCandidates.map(c => ({
        size: c.size,
        trigger: c.trigger.slice(0, 100),
        action: c.action.slice(0, 100),
        already_exists: c.already_exists,
        members: c.cluster_members.slice(0, 3),
      })),
      ...(execute ? {
        created,
        skipped,
      } : {
        message: 'Run with execute=true to compile candidates into reflexes',
      }),
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_session_evolve',
      description: 'Process a work event through the cognitive networks. Finds relevant beliefs to update, skills to record, and predictions to resolve. Call after meaningful events: deployments, client responses, bug fixes, completed features. Preview mode by default. SUPPLY OUTCOME: pass outcome=success|failure|neutral to tell the system whether the event resolved well — the lexical fallback misreads mixed-signal events (e.g. "bug found and fixed" reads as negative when outcome was success).',
      inputSchema: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'What just happened (e.g., "deployed MaidGlow successfully", "client said looks awesome")' },
          execute: { type: 'boolean', description: 'If true, apply belief updates and skill recordings. If false, preview only.' },
          outcome: { type: 'string', enum: ['success', 'failure', 'neutral'], description: 'Ground-truth outcome of the event. Supply this to override lexical sentiment inference. "success" → fired skills/reflexes marked success, matching predictions resolved correct. "failure" → marked failure. "neutral" → neither; useful for ambiguous / in-progress events.' },
        },
        required: ['event'],
      },
    },
    handler: (args) => sessionEvolve(args),
  },
  {
    definition: {
      name: 'vision_metacognitive_route',
      description: 'Metacognitive controller — given a situation, check if reflexes/antibodies handle it or if deliberation is needed. Returns matching reflexes, relevant antibodies, applicable skills with success rates, and a routing recommendation (reflex/deliberate/mixed). The decision of when to trust compiled knowledge vs think fresh.',
      inputSchema: {
        type: 'object',
        properties: {
          situation: { type: 'string', description: 'What is happening right now (e.g., "about to deploy Laravel app to production")' },
          proposed_action: { type: 'string', description: 'What I plan to do' },
        },
        required: ['situation'],
      },
    },
    handler: (args) => metacognitiveRoute(args),
  },
  {
    definition: {
      name: 'vision_prime',
      description: 'Context-Aware Priming — surface relevant beliefs, patterns, skills, predictions, and reflexes for a given context. Ambient cognition: knowledge participates without being explicitly asked.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'The context to prime for (e.g., "deploying Laravel to production")' },
          focus: { type: 'string', description: 'Optional focus area to narrow priming' },
        },
        required: ['context'],
      },
    },
    handler: async (args) => {
      const context = args.context as string;
      const focus = (args.focus as string) || null;
      const fullText = focus ? `${context} — focus: ${focus}` : context;
      const priming = await contextPrime(fullText, { limit: 5 });
      const totalSignals = priming
        ? Object.values(priming).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0)
        : 0;
      return jsonResult({
        context,
        focus,
        total_signals: totalSignals,
        ...priming,
      });
    },
  },
  {
    definition: {
      name: 'vision_production_compile',
      description: 'SOAR-inspired production compilation: scan reviewed decisions, decision insights, and high-success skills for recurring patterns. Clusters by semantic similarity (0.80+). When a pattern appears 3+ times with >80% success, compiles it into a learned_reflex. This is how deliberate (System 2) reasoning becomes automatic (System 1). Preview mode by default.',
      inputSchema: {
        type: 'object',
        properties: {
          execute: { type: 'boolean', description: 'If true, create reflexes from compilation candidates. If false, preview only.' },
          min_cluster_size: { type: 'number', description: 'Minimum cluster size for compilation (default 3)' },
          success_threshold: { type: 'number', description: 'Minimum success rate for compilation (default 0.8)' },
        },
      },
    },
    handler: (args) => productionCompile(args),
  },
];

export default tools;
