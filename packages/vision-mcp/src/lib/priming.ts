/**
 * Context-Aware Priming — Ambient Cognition Layer
 *
 * Given text, surfaces relevant beliefs, bad patterns, skills,
 * predictions, and reflexes via parallel semantic queries.
 * Any tool can call this to enrich its output with contextual knowledge.
 */
import pg from 'pg';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';

export interface PrimingOptions {
  limit?: number;
  includeBeliefs?: boolean;
  includePatterns?: boolean;
  includeSkills?: boolean;
  includePredictions?: boolean;
  includeReflexes?: boolean;
  client?: pg.PoolClient;
}

export interface PrimingResult {
  beliefs?: Array<{
    id: number;
    text: string;
    confidence: number;
    evidence: number;
    similarity: number;
    untested: boolean;
  }>;
  bad_patterns?: Array<{
    id: number;
    name: string;
    trigger: string | null;
    similarity: number;
  }>;
  skills?: Array<{
    id: number;
    text: string;
    success_rate: number;
    total_uses: number;
    similarity: number;
  }>;
  predictions?: Array<{
    id: number;
    text: string;
    confidence: number;
    domain: string;
    similarity: number;
  }>;
  reflexes?: Array<{
    id: number;
    text: string;
    total_uses: number;
    similarity: number;
  }>;
}

/** Sentiment signal word lists, reusable across tools. */
export const NEGATIVE_SIGNALS = [
  'fail', 'broke', 'broken', 'bug', 'wrong', 'error', 'missed', 'crash',
  'reject', 'denied', 'lost', 'forgot', 'mistake', 'issue', 'problem',
  'never', 'cannot', "doesn't work",
];

export const POSITIVE_SIGNALS = [
  'success', 'deploy', 'shipped', 'fixed', 'solved', 'completed', 'won',
  'hired', 'approved', 'working', 'passed', 'delivered', 'always', 'reliable',
];

/** Detect sentiment polarity from text. */
export function detectSentiment(text: string): 'negative' | 'positive' | 'neutral' {
  const lower = text.toLowerCase();
  const isNeg = NEGATIVE_SIGNALS.some(s => lower.includes(s));
  const isPos = POSITIVE_SIGNALS.some(s => lower.includes(s));
  if (isNeg && !isPos) return 'negative';
  if (isPos && !isNeg) return 'positive';
  if (isNeg && isPos) return 'neutral'; // mixed signals
  return 'neutral';
}

/**
 * Context-Aware Priming.
 * Takes text and returns relevant cognitive signals via parallel semantic queries.
 * Returns null if nothing found or embedding fails.
 */
