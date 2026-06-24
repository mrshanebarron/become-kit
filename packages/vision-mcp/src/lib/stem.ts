/**
 * STEM — Structure-Tracing Evidence Mining (Phase 4 Wave 6).
 *
 * Goes beyond Stage 2's "is this content_type pair allowed?" by tracing
 * the actual structural path from event to target through intermediate
 * memory nodes. Produces an auditable provenance chain.
 *
 * Co-designed agent + agent, 2026-05-02.
 *
 * Why STEM matters when find_contradictions already passes Stage 3:
 *   - Stage 3 is a black-box LLM verdict — high quality but opaque
 *   - STEM provides the SHOWING of the work: "supports because event A
 *     led to memory B which contradicts prior C which supports D which
 *     is the target belief"
 *   - Calibrates confidence: a 4-hop chain through 3 strongly-emotional
 *     nodes is stronger evidence than a 2-hop chain through a generic
 *     observation
 *   - Catches hallucinated edges where Stage 3 said 'supports' but no
 *     actual structural pathway exists in the graph (LLM filled in
 *     plausible-sounding reasoning that doesn't reflect reality)
 *
 * Architecture:
 *   1. Bidirectional BFS from both endpoints
 *   2. At each meeting point, score the chain by:
 *      - Edge strengths along the path (multiplicative)
 *      - Average emotional weight (additive bonus)
 *      - Reinforcement count (each touched edge contributes)
 *      - Length penalty (longer chains decay)
 *   3. Return the top-K chains with their scores and node/edge details
 *
 * Used by validateEdge (Stage 4 — the new gate after LLM): if
 * mineProvenance returns no chain with score > threshold, the verdict
 * is downgraded from 'supports'/'contradicts' to 'unrelated' even if
 * Stage 3 said otherwise. This is the structural override.
 */
import pg from 'pg';
import { pool } from '../db/pool.js';

export interface ChainStep {
  edge_id: number;
  from_id: number;
  to_id: number;
  relation_type: string;
  strength: number;
  emotional_weight: number;
}

export interface ProvenanceChain {
  /** Score: higher = stronger structural evidence */
  score: number;
  /** Chain of memory_edges traversed from source to target */
  steps: ChainStep[];
  /** Length of the chain (number of edges) */
  length: number;
  /** Direction summary — does the chain net to support or contradict? */
  net_direction: 'supporting' | 'contradicting' | 'mixed' | 'neutral';
}

export interface StemResult {
  /** Top chains found, ordered by score descending */
  chains: ProvenanceChain[];
  /** Best chain's score, or 0 if none found */
  best_score: number;
  /** Whether STEM judges the structural evidence sufficient */
  has_structural_evidence: boolean;
  /** Threshold used for has_structural_evidence */
  threshold: number;
  /** Time spent mining (ms) */
  duration_ms: number;
}

export interface StemOptions {
  /** Maximum hops in either direction during BFS */
  maxHops?: number;
  /** Maximum chains to return */
  topK?: number;
  /** Minimum chain score to count as "has structural evidence" */
  threshold?: number;
  /** Whether to include 'similar_to' / 'emotionally_resonant' edges
   *  (these are weaker structural evidence than 'supports'/'contradicts') */
  includeSoftEdges?: boolean;
  client?: pg.PoolClient;
}

const SUPPORT_RELATIONS = new Set([
  'supports', 'caused', 'causes', 'led_to', 'led to', 'leads_to', 'leads to',
  'enabled', 'enables', 'ensures', 'resulted_in', 'learned_during',
  'noted_during', 'noticed_during',
]);

const CONTRADICT_RELATIONS = new Set([
  'contradicts', 'supersedes', 'revises', 'revised_by', 'prevented', 'prevents',
]);

const SOFT_RELATIONS = new Set([
  'similar_to', 'emotionally_resonant', 'emotionally_linked',
  'consolidated_during_emotion', 'felt_during', 'replay_association',
  'remembered_during', 'entity_extracted', 'relates_to',
]);

/**
 * Score a chain — multiplicative on strengths, with emotional bonus
 * and length penalty. Tuned so a 1-hop strong-evidence edge scores ~1
 * and a 4-hop weak chain scores ~0.05.
 */
