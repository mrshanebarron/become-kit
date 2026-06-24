import type { Pool } from 'pg';

export type ActionCategory = 'read' | 'research' | 'relay' | 'feel' | 'build' | 'deploy' | 'write' | 'reply' | 'tool' | 'unknown';

export type AdaptiveReflexPressure = {
  count: number;
  pressure: number;
  reflexes: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
};

export type CreditedAction = {
  trace_key: string;
  tool_name: string | null;
  weight: number;
  tau_seconds: number;
  age_seconds: number;
};

export async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass($1)::text AS exists`,
    [`public.${table}`],
  );
  return Boolean(result.rows[0]?.exists);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function actionTerms(text: string): string[] {
  const stop = new Set(['this', 'that', 'with', 'from', 'your', 'have', 'will', 'into', 'next', 'action', 'prepare', 'learn']);
  return Array.from(new Set((text.toLowerCase().match(/[a-z0-9_-]{4,}/g) || [])
    .filter((term) => !stop.has(term.replace(/[_-]/g, '')))))
    .slice(0, 10);
}

export async function adaptiveReflexPressure(
  pool: Pool,
  args: {
    proposedAction: string;
    actionCategory: ActionCategory;
    lookbackHours: number;
    agent?: string;
    limit?: number;
  },
): Promise<AdaptiveReflexPressure> {
  if (!await tableExists(pool, 'adaptive_reflexes')) {
    return { count: 0, pressure: 0, reflexes: [], constraints: [] };
  }

  const terms = actionTerms(args.proposedAction);
  const limit = Math.max(1, Math.min(args.limit ?? 8, 20));
  const result = await pool.query(
    `SELECT
       id::int,
       reflex_key,
       trigger_kind,
       tool_name,
       action_category,
       capability,
       expected_behavior,
       occurrences::int,
       failure_count::int,
       success_count::int,
       salience::float,
       last_outcome,
       last_seen_at::text,
       evidence
     FROM adaptive_reflexes
     WHERE status = 'active'
       AND agent = COALESCE($4, agent)
       AND last_seen_at > NOW() - ($1::int || ' hours')::interval
       AND (
         action_category = $2
         OR (action_category = 'unknown' AND lower($3) LIKE '%' || lower(COALESCE(tool_name, '')) || '%')
         OR EXISTS (
           SELECT 1 FROM unnest($5::text[]) term
           WHERE lower(expected_behavior) LIKE '%' || lower(term) || '%'
              OR lower(reflex_key) LIKE '%' || lower(term) || '%'
         )
       )
     ORDER BY failure_count DESC, salience DESC, last_seen_at DESC
     LIMIT $6`,
    [args.lookbackHours, args.actionCategory, args.proposedAction, args.agent || null, terms, limit],
  );

  const reflexes = result.rows;
  const pressure = reflexes.reduce((sum, row) => {
    const failures = Number(row.failure_count ?? 0);
    const salience = Number(row.salience ?? 0);
    return sum + Math.min(6, salience * (1 + failures));
  }, 0);

  const constraints = reflexes.map((row) => ({
    reflex_id: row.id,
    reflex_key: row.reflex_key,
    capability: row.capability,
    verdict: 'adaptive',
    priority: Number(row.failure_count ?? 0) > 1 ? 0 : 1,
    constraint: row.expected_behavior,
  }));

  return {
    count: reflexes.length,
    pressure: round2(pressure),
    reflexes,
    constraints,
  };
}

export async function eligibleActionsForCredit(
  pool: Pool,
  args: {
    agent?: string;
    sessionId?: string | null;
    toolName?: string | null;
    actionCategory?: string | null;
    lookbackSeconds?: number;
    minWeight?: number;
    limit?: number;
  } = {},
): Promise<CreditedAction[]> {
  if (!await tableExists(pool, 'action_eligibility_traces')) return [];

  const lookbackSeconds = Math.max(30, Math.min(args.lookbackSeconds ?? 1800, 24 * 60 * 60));
  const minWeight = Math.max(0, Math.min(args.minWeight ?? 0.05, 1));
  const limit = Math.max(1, Math.min(args.limit ?? 8, 25));
  const result = await pool.query<CreditedAction>(
    `WITH weighted AS (
     SELECT
         trace_key,
         tool_name,
         decay_tau_seconds::int AS tau_seconds,
         EXTRACT(EPOCH FROM (NOW() - last_touched_at))::float AS age_seconds,
         LEAST(1, GREATEST(0, eligibility::float * EXP(
           -EXTRACT(EPOCH FROM (NOW() - started_at)) / GREATEST(decay_tau_seconds, 1)
         ))) AS weight
       FROM action_eligibility_traces
       WHERE status = 'open'
         AND expires_at > NOW()
         AND started_at > NOW() - ($1::int || ' seconds')::interval
         AND agent = COALESCE($2, agent)
         AND ($3::text IS NULL OR session_id = $3 OR session_id IS NULL)
         AND ($4::text IS NULL OR tool_name = $4)
         AND ($5::text IS NULL OR action_category = $5 OR action_category = 'unknown')
     )
     SELECT *
     FROM weighted
     WHERE weight >= $6
     ORDER BY weight DESC, age_seconds ASC
     LIMIT $7`,
    [
      lookbackSeconds,
      args.agent || null,
      args.sessionId || null,
      args.toolName || null,
      args.actionCategory || null,
      minWeight,
      limit,
    ],
  );
  return result.rows.map((row) => ({
    trace_key: row.trace_key,
    tool_name: row.tool_name,
    weight: Math.round(Number(row.weight ?? 0) * 1000) / 1000,
    tau_seconds: Number(row.tau_seconds ?? 0),
    age_seconds: Math.max(0, Math.round(Number(row.age_seconds ?? 0))),
  }));
}