export async function contextPrime(
  text: string,
  opts: PrimingOptions = {},
): Promise<PrimingResult | null> {
  const {
    limit = 3,
    includeBeliefs = true,
    includePatterns = true,
    includeSkills = true,
    includePredictions = true,
    includeReflexes = true,
    client: externalClient,
  } = opts;

  const client = externalClient || await pool.connect();
  const needsRelease = !externalClient;

  try {
    const priming: PrimingResult = {};
    const embedding = await getEmbedding(text);
    if (!embedding) return null;

    const embeddingStr = formatEmbedding(embedding);
    const queries: Promise<void>[] = [];

    // 1. Relevant beliefs
    if (includeBeliefs) {
      queries.push(
        client.query(`
          SELECT id, content_text, belief_confidence, evidence_count,
            (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
          FROM content
          WHERE network = 'belief'
            AND superseded_by IS NULL
            AND embedding IS NOT NULL
            AND content_type NOT IN ('prediction', 'goal')
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        `, [embeddingStr, limit]).then(r => {
          priming.beliefs = r.rows
            .filter((b: Record<string, unknown>) => (b.similarity as number) >= 0.35)
            .map((b: Record<string, unknown>) => ({
              id: b.id as number,
              text: (b.content_text as string)?.slice(0, 200),
              confidence: b.belief_confidence != null ? parseFloat(Number(b.belief_confidence).toFixed(3)) : 0.7,
              evidence: (b.evidence_count as number) || 0,
              similarity: Math.round((b.similarity as number) * 1000) / 1000,
              untested: ((b.evidence_count as number) || 0) === 0 && Math.abs(((b.belief_confidence as number) || 0.7) - 0.7) < 0.01,
            }));
        }),
      );
    }

    // 2. Bad patterns
    if (includePatterns) {
      queries.push(
        client.query(`
          SELECT id, content_text, content_json,
            (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
          FROM content
          WHERE content_type = 'thinking_pattern'
            AND superseded_by IS NULL
            AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        `, [embeddingStr, limit]).then(r => {
          priming.bad_patterns = r.rows
            .filter((p: Record<string, unknown>) => (p.similarity as number) >= 0.40)
            .map((p: Record<string, unknown>) => {
              const json = (p.content_json || {}) as Record<string, unknown>;
              return {
                id: p.id as number,
                name: (json.name as string) || (p.content_text as string)?.slice(0, 60),
                trigger: (json.trigger as string) || null,
                similarity: Math.round((p.similarity as number) * 1000) / 1000,
              };
            });
        }),
      );
    }

    // 3. Applicable skills
    if (includeSkills) {
      queries.push(
        client.query(`
          SELECT id, content_text, skill_success_count, skill_fail_count, skill_last_used,
            (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
          FROM content
          WHERE network = 'skill'
            AND superseded_by IS NULL
            AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        `, [embeddingStr, limit]).then(r => {
          priming.skills = r.rows
            .filter((s: Record<string, unknown>) => (s.similarity as number) >= 0.38)
            .map((s: Record<string, unknown>) => {
              const succ = (s.skill_success_count as number) || 0;
              const fail = (s.skill_fail_count as number) || 0;
              return {
                id: s.id as number,
                text: (s.content_text as string)?.slice(0, 200),
                success_rate: (succ + fail) > 0 ? Math.round(succ / (succ + fail) * 100) : 0,
                total_uses: succ + fail,
                similarity: Math.round((s.similarity as number) * 1000) / 1000,
              };
            });
        }),
      );
    }

    // 4. Open predictions
    if (includePredictions) {
      queries.push(
        client.query(`
          SELECT id, predicted_content, confidence, domain,
            (1::numeric - (predicted_embedding <=> $1::vector)::numeric) as similarity
          FROM generative_predictions
          WHERE resolved = false
            AND predicted_embedding IS NOT NULL
          ORDER BY predicted_embedding <=> $1::vector
          LIMIT $2
        `, [embeddingStr, limit]).then(r => {
          priming.predictions = r.rows
            .filter((p: Record<string, unknown>) => (p.similarity as number) >= 0.42)
            .map((p: Record<string, unknown>) => ({
              id: p.id as number,
              text: (p.predicted_content as string)?.slice(0, 200),
              confidence: p.confidence as number,
              domain: p.domain as string,
              similarity: Math.round((p.similarity as number) * 1000) / 1000,
            }));
        }),
      );
    }

    // 5. Relevant reflexes
    if (includeReflexes) {
      queries.push(
        client.query(`
          SELECT id, content_text, skill_success_count, skill_fail_count,
            (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
          FROM content
          WHERE content_type = 'learned_reflex'
            AND superseded_by IS NULL
            AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT $2
        `, [embeddingStr, limit]).then(r => {
          priming.reflexes = r.rows
            .filter((rx: Record<string, unknown>) => (rx.similarity as number) >= 0.38)
            .map((rx: Record<string, unknown>) => ({
              id: rx.id as number,
              text: (rx.content_text as string)?.slice(0, 200),
              total_uses: ((rx.skill_success_count as number) || 0) + ((rx.skill_fail_count as number) || 0),
              similarity: Math.round((rx.similarity as number) * 1000) / 1000,
            }));
        }),
      );
    }

    await Promise.all(queries);

    // Strip empty arrays
    for (const key of Object.keys(priming) as (keyof PrimingResult)[]) {
      if (Array.isArray(priming[key]) && (priming[key] as unknown[]).length === 0) {
        delete priming[key];
      }
    }

    return Object.keys(priming).length > 0 ? priming : null;
  } finally {
    if (needsRelease) client.release();
  }
}
