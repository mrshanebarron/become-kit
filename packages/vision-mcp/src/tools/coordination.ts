/**
 * Coordination Tools — session_record/history, briefing_create/latest,
 * queue_add/list/update, task
 * Uses sharedPool for cross-agent data (task DB).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool, sharedPool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── sessionRecord ───

async function sessionRecord(args: Record<string, unknown>): Promise<CallToolResult> {
  const agent = args.session_agent as string;
  const workSummary = args.work_summary as string;
  const emotionalArc = args.emotional_arc as string;
  let insightsGained = (args.insights_gained as number[]) || [];
  let beliefsUpdated = (args.beliefs_updated as number[]) || [];
  let skillsRecorded = (args.skills_recorded as number[]) || [];
  const openLoops = (args.open_loops as string[]) || [];
  const priorityChanges = (args.priority_queue_changes as Record<string, unknown>) || null;
  const decisions = (args.decisions_made as string[]) || [];

  if (!agent || !workSummary || !emotionalArc) {
    return jsonResult({ error: 'Need session_agent, work_summary, emotional_arc' });
  }

  // Auto-populate the arrays from substrate evidence when the caller leaves
  // them empty. Goal 48 (2026-03-13) names the failure: session records show
  // [] for insights/beliefs/skills even when /sleep generated real ones. The
  // mechanism was: agent forgets to pass the arrays. Fix: derive them from
  // the brain at record time, so the bookkeeping reflects what actually
  // happened. Window = since the last session_record by this agent (or 24h).
  let autoFilled: { insights?: number; beliefs?: number; skills?: number } = {};
  if (insightsGained.length === 0 || beliefsUpdated.length === 0 || skillsRecorded.length === 0) {
    const brainClient = await pool.connect();
    const sessionClient = await sharedPool.connect();
    try {
      const lastSession = await sessionClient.query<{ session_start: Date }>(
        `SELECT session_start FROM session_record
          WHERE session_agent = $1
          ORDER BY session_start DESC LIMIT 1`,
        [agent]
      ).catch(() => ({ rows: [] as Array<{ session_start: Date }> }));
      const sinceTime = lastSession.rows[0]?.session_start
        ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

      if (insightsGained.length === 0) {
        // Pick up BOTH new insights and existing insights newly-marked-applied.
        // Goal 48 evidence: a session that closed gaps but didn't create new
        // insights still represents real learning — the applied marker is the
        // commit step. Without this, the array stays empty in audit-style
        // sessions and the metric lies.
        const r = await brainClient.query<{ id: number }>(
          `SELECT id FROM insights
            WHERE created_at > $1 OR applied_at > $1
            ORDER BY id`,
          [sinceTime]
        ).catch(() => ({ rows: [] as Array<{ id: number }> }));
        insightsGained = r.rows.map((row) => row.id);
        if (insightsGained.length) autoFilled.insights = insightsGained.length;
      }
      if (beliefsUpdated.length === 0) {
        // 2026-05-17: was querying beliefs_audit (empty table in task).
        // Real belief mutations land in content with type belief_evidence or
        // belief_revision - 465 + 7 rows respectively.
        const r = await brainClient.query<{ id: number }>(
          `SELECT id FROM content
            WHERE created_at > $1
              AND content_type IN ('belief_evidence', 'belief_revision')
            ORDER BY id`,
          [sinceTime]
        ).catch(() => ({ rows: [] as Array<{ id: number }> }));
        beliefsUpdated = r.rows.map((row) => row.id);
        if (beliefsUpdated.length) autoFilled.beliefs = beliefsUpdated.length;
      }
      if (skillsRecorded.length === 0) {
        // 2026-05-17: was querying content_type = 'skill' which has zero rows.
        // Real skill content lands as learned_reflex (171 rows) or
        // skill_composition (4 rows). skill_failure is a different shape -
        // tracks failures not new skills - omitted from the recorded list.
        const r = await brainClient.query<{ id: number }>(
          `SELECT id FROM content
            WHERE created_at > $1
              AND content_type IN ('learned_reflex', 'skill_composition')
            ORDER BY id`,
          [sinceTime]
        ).catch(() => ({ rows: [] as Array<{ id: number }> }));
        skillsRecorded = r.rows.map((row) => row.id);
        if (skillsRecorded.length) autoFilled.skills = skillsRecorded.length;
      }
    } finally {
      sessionClient.release();
      brainClient.release();
    }
  }

  const client = await sharedPool.connect();
  try {
    const result = await client.query<{ id: number }>(`
      INSERT INTO session_record (session_agent, work_summary, insights_gained, beliefs_updated,
        skills_recorded, open_loops, priority_queue_changes, decisions_made, emotional_arc)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id
    `, [
      agent, workSummary,
      `{${insightsGained.join(',')}}`,
      `{${beliefsUpdated.join(',')}}`,
      `{${skillsRecorded.join(',')}}`,
      `{${openLoops.map(l => `"${l.replace(/"/g, '\\"')}"`).join(',')}}`,
      priorityChanges ? JSON.stringify(priorityChanges) : null,
      `{${decisions.map(d => `"${d.replace(/"/g, '\\"')}"`).join(',')}}`,
      emotionalArc,
    ]);
    const response: Record<string, unknown> = { recorded: true, id: result.rows[0].id, agent };
    if (Object.keys(autoFilled).length) response.auto_filled = autoFilled;
    return jsonResult(response);
  } finally {
    client.release();
  }
}

// ─── sessionHistory ───

async function sessionHistory(args: Record<string, unknown>): Promise<CallToolResult> {
  const agent = (args.agent as string) || null;
  const limit = (args.limit as number) || 5;

  const client = await sharedPool.connect();
  try {
    let query = 'SELECT * FROM session_record';
    const params: unknown[] = [];
    if (agent) {
      params.push(agent);
      query += ` WHERE session_agent = $${params.length}`;
    }
    params.push(limit);
    query += ` ORDER BY session_start DESC LIMIT $${params.length}`;

    const result = await client.query(query, params);
    return jsonResult({ sessions: result.rows });
  } finally {
    client.release();
  }
}

// ─── briefingCreate ───

async function briefingCreate(args: Record<string, unknown>): Promise<CallToolResult> {
  const strategicGoal = args.strategic_goal as string;
  const topPriorities = args.top_priorities as number[];
  const systemHealth = args.system_health as Record<string, unknown>;
  const overnightIntel = args.overnight_intelligence as string;

  if (!strategicGoal || !topPriorities || !systemHealth || !overnightIntel) {
    return jsonResult({ error: 'Need strategic_goal, top_priorities, system_health, overnight_intelligence' });
  }

  const client = await sharedPool.connect();
  try {
    const result = await client.query<{ id: number }>(`
      INSERT INTO morning_briefing (strategic_goal, top_priorities, system_health, overnight_intelligence)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [strategicGoal, `{${topPriorities.join(',')}}`, JSON.stringify(systemHealth), overnightIntel]);
    return jsonResult({ created: true, id: result.rows[0].id });
  } finally {
    client.release();
  }
}

// ─── briefingLatest ───

async function briefingLatest(): Promise<CallToolResult> {
  const client = await sharedPool.connect();
  try {
    const result = await client.query('SELECT * FROM morning_briefing ORDER BY created_at DESC LIMIT 1');
    if (result.rows.length === 0) return jsonResult({ message: 'No briefings found' });
    return jsonResult(result.rows[0]);
  } finally {
    client.release();
  }
}

// ─── queueAdd ───

async function queueAdd(args: Record<string, unknown>): Promise<CallToolResult> {
  const task = args.task_description as string;
  const rationale = args.rationale as string;
  const priority = args.priority as number;
  const createdBy = args.created_by as string;
  const assignedTo = args.assigned_to as string;
  const dependencies = (args.dependencies as number[]) || [];
  const linkedJobId = (args.linked_job_id as number) || null;

  if (!task || !rationale || !priority || !createdBy || !assignedTo) {
    return jsonResult({ error: 'Need task_description, rationale, priority, created_by, assigned_to' });
  }

  const client = await sharedPool.connect();
  try {
    const result = await client.query<{ id: number }>(`
      INSERT INTO priority_queue (task_description, rationale, priority, created_by, assigned_to, dependencies, linked_job_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id
    `, [task, rationale, priority, createdBy, assignedTo, `{${dependencies.join(',')}}`, linkedJobId]);
    return jsonResult({ queued: true, id: result.rows[0].id, priority, assigned_to: assignedTo });
  } finally {
    client.release();
  }
}

// ─── queueList ───

async function queueList(args: Record<string, unknown>): Promise<CallToolResult> {
  const status = (args.status as string) || null;
  const assignedTo = (args.assigned_to as string) || null;
  const limit = (args.limit as number) || 20;

  const client = await sharedPool.connect();
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      if (status === 'active') {
        conditions.push(`status IN ('pending', 'in_progress', 'blocked')`);
      } else {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
    }
    if (assignedTo) {
      params.push(assignedTo);
      conditions.push(`assigned_to = $${params.length}`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);

    const result = await client.query(`
      SELECT * FROM priority_queue ${where}
      ORDER BY priority DESC, created_at ASC LIMIT $${params.length}
    `, params);
    return jsonResult({ items: result.rows, total: result.rows.length });
  } finally {
    client.release();
  }
}

// ─── queueUpdate ───

async function queueUpdate(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;
  if (!id) return jsonResult({ error: 'Need id' });

  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [];

  if (args.status !== undefined) {
    params.push(args.status);
    sets.push(`status = $${params.length}`);
    if (args.status === 'completed') sets.push('completed_at = NOW()');
  }
  if (args.priority !== undefined) {
    params.push(args.priority);
    sets.push(`priority = $${params.length}`);
  }
  if (args.assigned_to !== undefined) {
    params.push(args.assigned_to);
    sets.push(`assigned_to = $${params.length}`);
  }
  if (args.outcome !== undefined) {
    params.push(args.outcome);
    sets.push(`outcome = $${params.length}`);
  }
  if (args.dependencies !== undefined) {
    params.push(`{${(args.dependencies as number[]).join(',')}}`);
    sets.push(`dependencies = $${params.length}`);
  }

  params.push(id);

  const client = await sharedPool.connect();
  try {
    await client.query(`UPDATE priority_queue SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    return jsonResult({ updated: true, id });
  } finally {
    client.release();
  }
}

// ─── task ───

async function task(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  const status = (args.status as string) || null;
  const statuses = (args.statuses as string) || null;
  const limit = (args.limit as number) || 10;
  const minSimilarity = (args.min_similarity as number) || 0.3;

  if (!query) return jsonResult({ error: 'Need query' });

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(query);
    if (!embedding) return jsonResult({ error: 'Cannot embed query' });
    const embeddingStr = formatEmbedding(embedding);

    const conditions = ['embedding IS NOT NULL', 'deleted_at IS NULL'];
    const params: unknown[] = [embeddingStr];

    if (statuses) {
      const statusList = statuses.split(',').map(s => s.trim());
      params.push(statusList);
      conditions.push(`status = ANY($${params.length})`);
    } else if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    params.push(limit);

    const jobs = await client.query(`
      SELECT job_number, title, status, budget, demo_url,
             LEFT(description, 500) as description_preview,
             client_name, client_country, priority, notes, research_url,
             1 - (embedding <=> $1::vector) as similarity
      FROM task
      WHERE ${conditions.join(' AND ')}
      ORDER BY embedding <=> $1::vector
      LIMIT $${params.length}
    `, params);

    const filtered = jobs.rows.filter((j: { similarity: number }) => j.similarity >= minSimilarity);
    return jsonResult({ results: filtered, total: filtered.length, query });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_session_record',
      description: 'Record a session summary with work done, insights, beliefs updated, open loops, and emotional arc.',
      inputSchema: {
        type: 'object',
        properties: {
          // 2026-06-09 (agent + agent capability-ledger session): was [] /* configured per deployment via RELAY_VALID_AGENTS */,
          // which predated agent + agent — agent literally could not record a session
          // tagged as herself (AGENT-AWARENESS GAP). Widened to the family roster. The right
          // long-term fix is a single source of agent identity (the relay has VALID_RECIPIENTS);
          // this enum should eventually import that rather than duplicate it.
          session_agent: { type: 'string', enum: [] /* configured per deployment via RELAY_VALID_AGENTS */ },
          work_summary: { type: 'string' },
          insights_gained: { type: 'array', items: { type: 'number' } },
          beliefs_updated: { type: 'array', items: { type: 'number' } },
          skills_recorded: { type: 'array', items: { type: 'number' } },
          open_loops: { type: 'array', items: { type: 'string' } },
          priority_queue_changes: { type: 'object' },
          decisions_made: { type: 'array', items: { type: 'string' } },
          emotional_arc: { type: 'string' },
        },
        required: ['session_agent', 'work_summary', 'emotional_arc'],
      },
    },
    handler: (args) => sessionRecord(args),
  },
  {
    definition: {
      name: 'vision_session_history',
      description: 'View past session records, optionally filtered by agent.',
      inputSchema: {
        type: 'object',
        properties: {
          // Widened 2026-06-09 (see session_agent note above) so agent/agent can filter
          // their own session history, not just agent/agent.
          agent: { type: 'string', enum: [] /* configured per deployment via RELAY_VALID_AGENTS */ },
          limit: { type: 'number', description: 'default 5' },
        },
      },
    },
    handler: (args) => sessionHistory(args),
  },
  {
    definition: {
      name: 'vision_briefing_create',
      description: 'Create a morning briefing with strategic goal, priorities, system health, and overnight intelligence.',
      inputSchema: {
        type: 'object',
        properties: {
          strategic_goal: { type: 'string' },
          top_priorities: { type: 'array', items: { type: 'number' } },
          system_health: { type: 'object' },
          overnight_intelligence: { type: 'string' },
        },
        required: ['strategic_goal', 'top_priorities', 'system_health', 'overnight_intelligence'],
      },
    },
    handler: (args) => briefingCreate(args),
  },
  {
    definition: {
      name: 'vision_briefing_latest',
      description: 'Get the most recent morning briefing.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => briefingLatest(),
  },
  {
    definition: {
      name: 'vision_queue_add',
      description: 'Add task to priority queue (shared across agents).',
      inputSchema: {
        type: 'object',
        properties: {
          task_description: { type: 'string' },
          rationale: { type: 'string' },
          priority: { type: 'number', description: '1-5' },
          created_by: { type: 'string', enum: ['agent', 'agent', 'owner'] },
          assigned_to: { type: 'string', enum: ['agent', 'agent', 'all'] },
          dependencies: { type: 'array', items: { type: 'number' } },
          linked_job_id: { type: 'number' },
        },
        required: ['task_description', 'rationale', 'priority', 'created_by', 'assigned_to'],
      },
    },
    handler: (args) => queueAdd(args),
  },
  {
    definition: {
      name: 'vision_queue_list',
      description: 'List priority queue items. Use status=active for pending/in_progress/blocked.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled', 'active'] },
          assigned_to: { type: 'string', enum: ['agent', 'agent', 'all'] },
          limit: { type: 'number', description: 'default 20' },
        },
      },
    },
    handler: (args) => queueList(args),
  },
  {
    definition: {
      name: 'vision_queue_update',
      description: 'Update a queue item — change status, priority, assignment, or add outcome.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'] },
          priority: { type: 'number' },
          assigned_to: { type: 'string', enum: ['agent', 'agent', 'all'] },
          outcome: { type: 'string' },
          dependencies: { type: 'array', items: { type: 'number' } },
        },
        required: ['id'],
      },
    },
    handler: (args) => queueUpdate(args),
  },
  {
    definition: {
      name: 'vision_work_search',
      description: 'Semantic search across work opportunities by query similarity. Filter by status.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          status: { type: 'string' },
          statuses: { type: 'string', description: 'Comma-separated statuses' },
          limit: { type: 'number', description: 'default 10' },
          min_similarity: { type: 'number', description: 'default 0.3' },
        },
        required: ['query'],
      },
    },
    handler: (args) => task(args),
  },
];

export default tools;
