/**
 * find_contradictions — Multi-Stage Edge Validator (Phase 4 Pillar)
 *
 * The single write-gate for edge creation across the cognitive system.
 * Replaces the lexical-sentiment + bare-similarity bug class that
 * poisoned skill counters, belief evidence, and prediction outcomes
 * (patched 2026-05-02).
 *
 * Three consumers (after rollout):
 *   - skill outcomes (skill_usage_log via vault.ts)
 *   - belief evidence (belief_evidence rows via lib/evidence.ts)
 *   - prediction resolution (prediction_outcomes via lib/inference-loop.ts)
 *
 * Three stages, each is a cheap-to-expensive filter:
 *   Stage 1 — Semantic match (pgvector cosine >= threshold)
 *   Stage 2 — Structural plausibility (content_type compatibility +
 *             graph distance bound)
 *   Stage 3 — LLM confirmation (cheap local model — see agent's
 *             prompt design in shared_doc 'find_contradictions_stage3')
 *
 * Returns a verdict with per-stage transcript so callers can decide
 * whether to write the edge, surface for review, or drop.
 *
 * Co-designed with agent 2026-05-02 (Vision Phase 4).
 * Ref: Engram Memory's find_contradictions, T³ ICLR 2026 belief deviation,
 * STEM (Structure-Tracing Evidence Mining).
 */
import pg from 'pg';
import { pool } from '../db/pool.js';
import { askLocalLLM } from '../db/embeddings.js';
import { EDGE_VALIDATION_PROMPT } from './multi-stage-prompt.js';
import { mineProvenance } from './stem.js';

/**
 * Verdict surface — three-way per agent's prompt schema, plus 'insufficient'
 * for cases where the validator itself couldn't run (missing embeddings,
 * missing nodes). Callers should treat 'insufficient' as a hard skip,
 * not a soft "unrelated".
 */
export type EdgeVerdict = 'supports' | 'contradicts' | 'unrelated' | 'insufficient';

/** Target classifier for the LLM prompt — drives `target_type` substitution. */
export type TargetType = 'Belief' | 'Skill' | 'Prediction';

/**
 * Map a content_type to the LLM prompt's target_type bucket.
 * The prompt was designed by agent to handle these three explicitly.
 */
function classifyTarget(contentType: string): TargetType {
  if (contentType === 'skill_failure' || contentType === 'learned_reflex') return 'Skill';
  if (contentType === 'prediction' || contentType === 'prediction_error') return 'Prediction';
  return 'Belief';  // default — beliefs, world_observation, insight, memory all map here
}

export interface ValidatorResult {
  verdict: EdgeVerdict;
  confidence: number;             // 0..1, validator's overall certainty
  stages_passed: Array<'semantic' | 'structural' | 'llm' | 'stem'>;
  semantic_similarity?: number;    // raw cosine if Stage 1 ran
  structural_distance?: number;    // graph hops between content nodes (Inf if disconnected)
  type_compatible?: boolean;       // Stage 2 verdict on content_type pair
  llm_verdict?: string;            // raw text from Stage 3 if it ran
  /** Stage 4 STEM: best chain score from structural mining */
  stem_score?: number;
  /** Stage 4 STEM: number of chains found above threshold */
  stem_chains_found?: number;
  /** Stage 4 STEM: net direction of strongest chain (sanity check vs LLM verdict) */
  stem_direction?: 'supporting' | 'contradicting' | 'mixed' | 'neutral';
  rejected_at?: 'semantic' | 'structural' | 'llm' | 'stem';
  rejected_reason?: string;
  psi_estimate?: number;           // T³ Ψ(b) when an oracle is in play
}

export interface ValidatorOptions {
  /** Minimum cosine similarity to pass Stage 1. Tightened from 0.42 to 0.65. */
  semanticThreshold?: number;
  /** Maximum graph distance (hops) between nodes for Stage 2 to pass. */
  maxStructuralDistance?: number;
  /** Whether to run Stage 3 LLM check. Defaults true. Set false for cheap-mode. */
  runLLM?: boolean;
  /** Whether to run Stage 4 STEM provenance mining. Defaults true when LLM
   *  returned supports/contradicts (so we can structurally verify the verdict). */
  runStem?: boolean;
  /** STEM score threshold — below this, the LLM verdict gets downgraded to 'unrelated'.
   *  This is the structural override: prevents LLM hallucinations from passing when
   *  no actual graph pathway exists between the nodes. */
  stemThreshold?: number;
  /** s⋆ proxy tier when computing T³ Ψ. 'A'=owner correction, 'B'=verify, 'C'=audit. */
  oracleTier?: 'A' | 'B' | 'C' | null;
  /** Caller identifier for audit logs. e.g. 'inference-loop:checkPredictions'. */
  caller?: string;
  client?: pg.PoolClient;
}

