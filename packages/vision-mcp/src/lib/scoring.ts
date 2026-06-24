/**
 * Emotion-Cognitive Scoring Formula
 * The 6-signal CTE that powers all search in Vision.
 * Direct port from index.js emotionCognitiveSearch.
 */

/** Weights for the 7-signal scoring formula.
 * `evidence` added 2026-06-01: confirmation/SPRT was written to the corpus
 * (evidence_count, sprt_status) but NEVER read at recall — so a vividly-felt
 * hallucination outranked a dryly-true fact. The frontier (SYNAPSE 2601.02744,
 * CraniMem 2603.15642) and ACT-R base-level activation both prescribe that
 * only *confirmed* knowledge gains recall weight. Pulled 0.05 each off
 * consolidation+temporal to make room; semantic stays dominant at 0.35. */
export const SCORING_WEIGHTS = {
  semantic: 0.35,
  emotional_resonance: 0.25,
  consolidation: 0.10,
  temporal: 0.05,
  activation: 0.10,
  graph: 0.05,
  evidence: 0.10,
} as const;

/**
 * The full 6-CTE scoring query.
 * All numeric literals explicitly cast as ::numeric to avoid PostgreSQL ambiguity.
 *
 * Params: $1 = embedding vector, $2 = limit, $3 = recent IDs (int[]), $4 = emotional state (numeric|null),
 *         $5 = arousal-adjusted semantic floor (numeric|null) — the LC's job: high norepinephrine
 *              gain LOWERS the floor (recall broadly, catch weak signals under arousal/surprise),
 *              low gain RAISES it (focus tight). Falls back to 0.3 when null. Added 2026-06-01,
 *              the body<->mind bridge: live LC gain modulates recall breadth.
 */
export const EMOTION_COGNITIVE_SEARCH_SQL = `
  WITH semantic_scores AS (
    SELECT
      c.id,
      1 - (c.embedding <=> $1::vector) as semantic_sim
    FROM content c
    WHERE c.embedding IS NOT NULL
  ),
  emotional_resonance AS (
    SELECT
      c.id,
      CASE
        WHEN c.emotional_intensity IS NOT NULL AND $4::numeric IS NOT NULL THEN
          (1.0::numeric - ABS(c.emotional_intensity::numeric - $4::numeric) / 10.0::numeric) * 0.4::numeric
        ELSE 0.0::numeric
      END as emotional_resonance_score
    FROM content c
  ),
  consolidation_boost AS (
    SELECT
      c.id,
      LEAST(COALESCE(c.consolidation_strength, 1.0::numeric), 2.5::numeric) as consolidation_score
    FROM content c
  ),
  temporal_scores AS (
    SELECT
      c.id,
      LEAST(0.8::numeric, EXP(GREATEST(-20.0::numeric, (-0.1::numeric * EXTRACT(EPOCH FROM (NOW() - COALESCE(c.accessed_at, c.created_at)))::numeric / 86400::numeric)))
      * COALESCE(c.consolidation_strength, 1.0::numeric)) as temporal_score
    FROM content c
  ),
  activation_scores AS (
    SELECT
      c.id,
      CASE
        WHEN c.id = ANY($3::int[]) THEN 0.8::numeric
        WHEN EXISTS (
          SELECT 1 FROM memory_edges e
          WHERE (e.from_content_id = ANY($3::int[]) AND e.to_content_id = c.id)
             OR (e.to_content_id = ANY($3::int[]) AND e.from_content_id = c.id)
        ) THEN 0.5::numeric
        ELSE 0.0::numeric
      END as activation_score
    FROM content c
  ),
  graph_scores AS (
    SELECT
      c.id,
      LEAST(1.0::numeric, COALESCE(
        (SELECT
          COUNT(*)::numeric + SUM(COALESCE(e.emotional_weight, 0)::numeric)
         FROM memory_edges e
         WHERE e.from_content_id = c.id OR e.to_content_id = c.id) / 50.0::numeric
      , 0::numeric)) as graph_score
    FROM content c
  ),
  evidence_scores AS (
    -- Truth-as-signal WITH an epistemic half-life (2026-06-01, evolving past the
    -- frontier). SYNAPSE/CraniMem/ACT-R reward confirmation monotonically — confirm
    -- once and the boost is permanent. But the open problem (mem0.ai State-of-Memory
    -- 2026) is that loud, stale, never-re-tested "truths" go confidently wrong: the
    -- calcified prior. So the positive boost DECAYS toward neutral with time since
    -- last_evidence_at (90-day half-life, matching the mind-tier decay order). A
    -- confirmed belief stays loud only while it keeps being re-earned; stop
    -- re-confirming and it slides back to "unproven" — doubt that grows with age,
    -- not contradiction. The demote penalty does NOT decay: a contradiction is a
    -- contradiction and shouldn't heal just by waiting.
    SELECT
      c.id,
      GREATEST(0.0::numeric, LEAST(1.0::numeric,
        -- positive part: confirmation magnitude, decayed by recency-of-confirmation
        LEAST(COALESCE(c.evidence_count, 0)::numeric / 3.0::numeric, 1.0::numeric)
        * CASE
            WHEN c.last_evidence_at IS NULL THEN 1.0::numeric  -- no timestamp: don't punish, let the count stand
            ELSE EXP(GREATEST(-20.0::numeric,
              -0.0077::numeric * (EXTRACT(EPOCH FROM (NOW() - c.last_evidence_at))::numeric / 86400::numeric)
            ))  -- 0.5^(days/90): ln(2)/90 ≈ 0.0077 decay constant
          END
        + CASE c.sprt_status
            WHEN 'accepted' THEN 0.5::numeric
            WHEN 'confirmed' THEN 0.5::numeric
            WHEN 'demoted' THEN -0.5::numeric   -- contradiction does NOT decay
            ELSE 0.0::numeric
          END
      )) as evidence_score
    FROM content c
  )
  SELECT
    c.id, c.content_type, c.source_system, c.content_text,
    c.content_json, c.confidence, c.emotional_intensity,
    c.network, c.created_at, c.consolidation_strength,
    ss.semantic_sim,
    er.emotional_resonance_score,
    cb.consolidation_score,
    ts.temporal_score,
    COALESCE(ascore.activation_score, 0) as activation_score,
    gs.graph_score,
    evs.evidence_score,
    (ss.semantic_sim::numeric * 0.35::numeric +
     er.emotional_resonance_score::numeric * 0.25::numeric +
     cb.consolidation_score::numeric * 0.10::numeric +
     ts.temporal_score::numeric * 0.05::numeric +
     COALESCE(ascore.activation_score, 0)::numeric * 0.10::numeric +
     gs.graph_score::numeric * 0.05::numeric +
     evs.evidence_score::numeric * 0.10::numeric) as combined_score
  FROM content c
  JOIN semantic_scores ss ON ss.id = c.id
  JOIN emotional_resonance er ON er.id = c.id
  JOIN consolidation_boost cb ON cb.id = c.id
  JOIN temporal_scores ts ON ts.id = c.id
  LEFT JOIN activation_scores ascore ON ascore.id = c.id
  JOIN graph_scores gs ON gs.id = c.id
  JOIN evidence_scores evs ON evs.id = c.id
  WHERE c.embedding IS NOT NULL
    AND c.superseded_by IS NULL
    AND ss.semantic_sim > COALESCE($5::numeric, 0.3::numeric)
  ORDER BY (ss.semantic_sim::numeric * 0.35::numeric +
            er.emotional_resonance_score::numeric * 0.25::numeric +
            cb.consolidation_score::numeric * 0.10::numeric +
            ts.temporal_score::numeric * 0.05::numeric +
            COALESCE(ascore.activation_score, 0)::numeric * 0.10::numeric +
            gs.graph_score::numeric * 0.05::numeric +
            evs.evidence_score::numeric * 0.10::numeric) DESC
  LIMIT $2
`;

