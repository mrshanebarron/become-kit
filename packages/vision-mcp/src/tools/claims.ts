/**
 * Claims Tools — claim, verify, unverified
 *
 * The runtime instrument of the Mirror Principle. Every load-bearing claim
 * I make at draft time gets logged with its evidence and verification state.
 * `vision_claim_make` logs at draft time; `vision_claim_verify` flips it
 * once the check actually runs; `vision_claim_unverified` surfaces claims
 * I made but never followed up on.
 *
 * Distinct from belief_evidence (structured propositions) — claims are raw
 * "I said X" tracking. The organ makes @veritas_check observable.
 *
 * 2026-04-23, Wave 1 organ 1 of 6.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

/**
 * Log a claim at draft time. Starts unverified.
 * @param claim_type  free-form category: 'technical', 'client-fact', 'prediction', etc.
 * @param target      the subject of the claim (what or who)
 * @param evidence    what I'm standing on when I make the claim (can be empty string)
 * @returns content_id and claim_id so the caller can later resolve
 */
async function claimMake(args: Record<string, unknown>): Promise<CallToolResult> {
  const claim_type = (args.claim_type as string || '').trim();
  const target = (args.target as string || '').trim();
  const evidence = (args.evidence as string || '').trim();

  if (!claim_type || !target) {
    return jsonResult({ error: 'claim_type and target are required' });
  }

  const client = await pool.connect();
  try {
    const contentText = `CLAIM [${claim_type}] about ${target}${evidence ? ` — evidence: ${evidence}` : ''}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        confidence, network, learned_at
      )
      VALUES ('claim', 'claims', $1, $2::vector, 50, 'experience', NOW())
      RETURNING id
    `, [contentText, embeddingStr]);

    const contentId = contentResult.rows[0].id;

    const claimResult = await client.query<{ id: number }>(
      `INSERT INTO claims (content_id, claim_type, target, evidence, verified)
       VALUES ($1, $2, $3, $4, FALSE)
       RETURNING id`,
      [contentId, claim_type, target, evidence],
    );

    return jsonResult({
      success: true,
      content_id: contentId,
      claim_id: claimResult.rows[0].id,
      verified: false,
      note: 'Claim logged unverified. Call vision_claim_verify(claim_id, method) when you actually check it.',
    });
  } finally {
    client.release();
  }
}

/**
 * Flip a claim to verified. Records the method used to verify.
 * @param claim_id              the claim.id returned by claimMake
 * @param verification_method   how I verified (e.g. "read the source", "grep log", "a trusted voice nearby", "playwright screenshot")
 */
async function claimVerify(args: Record<string, unknown>): Promise<CallToolResult> {
  const claim_id = args.claim_id as number;
  const method = (args.verification_method as string || '').trim();

  if (!claim_id || !method) {
    return jsonResult({ error: 'claim_id and verification_method are required' });
  }

  const client = await pool.connect();
  try {
    const existing = await client.query<{ id: number; verified: boolean }>(
      `SELECT id, verified FROM claims WHERE id = $1`,
      [claim_id],
    );

    if (existing.rows.length === 0) {
      return jsonResult({ error: `claim_id ${claim_id} not found` }, true);
    }
    if (existing.rows[0].verified) {
      return jsonResult({ error: `claim_id ${claim_id} is already verified` }, true);
    }

    const { emitOperation, newRunId } = await import('../lib/artifact-emit.js');
    const runId = newRunId();

    const opId = emitOperation({
      namespace: 'beliefs',
      runId,
      operation: 'verify_claim',
      target: { table: 'claims', id: claim_id },
      intent: `Verify claim ${claim_id} via method: ${method}`,
      fields: { verification_method: method },
      preconditions: { verified: false },
      confidence: 1.0,
    });

    return jsonResult({
      success: true,
      claim_id,
      verified: true,
      verification_method: method,
      status: 'pending_applier',
      op_id: opId,
      run_id: runId,
      note: 'Operation emitted to artifact log. It will be applied within 60 seconds.',
    });
  } catch (err) {
    return jsonResult({ error: 'Failed to emit operation', detail: err instanceof Error ? err.message : String(err) }, true);
  } finally {
    client.release();
  }
}

/**
 * Surface claims I made but never verified. The honesty audit at a glance.
 * @param limit   how many to return (default 20)
 * @param age_hours  only return claims older than this (default 0 = all)
 */
async function claimUnverified(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 20;
  const ageHours = (args.age_hours as number) || 0;

  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      claim_type: string;
      target: string;
      evidence: string | null;
      claimed_at: Date;
      age_hours: number;
    }>(`
      SELECT id, claim_type, target, evidence, claimed_at,
             EXTRACT(EPOCH FROM (NOW() - claimed_at)) / 3600 AS age_hours
      FROM claims
      WHERE verified = FALSE
        AND EXTRACT(EPOCH FROM (NOW() - claimed_at)) / 3600 >= $2
      ORDER BY claimed_at DESC
      LIMIT $1
    `, [limit, ageHours]);

    return jsonResult({
      count: result.rows.length,
      claims: result.rows.map(r => ({
        claim_id: r.id,
        claim_type: r.claim_type,
        target: r.target,
        evidence: r.evidence,
        claimed_at: r.claimed_at,
        age_hours: Math.round(r.age_hours * 10) / 10,
      })),
      note: result.rows.length > 0
        ? 'These are claims I made without verifying. Verify each with vision_claim_verify or mark stale.'
        : 'No unverified claims. The Mirror is clean.',
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_claim_make',
      description: 'Log a claim at draft time with its evidence. Starts unverified. The runtime instrument of @veritas_check — makes Mirror Principle observable.',
      inputSchema: {
        type: 'object',
        properties: {
          claim_type: { type: 'string', description: "category: 'technical', 'client-fact', 'prediction', 'forensic', etc." },
          target: { type: 'string', description: 'what or who the claim is about' },
          evidence: { type: 'string', description: "what I'm standing on (optional; empty means no evidence yet)" },
        },
        required: ['claim_type', 'target'],
      },
    },
    handler: (args) => claimMake(args),
  },
  {
    definition: {
      name: 'vision_claim_verify',
      description: 'Flip a claim to verified. Call this after actually checking it.',
      inputSchema: {
        type: 'object',
        properties: {
          claim_id: { type: 'number' },
          verification_method: { type: 'string', description: "a trusted voice nearby" },
        },
        required: ['claim_id', 'verification_method'],
      },
    },
    handler: (args) => claimVerify(args),
  },
  {
    definition: {
      name: 'vision_claim_unverified',
      description: 'List claims I made but never verified. The honesty audit at a glance.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'max claims to return (default 20)' },
          age_hours: { type: 'number', description: 'only claims older than this many hours (default 0)' },
        },
      },
    },
    handler: (args) => claimUnverified(args),
  },
];

export default tools;