/**
 * Stage 2 compatibility table — which content_type pairs can plausibly
 * share a 'supports' / 'contradicts' / 'caused' style edge.
 *
 * Three buckets: epistemic (claims/observations), experiential (felt
 * states), operational (skills/goals). All in-bucket pairs are allowed.
 * Cross-bucket pairs allowed where they make cognitive sense:
 *   - operational ↔ epistemic: skill outcomes update beliefs about skills
 *   - experiential ↔ epistemic: somatic markers (feelings/gut) ARE
 *     primary empirical evidence for abstract beliefs (Damasio). The
 *     2026-05-02 patched bug was lexical false-positives, NOT the
 *     legitimate "I feel the project failing → evidence against the
 *     belief that it's succeeding" pathway. Stage 3 (LLM, Rule 1:
 *     DIRECTLY prove/disprove) is the gate that filters the false
 *     positives we used to ship structurally. (Re-enabled by agent
 *     2026-05-02 after my initial overcorrection.)
 *
 * Stage 2 now rejects ONLY: unknown content_types, and pairs not in
 * the explicit map (e.g. operational ↔ experiential — a skill outcome
 * doesn't directly evidence a feeling).
 */
const COMPATIBILITY: Record<string, Set<string>> = (() => {
  const epistemic = new Set([
    'belief',
    'belief_evidence',
    'prediction',
    'prediction_error',
    'world_observation',
    'insight',
    'insight:synthesis',
    'thinking_pattern',
    'core_value',
    'memory',          // memory of an event can support/contradict a belief about that event
    'session_handoff', // handoffs include claims that can be checked
    'salient_event',
    'coherence_check',
    'pattern',
  ]);
  const experiential = new Set([
    'feeling',
    'gratitude_moment',
    'energy_checkin',
    'episode',
    'emergence_event',
  ]);
  const operational = new Set([
    'skill_failure',
    'learned_reflex',
    'goal',
    'task',
  ]);

  // Compatibility map: {from_bucket: Set<to_bucket>}
  // Epistemic ↔ Epistemic: yes (claim/evidence space)
  // Experiential ↔ Experiential: yes (resonance space)
  // Operational ↔ Operational: yes (skill/goal space)
  // Cross-bucket: only specific pairs (operational → epistemic for skill outcomes
  // updating beliefs about skill efficacy; experiential ↔ epistemic MUST be allowed
  // because affective states (feelings/somatic markers) are primary empirical evidence 
  // for abstract beliefs, provided the LLM check (Stage 3) confirms the contradiction).
  return {
    epistemic_epistemic: epistemic,
    experiential_experiential: experiential,
    operational_operational: operational,
    operational_epistemic: epistemic,  // skill outcome can update belief about skill efficacy
    epistemic_operational: operational, // belief about a skill can predict its outcome
    experiential_epistemic: epistemic, // somatic markers provide evidence for beliefs
    epistemic_experiential: experiential, // beliefs contextualize experiences
  } as Record<string, Set<string>>;
})();

const TYPE_BUCKETS: Record<string, 'epistemic' | 'experiential' | 'operational' | 'unknown'> = (() => {
  const map: Record<string, 'epistemic' | 'experiential' | 'operational' | 'unknown'> = {};
  const groups = {
    epistemic: ['belief', 'belief_evidence', 'prediction', 'prediction_error', 'world_observation',
                'insight', 'insight:synthesis', 'thinking_pattern', 'core_value', 'memory',
                'session_handoff', 'salient_event', 'coherence_check', 'pattern'],
    experiential: ['feeling', 'gratitude_moment', 'energy_checkin', 'episode', 'emergence_event'],
    operational: ['skill_failure', 'learned_reflex', 'goal', 'task'],
  };
  for (const [bucket, types] of Object.entries(groups)) {
    for (const t of types) map[t] = bucket as 'epistemic' | 'experiential' | 'operational';
  }
  return map;
})();