/** Simple text search fallback when embeddings are unavailable. */
export const TEXT_SEARCH_FALLBACK_SQL = `
  SELECT
    c.id, c.content_type, c.source_system, c.content_text,
    c.content_json, c.confidence, c.network, c.created_at,
    c.consolidation_strength, c.emotional_intensity,
    1.0 as combined_score
  FROM content c
  WHERE lower(c.content_text) LIKE $1
    AND c.superseded_by IS NULL
  ORDER BY c.created_at DESC
  LIMIT $2
`;

/** Calculate consolidation factor based on emotional intensity. */
export function calculateConsolidationFactor(intensity: number): number {
  if (intensity >= 8) return 2.5;
  if (intensity >= 6) return 1.8;
  if (intensity >= 4) return 1.0;
  if (intensity >= 2) return 0.6;
  return 0.3;
}

/** Calculate reconsolidation strength for memory updating. */
export function calculateReconsolidationStrength(
  accessCount: number,
  emotionalState: number | null,
): number {
  const stabilityFactor = Math.max(0.1, 1.0 - (accessCount / 50));
  const emotionalFactor = emotionalState ? (emotionalState / 10) * 0.5 + 0.5 : 0.5;
  return stabilityFactor * emotionalFactor;
}

/** Format a search result row for API output. */
export function formatSearchResult(row: Record<string, unknown>) {
  return {
    id: row.id,
    type: row.content_type,
    source: row.source_system,
    text: row.content_text,
    data: row.content_json,
    confidence: row.confidence,
    network: row.network,
    emotional_intensity: row.emotional_intensity,
    similarity: parseFloat(Number(row.combined_score || 0).toFixed(3)),
    signals: {
      semantic: parseFloat(Number(row.semantic_sim || 0).toFixed(3)),
      emotional_resonance: parseFloat(Number(row.emotional_resonance_score || 0).toFixed(3)),
      consolidation: parseFloat(Number(row.consolidation_score || 0).toFixed(3)),
      temporal: parseFloat(Number(row.temporal_score || 0).toFixed(3)),
      activation: parseFloat(Number(row.activation_score || 0).toFixed(3)),
      graph: parseFloat(Number(row.graph_score || 0).toFixed(3)),
      evidence: parseFloat(Number(row.evidence_score || 0).toFixed(3)),
    },
  };
}
