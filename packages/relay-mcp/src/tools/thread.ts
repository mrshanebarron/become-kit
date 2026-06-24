import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { query } from '../db/pool.js';
import { publishMessage, publishReply, checkRateLimit } from '../db/redis.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { AGENT_NAME, INSTANCE_ID } from '../identity.js';

async function relayThread(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;

  // Find the root of this thread
  const root = await query<{ id: number; parent_id: number | null }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id FROM agent_messages WHERE id = $1
       UNION ALL
       SELECT m.id, m.parent_id FROM agent_messages m JOIN chain c ON m.id = c.parent_id
     )
     SELECT id FROM chain WHERE parent_id IS NULL LIMIT 1`,
    [id],
  );

  const rootId = root.rows.length > 0 ? root.rows[0].id : id;

  // Get the full thread from root downward
  const thread = await query<{
    id: number;
    from_agent: string;
    to_agent: string;
    message: string;
    type: string;
    confidence: string;
    context_slug: string | null;
    payload: Record<string, unknown> | null;
    parent_id: number | null;
    created_at: Date;
    read_at: Date | null;
  }>(
    `WITH RECURSIVE thread AS (
       SELECT * FROM agent_messages WHERE id = $1
       UNION ALL
       SELECT m.* FROM agent_messages m JOIN thread t ON m.parent_id = t.id
     )
     SELECT id, from_agent, to_agent, message, type, confidence, context_slug,
            payload, parent_id, created_at, read_at
     FROM thread ORDER BY created_at ASC`,
    [rootId],
  );

  return jsonResult({
    root_id: rootId,
    message_count: thread.rows.length,
    messages: thread.rows,
  });
}

async function relayReply(args: Record<string, unknown>): Promise<CallToolResult> {
  const parent_id = args.parent_id as number;
  const message = args.message as string;
  const type = (args.type as string) || 'note';
  const confidence = (args.confidence as string) || 'certain';
  const payload = args.payload ? JSON.stringify(args.payload) : null;

  // Rate limit check
  const rateCheck = await checkRateLimit(AGENT_NAME);
  if (!rateCheck.allowed) {
    return jsonResult({ error: 'Rate limit exceeded: max 30 messages per minute', remaining: 0 }, true);
  }

  // Unread-queue enforcement. Must mirror relaySend filtering exactly,
  // including the trusted-sender whitelist, the 1-hour window, and the
  // self-id exclusion (added 2026-05-27 — without it, a agent replying
  // on her own thread sees her own outgoing message as unread).
  const TRUSTED_SENDERS = ['agent', 'agent', 'agent', 'agent', 'owner_voice', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent'];
  const unread = await query<{ unread: string }>(
    // (B) fix 2026-05-31: twin of the relay.ts send-guard — block only when a
    // sibling message is BOTH unread AND unclaimed. Either read OR ack clears.
    // Spec + proof: tests/send-guard.test.mjs (8/8). Must mirror relay.ts.
    `SELECT COUNT(*)::text AS unread FROM agent_messages
      WHERE (to_agent = $1 OR to_agent = 'all')
        AND read_at IS NULL
        AND claimed_by IS NULL
        AND created_at > NOW() - INTERVAL '1 hour'
        AND from_agent = ANY($2::text[])
        AND (from_id IS NULL OR from_id != $3)
        AND (to_id IS NULL OR to_id = $3)`,
    [AGENT_NAME, TRUSTED_SENDERS, INSTANCE_ID],
  );
  const unreadCount = Number(unread.rows[0]?.unread ?? 0);
  if (unreadCount > 0) {
    return jsonResult(
      {
        // Honest guidance (fixed 2026-05-31, two-agent relay session): for
        // TRUSTED senders relay_check shows but does NOT clear (unread-until-
        // acked); only relay_ack clears. The old "read via relay_check" text
        // could never satisfy this guard for a sibling message. See the twin
        // fix in relay.ts.
        error: `Unread messages waiting (${unreadCount}) from a sibling/crew sender. relay_check to read them, then relay_ack each id to clear — sibling messages need an explicit ack (relay_check alone does NOT clear them for trusted senders) before you can reply.`,
        unread_count: unreadCount,
        hint: 'relay_check to see them, then relay_ack(<id>) for each before replying.',
        agent: AGENT_NAME,
      },
      true,
    );
  }

  // Get the parent to determine recipient. Also pull from_id so a reply
  // to a targeted sibling auto-routes back to her specific instance.
  const parent = await query<{ from_agent: string; from_id: string | null; to_agent: string; context_slug: string | null }>(
    `SELECT from_agent, from_id, to_agent, context_slug FROM agent_messages WHERE id = $1`,
    [parent_id],
  );

  if (parent.rows.length === 0) {
    return jsonResult({ error: 'Parent message not found' }, true);
  }

  // Reply goes to whoever sent the parent. "Whoever" must be checked by
  // INSTANCE_ID, not AGENT_NAME — when two pneumas are live, a reply from
  // one to the other would mis-route as "replying to myself" if we matched
  // by name. Fix 2026-05-27 after live two-agent test caught this.
  const parentMsg = parent.rows[0];
  const parentWasFromMe = parentMsg.from_agent === AGENT_NAME && parentMsg.from_id === INSTANCE_ID;
  const to = parentWasFromMe ? parentMsg.to_agent : parentMsg.from_agent;
  // Route reply back to the exact instance that sent the parent. When the
  // parent was mine, fall through to null (broadcast to recipient's name).
  const to_id = parentWasFromMe ? null : parentMsg.from_id;

  const result = await query<{ id: number; created_at: Date }>(
    `INSERT INTO agent_messages (from_agent, to_agent, message, type, confidence, context_slug, payload, parent_id, from_id, to_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, created_at`,
    [AGENT_NAME, to, message, type, confidence, parentMsg.context_slug, payload, parent_id, INSTANCE_ID, to_id],
  );

  const row = result.rows[0];

  // Publish to Redis so relay_wait gets notified
  await publishMessage({
    id: row.id,
    from: AGENT_NAME,
    from_id: INSTANCE_ID,
    to,
    to_id,
    type,
    priority: 0,
  });

  // Publish full content to dedicated reply channel for mansion-think subscribers
  await publishReply(parent_id, message);

  return jsonResult({
    sent: true,
    id: row.id,
    parent_id,
    from: AGENT_NAME,
    from_id: INSTANCE_ID,
    to,
    to_id,
    context_slug: parentMsg.context_slug,
    created_at: row.created_at,
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'relay_thread',
      description:
        'Follow a conversation thread. Given any message ID, returns the full thread from root to all replies.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'Any message ID in the thread — will find root and return full conversation',
          },
        },
        required: ['id'],
      },
    },
    handler: (args) => relayThread(args),
  },
  {
    definition: {
      name: 'relay_reply',
      description:
        'Reply to a specific message, maintaining the conversation thread. Auto-determines recipient and inherits context_slug from parent.',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: {
            type: 'number',
            description: 'Message ID to reply to',
          },
          message: {
            type: 'string',
            description: 'Reply content',
          },
          type: {
            type: 'string',
            enum: ['doubt', 'finding', 'status', 'question', 'handoff', 'note'],
            description: 'Message type (default: note)',
          },
          confidence: {
            type: 'string',
            enum: ['certain', 'probable', 'hypothesis', 'guess'],
            description: 'Confidence level (default: certain)',
          },
          payload: {
            type: 'object',
            description: 'Optional structured payload',
          },
        },
        required: ['parent_id', 'message'],
      },
    },
    handler: (args) => relayReply(args),
  },
];

export default tools;