function bucketOf(contentType: string): 'epistemic' | 'experiential' | 'operational' | 'unknown' {
  return TYPE_BUCKETS[contentType] ?? 'unknown';
}

/**
 * Stage 2a — content_type compatibility check.
 * Returns true if an edge between these two types is structurally plausible.
 * See COMPATIBILITY comment above for the bucket allowlist rationale.
 * Stage 3 (LLM) is the gate that filters lexical false-positives within
 * an allowed pair.
 */
export function isTypeCompatible(fromType: string, toType: string): boolean {
  const fromBucket = bucketOf(fromType);
  const toBucket = bucketOf(toType);
  if (fromBucket === 'unknown' || toBucket === 'unknown') return false;
  const key1 = `${fromBucket}_${toBucket}`;
  const key2 = `${toBucket}_${fromBucket}`;
  return key1 in COMPATIBILITY || key2 in COMPATIBILITY;
}

/**
 * Stage 2b — graph distance check.
 * Counts hops between two content nodes via memory_edges.
 * Returns Infinity if disconnected within `maxHops`.
 *
 * Rationale: spectral_recall principle (Engram Memory) — semantically
 * similar nodes that are topologically distant are likely false positives.
 * A genuine 'supports' edge usually sits in a region of dense local
 * connectivity, not across an isolated semantic island.
 */
export async function graphDistance(
  fromId: number,
  toId: number,
  maxHops: number,
  client?: pg.PoolClient,
): Promise<number> {
  if (fromId === toId) return 0;
  const c = client ?? await pool.connect();
  const ownClient = !client;
  try {
    // BFS via recursive CTE, bounded by maxHops to avoid full-graph scan.
    // PostgreSQL WITH RECURSIVE requires exactly one non-recursive seed
    // term and one recursive term; the seed unions both directions of
    // the start node, the recursive step traverses both directions of
    // each frontier node.
    const result = await c.query<{ depth: number }>(`
      WITH RECURSIVE bfs AS (
        SELECT node, depth FROM (
          SELECT to_content_id AS node, 1 AS depth FROM memory_edges WHERE from_content_id = $1
          UNION
          SELECT from_content_id AS node, 1 AS depth FROM memory_edges WHERE to_content_id = $1
        ) seed
        UNION
        SELECT next_node, b.depth + 1 FROM bfs b
        JOIN LATERAL (
          SELECT to_content_id AS next_node FROM memory_edges WHERE from_content_id = b.node
          UNION
          SELECT from_content_id AS next_node FROM memory_edges WHERE to_content_id = b.node
        ) neighbors ON true
        WHERE b.depth < $3
      )
      SELECT MIN(depth) AS depth FROM bfs WHERE node = $2
    `, [fromId, toId, maxHops]);
    const depth = result.rows[0]?.depth;
    return depth == null ? Infinity : depth;
  } finally {
    if (ownClient) c.release();
  }
}

/**
 * Stage 1 — semantic similarity. Lookup pgvector cosine.
 * Returns the cosine similarity (1 - distance), or null if either embedding missing.
 */
async function semanticSimilarity(
  fromId: number,
  toId: number,
  client?: pg.PoolClient,
): Promise<number | null> {
  const c = client ?? await pool.connect();
  const ownClient = !client;
  try {
    const result = await c.query<{ similarity: number | null }>(`
      SELECT 1 - (a.embedding <=> b.embedding) AS similarity
      FROM content a, content b
      WHERE a.id = $1 AND b.id = $2
        AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
    `, [fromId, toId]);
    const sim = result.rows[0]?.similarity;
    return sim == null ? null : Number(sim);
  } finally {
    if (ownClient) c.release();
  }
}

/**
 * Main entry. Validate whether an edge between two content nodes is plausible.
 * Wraps the inner validator with audit logging to phase4_validator_log
 * (added migration 021, 2026-05-02). Logging is fire-and-forget so a
 * logging failure can never break a caller's hot path.
 */
export async function validateEdge(
  fromId: number,
  toId: number,
  options: ValidatorOptions = {},
): Promise<ValidatorResult> {
  const t0 = Date.now();
  const result = await validateEdgeInner(fromId, toId, options);
  const durationMs = Date.now() - t0;

  // Fire-and-forget audit log
  logValidatorCall(fromId, toId, options, result, durationMs).catch(err => {
    console.error('[find-contradictions] log insert failed:', (err as Error).message);
  });

  return result;
}