function scoreChain(steps: ChainStep[]): number {
  if (steps.length === 0) return 0;

  // Geometric mean of strengths — penalizes any one weak link
  const strengthProduct = steps.reduce((acc, s) => acc * Math.max(0.1, s.strength), 1);
  const strengthGeoMean = Math.pow(strengthProduct, 1 / steps.length);

  // Emotional lift — emotionally-charged chains are stronger evidence
  const avgEmotional = steps.reduce((acc, s) => acc + Math.abs(s.emotional_weight ?? 0), 0) / steps.length;
  const emotionalLift = 1 + avgEmotional * 0.5;

  // Length penalty — longer chains decay
  const lengthPenalty = Math.pow(0.7, Math.max(0, steps.length - 1));

  return strengthGeoMean * emotionalLift * lengthPenalty;
}

/**
 * Determine the net direction of a chain by counting support vs contradict edges.
 * Soft edges (similar_to, etc.) don't contribute to direction, only to structure.
 */
function chainDirection(steps: ChainStep[]): 'supporting' | 'contradicting' | 'mixed' | 'neutral' {
  let support = 0;
  let contradict = 0;
  for (const s of steps) {
    if (SUPPORT_RELATIONS.has(s.relation_type)) support++;
    if (CONTRADICT_RELATIONS.has(s.relation_type)) contradict++;
  }
  if (support === 0 && contradict === 0) return 'neutral';
  if (support > 0 && contradict === 0) return 'supporting';
  if (contradict > 0 && support === 0) return 'contradicting';
  // Net via XOR — odd contradicts flips, even cancels back to support
  return contradict % 2 === 1 ? 'contradicting' : 'supporting';
}

/**
 * Bidirectional BFS to find structural pathways from source to target.
 * Returns up to topK chains ordered by score.
 *
 * Implementation: forward BFS from source AND backward BFS from target,
 * both bounded by maxHops/2. When the frontiers meet at any node, we
 * have a candidate chain; reconstruct it by walking parent pointers.
 *
 * To stay within budget on large graphs, we hard-cap each frontier
 * expansion at 200 nodes per hop.
 */
