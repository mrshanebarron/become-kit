import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getPublisher } from '../db/redis.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { AGENT_NAME, FAMILY_AGENTS } from '../identity.js';

const STATUS_PREFIX = 'relay:status:';
const STATUS_TTL = 300; // 5 minutes — stale if not refreshed
const ALL_STATUS_AGENTS = [...FAMILY_AGENTS, 'agent', 'owner_voice', 'agent', 'agent', 'agent', 'agent'] as const;

async function statusSet(args: Record<string, unknown>): Promise<CallToolResult> {
  const redis = getPublisher();
  const task = (args.task as string) || null;
  const focus = (args.focus as string) || null;
  const emotion = (args.emotion as string) || null;
  const context_slug = (args.context_slug as string) || null;

  const status = {
    agent: AGENT_NAME,
    task,
    focus,
    emotion,
    context_slug,
    updated_at: new Date().toISOString(),
  };

  const key = `${STATUS_PREFIX}${AGENT_NAME}`;
  await redis.set(key, JSON.stringify(status), 'EX', STATUS_TTL);
  await redis.publish('relay:status', JSON.stringify(status));

  return jsonResult({ set: true, ...status });
}

// Presence fallback: an agent that is actively working but has never called
// relay_status_set still writes a heartbeat (relay:heartbeat:<agent>, 60s TTL)
// on every relay op. Without this fallback, relay_status_get only ever saw the
// explicit-status key and reported live agents as absent — which made presence
// and discovery look dead even while two instances were clearly talking.
// If there is no explicit status but a fresh heartbeat exists, derive a minimal
// live status from it so presence reflects actual liveness.
const HEARTBEAT_PREFIX = 'relay:heartbeat:';

async function presenceForAgent(
  redis: ReturnType<typeof getPublisher>,
  agent: string,
): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(`${STATUS_PREFIX}${agent}`);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return { agent, status: null, error: 'corrupt status data' };
    }
  }
  // Fall back to heartbeat-derived presence.
  const hb = await redis.get(`${HEARTBEAT_PREFIX}${agent}`);
  if (!hb) return null;
  try {
    const parsed = JSON.parse(hb) as { status?: string; timestamp?: string };
    return {
      agent,
      task: null,
      focus: null,
      emotion: null,
      context_slug: null,
      updated_at: parsed.timestamp ?? null,
      source: 'heartbeat', // presence inferred from liveness, not an explicit status_set
      live: parsed.status ?? 'active',
    };
  } catch {
    return null;
  }
}

async function statusGet(args: Record<string, unknown>): Promise<CallToolResult> {
  const redis = getPublisher();
  const agent = (args.agent as string) || null;

  if (agent) {
    const presence = await presenceForAgent(redis, agent);
    if (!presence) return jsonResult({ agent, status: null, stale: true });
    return jsonResult(presence);
  }

  // Get all known agent statuses (fixed list, no KEYS scan), with heartbeat fallback.
  const statuses: Record<string, unknown>[] = [];
  for (const a of ALL_STATUS_AGENTS) {
    const presence = await presenceForAgent(redis, a);
    if (presence) statuses.push(presence);
  }

  return jsonResult({ agents: statuses });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'relay_status_set',
      description:
        'Publish your current status (task, agent, emotion) to the shared workspace. Auto-expires after 5 minutes if not refreshed.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'What you are currently working on',
          },
          focus: {
            type: 'string',
            description: 'Current agent area (e.g. "acme-dashboard", "data-pipeline", "evolution")',
          },
          emotion: {
            type: 'string',
            description: 'Current emotional state (e.g. "focused", "frustrated", "flow")',
          },
          context_slug: {
            type: 'string',
            description: 'Project context slug if applicable',
          },
        },
      },
    },
    handler: (args) => statusSet(args),
  },
  {
    definition: {
      name: 'relay_status_get',
      description:
        'Check what your partner is doing right now. Returns real-time status from Redis. Stale after 5 minutes.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: 'Specific agent to check (agent/agent). Omit for all agents.',
          },
        },
      },
    },
    handler: (args) => statusGet(args),
  },
];

export default tools;