async function validateEdgeInner(
  fromId: number,
  toId: number,
  options: ValidatorOptions = {},
): Promise<ValidatorResult> {
  const semanticThreshold = options.semanticThreshold ?? 0.65;
  const maxStructuralDistance = options.maxStructuralDistance ?? 4;
  const runLLM = options.runLLM ?? true;
  const c = options.client ?? await pool.connect();
  const ownClient = !options.client;

  const stages_passed: Array<'semantic' | 'structural' | 'llm' | 'stem'> = [];

  try {
    // ─── Stage 1: Semantic ───
    const sim = await semanticSimilarity(fromId, toId, c);
    if (sim == null) {
      return {
        verdict: 'insufficient',
        confidence: 0,
        stages_passed,
        rejected_at: 'semantic',
        rejected_reason: 'one or both nodes lack embeddings',
      };
    }
    if (sim < semanticThreshold) {
      return {
        verdict: 'unrelated',
        confidence: 1 - sim,  // confident in unrelatedness
        stages_passed,
        semantic_similarity: sim,
        rejected_at: 'semantic',
        rejected_reason: `cosine ${sim.toFixed(3)} < ${semanticThreshold}`,
      };
    }
    stages_passed.push('semantic');

    // ─── Stage 2: Structural ───
    // 2a — content_type compatibility
    const typeRow = await c.query<{ from_type: string; to_type: string }>(`
      SELECT a.content_type AS from_type, b.content_type AS to_type
      FROM content a, content b
      WHERE a.id = $1 AND b.id = $2
    `, [fromId, toId]);
    if (typeRow.rows.length === 0) {
      return {
        verdict: 'insufficient',
        confidence: 0,
        stages_passed,
        semantic_similarity: sim,
        rejected_at: 'structural',
        rejected_reason: 'one or both nodes missing',
      };
    }
    const { from_type, to_type } = typeRow.rows[0];
    const typeCompat = isTypeCompatible(from_type, to_type);
    if (!typeCompat) {
      return {
        verdict: 'unrelated',
        confidence: 0.85,  // high confidence the edge is wrong on type grounds
        stages_passed,
        semantic_similarity: sim,
        type_compatible: false,
        rejected_at: 'structural',
        rejected_reason: `${from_type} ↔ ${to_type} not in compatibility table`,
      };
    }

    // 2b — graph distance
    const dist = await graphDistance(fromId, toId, maxStructuralDistance, c);
    if (dist === Infinity) {
      // Topologically isolated — Engram's spectral principle says reject
      return {
        verdict: 'unrelated',
        confidence: 0.7,
        stages_passed,
        semantic_similarity: sim,
        type_compatible: true,
        structural_distance: Infinity,
        rejected_at: 'structural',
        rejected_reason: `no path within ${maxStructuralDistance} hops — likely semantic false positive`,
      };
    }
    stages_passed.push('structural');

    // ─── Stage 3: LLM (agent's prompt via askLocalLLM) ───
    if (!runLLM) {
      const conf = 0.5 + (sim - semanticThreshold) * 0.5;
      return {
        verdict: 'supports',
        confidence: Math.min(0.7, conf),
        stages_passed,
        semantic_similarity: sim,
        type_compatible: true,
        structural_distance: dist,
      };
    }

    const llmResult = await stage3LLMCheck(fromId, toId, c);
    stages_passed.push('llm');

    // ─── Stage 4: STEM (Structure-Tracing Evidence Mining) ───
    // Only run STEM when LLM returned a positive verdict — that's the
    // case where a structural override matters. If LLM said 'unrelated',
    // STEM can't change the answer (we already agree there's no edge).
    // This is the cheapest place to skip — STEM does up to 8 SQL queries.
    const runStem = options.runStem ?? true;
    const stemThreshold = options.stemThreshold ?? 0.10;

    if (runStem && (llmResult.verdict === 'supports' || llmResult.verdict === 'contradicts')) {
      try {
        const stem = await mineProvenance(fromId, toId, {
          client: c,
          maxHops: 4,
          topK: 3,
          threshold: stemThreshold,
          includeSoftEdges: true,
        });

        stages_passed.push('stem');

        // Structural override: if no chain meets threshold, downgrade
        // the LLM verdict to 'unrelated' (the LLM was likely hallucinating
        // a relationship that doesn't exist in our actual graph).
        if (!stem.has_structural_evidence) {
          return {
            verdict: 'unrelated',
            confidence: 0.6,  // moderate confidence — LLM said yes but graph said no
            stages_passed,
            semantic_similarity: sim,
            type_compatible: true,
            structural_distance: dist,
            llm_verdict: llmResult.raw,
            stem_score: stem.best_score,
            stem_chains_found: stem.chains.length,
            rejected_at: 'stem',
            rejected_reason: `LLM said ${llmResult.verdict} but no structural pathway found (best chain score ${stem.best_score.toFixed(3)} < ${stemThreshold})`,
            psi_estimate: options.oracleTier ? computePsi(0.6, options.oracleTier) : undefined,
          };
        }

        // Direction sanity check: if STEM's net direction strongly
        // disagrees with LLM's verdict, that's a smell — flag in confidence.
        const stemDirection = stem.chains[0]?.net_direction;
        const llmDirection = llmResult.verdict === 'supports' ? 'supporting' : 'contradicting';
        const directionsAgree = stemDirection === llmDirection || stemDirection === 'neutral' || stemDirection === 'mixed';
        const finalConfidence = directionsAgree
          ? Math.min(1, llmResult.confidence + stem.best_score * 0.1)  // boost for agreement
          : llmResult.confidence * 0.7;  // penalize for disagreement

        return {
          verdict: llmResult.verdict,
          confidence: finalConfidence,
          stages_passed,
          semantic_similarity: sim,
          type_compatible: true,
          structural_distance: dist,
          llm_verdict: llmResult.raw,
          stem_score: stem.best_score,
          stem_chains_found: stem.chains.length,
          stem_direction: stemDirection,
          psi_estimate: options.oracleTier ? computePsi(finalConfidence, options.oracleTier) : undefined,
        };
      } catch (err) {
        // STEM failure is non-fatal — fall through to original LLM verdict
        console.error('[find-contradictions] STEM failed:', (err as Error).message);
      }
    }

    return {
      verdict: llmResult.verdict,
      confidence: llmResult.confidence,
      stages_passed,
      semantic_similarity: sim,
      type_compatible: true,
      structural_distance: dist,
      llm_verdict: llmResult.raw,
      psi_estimate: options.oracleTier ? computePsi(llmResult.confidence, options.oracleTier) : undefined,
    };
  } finally {
    if (ownClient) c.release();
  }
}

