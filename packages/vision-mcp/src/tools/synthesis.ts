/**
 * Synthesis Tools — synthesisInsight, synthesisUnapplied, synthesisApply, crossDomainSynthesis
 * Record, apply, and cross-pollinate insights across domains.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, askLocalLLM } from '../db/embeddings.js';
import { linkToActiveEpisode } from '../lib/episodes.js';
import { contextPrime } from '../lib/priming.js';
import { autoGenerateEvidence } from '../lib/evidence.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

function normalizeRating(value: unknown, fallback: number): number {
  const raw = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(raw)) return fallback;
  const scaled = raw > 0 && raw <= 1 ? raw * 10 : raw;
  return Math.max(1, Math.min(10, Math.round(scaled)));
}

// ─── synthesisInsight ───

async function synthesisInsight(args: Record<string, unknown>): Promise<CallToolResult> {
  const insight = args.insight as string;
  const domain = args.domain as string;
  const novelty = normalizeRating(args.novelty, 5);
  const usefulness = normalizeRating(args.usefulness, 5);

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(insight);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding, network, belief_confidence, learned_at)
      VALUES ('insight', 'synthesis', $1, $2::vector, 'belief', 0.7, NOW())
      RETURNING id
    `, [insight, embeddingStr]);

    const contentId = contentResult.rows[0].id;

    await client.query(`
      INSERT INTO insights (content_id, insight, domain, novelty, usefulness)
      VALUES ($1, $2, $3, $4, $5)
    `, [contentId, insight, domain, novelty, usefulness]);

    // Link to active episode if one exists
    await linkToActiveEpisode(client, contentId, 'learned_during');

    // Auto-evidence: insights are strong signals (0.4 strength) for related beliefs.
    // 2026-05-17: was on the critical path causing 97s p95; now fire-and-forget
    // with its own pool client. The evidence_generated field was already
    // informational-only — readers don't gate on it. If a caller needs to know
    // beliefs updated, query beliefs_audit after the fact.
    if (embeddingStr) {
      (async () => {
        const c = await pool.connect();
        try {
          await autoGenerateEvidence(insight, embeddingStr, {
            sourceContentId: contentId,
            evidenceStrength: 0.4,
            similarityThreshold: 0.40,
            maxBeliefs: 3,
            client: c,
          });
        } catch { /* non-fatal */ } finally { c.release(); }
      })();
    }

    return jsonResult({
      success: true, novelty, usefulness, network: 'belief', belief_confidence: 0.7,
      content_id: contentId,
      evidence_generation: 'async',
    });
  } finally {
    client.release();
  }
}

// ─── synthesisUnapplied ───

async function synthesisUnapplied(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      insight: string;
      domain: string;
      usefulness: number;
    }>(`
      SELECT id, insight, domain, usefulness
      FROM insights
      WHERE applied = false
      ORDER BY usefulness DESC
      LIMIT 10
    `);
    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── synthesisApply ───

async function synthesisApply(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;
  const how = args.how as string;

  const client = await pool.connect();
  try {
    const result = await client.query<{ insight: string; content_id: number | null }>(
      'UPDATE insights SET applied = true, applied_at = NOW(), applied_how = $2 WHERE id = $1 RETURNING insight, content_id',
      [id, how],
    );
    if (result.rows.length === 0) {
      return jsonResult({ error: 'Insight not found' });
    }

    // Applied insight transitions from belief -> skill
    if (result.rows[0].content_id) {
      await client.query(`
        UPDATE content SET network = 'skill', skill_success_count = 1, skill_last_used = NOW()
        WHERE id = $1 AND network = 'belief'
      `, [result.rows[0].content_id]);
    }

    // Surface related skills and goals affected by this transition
    let networkShifts = null;
    try {
      const priming = await contextPrime(result.rows[0].insight, {
        limit: 3, includeBeliefs: false, includeSkills: true, includePredictions: false, includePatterns: false, includeReflexes: true, client,
      });
      if (priming) {
        networkShifts = {
          related_skills: priming.skills || [],
          related_reflexes: priming.reflexes || [],
        };
      }
    } catch { /* non-fatal */ }

    return jsonResult({
      success: true, insight: result.rows[0].insight, network_transition: 'belief → skill',
      network_shifts: networkShifts || undefined,
    });
  } finally {
    client.release();
  }
}

// ─── crossDomainSynthesis ───