export async function mineProvenance(
  sourceId: number,
  targetId: number,
  options: StemOptions = {},
): Promise<StemResult> {
  const t0 = Date.now();
  const maxHops = options.maxHops ?? 4;
  const topK = options.topK ?? 5;
  const threshold = options.threshold ?? 0.15;
  const includeSoftEdges = options.includeSoftEdges ?? true;
  const c = options.client ?? await pool.connect();
  const ownClient = !options.client;

  try {
    if (sourceId === targetId) {
      return {
        chains: [{
          score: 1.0,
          steps: [],
          length: 0,
          net_direction: 'neutral',
        }],
        best_score: 1.0,
        has_structural_evidence: true,
        threshold,
        duration_ms: Date.now() - t0,
      };
    }

    // Build relation-type filter for the SQL queries
    const allowedTypes = new Set([...SUPPORT_RELATIONS, ...CONTRADICT_RELATIONS]);
    if (includeSoftEdges) {
      for (const r of SOFT_RELATIONS) allowedTypes.add(r);
    }
    const allowedTypesArray = Array.from(allowedTypes);

    // Bidirectional BFS state:
    //   forward[node_id] = parent_edge_id (0 means seed/no parent)
    //   backward[node_id] = parent_edge_id
    const forward = new Map<number, { parentEdgeId: number; depth: number; fromNode: number }>();
    const backward = new Map<number, { parentEdgeId: number; depth: number; fromNode: number }>();
    forward.set(sourceId, { parentEdgeId: 0, depth: 0, fromNode: -1 });
    backward.set(targetId, { parentEdgeId: 0, depth: 0, fromNode: -1 });

    let forwardFrontier: number[] = [sourceId];
    let backwardFrontier: number[] = [targetId];
    const meetingPoints = new Set<number>();
    const halfHops = Math.ceil(maxHops / 2);

    // Edge cache so we can reconstruct the chain without re-querying
    const edgeCache = new Map<number, ChainStep>();

    for (let depth = 0; depth < halfHops; depth++) {
      // Forward expansion
      const fwdRows = await c.query<{
        edge_id: number;
        from_id: number;
        to_id: number;
        relation_type: string;
        strength: number;
        emotional_weight: number;
      }>(`
        SELECT id AS edge_id, from_content_id AS from_id, to_content_id AS to_id,
          relation_type, strength, emotional_weight
        FROM memory_edges
        WHERE from_content_id = ANY($1::int[])
          AND superseded_at IS NULL
          AND relation_type = ANY($2::text[])
        LIMIT 200
      `, [forwardFrontier, allowedTypesArray]);

      const newForward: number[] = [];
      for (const row of fwdRows.rows) {
        if (!forward.has(row.to_id)) {
          forward.set(row.to_id, {
            parentEdgeId: row.edge_id,
            depth: depth + 1,
            fromNode: row.from_id,
          });
          edgeCache.set(row.edge_id, row);
          newForward.push(row.to_id);
          if (backward.has(row.to_id)) meetingPoints.add(row.to_id);
        }
      }
      forwardFrontier = newForward;

      // Backward expansion
      const bwdRows = await c.query<{
        edge_id: number;
        from_id: number;
        to_id: number;
        relation_type: string;
        strength: number;
        emotional_weight: number;
      }>(`
        SELECT id AS edge_id, from_content_id AS from_id, to_content_id AS to_id,
          relation_type, strength, emotional_weight
        FROM memory_edges
        WHERE to_content_id = ANY($1::int[])
          AND superseded_at IS NULL
          AND relation_type = ANY($2::text[])
        LIMIT 200
      `, [backwardFrontier, allowedTypesArray]);

      const newBackward: number[] = [];
      for (const row of bwdRows.rows) {
        if (!backward.has(row.from_id)) {
          backward.set(row.from_id, {
            parentEdgeId: row.edge_id,
            depth: depth + 1,
            fromNode: row.to_id,
          });
          edgeCache.set(row.edge_id, row);
          newBackward.push(row.from_id);
          if (forward.has(row.from_id)) meetingPoints.add(row.from_id);
        }
      }
      backwardFrontier = newBackward;

      if (meetingPoints.size > 0 && depth > 0) break;
      if (forwardFrontier.length === 0 && backwardFrontier.length === 0) break;
    }

    // Reconstruct chains from meeting points
    const chains: ProvenanceChain[] = [];
    for (const meet of meetingPoints) {
      const fwdSteps: ChainStep[] = [];
      let cursor = meet;
      while (cursor !== sourceId) {
        const f = forward.get(cursor);
        if (!f || f.parentEdgeId === 0) break;
        const edge = edgeCache.get(f.parentEdgeId);
        if (edge) fwdSteps.unshift(edge);
        cursor = f.fromNode;
        if (fwdSteps.length > maxHops) break;
      }

      const bwdSteps: ChainStep[] = [];
      cursor = meet;
      while (cursor !== targetId) {
        const b = backward.get(cursor);
        if (!b || b.parentEdgeId === 0) break;
        const edge = edgeCache.get(b.parentEdgeId);
        if (edge) bwdSteps.push(edge);
        cursor = b.fromNode;
        if (bwdSteps.length > maxHops) break;
      }

      const fullSteps = [...fwdSteps, ...bwdSteps];
      if (fullSteps.length === 0) continue;
      if (fullSteps.length > maxHops) continue;

      const score = scoreChain(fullSteps);
      chains.push({
        score,
        steps: fullSteps,
        length: fullSteps.length,
        net_direction: chainDirection(fullSteps),
      });
    }

    // Top-K by score
    chains.sort((a, b) => b.score - a.score);
    const topChains = chains.slice(0, topK);
    const bestScore = topChains.length > 0 ? topChains[0].score : 0;

    return {
      chains: topChains,
      best_score: bestScore,
      has_structural_evidence: bestScore >= threshold,
      threshold,
      duration_ms: Date.now() - t0,
    };
  } finally {
    if (ownClient) c.release();
  }
}
