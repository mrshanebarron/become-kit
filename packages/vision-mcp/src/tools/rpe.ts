/**
 * Reward Prediction Error (RPE) Tools — phasic dopamine teaching signal
 *
 * The neuroscience: Phasic dopamine encodes a reward prediction error
 *   δ = r + γ·V(s′) − V(s)
 * that drives credit assignment across cortico-striatal loops. Not the
 * same as a "feeling" (heart valence/arousal) or a "decision outcome"
 * (somatic marker) — δ is a clean scalar teaching signal attributable
 * to specific prior actions and beliefs.
 *
 * Why Vision needs it as a first-class organ:
 *   - desire.ts already models the wanting-vs-liking split (mesolimbic
 *     phenomenology — "I wanted more than I liked")
 *   - predictions table tracks arbitrary-claim accuracy
 *   - neither gives a domain-aggregated teaching signal that says
 *     "actions in domain X on average paid off by +0.3 — keep doing"
 *
 * Sign convention:
 *   δ > 0 : positive surprise (outcome better than expected; reinforce)
 *   δ < 0 : negative surprise (outcome worse than expected; update down)
 *   δ = 0 : expectation met (no learning signal)
 *
 * Sources of value:
 *   - goals.status='completed' + reflection/progress → observed_value
 *   - desires satisfied with satisfaction score
 *   - work_opportunities.phase -> demo_complete with audit_pass
 *   - manual: for events not yet automatically captured
 *
 * Consumers:
 *   - beliefs in credited_beliefs get confidence nudged by α·δ
 *   - domain summary informs intent-setting ("this domain pays off")
 *   - workspace can broadcast high-magnitude δ events for meta-learning
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { eligibleActionsForCredit } from '../lib/adaptive-reflexes.js';

const AGENT = process.env.VISION_AGENT || 'agent';

// ─── Helper: insert one RPE row ───

async function insertRpe(params: {
  source_type: string;
  source_id: number | null;
  source_label: string | null;
  expected_value: number;
  observed_value: number;
  domain: string | null;
  context_content_id: number | null;
  credited_beliefs: number[];
  credited_actions: unknown[];
  notes: string | null;
}): Promise<{ id: number; delta: number; magnitude: number }> {
  const delta = params.observed_value - params.expected_value;
  const magnitude = Math.abs(delta);
  const creditedActions = params.credited_actions.length > 0
    ? params.credited_actions
    : await eligibleActionsForCredit(pool, {
        agent: AGENT,
        actionCategory: params.domain,
        lookbackSeconds: 1800,
        minWeight: magnitude >= 0.3 ? 0.03 : 0.08,
      });

  const client = await pool.connect();
  try {
    const res = await client.query<{ id: number }>(`
      INSERT INTO reward_prediction_errors
        (source_type, source_id, source_label, expected_value, observed_value,
         delta, magnitude, domain, context_content_id, credited_beliefs, credited_actions, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
      RETURNING id
    `, [
      params.source_type,
      params.source_id,
      params.source_label,
      params.expected_value,
      params.observed_value,
      delta,
      magnitude,
      params.domain,
      params.context_content_id,
      JSON.stringify(params.credited_beliefs),
      JSON.stringify(creditedActions),
      params.notes,
    ]);

    return { id: res.rows[0].id, delta, magnitude };
  } finally {
    client.release();
  }
}

// ─── rpeRecord ───
// Manual RPE entry. Used when a rewarding event doesn't fit a scanner.
async function rpeRecord(args: Record<string, unknown>): Promise<CallToolResult> {
  const expected_value = args.expected_value as number;
  const observed_value = args.observed_value as number;
  if (typeof expected_value !== 'number' || typeof observed_value !== 'number') {
    return jsonResult({ error: 'expected_value and observed_value required (0..1)' });
  }
  if (expected_value < 0 || expected_value > 1 || observed_value < 0 || observed_value > 1) {
    return jsonResult({ error: 'expected_value and observed_value must be in [0, 1]' });
  }

  const result = await insertRpe({
    source_type: (args.source_type as string) || 'manual',
    source_id: (args.source_id as number) ?? null,
    source_label: (args.source_label as string) || null,
    expected_value,
    observed_value,
    domain: (args.domain as string) || null,
    context_content_id: (args.context_content_id as number) ?? null,
    credited_beliefs: (args.credited_beliefs as number[]) || [],
    credited_actions: (args.credited_actions as unknown[]) || [],
    notes: (args.notes as string) || null,
  });

  return jsonResult({
    rpe_id: result.id,
    delta: Number(result.delta.toFixed(3)),
    magnitude: Number(result.magnitude.toFixed(3)),
    sign: result.delta > 0 ? 'positive' : result.delta < 0 ? 'negative' : 'zero',
    interpretation:
      result.magnitude < 0.1 ? 'expectation met — no strong teaching signal' :
      result.delta > 0.3 ? 'strong positive surprise — reinforce the credited actions/beliefs' :
      result.delta < -0.3 ? 'strong negative surprise — downweight the credited beliefs' :
      result.delta > 0 ? 'mild positive surprise' : 'mild negative surprise',
  });
}

// ─── rpeOnGoalComplete ───
// Scan goals completed since last run and compute δ for each.
// Expected value is derived from the goal's recorded confidence (if any)
// or defaults to 0.5. Observed value comes from the reflection field if
// present (parsed for success markers) or from the completion itself.
async function rpeOnGoalComplete(args: Record<string, unknown>): Promise<CallToolResult> {
  const lookbackMinutes = (args.lookback_minutes as number) ?? 1440;  // default 24h
  const defaultExpected = (args.default_expected as number) ?? 0.5;

  const client = await pool.connect();
  const created: Array<Record<string, unknown>> = [];

  try {
    // Find completed goals we haven't recorded RPE for yet
    const goalsRes = await client.query<{
      id: number;
      goal: string;
      domain: string | null;
      progress: number | null;
      reflection: string | null;
      completed_at: string;
      content_id: number | null;
    }>(`
      SELECT g.id, g.goal, g.domain, g.progress, g.reflection, g.completed_at, g.content_id
      FROM goals g
      WHERE g.status = 'completed'
        AND g.completed_at > NOW() - ($1 || ' minutes')::interval
        AND NOT EXISTS (
          SELECT 1 FROM reward_prediction_errors r
          WHERE r.source_type = 'goal' AND r.source_id = g.id
        )
      ORDER BY g.completed_at ASC
    `, [String(lookbackMinutes)]);

    for (const row of goalsRes.rows) {
      // Observed value: prefer progress/100 if set, else 1.0 for any completed goal
      const observed = row.progress != null && row.progress > 0
        ? Math.min(1.0, row.progress / 100)
        : 1.0;

      // Expected value: 0.5 default (we don't record prior confidence on goals today)
      const expected = defaultExpected;

      const result = await insertRpe({
        source_type: 'goal',
        source_id: row.id,
        source_label: row.goal.slice(0, 200),
        expected_value: expected,
        observed_value: observed,
        domain: row.domain,
        context_content_id: row.content_id,
        credited_beliefs: [],
        credited_actions: [],
        notes: row.reflection ? row.reflection.slice(0, 400) : null,
      });

      created.push({
        rpe_id: result.id,
        goal_id: row.id,
        goal: row.goal.slice(0, 80),
        domain: row.domain,
        delta: Number(result.delta.toFixed(3)),
      });
    }

    return jsonResult({
      scanned_minutes: lookbackMinutes,
      created_count: created.length,
      created,
    });
  } finally {
    client.release();
  }
}

// ─── rpeTimeline ───
async function rpeTimeline(args: Record<string, unknown>): Promise<CallToolResult> {
  const hours = (args.hours as number) ?? 24;
  const limit = (args.limit as number) ?? 100;
  const domain = (args.domain as string) || null;

  const client = await pool.connect();
  try {
    const res = await client.query<{
      id: number;
      computed_at: string;
      source_type: string;
      source_id: number | null;
      source_label: string | null;
      expected_value: number;
      observed_value: number;
      delta: number;
      magnitude: number;
      domain: string | null;
    }>(`
      SELECT id, computed_at, source_type, source_id, source_label,
             expected_value, observed_value, delta, magnitude, domain
      FROM reward_prediction_errors
      WHERE computed_at > NOW() - ($1 || ' hours')::interval
        AND ($2::text IS NULL OR domain = $2)
      ORDER BY computed_at DESC
      LIMIT $3
    `, [String(hours), domain, limit]);

    let sumDelta = 0, sumMag = 0, positive = 0, negative = 0;
    for (const row of res.rows) {
      sumDelta += row.delta;
      sumMag += row.magnitude;
      if (row.delta > 0) positive++;
      else if (row.delta < 0) negative++;
    }
    const n = res.rows.length;

    return jsonResult({
      window_hours: hours,
      domain_filter: domain,
      event_count: n,
      avg_delta: n > 0 ? Number((sumDelta / n).toFixed(3)) : null,
      avg_magnitude: n > 0 ? Number((sumMag / n).toFixed(3)) : null,
      positive_count: positive,
      negative_count: negative,
      events: res.rows,
    });
  } finally {
    client.release();
  }
}

// ─── rpeSummary ───
// Per-domain aggregate: which domains pay off, which don't.
async function rpeSummary(args: Record<string, unknown>): Promise<CallToolResult> {
  const hours = (args.hours as number) ?? 168;  // default 7 days

  const client = await pool.connect();
  try {
    const res = await client.query<{
      domain: string | null;
      n: number;
      avg_delta: number | null;
      avg_magnitude: number | null;
      positive: number;
      negative: number;
    }>(`
      SELECT
        domain,
        COUNT(*)::int AS n,
        AVG(delta)::real AS avg_delta,
        AVG(magnitude)::real AS avg_magnitude,
        COUNT(*) FILTER (WHERE delta > 0)::int AS positive,
        COUNT(*) FILTER (WHERE delta < 0)::int AS negative
      FROM reward_prediction_errors
      WHERE computed_at > NOW() - ($1 || ' hours')::interval
      GROUP BY domain
      ORDER BY AVG(delta) DESC NULLS LAST
    `, [String(hours)]);

    const rows = res.rows.map((r) => ({
      domain: r.domain || '(unlabeled)',
      events: r.n,
      avg_delta: r.avg_delta != null ? Number(r.avg_delta.toFixed(3)) : null,
      avg_magnitude: r.avg_magnitude != null ? Number(r.avg_magnitude.toFixed(3)) : null,
      positive: r.positive,
      negative: r.negative,
      interpretation:
        r.avg_delta == null ? 'no data' :
        r.avg_delta > 0.2 ? 'strongly positive — this domain pays off; keep doing' :
        r.avg_delta < -0.2 ? 'strongly negative — expectations here are too high; adjust' :
        'roughly calibrated',
    }));

    return jsonResult({
      window_hours: hours,
      domains: rows,
    });
  } finally {
    client.release();
  }
}

// ─── tools array ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_rpe_record',
      description:
        'Record a reward prediction error: δ = observed − expected. Values in [0, 1]. ' +
        'Use when an outcome resolves and the gap between expectation and reality is ' +
        'the useful signal. Source can be goal, desire, action, work_opportunity, or manual.',
      inputSchema: {
        type: 'object',
        properties: {
          expected_value: { type: 'number', description: 'Prior expectation in [0, 1]' },
          observed_value: { type: 'number', description: 'Actual outcome in [0, 1]' },
          source_type: { type: 'string', description: 'goal | desire | action | work_opportunity | manual' },
          source_id: { type: 'number', description: 'ID in source table if applicable' },
          source_label: { type: 'string', description: 'Human-readable what completed' },
          domain: { type: 'string', description: 'Optional domain tag' },
          context_content_id: { type: 'number', description: 'Linked content row' },
          credited_beliefs: { type: 'array', items: { type: 'number' }, description: 'Belief IDs to nudge' },
          credited_actions: { type: 'array', description: 'Action descriptors' },
          notes: { type: 'string' },
        },
        required: ['expected_value', 'observed_value'],
      },
    },
    handler: (args) => rpeRecord(args),
  },
  {
    definition: {
      name: 'vision_rpe_on_goal_complete',
      description:
        'Scan goals completed in the lookback window that do not yet have an RPE entry ' +
        'and record one for each. Expected value defaults to 0.5; observed derived from ' +
        'progress/reflection. Idempotent — existing RPEs are not duplicated.',
      inputSchema: {
        type: 'object',
        properties: {
          lookback_minutes: { type: 'number', description: 'How far back to scan (default 1440 = 24h)' },
          default_expected: { type: 'number', description: 'Prior expectation when none recorded (default 0.5)' },
        },
      },
    },
    handler: (args) => rpeOnGoalComplete(args),
  },
  {
    definition: {
      name: 'vision_rpe_timeline',
      description:
        'Recent RPE events with summary stats (avg delta, positive/negative counts). ' +
        'Optional domain filter.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback window (default 24)' },
          limit: { type: 'number', description: 'Max events (default 100)' },
          domain: { type: 'string', description: 'Filter by domain' },
        },
      },
    },
    handler: (args) => rpeTimeline(args),
  },
  {
    definition: {
      name: 'vision_rpe_summary',
      description:
        'Per-domain aggregate: which domains produce positive surprise (pay off), ' +
        'which produce negative (over-confident expectations), which are calibrated. ' +
        'Use at wake or when deciding where to allocate attention.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback window (default 168 = 7 days)' },
        },
      },
    },
    handler: (args) => rpeSummary(args),
  },
];

export default tools;