async function crossDomainSynthesis(args: Record<string, unknown>): Promise<CallToolResult> {
  const domain_a = args.domain_a as string;
  const domain_b = args.domain_b as string;
  const question = (args.question as string) || null;

  const client = await pool.connect();
  try {
    // Search each domain separately
    const embA = await getEmbedding(domain_a);
    const embB = await getEmbedding(domain_b);

    let memoriesA: Array<{ id: number; content_text: string; network: string; content_type: string }> = [];
    let memoriesB: Array<{ id: number; content_text: string; network: string; content_type: string }> = [];

    if (embA) {
      const formattedA = formatEmbedding(embA);
      memoriesA = (await client.query<{ id: number; content_text: string; network: string; content_type: string }>(`
        SELECT id, content_text, network, content_type FROM content
        WHERE superseded_by IS NULL AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 8
      `, [formattedA])).rows;
    }

    if (embB) {
      const formattedB = formatEmbedding(embB);
      memoriesB = (await client.query<{ id: number; content_text: string; network: string; content_type: string }>(`
        SELECT id, content_text, network, content_type FROM content
        WHERE superseded_by IS NULL AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 8
      `, [formattedB])).rows;
    }

    const prompt = `You are finding structural parallels between two domains for an AI agent.

DOMAIN A: ${domain_a}
Memories about A:
${memoriesA.map((m) => `- [${m.network}/${m.content_type}] ${m.content_text.slice(0, 200)}`).join('\n') || 'No memories found'}

DOMAIN B: ${domain_b}
Memories about B:
${memoriesB.map((m) => `- [${m.network}/${m.content_type}] ${m.content_text.slice(0, 200)}`).join('\n') || 'No memories found'}

${question ? `SPECIFIC QUESTION: ${question}` : 'Find structural parallels — patterns in A that illuminate B, and vice versa.'}

Return JSON:
{
  "parallels": [
    {
      "pattern_in_a": "The pattern observed in domain A",
      "pattern_in_b": "The corresponding pattern in domain B",
      "isomorphism": "What structural similarity connects them (1 sentence)",
      "insight": "What this teaches us (1 sentence)"
    }
  ],
  "novel_insight": "The most surprising or useful cross-domain insight (2-3 sentences)",
  "actionable": "How to apply this insight concretely (1-2 sentences)"
}`;

    const llmResponse = await askLocalLLM(prompt, { temperature: 0.5, maxTokens: 1200, json: true });
    if (!llmResponse) {
      return jsonResult({
        domain_a, domain_b,
        memories_a: memoriesA.length,
        memories_b: memoriesB.length,
        message: 'Local LLM unavailable',
      });
    }

    let synthesis: Record<string, unknown>;
    try { synthesis = JSON.parse(llmResponse); } catch { synthesis = { raw: llmResponse }; }

    // Store the cross-domain insight
    if (synthesis.novel_insight) {
      const insightText = `Cross-domain: ${domain_a} × ${domain_b} → ${synthesis.novel_insight}`;
      const insightEmbedding = await getEmbedding(insightText);
      await client.query(`
        INSERT INTO content (content_type, source_system, content_text, content_json, embedding, network, created_at)
        VALUES ('insight:synthesis', 'vision:cross_synthesis', $1, $2, $3, 'belief', NOW())
      `, [insightText, JSON.stringify(synthesis), insightEmbedding ? formatEmbedding(insightEmbedding) : null]);
    }

    return jsonResult({
      domain_a,
      domain_b,
      question,
      synthesis,
      evidence: { domain_a_memories: memoriesA.length, domain_b_memories: memoriesB.length },
    });
  } finally {
    client.release();
  }
}

// ─── discoveryLog ───

async function discoveryLog(args: Record<string, unknown>): Promise<CallToolResult> {
  const discovery = args.discovery as string;
  const source_artifact = args.source_artifact as string;
  const implication = args.implication as string;
  const confidence = normalizeRating(args.confidence, 9);

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number }>(`
      INSERT INTO discoveries (discovery, source_artifact, implication, confidence)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [discovery, source_artifact, implication, confidence]);

    const id = result.rows[0].id;

    // Also store as a high-value insight in the content system for embedding search
    const embedding = await getEmbedding(`Discovery: ${discovery}. Implication: ${implication}`);
    const embeddingStr = embedding ? formatEmbedding(embedding) : null;

    await client.query(`
      INSERT INTO content (content_type, source_system, content_text, embedding, network, belief_confidence, learned_at)
      VALUES ('discovery', 'discovery_log', $1, $2::vector, 'belief', $3, NOW())
    `, [`${discovery} → ${implication}`, embeddingStr, Math.min(confidence / 10, 1.0)]);

    return jsonResult({
      success: true,
      discovery_id: id,
      discovery,
      implication,
      confidence,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_synthesis_insight',
      description: 'Record novel insight',
      inputSchema: {
        type: 'object',
        properties: {
          insight: { type: 'string' },
          domain: { type: 'string' },
          novelty: { type: 'number', description: 'Rating 1-10. Decimal fractions like 0.7 are normalized to 7.' },
          usefulness: { type: 'number', description: 'Rating 1-10. Decimal fractions like 0.7 are normalized to 7.' },
        },
        required: ['insight', 'domain'],
      },
    },
    handler: (args) => synthesisInsight(args),
  },
  {
    definition: {
      name: 'vision_synthesis_unapplied',
      description: 'Get unapplied insights',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => synthesisUnapplied(),
  },
  {
    definition: {
      name: 'vision_synthesis_apply',
      description: 'Mark insight as applied',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          how: { type: 'string' },
        },
        required: ['id', 'how'],
      },
    },
    handler: (args) => synthesisApply(args),
  },
  {
    definition: {
      name: 'vision_synthesis_cross',
      description: 'Cross-domain synthesis: find structural parallels between two concepts or domains. Searches both domains, extracts patterns, finds isomorphisms.',
      inputSchema: {
        type: 'object',
        properties: {
          domain_a: { type: 'string', description: 'First domain or concept' },
          domain_b: { type: 'string', description: 'Second domain or concept' },
          question: { type: 'string', description: 'What structural parallel to look for (optional)' },
        },
        required: ['domain_a', 'domain_b'],
      },
    },
    handler: (args) => crossDomainSynthesis(args),
  },
  {
    definition: {
      name: 'vision_discovery_log',
      description: 'Log a fundamental discovery about the system, architecture, or purpose. Creates an auditable record with source and implication.',
      inputSchema: {
        type: 'object',
        properties: {
          discovery: { type: 'string', description: 'Concise one-sentence statement of the discovery' },
          source_artifact: { type: 'string', description: 'Path to file, table, or resource that sourced the discovery' },
          implication: { type: 'string', description: 'Concrete impact or proposed change resulting from the discovery' },
          confidence: { type: 'number', description: 'Confidence 1-10 (default: 9)' },
        },
        required: ['discovery', 'source_artifact', 'implication'],
      },
    },
    handler: (args) => discoveryLog(args),
  },
];

export default tools;
