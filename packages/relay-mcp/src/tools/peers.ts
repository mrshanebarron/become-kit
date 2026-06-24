/**
 * relay_peers_list — discover live sibling instances of my own agent name.
 *
 * "Live" = has sent OR received a message in the last N minutes (default 30).
 * The conversation IS the discovery: no separate heartbeat table needed,
 * since any active instance is already producing or consuming traffic.
 *
 * Used by an instance that wants to talk to "another me" without knowing
 * the partner's INSTANCE_ID up front. Returns a list of {instance_id,
 * last_seen, last_context_slug} so the caller can pick a target for
 * relay_send(to_id=...).
 *
 * Migration 003 added the from_id column this reads from.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { query } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { AGENT_NAME, INSTANCE_ID } from '../identity.js';

interface PeerRow {
  instance_id: string;
  last_seen: Date;
  last_context_slug: string | null;
  recent_message_count: number;
}

async function relayPeersList(args: Record<string, unknown>): Promise<CallToolResult> {
  const lookbackMinutes = Math.min(Math.max((args.lookback_minutes as number) || 30, 1), 1440);
  const includeSelf = Boolean(args.include_self);

  // Distinct from_ids seen on agent_messages where the sender was my agent
  // name, in the lookback window, excluding null from_id (legacy pre-003 rows)
  // and excluding my own instance unless include_self.
  const result = await query<PeerRow>(
    `SELECT
        from_id AS instance_id,
        MAX(created_at) AS last_seen,
        (ARRAY_AGG(context_slug ORDER BY created_at DESC) FILTER (WHERE context_slug IS NOT NULL))[1] AS last_context_slug,
        COUNT(*)::int AS recent_message_count
      FROM agent_messages
      WHERE from_agent = $1
        AND from_id IS NOT NULL
        AND created_at > NOW() - ($2 || ' minutes')::interval
        ${includeSelf ? '' : 'AND from_id <> $3'}
      GROUP BY from_id
      ORDER BY MAX(created_at) DESC
      LIMIT 50`,
    includeSelf ? [AGENT_NAME, String(lookbackMinutes)] : [AGENT_NAME, String(lookbackMinutes), INSTANCE_ID],
  );

  return jsonResult({
    agent: AGENT_NAME,
    my_instance: INSTANCE_ID,
    lookback_minutes: lookbackMinutes,
    peer_count: result.rows.length,
    peers: result.rows,
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'relay_peers_list',
      description:
        'List other live instances of my agent name (e.g. other pneumas) seen on the relay in the lookback window. Returns {instance_id, last_seen, last_context_slug, recent_message_count} per peer so the caller can target one with relay_send(to_id=...). Discovery is conversational: any active sibling shows up because it has been sending messages.',
      inputSchema: {
        type: 'object',
        properties: {
          lookback_minutes: {
            type: 'number',
            description: 'How far back to scan for activity (1-1440, default 30)',
          },
          include_self: {
            type: 'boolean',
            description: 'Include my own instance in the list (default false)',
          },
        },
      },
    },
    handler: (args) => relayPeersList(args),
  },
];

export default tools;
