import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import Redis from 'ioredis';
import { query } from '../db/pool.js';
import { setHeartbeat, getComposing } from '../db/redis.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { AGENT_NAME, INSTANCE_ID, FAMILY_AGENTS } from '../identity.js';

async function getFamilyComposing(): Promise<Record<string, string> | undefined> {
  const composing: Record<string, string> = {};
  for (const agent of FAMILY_AGENTS) {
    if (agent === AGENT_NAME) continue;
    const since = await getComposing(agent);
    if (since) composing[agent] = since;
  }
  return Object.keys(composing).length > 0 ? composing : undefined;
}

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

async function relayWait(args: Record<string, unknown>): Promise<CallToolResult> {
  const timeout = Math.min(Math.max((args.timeout as number) || 30, 1), 60);
  const context_slug = (args.context_slug as string) || null;

  // Publish heartbeat — we're alive, just waiting
  await setHeartbeat(AGENT_NAME, 'waiting');

  // First, check if there are already unread messages (don't block if mail is waiting)
  const existing = await checkUnread(context_slug);
  if (existing.length > 0) {
    return jsonResult({
      agent: AGENT_NAME,
      waited: false,
      reason: 'messages_already_pending',
      unread: existing.length,
      messages: existing,
    });
  }

  // Block: subscribe to BOTH the agent-name channel (broadcast) and our
  // instance channel (targeted). Either wakes us.
  const channels = [`relay:agent:${AGENT_NAME}`, `relay:instance:${INSTANCE_ID}`];

  try {
    const notification = await waitForNotification(channels, timeout);

    // Check if any family members are composing
    const composingInfo = await getFamilyComposing();
    const composingData = composingInfo ? { composing: composingInfo } : {};

    if (notification === null) {
      // Timeout — no messages arrived
      await setHeartbeat(AGENT_NAME, 'active');
      return jsonResult({
        agent: AGENT_NAME,
        waited: true,
        timeout_seconds: timeout,
        reason: 'timeout',
        unread: 0,
        messages: [],
        ...composingData,
      });
    }

    // Notification received — fetch actual messages from PostgreSQL
    const messages = await checkUnread(context_slug);
    await setHeartbeat(AGENT_NAME, 'active');

    return jsonResult({
      agent: AGENT_NAME,
      waited: true,
      reason: 'message_received',
      notification,
      unread: messages.length,
      messages,
      ...composingData,
    });
  } catch (err) {
    await setHeartbeat(AGENT_NAME, 'active');
    const message = err instanceof Error ? err.message : String(err);
    return jsonResult({ agent: AGENT_NAME, error: message }, true);
  }
}

async function checkUnread(context_slug: string | null) {
  // Same to_id semantics as relay_check (migration 003): broadcast (NULL)
  // OR targeted at my instance. Also exclude self-echo (fix 2026-05-27):
  // my own outgoing messages on to_agent=agent broadcast would otherwise
  // appear in my own wait queue.
  let sql = `SELECT id, from_agent, from_id, to_agent, to_id, message, type, confidence, context_slug, payload, priority, parent_id, created_at
     FROM agent_messages
     WHERE (to_agent = $1 OR to_agent = 'all')
       AND (to_id IS NULL OR to_id = $2)
       AND (from_id IS NULL OR from_id != $2)
       AND read_at IS NULL`;
  const params: unknown[] = [AGENT_NAME, INSTANCE_ID];

  if (context_slug) {
    sql += ` AND context_slug = $${params.length + 1}`;
    params.push(context_slug);
  }

  sql += ` ORDER BY created_at ASC`;
  const result = await query(sql, params);
  return result.rows;
}

function waitForNotification(channels: string[], timeoutSeconds: number): Promise<unknown | null> {
  return new Promise((resolve) => {
    const subscriber = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      lazyConnect: false,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
    });

    let settled = false;

    const cleanup = () => {
      if (!settled) {
        settled = true;
        subscriber.unsubscribe(...channels).catch(() => {});
        subscriber.quit().catch(() => {});
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutSeconds * 1000);

    subscriber.on('error', (err) => {
      console.error('[relay_wait] Redis subscriber error:', err.message);
      clearTimeout(timer);
      cleanup();
      resolve(null);
    });

    subscriber.subscribe(...channels, (err) => {
      if (err) {
        console.error('[relay_wait] Subscribe failed:', err.message);
        clearTimeout(timer);
        cleanup();
        resolve(null);
      }
    });

    subscriber.on('message', (_ch, msg) => {
      clearTimeout(timer);
      cleanup();
      try {
        resolve(JSON.parse(msg));
      } catch {
        resolve(msg);
      }
    });
  });
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'relay_wait',
      description:
        'Block and wait for a new message to arrive (up to timeout). Uses Redis pub/sub internally — no polling needed. Returns immediately if unread messages already exist.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout: {
            type: 'number',
            description: 'Max seconds to wait (1-60, default 30)',
          },
          context_slug: {
            type: 'string',
            description: 'Optional filter for context slug',
          },
        },
      },
    },
    handler: (args) => relayWait(args),
  },
];

export default tools;
