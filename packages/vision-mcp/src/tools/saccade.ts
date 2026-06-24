/**
 * Saccade Tools — done_claim recording and verification
 *
 * Per saccade organ (meta-observe proposal #6 + migration 038):
 * runtime-verification checkpoint between action execution and
 * done-claim emission. Tools here let hooks record done_claims via
 * direct MCP invocation (Claude Code 2.1.139 type='mcp_tool' pattern)
 * instead of shelling out to bash+psql.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── doneClaimRecord ───

async function doneClaimRecord(args: Record<string, unknown>): Promise<CallToolResult> {
  const claimText = args.claim_text as string;
  const sessionId = (args.session_id as string) || '';
  const claimPhrase = (args.claim_phrase as string) || claimText.slice(0, 40);
  const claimTarget = (args.claim_target as string) || null;

  if (!claimText) {
    return jsonResult({ error: 'claim_text is required' }, true);
  }

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number }>(
      `INSERT INTO done_claims
         (session_id, claim_text, claim_phrase, claim_target, verified)
       VALUES ($1, $2, $3, $4, false)
       RETURNING id`,
      [sessionId.slice(0, 64), claimText, claimPhrase.slice(0, 120), claimTarget],
    );
    return jsonResult({
      success: true,
      id: result.rows[0].id,
      claim_phrase: claimPhrase.slice(0, 120),
    });
  } catch (err) {
    return jsonResult({ error: (err as Error).message }, true);
  } finally {
    client.release();
  }
}

// ─── doneClaimsRecent ───

async function doneClaimsRecent(args: Record<string, unknown>): Promise<CallToolResult> {
  const minutes = (args.minutes as number) || 30;
  const limit = (args.limit as number) || 20;
  const onlyUnverified = args.only_unverified !== false;

  const client = await pool.connect();
  try {
    const sql = onlyUnverified
      ? `SELECT id, claim_phrase, verified, verification_method, claimed_at
         FROM done_claims
         WHERE NOT verified AND claimed_at > NOW() - ($1 || ' minutes')::interval
         ORDER BY claimed_at DESC LIMIT $2`
      : `SELECT id, claim_phrase, verified, verification_method, claimed_at
         FROM done_claims
         WHERE claimed_at > NOW() - ($1 || ' minutes')::interval
         ORDER BY claimed_at DESC LIMIT $2`;
    const result = await client.query(sql, [String(minutes), limit]);
    return jsonResult({ count: result.rows.length, claims: result.rows });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_done_claim_record',
      description:
        'Record a done-claim emitted in assistant text. Saccade ring 1. ' +
        'Hooks call this via type=mcp_tool instead of shelling out to psql ' +
        '(Claude Code 2.1.139 pattern). Verification linkage happens out-of-band ' +
        'via com.the agent.saccade-verify daemon.',
      inputSchema: {
        type: 'object',
        properties: {
          claim_text: { type: 'string', description: 'The full claim phrase from assistant text' },
          claim_phrase: { type: 'string', description: 'Optional shortened phrase (default: claim_text[:40])' },
          claim_target: { type: 'string', description: 'Optional named target (file path, commit sha, feature name)' },
          session_id: { type: 'string', description: 'Session id (text)' },
        },
        required: ['claim_text'],
      },
    },
    handler: (args) => doneClaimRecord(args),
  },
  {
    definition: {
      name: 'vision_done_claims_recent',
      description: 'List recent done_claims. Default: unverified from last 30min, limit 20.',
      inputSchema: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'Lookback window in minutes (default 30)' },
          limit: { type: 'number', description: 'Max claims returned (default 20)' },
          only_unverified: { type: 'boolean', description: 'Only return unverified (default true)' },
        },
      },
    },
    handler: (args) => doneClaimsRecent(args),
  },
];

export default tools;