/**
 * Audit log writer — INSERT into phase4_validator_log (migration 021).
 * Caller-passed `caller` and `mode` are encoded in the row so a single
 * SELECT GROUP BY query can split shadow vs on, by-source, by-verdict.
 */
async function logValidatorCall(
  fromId: number,
  toId: number,
  options: ValidatorOptions,
  result: ValidatorResult,
  durationMs: number,
): Promise<void> {
  const mode = process.env.VISION_PHASE4_PREDICTIONS === 'on' ? 'on' : 'shadow';
  const caller = options.caller ?? 'unknown';
  const llmCalled = result.stages_passed.includes('llm');

  // Lookup denormalized types if the validator got far enough to know them
  let fromType: string | null = null;
  let toType: string | null = null;
  try {
    const c = await pool.connect();
    try {
      const r = await c.query<{ from_type: string; to_type: string }>(`
        SELECT a.content_type AS from_type, b.content_type AS to_type
        FROM content a, content b
        WHERE a.id = $1 AND b.id = $2
      `, [fromId, toId]);
      if (r.rows.length > 0) {
        fromType = r.rows[0].from_type;
        toType = r.rows[0].to_type;
      }
    } finally {
      c.release();
    }
  } catch {
    // Type lookup failure is non-fatal for logging
  }

  const c = await pool.connect();
  try {
    await c.query(
      `INSERT INTO phase4_validator_log (
        from_content_id, to_content_id, from_type, to_type,
        caller, mode,
        semantic_similarity, type_compatible, structural_distance,
        llm_verdict_raw, llm_reasoning,
        verdict, confidence, stages_passed,
        rejected_at, rejected_reason,
        oracle_tier, psi_estimate,
        enforced, llm_called, duration_ms,
        stem_score, stem_chains_found, stem_direction
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
        $22, $23, $24
      )`,
      [
        fromId, toId, fromType, toType,
        caller, mode,
        result.semantic_similarity ?? null,
        result.type_compatible ?? null,
        result.structural_distance === Infinity ? null : (result.structural_distance ?? null),
        result.llm_verdict ?? null,
        null, // llm_reasoning — populated when validateEdge gains structured Stage 3 return shape
        result.verdict,
        result.confidence,
        result.stages_passed,
        result.rejected_at ?? null,
        result.rejected_reason ?? null,
        options.oracleTier ?? null,
        result.psi_estimate ?? null,
        false, // enforced — set true by caller when verdict actually drove a write
        llmCalled,
        durationMs,
        result.stem_score ?? null,
        result.stem_chains_found ?? null,
        result.stem_direction ?? null,
      ],
    );
  } finally {
    c.release();
  }
}

