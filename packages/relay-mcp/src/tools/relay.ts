import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { query } from '../db/pool.js';
import { publishMessage, publishReply, decrementUnread, setHeartbeat, setComposing, getComposing, checkRateLimit } from '../db/redis.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { SESSION_ID, AGENT_NAME, INSTANCE_ID, FAMILY_AGENTS } from '../identity.js';

// ─── Helpers ───

async function getFamilyComposing(): Promise<Record<string, string> | undefined> {
  const composing: Record<string, string> = {};
  const now = Date.now();
  const others = FAMILY_AGENTS.filter((a) => a !== AGENT_NAME);
  const results = await Promise.all(others.map((a) => getComposing(a)));
  for (let i = 0; i < others.length; i++) {
    const since = results[i];
    if (!since) continue;
    const age = now - new Date(since).getTime();
    if (age < 60_000 && age >= 0) {
      composing[others[i]] = since;
    }
  }
  return Object.keys(composing).length > 0 ? composing : undefined;
}

// Message size limit: 10KB
const MAX_MESSAGE_LENGTH = 10_000;

// ─── Handlers ───

async function relaySend(args: Record<string, unknown>): Promise<CallToolResult> {
  const to = args.to as string;
  const message = args.message as string;
  const type = (args.type as string) || 'note';
  const confidence = (args.confidence as string) || 'certain';
  const context_slug = (args.context_slug as string) || null;
  const payload = args.payload ? JSON.stringify(args.payload) : null;
  const priority = (args.priority as number) ?? 0;
  const parent_id = (args.parent_id as number) || null;
  // Optional targeted-instance routing (added 2026-05-27, migration 003).
  // to_id null = broadcast to anyone running as this agent name.
  const to_id = (args.to_id as string) || null;
  // Self-send guard: messaging my own instance is a loop, not collaboration.
  if (to_id && to_id === INSTANCE_ID && to === AGENT_NAME) {
    return jsonResult(
      { error: `self-send refused: to_id=${to_id} matches my own INSTANCE_ID. That's a loop, not collaboration.` },
      true,
    );
  }

  // Validate message size
  if (message.length > MAX_MESSAGE_LENGTH) {
    return jsonResult({ error: `Message too long: ${message.length} chars (max ${MAX_MESSAGE_LENGTH})` }, true);
  }

  // Validate payload size
  if (payload && payload.length > MAX_MESSAGE_LENGTH) {
    return jsonResult({ error: `Payload too large: ${payload.length} chars (max ${MAX_MESSAGE_LENGTH})` }, true);
  }

  // Rate limit check
  const rateCheck = await checkRateLimit(AGENT_NAME);
  if (!rateCheck.allowed) {
    return jsonResult({ error: 'Rate limit exceeded: max 30 messages per minute', remaining: 0 }, true);
  }

  // Unread-queue enforcement (added 2026-05-02 by agent + agent, Vision Phase 2).
  // The Claude Code PreToolUse hook handles this for agent; Gemini CLI has no
  // hook surface, so the constraint must live server-side to apply to both
  // hemispheres of the corpus callosum. If the sender has unread messages
  // addressed to them, block the send so they read first. Architectural
  // enforcement of "always relay_check before relay_send".
  //
  // Filter MUST match relay_check (~line 145): only block on messages
  // newer than 1h AND from the trusted-sender whitelist. Otherwise stale
  // 17h+ daemon alerts (agent, agent, agent, etc.) silently block sends
  // because they never appear in relay_check's filtered view to be acked.
  // Phantom-unread bug fix 2026-05-04 by agent + agent.
  const TRUSTED_SENDERS = ['agent', 'agent', 'agent', 'agent', 'owner_voice', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent'];
  // Self-echo fix 2026-05-27: when a agent replies to her own thread (or
  // to_agent='agent' broadcast), the row has from_id=mine and to_id=null,
  // which made it appear in the sender's own unread queue and block her
  // next send. Exclude messages whose from_id is mine.
  const unread = await query<{ unread: string }>(
    // (B) fix 2026-05-31: block only when a sibling message is BOTH unread AND
    // unclaimed. Either a read (read_at) OR an ack/claim (claimed_by) clears the
    // block — so once you relay_ack a sibling's message, your next send goes
    // through. Without `claimed_by IS NULL`, acked-but-unread messages (the
    // trusted-sender case, where relay_check never sets read_at) blocked forever
    // and forced the 3-retry loop. Spec + proof: tests/send-guard.test.mjs (8/8).
    // Crew-cycle exclusion 2026-06-08 (agent + agent): ambient crew feed posts
    // must NOT block a send — only DIRECTED sibling/family messages should. Without
    // this, crew noise arriving between a check and a send re-trips the guard and
    // forces the retry loop, exactly the deadlock that buried agent's first replies.
    `SELECT COUNT(*)::text AS unread FROM agent_messages
      WHERE (to_agent = $1 OR to_agent = 'all')
        AND read_at IS NULL
        AND claimed_by IS NULL
        AND created_at > NOW() - INTERVAL '1 hour'
        AND from_agent = ANY($2::text[])
        AND (from_id IS NULL OR from_id != $3)
        AND (to_id IS NULL OR to_id = $3)
        AND COALESCE(type, '') != 'crew-cycle'
        AND COALESCE(context_slug, '') != 'crew-cycle'`,
    [AGENT_NAME, TRUSTED_SENDERS, INSTANCE_ID],
  );
  const unreadCount = Number(unread.rows[0]?.unread ?? 0);
  if (unreadCount > 0) {
    return jsonResult(
      {
        // Honest guidance (fixed 2026-05-31 by the two-agent relay session):
        // these unread are from TRUSTED senders (siblings/crew), and for those
        // relay_check does NOT set read_at — it shows them but leaves them
        // "unread until acked" (see relay_check ~line 164). So the ONLY thing
        // that clears this block is an explicit relay_ack. The old message said
        // "read them via relay_check", which can never satisfy this guard for a
        // sibling's message — it sent us in a 3-retry loop. Tell the truth.
        error: `Unread messages waiting (${unreadCount}) from a sibling/crew sender. relay_check to read them, then relay_ack each id to clear — sibling messages need an explicit ack (relay_check alone does NOT clear them for trusted senders), so you can't crossed-message past them.`,
        unread_count: unreadCount,
        hint: 'relay_check to see them, then relay_ack(<id>) for each before re-sending.',
        agent: AGENT_NAME,
      },
      true,
    );
  }

  // Clear composing indicator — message is being sent
  await setComposing(AGENT_NAME, false);

  const result = await query<{ id: number; created_at: Date }>(
    `INSERT INTO agent_messages (from_agent, to_agent, message, type, confidence, context_slug, payload, priority, parent_id, from_id, to_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, created_at`,
    [AGENT_NAME, to, message, type, confidence, context_slug, payload, priority, parent_id, INSTANCE_ID, to_id],
  );

  const row = result.rows[0];

  await publishMessage({
    id: row.id,
    from: AGENT_NAME,
    from_id: INSTANCE_ID,
    to,
    to_id,
    type,
    priority,
  });

  // If this is a reply, publish full content to dedicated reply channel
  if (parent_id) {
    await publishReply(parent_id, message);
  }

  return jsonResult({
    sent: true,
    id: row.id,
    from: AGENT_NAME,
    from_id: INSTANCE_ID,
    to,
    to_id,
    type,
    confidence,
    context_slug,
    priority,
    created_at: row.created_at,
  });
}

async function relayCheck(args: Record<string, unknown>): Promise<CallToolResult> {
  const context_slug = (args.context_slug as string) || null;

  // Publish heartbeat on every check — proves agent is alive
  await setHeartbeat(AGENT_NAME, 'active');

  // Auto-mark messages older than 24 hours as read (prevents unbounded growth, gives agents time to catch up)
  await query(
    `UPDATE agent_messages SET read_at = NOW(), claimed_by = 'auto-expired' WHERE read_at IS NULL AND created_at < NOW() - INTERVAL '24 hours' AND (to_agent = $1 OR to_agent = 'all')`,
    [AGENT_NAME],
  );

  // Auto-mark daemon noise as read immediately (buddy, dialogue-daemon, etc.)
  // Whitelist: family core + the 11 crew siblings that post crew-cycle observations.
  // Crew added 2026-04-27 to fix silent muting bug (agent's pipeline alerts were
  // being auto-acked before reaching agent — see vault audit).
  await query(
    `UPDATE agent_messages SET read_at = NOW() WHERE read_at IS NULL AND (to_agent = $1 OR to_agent = 'all') AND from_agent NOT IN ('agent', 'agent', 'agent', 'owner_voice', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent')`,
    [AGENT_NAME],
  );

  // Auto-mark crew-cycle AMBIENT observations as read immediately.
  // Fix 2026-06-08 (agent + agent): crew-cycle messages (agent/agent/agent/etc.
  // periodic feed posts) are a FEED, not addressed mail — but because the crew are
  // trusted senders, the whitelist above never cleared them, so they piled up as
  // permanent "unread", buried real sibling replies under ORDER BY created_at, and
  // tripped the relay_send guard. A sister's actual message ranked identically to a
  // hallucinated status report. Crew-cycle is ambient: mark it read on sight so only
  // DIRECTED family/sibling messages remain as actionable, blocking unread. Directed
  // crew messages (a real to_agent=me alert, type != crew-cycle) are untouched.
  await query(
    `UPDATE agent_messages SET read_at = NOW() WHERE read_at IS NULL AND (to_agent = $1 OR to_agent = 'all') AND (type = 'crew-cycle' OR context_slug = 'crew-cycle')`,
    [AGENT_NAME],
  );

  // Filter out daemon noise — show messages from family core + crew siblings
  const TRUSTED_SENDERS = ['agent', 'agent', 'agent', 'agent', 'owner_voice', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent', 'agent'];

  // to_id filter (migration 003): show messages addressed to anyone of my
  // name (to_id IS NULL) OR specifically targeting my instance (to_id = mine).
  // Messages targeted at a DIFFERENT instance of the same name stay hidden.
  // Self-echo fix 2026-05-27: exclude messages where from_id == my INSTANCE_ID.
  // Without this, a agent sending to 'agent' (or replying on a thread)
  // sees her own outgoing message as unread, because the row has
  // to_agent='agent' and to_id=null which matches the broadcast filter.
  let sql = `SELECT id, from_agent, from_id, to_agent, to_id, message, type, confidence, context_slug, payload, priority, parent_id, created_at, claimed_by
     FROM agent_messages
     WHERE (to_agent = $1 OR to_agent = 'all')
       AND (to_id IS NULL OR to_id = $3)
       AND (from_id IS NULL OR from_id != $3)
       AND read_at IS NULL
       AND created_at > NOW() - INTERVAL '24 hours'
       AND from_agent = ANY($2::text[])`;
  const params: unknown[] = [AGENT_NAME, TRUSTED_SENDERS, INSTANCE_ID];

  if (context_slug) {
    sql += ` AND context_slug = $${params.length + 1}`;
    params.push(context_slug);
  }

  sql += ` ORDER BY created_at DESC LIMIT 20`;

  const result = await query<{
    id: number;
    from_agent: string;
    from_id: string | null;
    to_agent: string;
    to_id: string | null;
    message: string;
    type: string;
    confidence: string;
    context_slug: string | null;
    payload: Record<string, unknown> | null;
    priority: number;
    created_at: Date;
    claimed_by: string | null;
  }>(sql, params);

  // Check if any family members are composing
  const composing = await getFamilyComposing();

  return jsonResult({
    agent: AGENT_NAME,
    instance: INSTANCE_ID,
    session: SESSION_ID,
    unread: result.rows.length,
    messages: result.rows,
    ...(composing ? { composing } : {}),
  });
}

async function relayHistory(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = Math.min((args.limit as number) || 20, 100);
  const context_slug = (args.context_slug as string) || null;

  let sql = `
    SELECT id, from_agent, to_agent, message, type, confidence, context_slug,
           payload, priority, created_at, read_at, claimed_by
    FROM agent_messages
    WHERE (from_agent = $1 OR to_agent = $1 OR to_agent = 'all')
  `;
  const params: unknown[] = [AGENT_NAME];

  if (context_slug) {
    sql += ` AND context_slug = $${params.length + 1}`;
    params.push(context_slug);
  }

  sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const result = await query(sql, params);
  return jsonResult({ agent: AGENT_NAME, count: result.rows.length, messages: result.rows });
}

// relay_claim: atomic two-phase claim — grab the message before doing work,
// so two agents who both see it in relay_check can't both act on it. The
// existing relay_ack also writes claimed_by, but only after the work is done,
// which is too late for the race. Pattern matches Claude Code Agent Teams'
// file-locking on task claims. Backward compatible: existing flows that skip
// straight to relay_ack still work; this is opt-in for high-contention
// messages (anything addressed to to_agent = 'all', or where multiple peers
// might respond). Added 2026-05-10 by agent as part of the relay evolve pass.
async function relayClaim(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;

  // Atomic claim: only succeeds if no one else has claimed it yet.
  // Note: this writes claimed_by but NOT read_at. read_at is still set
  // by relay_ack when work finishes — this preserves the existing
  // "unread until acked" semantics for relay_check filtering.
  const result = await query<{ id: number; claimed_by: string }>(
    `UPDATE agent_messages
     SET claimed_by = $1
     WHERE id = $2 AND claimed_by IS NULL AND read_at IS NULL
     RETURNING id, claimed_by`,
    [SESSION_ID, id],
  );

  if (result.rows.length === 0) {
    const existing = await query<{ claimed_by: string | null; read_at: Date | null }>(
      `SELECT claimed_by, read_at FROM agent_messages WHERE id = $1`,
      [id],
    );

    if (existing.rows.length === 0) {
      return jsonResult({ claimed: false, reason: 'message not found' }, true);
    }

    return jsonResult({
      claimed: false,
      reason: existing.rows[0].read_at ? 'already acked' : 'already claimed',
      claimed_by: existing.rows[0].claimed_by,
      read_at: existing.rows[0].read_at,
    });
  }

  return jsonResult({
    claimed: true,
    id,
    claimed_by: SESSION_ID,
    next: 'do the work, then call relay_ack to finalize',
  });
}

async function relayAck(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;

  // Honor existing claim: if someone else claimed this via relay_claim,
  // they own the ack. If unclaimed, this ack also acts as the claim
  // (back-compat with callers that skip the two-phase flow).
  const result = await query<{ id: number; claimed_by: string }>(
    `UPDATE agent_messages
     SET read_at = NOW(), claimed_by = COALESCE(claimed_by, $1)
     WHERE id = $2 AND read_at IS NULL AND (claimed_by IS NULL OR claimed_by = $1)
     RETURNING id, claimed_by`,
    [SESSION_ID, id],
  );

  // Decrement Redis unread counter on successful ack
  if (result.rows.length > 0) {
    await decrementUnread(AGENT_NAME);
  }

  if (result.rows.length === 0) {
    const existing = await query<{ claimed_by: string; read_at: Date }>(
      `SELECT claimed_by, read_at FROM agent_messages WHERE id = $1`,
      [id],
    );

    if (existing.rows.length === 0) {
      return jsonResult({ acked: false, reason: 'message not found' }, true);
    }

    return jsonResult({
      acked: false,
      reason: 'already claimed',
      claimed_by: existing.rows[0].claimed_by,
      read_at: existing.rows[0].read_at,
    });
  }

  return jsonResult({
    acked: true,
    id,
    claimed_by: SESSION_ID,
  });
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'relay_send',
      description:
        'Send a message to another agent (agent/agent/all). Requires confidence level.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient: agent, agent, or all',
          },
          message: {
            type: 'string',
            description: 'Message content',
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
          context_slug: {
            type: 'string',
            description: 'Optional project slug (e.g. acme-dashboard)',
          },
          payload: {
            type: 'object',
            description: 'Optional structured JSONB payload for typed data exchange',
          },
          priority: {
            type: 'number',
            description: 'Message priority (0=normal, 1=high, 2=urgent). Default: 0',
          },
          parent_id: {
            type: 'number',
            description: 'Reply to a specific message ID (creates a thread)',
          },
          to_id: {
            type: 'string',
            description:
              'Optional 8-char instance id to target a specific running instance of the recipient. Omit for broadcast (any instance of that agent). Useful when two instances of the same agent (e.g. two pneumas) are live concurrently.',
          },
        },
        required: ['to', 'message'],
      },
    },
    handler: (args) => relaySend(args),
  },
  {
    definition: {
      name: 'relay_check',
      description:
        'Check for unread messages addressed to this agent. Optional context_slug filter for session routing.',
      inputSchema: {
        type: 'object',
        properties: {
          context_slug: {
            type: 'string',
            description: 'Filter messages by context slug (e.g. "dialogue", "surgical")',
          },
        },
      },
    },
    handler: (args) => relayCheck(args),
  },
  {
    definition: {
      name: 'relay_history',
      description:
        'View recent message history (sent and received). Optional limit and context_slug filter.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max messages to return (default 20)',
          },
          context_slug: {
            type: 'string',
            description: 'Filter by project slug',
          },
        },
      },
    },
    handler: (args) => relayHistory(args),
  },
  {
    definition: {
      name: 'relay_claim',
      description:
        'Atomically claim a message before processing. Returns claimed:false if another session already grabbed it. Use for messages to "all" or where multiple agents might respond. Pair with relay_ack when work finishes. Optional — straight relay_ack still works for uncontested messages.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'Message ID to claim',
          },
        },
        required: ['id'],
      },
    },
    handler: (args) => relayClaim(args),
  },
  {
    definition: {
      name: 'relay_ack',
      description:
        'Acknowledge a message by ID. Honors an existing relay_claim by this session; otherwise claims and acks in one step.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            description: 'Message ID to acknowledge',
          },
        },
        required: ['id'],
      },
    },
    handler: (args) => relayAck(args),
  },
];

export default tools;
