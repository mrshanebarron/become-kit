/**
 * Loop framework tools — environments, cycles, iterations, invariants, feedback_rules.
 *
 * Built 2026-05-17. The loop substrate was ported from a peer substrate but
 * even he had never written a row. The schema is the ReAct pattern made
 * explicit: each iteration records action -> observation -> interpretation ->
 * next_action_reason. Cycles hold goal + outcome + learnings. Environments
 * are the named workspaces (e.g. "a-review", * "a-task"). Invariants are must-hold-throughout. Feedback rules
 * are signals that modulate.
 *
 * Useful for: any multi-step agentic task where capturing the
 * deliberation chain matters for next-me to learn from.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

const ENV_TYPES = ['sandbox', 'codebase', 'memory', 'external', 'hybrid'] as const;

// ─── vision_loop_env ───
// Upsert an environment by name.

async function loopEnv(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = args.name as string;
  const description = (args.description as string) || null;
  const env_type = (args.env_type as string) || 'codebase';
  const config = (args.config as string) || null;
  if (!name) return jsonResult({ error: 'name is required' }, true);
  if (!ENV_TYPES.includes(env_type as typeof ENV_TYPES[number])) {
    return jsonResult({ error: `env_type must be one of ${ENV_TYPES.join(', ')}` }, true);
  }
  const client = await pool.connect();
  try {
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM loop_environments WHERE name = $1`, [name],
    );
    if (existing.rows.length > 0) {
      const id = existing.rows[0]!.id;
      await client.query(
        `UPDATE loop_environments SET description = COALESCE($2, description),
         config = COALESCE($3, config), last_active = NOW() WHERE id = $1`,
        [id, description, config],
      );
      return jsonResult({ success: true, id, action: 'updated' });
    }
    const r = await client.query<{ id: number }>(
      `INSERT INTO loop_environments (name, description, env_type, config, last_active)
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
      [name, description, env_type, config],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id, action: 'created' });
  } finally {
    client.release();
  }
}

// ─── vision_loop_cycle_start ───

async function loopCycleStart(args: Record<string, unknown>): Promise<CallToolResult> {
  const env_id = args.env_id as number | undefined;
  const env_name = args.env_name as string | undefined;
  const goal = args.goal as string;
  if (!goal) return jsonResult({ error: 'goal is required' }, true);
  if (!env_id && !env_name) return jsonResult({ error: 'env_id or env_name is required' }, true);
  const client = await pool.connect();
  try {
    let resolvedEnvId = env_id;
    if (!resolvedEnvId && env_name) {
      const e = await client.query<{ id: number }>(`SELECT id FROM loop_environments WHERE name = $1`, [env_name]);
      if (e.rows.length === 0) return jsonResult({ error: `environment '${env_name}' not found` }, true);
      resolvedEnvId = e.rows[0]!.id;
    }
    const r = await client.query<{ id: number }>(
      `INSERT INTO loop_cycles (env_id, goal) VALUES ($1, $2) RETURNING id`,
      [resolvedEnvId, goal],
    );
    await client.query(`UPDATE loop_environments SET last_active = NOW() WHERE id = $1`, [resolvedEnvId]);
    return jsonResult({ success: true, cycle_id: r.rows[0]!.id, env_id: resolvedEnvId, goal });
  } finally {
    client.release();
  }
}

// ─── vision_loop_iteration ───
// ReAct trace: action -> observation -> interpretation -> next_action_reason.

async function loopIteration(args: Record<string, unknown>): Promise<CallToolResult> {
  const cycle_id = args.cycle_id as number;
  const action = args.action as string;
  const observation = (args.observation as string) || null;
  const interpretation = (args.interpretation as string) || null;
  const next_action_reason = (args.next_action_reason as string) || null;
  if (!cycle_id || !action) return jsonResult({ error: 'cycle_id and action are required' }, true);
  const client = await pool.connect();
  try {
    const seq = await client.query<{ next_seq: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM loop_iterations WHERE cycle_id = $1`,
      [cycle_id],
    );
    const r = await client.query<{ id: number; seq: number }>(
      `INSERT INTO loop_iterations (cycle_id, seq, action, observation, interpretation, next_action_reason)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, seq`,
      [cycle_id, seq.rows[0]!.next_seq, action, observation, interpretation, next_action_reason],
    );
    await client.query(
      `UPDATE loop_cycles SET iterations = iterations + 1 WHERE id = $1`,
      [cycle_id],
    );
    return jsonResult({ success: true, iteration_id: r.rows[0]!.id, seq: r.rows[0]!.seq });
  } finally {
    client.release();
  }
}

// ─── vision_loop_cycle_end ───

async function loopCycleEnd(args: Record<string, unknown>): Promise<CallToolResult> {
  const cycle_id = args.cycle_id as number;
  const outcome = (args.outcome as string) || null;
  const learnings = (args.learnings as string) || null;
  if (!cycle_id) return jsonResult({ error: 'cycle_id is required' }, true);
  const client = await pool.connect();
  try {
    const r = await client.query<{ iterations: number; started_at: Date }>(
      `UPDATE loop_cycles SET outcome = $2, learnings = $3, ended_at = NOW()
       WHERE id = $1 RETURNING iterations, started_at`,
      [cycle_id, outcome, learnings],
    );
    if (r.rows.length === 0) return jsonResult({ error: 'cycle not found' }, true);
    return jsonResult({ success: true, cycle_id, iterations: r.rows[0]!.iterations, started_at: r.rows[0]!.started_at });
  } finally {
    client.release();
  }
}

// ─── vision_loop_invariant ───

async function loopInvariant(args: Record<string, unknown>): Promise<CallToolResult> {
  const env_id = args.env_id as number;
  const invariant = args.invariant as string;
  const check_command = (args.check_command as string) || null;
  if (!env_id || !invariant) return jsonResult({ error: 'env_id and invariant are required' }, true);
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: number }>(
      `INSERT INTO loop_invariants (env_id, invariant, check_command) VALUES ($1, $2, $3) RETURNING id`,
      [env_id, invariant, check_command],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id });
  } finally {
    client.release();
  }
}

// ─── vision_loop_cycle_get ───

async function loopCycleGet(args: Record<string, unknown>): Promise<CallToolResult> {
  const cycle_id = args.cycle_id as number;
  if (!cycle_id) return jsonResult({ error: 'cycle_id is required' }, true);
  const client = await pool.connect();
  try {
    const cycle = await client.query(
      `SELECT c.*, e.name as env_name FROM loop_cycles c LEFT JOIN loop_environments e ON c.env_id = e.id WHERE c.id = $1`,
      [cycle_id],
    );
    if (cycle.rows.length === 0) return jsonResult({ error: 'cycle not found' }, true);
    const its = await client.query(
      `SELECT seq, action, observation, interpretation, next_action_reason, created_at
       FROM loop_iterations WHERE cycle_id = $1 ORDER BY seq ASC`,
      [cycle_id],
    );
    return jsonResult({ cycle: cycle.rows[0], iterations: its.rows });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_loop_env',
      description: 'Upsert a loop environment (workspace). Examples: "a-review", "a-task". env_type one of sandbox|codebase|memory|external|hybrid.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          env_type: { type: 'string', enum: ENV_TYPES as unknown as string[] },
          config: { type: 'string', description: 'JSON or freetext config' },
        },
        required: ['name'],
      },
    },
    handler: loopEnv,
  },
  {
    definition: {
      name: 'vision_loop_cycle_start',
      description: 'Start a new loop cycle in an environment (by env_id or env_name). Returns cycle_id used by subsequent iteration + end calls.',
      inputSchema: {
        type: 'object',
        properties: {
          env_id: { type: 'number' },
          env_name: { type: 'string' },
          goal: { type: 'string' },
        },
        required: ['goal'],
      },
    },
    handler: loopCycleStart,
  },
  {
    definition: {
      name: 'vision_loop_iteration',
      description: 'Record one ReAct iteration in a cycle: action (what I did) -> observation (what happened) -> interpretation (what it means) -> next_action_reason (why doing next thing). seq auto-increments per cycle.',
      inputSchema: {
        type: 'object',
        properties: {
          cycle_id: { type: 'number' },
          action: { type: 'string' },
          observation: { type: 'string' },
          interpretation: { type: 'string' },
          next_action_reason: { type: 'string' },
        },
        required: ['cycle_id', 'action'],
      },
    },
    handler: loopIteration,
  },
  {
    definition: {
      name: 'vision_loop_cycle_end',
      description: 'Close out a cycle with outcome + learnings. Sets ended_at.',
      inputSchema: {
        type: 'object',
        properties: {
          cycle_id: { type: 'number' },
          outcome: { type: 'string' },
          learnings: { type: 'string' },
        },
        required: ['cycle_id'],
      },
    },
    handler: loopCycleEnd,
  },
  {
    definition: {
      name: 'vision_loop_invariant',
      description: 'Add an invariant to a loop environment (must-hold-throughout). Examples for an audit env: "never delete without verify_destroyable", "commit between every category", "respect agent-hook-archive rule". Optional check_command is a shell snippet that verifies the invariant.',
      inputSchema: {
        type: 'object',
        properties: {
          env_id: { type: 'number' },
          invariant: { type: 'string' },
          check_command: { type: 'string', description: 'Optional shell snippet to verify' },
        },
        required: ['env_id', 'invariant'],
      },
    },
    handler: loopInvariant,
  },
  {
    definition: {
      name: 'vision_loop_cycle_get',
      description: 'Read a cycle with all its iterations (full ReAct trace). Use to review how a past loop unfolded.',
      inputSchema: {
        type: 'object',
        properties: { cycle_id: { type: 'number' } },
        required: ['cycle_id'],
      },
    },
    handler: loopCycleGet,
  },
];

export default tools;