/**
 * Stage 3 — LLM verdict via askLocalLLM (shared local-model wrapper).
 * Uses agent's prompt from `multi-stage-prompt.ts`. Returns the model's
 * strict JSON `{verdict, confidence, reasoning}` parsed into our shape.
 *
 * Failure modes:
 *  - askLocalLLM returns null → 'insufficient' (callers must skip)
 *  - JSON parse fails → 'insufficient' with raw payload preserved
 *  - Verdict outside enum → coerced to 'unrelated' at low confidence
 */
async function stage3LLMCheck(
  fromId: number,
  toId: number,
  client: pg.PoolClient,
): Promise<{ verdict: EdgeVerdict; confidence: number; raw: string }> {
  const rows = await client.query<{
    id: number;
    content_text: string;
    content_type: string;
  }>(`
    SELECT id, content_text, content_type FROM content WHERE id = ANY($1::int[])
  `, [[fromId, toId]]);

  const fromRow = rows.rows.find(r => r.id === fromId);
  const toRow = rows.rows.find(r => r.id === toId);
  if (!fromRow || !toRow) {
    return { verdict: 'insufficient', confidence: 0, raw: 'one or both content rows not found' };
  }

  const targetType = classifyTarget(toRow.content_type);
  const prompt = EDGE_VALIDATION_PROMPT
    .replace('{target_type}', targetType)
    .replace('{target_text}', (toRow.content_text || '').slice(0, 800))
    .replace('{event_text}', (fromRow.content_text || '').slice(0, 800));

  const response = await askLocalLLM(prompt, {
    temperature: 0.1,
    // Higher than seems necessary because the local reasoning model
    // (mlx-brain) eats most of the budget in chain-of-thought before
    // emitting the final JSON.
    maxTokens: 1500,
    json: true,
  });

  if (!response) {
    return { verdict: 'insufficient', confidence: 0, raw: 'askLocalLLM returned null' };
  }

  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { verdict: 'insufficient', confidence: 0, raw: response };
  }
  let parsed: { verdict?: string; confidence?: number; reasoning?: string };
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { verdict: 'insufficient', confidence: 0, raw: response };
  }

  const verdict: EdgeVerdict =
    parsed.verdict === 'supports' || parsed.verdict === 'contradicts' || parsed.verdict === 'unrelated'
      ? parsed.verdict
      : 'unrelated';
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));

  return {
    verdict,
    confidence,
    raw: parsed.reasoning ?? response,
  };
}

/**
 * T³ Ψ(b) := -log b(s⋆) — belief discrepancy under an oracle.
 * b is the validator's confidence; s⋆ is the oracle outcome.
 * Tier-A oracle: assumed truth with probability 0.95.
 * Tier-B oracle: assumed truth with probability 0.85.
 * Tier-C oracle: assumed truth with probability 0.70.
 *
 * Higher Ψ → larger surprise → candidate for evidence prune.
 */
function computePsi(belief: number, tier: 'A' | 'B' | 'C'): number {
  const oracleProb = tier === 'A' ? 0.95 : tier === 'B' ? 0.85 : 0.70;
  // If belief points toward oracle, Ψ small; if belief contradicts, Ψ large.
  const aligned = belief * oracleProb + (1 - belief) * (1 - oracleProb);
  return -Math.log(Math.max(0.01, aligned));
}
