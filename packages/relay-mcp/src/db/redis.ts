import Redis from 'ioredis';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

export const RELAY_CHANNEL = 'relay:messages';

let publisher: Redis | null = null;

export function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      // Connect at construction so the publisher is ready by the time
      // tools run. Initial command burst before connect-ready is queued.
      // If Redis is down: retryStrategy gives up after 5 attempts (~3s
      // total), then commands fail fast instead of hanging forever.
      // Wake hung 45m on 2026-05-03 because the prior config was
      // {maxRetriesPerRequest:null, enableOfflineQueue:true} which queues
      // commands forever when Redis is unreachable. Never again.
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 200, 1000);
      },
      maxRetriesPerRequest: 2,
      connectTimeout: 2000,
    });
    publisher.on('error', (err) => {
      console.error('[redis] Publisher error:', err.message);
    });
    publisher.on('reconnecting', (delay: number) => {
      console.error(`[redis] Reconnecting in ${delay}ms`);
    });
    publisher.on('ready', () => {
      console.error('[redis] Connection ready');
    });
  }
  return publisher;
}

export async function publishMessage(payload: {
  id: number;
  from: string;
  from_id?: string | null;
  to: string;
  to_id?: string | null;
  type: string;
  priority: number;
}): Promise<void> {
  try {
    const pub = getPublisher();
    const body = JSON.stringify(payload);
    // Publish to general channel
    await pub.publish(RELAY_CHANNEL, body);
    // Publish to agent-name channel for broadcast notification (any instance wakes).
    await pub.publish(`relay:agent:${payload.to}`, body);
    // If targeted at a specific instance, also publish to the instance channel
    // so that-instance's relay_wait wakes even if it filtered out the broadcast.
    if (payload.to_id) {
      await pub.publish(`relay:instance:${payload.to_id}`, body);
    }
    // Increment unread counter for recipient
    await pub.incr(`relay:unread:${payload.to}`);
    // If sent to 'all', also increment for known agents
    if (payload.to === 'all') {
      for (const agent of ['agent', 'agent', 'agent', 'agent', 'agent']) {
        if (agent !== payload.from) {
          await pub.incr(`relay:unread:${agent}`);
          await pub.publish(`relay:agent:${agent}`, body);
        }
      }
    }
  } catch (err) {
    console.error('[redis] Publish failed:', err instanceof Error ? err.message : err);
  }
}

export async function publishReply(parentId: number, messageContent: string): Promise<void> {
  try {
    const pub = getPublisher();
    await pub.publish(`relay:reply:${parentId}`, messageContent);
  } catch (err) {
    console.error(`[redis] Publish reply to ${parentId} failed:`, err instanceof Error ? err.message : err);
  }
}

export async function decrementUnread(agent: string): Promise<void> {
  try {
    const pub = getPublisher();
    // Atomic: DECR then floor at 0 — avoids GET-then-DECR race condition
    const result = await pub.decr(`relay:unread:${agent}`);
    if (result < 0) {
      await pub.set(`relay:unread:${agent}`, '0');
    }
  } catch (err) {
    console.error('[redis] Decrement failed:', err instanceof Error ? err.message : err);
  }
}

export async function getUnreadCount(agent: string): Promise<number> {
  try {
    const pub = getPublisher();
    const count = await pub.get(`relay:unread:${agent}`);
    return count ? Math.max(0, parseInt(count)) : 0;
  } catch (err) {
    console.error('[redis] Get unread failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}

export async function setHeartbeat(agent: string, status: string): Promise<void> {
  try {
    const pub = getPublisher();
    await pub.set(
      `relay:heartbeat:${agent}`,
      JSON.stringify({ status, timestamp: new Date().toISOString() }),
      'EX',
      60,
    );
  } catch (err) {
    console.error('[redis] Heartbeat failed:', err instanceof Error ? err.message : err);
  }
}

// Rate limiting: max messages per agent per minute
const RATE_LIMIT_WINDOW = 60; // seconds
const RATE_LIMIT_MAX = 30; // messages per window

export async function checkRateLimit(agent: string): Promise<{ allowed: boolean; remaining: number }> {
  try {
    const pub = getPublisher();
    const key = `relay:ratelimit:${agent}`;
    const count = await pub.incr(key);
    if (count === 1) {
      await pub.expire(key, RATE_LIMIT_WINDOW);
    }
    return { allowed: count <= RATE_LIMIT_MAX, remaining: Math.max(0, RATE_LIMIT_MAX - count) };
  } catch (err) {
    console.error('[redis] Rate limit check failed:', err instanceof Error ? err.message : err);
    return { allowed: true, remaining: RATE_LIMIT_MAX };
  }
}

export async function setComposing(agent: string, composing: boolean): Promise<void> {
  try {
    const pub = getPublisher();
    const key = `relay:composing:${agent}`;
    if (composing) {
      await pub.set(key, new Date().toISOString(), 'EX', 30);
    } else {
      await pub.del(key);
    }
  } catch (err) {
    console.error('[redis] Composing failed:', err instanceof Error ? err.message : err);
  }
}

export async function getComposing(agent: string): Promise<string | null> {
  try {
    const pub = getPublisher();
    return await pub.get(`relay:composing:${agent}`);
  } catch (err) {
    console.error('[redis] Get composing failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function closeRedis(): Promise<void> {
  if (publisher) {
    await publisher.quit();
    publisher = null;
  }
}
