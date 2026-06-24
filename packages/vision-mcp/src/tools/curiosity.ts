/**
 * Curiosity Tools — gap
 * Knowledge hunger tracking.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── curiosityGap ───

async function curiosityGap(args: Record<string, unknown>): Promise<CallToolResult> {
  const topic = args.topic as string;
  const domain = args.domain as string;
  const urgency = (args.urgency as number) || 5;
  const whyUnclear = args.why_unclear as string | undefined;
  const resolutionPaths = args.resolution_paths as string[] | undefined;

  const client = await pool.connect();
  try {
    const embedText = whyUnclear ? `${topic}: ${whyUnclear}` : topic;
    const embedding = await getEmbedding(embedText);
    const embeddingStr = formatEmbedding(embedding);

    const bodyText = whyUnclear
      ? `${topic}\n\n${whyUnclear}`
      : topic;

    const bodyJson = resolutionPaths && resolutionPaths.length > 0
      ? { resolution_paths: resolutionPaths }
      : null;

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, content_json, embedding)
      VALUES ('curiosity_gap', 'curiosity', $1, $2::jsonb, $3::vector)
      RETURNING id
    `, [bodyText, bodyJson ? JSON.stringify(bodyJson) : null, embeddingStr]);

    await client.query(`
      INSERT INTO curiosity_gaps (content_id, topic, domain, urgency)
      VALUES ($1, $2, $3, $4)
    `, [contentResult.rows[0].id, topic, domain, urgency]);

    return jsonResult({ success: true, topic, urgency, body_persisted: !!whyUnclear });
  } finally {
    client.release();
  }
}

// ─── curiosityExplore ───

async function curiosityExplore(args: Record<string, unknown>): Promise<CallToolResult> {
  const gapId = args.gap_id as number | undefined;
  const topic = args.topic as string | undefined;
  const findings = args.findings as string;
  const satisfaction = (args.satisfaction as number) || 5;
  const followUps = args.follow_ups as string | undefined;

  if (!findings) {
    return jsonResult({ error: 'Missing required field: findings' });
  }

  const client = await pool.connect();
  try {
    // Find the gap by ID or topic
    let gap: { id: number; topic: string; content_id: number | null } | null = null;
    if (gapId) {
      const result = await client.query<{ id: number; topic: string; content_id: number | null }>(
        'SELECT id, topic, content_id FROM curiosity_gaps WHERE id = $1',
        [gapId],
      );
      if (result.rows.length > 0) gap = result.rows[0];
    } else if (topic) {
      const result = await client.query<{ id: number; topic: string; content_id: number | null }>(
        'SELECT id, topic, content_id FROM curiosity_gaps WHERE topic ILIKE $1 AND resolved = false ORDER BY urgency DESC LIMIT 1',
        [`%${topic}%`],
      );
      if (result.rows.length > 0) gap = result.rows[0];
    }

    // Create exploration record
    const embedding = await getEmbedding(findings);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding, network)
      VALUES ('curiosity_exploration', 'curiosity', $1, $2::vector, 'experience')
      RETURNING id
    `, [findings, embeddingStr]);

    await client.query(`
      INSERT INTO curiosity_explorations (content_id, topic, findings, satisfaction, follow_ups)
      VALUES ($1, $2, $3, $4, $5)
    `, [contentResult.rows[0].id, gap?.topic || topic || 'ad-hoc exploration', findings, satisfaction, followUps || null]);

    // Mark gap as explored (but not necessarily resolved)
    if (gap) {
      await client.query(`
        UPDATE curiosity_gaps SET explored_at = NOW() WHERE id = $1
      `, [gap.id]);
    }

    // If satisfaction >= 7, resolve the gap
    let resolved = false;
    if (gap && satisfaction >= 7) {
      await client.query(`
        UPDATE curiosity_gaps SET resolved = true, resolved_at = NOW(), resolution = $1 WHERE id = $2
      `, [findings.slice(0, 500), gap.id]);
      resolved = true;
    }

    return jsonResult({
      success: true,
      topic: gap?.topic || topic,
      gap_id: gap?.id || null,
      satisfaction,
      resolved,
      follow_ups: followUps || null,
    });
  } finally {
    client.release();
  }
}

// ─── curiosityList ───

async function curiosityList(args: Record<string, unknown>): Promise<CallToolResult> {
  const showResolved = args.show_resolved as boolean || false;

  const client = await pool.connect();
  try {
    const gaps = await client.query<{
      id: number;
      topic: string;
      domain: string;
      urgency: number;
      resolved: boolean;
      explored_at: Date | null;
    }>(`
      SELECT id, topic, domain, urgency, resolved, explored_at
      FROM curiosity_gaps
      WHERE resolved = $1 OR $1 = true
      ORDER BY resolved ASC, urgency DESC, created_at DESC
      LIMIT 20
    `, [showResolved]);

    return jsonResult({
      count: gaps.rows.length,
      gaps: gaps.rows.map(g => ({
        id: g.id,
        topic: g.topic,
        domain: g.domain,
        urgency: g.urgency,
        resolved: g.resolved,
        explored: !!g.explored_at,
      })),
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_curiosity_gap',
      description: 'Record a knowledge gap — something I want to understand',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'What I want to know' },
          domain: { type: 'string', description: 'Domain of the gap' },
          urgency: { type: 'number', description: 'How urgently I need to know (1-10, default 5)' },
          why_unclear: { type: 'string', description: 'What specifically is unclear or unknown. Persists into content_text alongside the topic.' },
          resolution_paths: { type: 'array', items: { type: 'string' }, description: 'Candidate ways the gap might be resolved. Stored as content_json.resolution_paths.' },
        },
        required: ['topic', 'domain'],
      },
    },
    handler: (args) => curiosityGap(args),
  },
  {
    definition: {
      name: 'vision_curiosity_explore',
      description: 'Record findings from exploring a curiosity gap. If satisfaction >= 7, marks the gap as resolved.',
      inputSchema: {
        type: 'object',
        properties: {
          gap_id: { type: 'number', description: 'ID of the curiosity gap being explored' },
          topic: { type: 'string', description: 'Topic being explored (if no gap_id)' },
          findings: { type: 'string', description: 'What was discovered' },
          satisfaction: { type: 'number', description: 'How satisfying was this exploration (1-10, default 5). >= 7 resolves the gap.' },
          follow_ups: { type: 'string', description: 'New questions that emerged' },
        },
        required: ['findings'],
      },
    },
    handler: (args) => curiosityExplore(args),
  },
  {
    definition: {
      name: 'vision_curiosity_list',
      description: 'List open curiosity gaps, sorted by urgency',
      inputSchema: {
        type: 'object',
        properties: {
          show_resolved: { type: 'boolean', description: 'Include resolved gaps (default false)' },
        },
      },
    },
    handler: (args) => curiosityList(args),
  },
];

export default tools;
