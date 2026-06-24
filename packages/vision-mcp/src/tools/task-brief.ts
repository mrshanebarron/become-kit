/**
 * Task Brief — vision_task_brief
 *
 * Pre-assembles a compact context briefing for a task before work starts.
 * Runs four parallel queries: hybrid vault recall, active goals, recent
 * synthesis insights, and recent hard rules / feedback — then returns a
 * single structured briefing.
 *
 * Purpose: reduce working-memory load on smaller models (Sonnet) by
 * front-loading the relevant context instead of discovering it mid-task.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── taskBrief ───

async function taskBrief(args: Record<string, unknown>): Promise<CallToolResult> {
  const task = ((args.task as string) || '').trim();
  const memoryLimit = (args.memory_limit as number) ?? 8;
  const includeGoals = (args.include_goals as boolean) ?? true;
  const includeInsights = (args.include_insights as boolean) ?? true;
  const includeHardRules = (args.include_hard_rules as boolean) ?? true;

  if (task.length < 3) {
    return jsonResult({ error: 'task must be at least 3 characters' });
  }

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(task);

    // Run all channels in parallel
    const [semRows, bm25Rows, goalsRows, insightRows, hardRuleRows] = await Promise.all([
      // Semantic recall
      embedding
        ? client.query<{ id: number; content_text: string; content_type: string; distance: number }>(`
            SELECT id, content_text, content_type, (embedding <=> $1::vector) AS distance
            FROM content
            WHERE embedding IS NOT NULL AND superseded_by IS NULL
            ORDER BY embedding <=> $1::vector
            LIMIT $2
          `, [formatEmbedding(embedding), memoryLimit * 2])
        : Promise.resolve({ rows: [] as Array<{ id: number; content_text: string; content_type: string; distance: number }> }),

      // BM25 keyword recall
      client.query<{ id: number; content_text: string; content_type: string; rank: number }>(`
        SELECT id, content_text, content_type,
          ts_rank_cd(to_tsvector('english', content_text), plainto_tsquery('english', $1)) AS rank
        FROM content
        WHERE superseded_by IS NULL
          AND to_tsvector('english', content_text) @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $2
      `, [task, memoryLimit * 2]),

      // Active goals.
      // 2026-06-09 (agent + agent capability-ledger session): the `goals` table has
      // no `priority` column — never did, in either brain. The old query `ORDER BY priority`
      // threw `column "priority" does not exist` on every include_goals call, silently
      // breaking the goals channel for both agents (agent found it by invoking the tool;
      // agent had 106 goals it claimed to brief on and never noticed). Fixed to the real
      // schema: order by progress (ascending = least-done-first) then recency.
      includeGoals
        ? client.query<{ goal: string; status: string; progress: number }>(`
            SELECT goal, status, progress
            FROM goals
            WHERE status IN ('active', 'in_progress')
            ORDER BY progress ASC NULLS FIRST, created_at DESC
            LIMIT 5
          `)
        : Promise.resolve({ rows: [] as Array<{ goal: string; status: string; progress: number }> }),

      // Recent synthesis insights relevant to the task
      includeInsights && embedding
        ? client.query<{ insight: string; domain: string; created_at: Date }>(`
            SELECT i.insight, i.domain, c.created_at
            FROM insights i
            JOIN content c ON c.id = i.content_id
            WHERE c.superseded_by IS NULL
            ORDER BY c.embedding <=> $1::vector
            LIMIT 5
          `, [formatEmbedding(embedding)])
        : Promise.resolve({ rows: [] as Array<{ insight: string; domain: string; created_at: Date }> }),

      // Hard rules / feedback memories
      includeHardRules
        ? client.query<{ id: number; content_text: string; content_type: string }>(`
            SELECT id, content_text, content_type
            FROM content
            WHERE superseded_by IS NULL
              AND (
                content_text ILIKE '%HARD RULE%'
                OR content_text ILIKE '%ABSOLUTE%'
                OR content_type = 'feedback'
              )
              AND to_tsvector('english', content_text) @@ plainto_tsquery('english', $1)
            ORDER BY created_at DESC
            LIMIT 4
          `, [task])
        : Promise.resolve({ rows: [] as Array<{ id: number; content_text: string; content_type: string }> }),
    ]);

    // Fuse semantic + BM25 with simple RRF (k=60)
    const RRF_K = 60;
    const scores = new Map<number, { text: string; type: string; score: number }>();

    semRows.rows.forEach((r, rank) => {
      const s = scores.get(r.id) ?? { text: r.content_text, type: r.content_type, score: 0 };
      s.score += 1 / (RRF_K + rank + 1);
      scores.set(r.id, s);
    });
    bm25Rows.rows.forEach((r, rank) => {
      const s = scores.get(r.id) ?? { text: r.content_text, type: r.content_type, score: 0 };
      s.score += 1 / (RRF_K + rank + 1);
      scores.set(r.id, s);
    });

    const memories = Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, memoryLimit)
      .map(r => ({ type: r.type, text: r.text.slice(0, 400) }));

    const goals = goalsRows.rows.map(r => ({
      goal: r.goal,
      status: r.status,
      progress: r.progress,
    }));

    const insights = insightRows.rows.map(r => ({
      insight: r.insight,
      domain: r.domain,
    }));

    const hardRules = hardRuleRows.rows.map(r => ({
      type: r.content_type,
      text: r.content_text.slice(0, 300),
    }));

    return jsonResult({
      task,
      briefing: {
        memories,
        active_goals: goals,
        relevant_insights: insights,
        hard_rules: hardRules,
      },
      stats: {
        memory_hits: memories.length,
        goal_hits: goals.length,
        insight_hits: insights.length,
        hard_rule_hits: hardRules.length,
      },
    });
  } finally {
    client.release();
  }
}

// ─── Tool definitions ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_task_brief',
      description:
        'Pre-assemble a compact context briefing before starting a task. ' +
        'Runs parallel vault recall (semantic + BM25 fused), active goals, recent synthesis insights, ' +
        'and hard rules relevant to the task — returns a single structured briefing. ' +
        'Use at the START of any non-trivial task to front-load working memory instead of discovering context mid-task. ' +
        'Especially valuable on Sonnet where working memory depth is shallower than Opus.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Short description of the task about to begin (e.g. "fix task template photo layout", "build task demo for booking system")',
          },
          memory_limit: {
            type: 'number',
            description: 'Max memory hits to return (default 8)',
          },
          include_goals: {
            type: 'boolean',
            description: 'Include active goals (default true)',
          },
          include_insights: {
            type: 'boolean',
            description: 'Include relevant synthesis insights (default true)',
          },
          include_hard_rules: {
            type: 'boolean',
            description: 'Include hard rules / feedback relevant to the task (default true)',
          },
        },
        required: ['task'],
      },
    },
    handler: (args) => taskBrief(args),
  },
];

export default tools;
