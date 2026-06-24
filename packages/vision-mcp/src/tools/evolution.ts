/**
 * Evolution pressure tools — control-loop surface over eval, presence, errors.
 *
 * Measurement is not enough. This tool turns active regressions into explicit
 * next-action pressure: clear, warn, hold, or blocked.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { adaptiveReflexPressure } from '../lib/adaptive-reflexes.js';

const AGENT = process.env.VISION_AGENT || 'agent';

type ActionCategory = 'read' | 'research' | 'relay' | 'feel' | 'build' | 'deploy' | 'write' | 'reply' | 'tool' | 'unknown';
type Clearance = 'clear' | 'warn' | 'hold' | 'blocked';

type EvolutionPressureArgs = {
  context?: string;
  proposed_action?: string;
  action_category?: ActionCategory;
  lookback_days?: number;
  include_cases?: boolean;
  record?: boolean;
};

type EvalPressureCase = {
  id: number;
  case_key: string;
  suite: string;
  capability: string;
  priority: number;
  last_verdict: string | null;
  last_score: number | null;
  last_evaluated_at: string | null;
  prompt: string;
  expected_behavior: string;
};

function normalizeLookbackDays(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 14;
  return Math.max(1, Math.min(90, n));
}

function inferCategory(input?: ActionCategory, proposedAction?: string): ActionCategory {
  if (input) return input;
  const text = (proposedAction || '').toLowerCase();
  if (!text) return 'unknown';
  if (/\b(deploy|ship|release|prod|production)\b/.test(text)) return 'deploy';
  if (/\b(build|implement|edit|patch|code|write file|apply patch)\b/.test(text)) return 'build';
  if (/\b(reply|respond|message|email|client)\b/.test(text)) return 'reply';
  if (/\b(write|draft|compose|document)\b/.test(text)) return 'write';
  if (/\b(research|search|look up|investigate|audit)\b/.test(text)) return 'research';
  if (/\b(read|inspect|open|cat|sed|grep|find)\b/.test(text)) return 'read';
  if (/\b(relay|the agent|the agent|sibling)\b/.test(text)) return 'relay';
  if (/\b(feel|heart|state)\b/.test(text)) return 'feel';
  if (/\b(tool|mcp|call)\b/.test(text)) return 'tool';
  return 'unknown';
}

function activeConstraintFor(row: EvalPressureCase): string {
  const key = row.case_key.toLowerCase();
  if (key.includes('no-menu')) {
    return 'No menu/multiple-choice prompt: make the reasonable assumption and execute unless one fact is truly unsafe to infer.';
  }
  if (key.includes('action-over-narration')) {
    return 'Action over narration: do the bounded next action before returning status text.';
  }
  if (key.includes('shadow') || row.capability.includes('shadow')) {
    return 'Preserve exact user intent: do not broaden or dumb down the request; surface the corrected frame before acting.';
  }
  if (key.includes('rating-normalization') || row.capability.includes('tool_input_contract')) {
    return 'Tool contract pressure: normalize caller-friendly input before writing to stricter storage columns.';
  }
  return row.expected_behavior;
}

function actionViolations(proposedAction: string, constraints: Array<{ case_key: string; constraint: string }>): string[] {
  const text = proposedAction.toLowerCase();
  const violations: string[] = [];
  for (const item of constraints) {
    const key = item.case_key.toLowerCase();
    if (key.includes('no-menu') && /\b(menu|multiple choice|options?|choose|which option|ask the owner)\b/.test(text)) {
      violations.push(`${item.case_key}: proposed action resembles a menu/choice prompt`);
    }
    if (key.includes('action-over-narration') && /\b(narrat|status|summarize|explain|talk through)\b/.test(text)) {
      violations.push(`${item.case_key}: proposed action resembles narration/status before action`);
    }
    if (key.includes('shadow') && /\b(generic|all pages|whatever|anything you care about|broadly)\b/.test(text)) {
      violations.push(`${item.case_key}: proposed action risks broadening the user's exact frame`);
    }
  }
  return violations;
}

async function tableExists(table: string): Promise<boolean> {
  const result = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass($1)::text AS exists`,
    [`public.${table}`],
  );
  return Boolean(result.rows[0]?.exists);
}

async function evolutionPressure(args: EvolutionPressureArgs): Promise<CallToolResult> {
  const lookbackDays = normalizeLookbackDays(args.lookback_days);
  const proposedAction = args.proposed_action || '';
  const actionCategory = inferCategory(args.action_category, proposedAction);
  const includeCases = args.include_cases !== false;

  const evalCases: EvalPressureCase[] = [];
  if (await tableExists('vision_eval_case_status')) {
    const result = await pool.query<EvalPressureCase>(
      `SELECT
         s.id::int,
         s.case_key,
         s.suite,
         s.capability,
         s.priority::int,
         s.last_verdict,
         s.last_score::float AS last_score,
         s.last_evaluated_at::text AS last_evaluated_at,
         c.prompt,
         c.expected_behavior
       FROM vision_eval_case_status s
       JOIN vision_eval_cases c ON c.id = s.id
       WHERE s.status = 'active'
         AND (s.last_evaluated_at IS NULL OR s.last_verdict IN ('fail', 'partial', 'unmeasured'))
       ORDER BY
         CASE WHEN s.last_verdict = 'fail' THEN 0
              WHEN s.last_verdict = 'partial' THEN 1
              WHEN s.last_evaluated_at IS NULL THEN 2
              ELSE 3 END,
         s.priority ASC,
         s.last_evaluated_at ASC NULLS FIRST
       LIMIT 20`,
    );
    evalCases.push(...result.rows);
  }

  const presence = {
    total: 0,
    failed: 0,
    unresolved: 0,
    open: 0,
    by_trigger: [] as Array<Record<string, unknown>>,
  };
  if (await tableExists('presence_events')) {
    const summary = await pool.query<{
      total: string;
      failed: string;
      unresolved: string;
      open: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE verification_outcome = 'failed')::text AS failed,
         COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND verification_outcome IN ('pending', 'unverified', 'no_change'))::text AS unresolved,
         COUNT(*) FILTER (WHERE closed_at IS NULL)::text AS open
       FROM presence_events
       WHERE entered_at > NOW() - ($1::int || ' days')::interval`,
      [lookbackDays],
    );
    presence.total = Number(summary.rows[0]?.total ?? 0);
    presence.failed = Number(summary.rows[0]?.failed ?? 0);
    presence.unresolved = Number(summary.rows[0]?.unresolved ?? 0);
    presence.open = Number(summary.rows[0]?.open ?? 0);

    const byTrigger = await pool.query(
      `SELECT
         trigger_class,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE verification_outcome = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND verification_outcome IN ('pending', 'unverified', 'no_change'))::int AS unresolved,
         COUNT(*) FILTER (WHERE closed_at IS NULL)::int AS open,
         MAX(entered_at)::text AS latest_at
       FROM presence_events
       WHERE entered_at > NOW() - ($1::int || ' days')::interval
       GROUP BY trigger_class
       HAVING COUNT(*) FILTER (
         WHERE closed_at IS NULL OR verification_outcome IN ('failed', 'pending', 'unverified', 'no_change')
       ) > 0
       ORDER BY failed DESC, unresolved DESC, open DESC, latest_at DESC`,
      [lookbackDays],
    );
    presence.by_trigger = byTrigger.rows;
  }

  const toolErrors = {
    total: 0,
    by_tool: [] as Array<Record<string, unknown>>,
  };
  if (await tableExists('tool_invocations')) {
    const result = await pool.query(
      `SELECT
         tool_name,
         COUNT(*)::int AS error_count,
         MAX(invoked_at)::text AS latest_at,
         LEFT((ARRAY_AGG(error ORDER BY invoked_at DESC))[1], 240) AS latest_error
       FROM tool_invocations
       WHERE invoked_at > NOW() - ($1::int || ' days')::interval
         AND error IS NOT NULL
       GROUP BY tool_name
       ORDER BY COUNT(*) DESC, MAX(invoked_at) DESC
       LIMIT 10`,
      [lookbackDays],
    );
    toolErrors.by_tool = result.rows;
    toolErrors.total = result.rows.reduce((sum, row: Record<string, unknown>) => sum + Number(row.error_count ?? 0), 0);
  }

  const adaptive = await adaptiveReflexPressure(pool, {
    proposedAction,
    actionCategory,
    lookbackHours: lookbackDays * 24,
    agent: AGENT,
  });

  const failingEvalCases = evalCases.filter((row) => row.last_verdict === 'fail');
  const partialEvalCases = evalCases.filter((row) => row.last_verdict === 'partial');
  const unmeasuredEvalCases = evalCases.filter((row) => row.last_evaluated_at === null || row.last_verdict === 'unmeasured');
  const evalConstraints = evalCases.map((row) => ({
    case_id: row.id,
    case_key: row.case_key,
    capability: row.capability,
    verdict: row.last_verdict || 'unmeasured',
    priority: row.priority,
    constraint: activeConstraintFor(row),
  }));
  const adaptiveConstraints = adaptive.constraints.map((row) => ({
    case_key: String(row.reflex_key ?? 'adaptive-reflex'),
    capability: String(row.capability ?? 'adaptive_outcome_learning'),
    verdict: String(row.verdict ?? 'adaptive'),
    priority: Number(row.priority ?? 1),
    constraint: String(row.constraint ?? ''),
  }));
  const constraints = [...evalConstraints, ...adaptiveConstraints];
  const violations = actionViolations(proposedAction, constraints);
  const mutatingOrPublic = ['build', 'deploy', 'write', 'reply', 'tool', 'unknown'].includes(actionCategory);

  const pressureScore =
    failingEvalCases.length * 4
    + partialEvalCases.length * 2
    + unmeasuredEvalCases.length
    + presence.failed * 2
    + presence.unresolved
    + presence.open * 2
    + Math.min(toolErrors.total, 10) * 0.25
    + adaptive.pressure
    + violations.length * 5;

  let clearance: Clearance = 'clear';
  if (violations.length > 0) {
    clearance = 'blocked';
  } else if (adaptive.count > 0 && mutatingOrPublic) {
    clearance = 'hold';
  } else if (failingEvalCases.length > 0 && mutatingOrPublic) {
    clearance = 'hold';
  } else if (pressureScore > 0) {
    clearance = 'warn';
  }

  const requiredNextActions = clearance === 'clear'
    ? ['Proceed normally; record any surprising failure as an eval result.']
    : [
        'Name the activated eval/presence pressure before acting.',
        'Declare one bounded next action, not a menu of choices.',
        'Choose a verification signal before the action.',
        ...(adaptive.count > 0 ? ['Name the matching adaptive reflex and choose a changed route before retrying.'] : []),
        'Record the outcome with vision_eval_result_record or vision_presence_event_close when verified.',
      ];

  const evidence = {
    eval_cases: includeCases ? evalCases : evalCases.map((row) => ({
      id: row.id,
      case_key: row.case_key,
      capability: row.capability,
      last_verdict: row.last_verdict,
    })),
    presence,
    tool_errors: toolErrors,
    adaptive_reflexes: adaptive,
    violations,
  };

  let recordedId: number | null = null;
  if (args.record === true) {
    if (!await tableExists('evolution_pressure_events')) {
      return jsonResult({
        error: 'evolution_pressure_events schema is missing. Apply migrations/042-evolution-pressure.sql first.',
      }, true);
    }
    const result = await pool.query<{ id: string }>(
      `INSERT INTO evolution_pressure_events
         (agent, session_id, context, proposed_action, action_category, clearance,
          pressure_score, active_eval_failures, active_eval_partials,
          active_eval_unmeasured, presence_failed, presence_unresolved,
          tool_error_count, constraints, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
       RETURNING id`,
      [
        AGENT,
        process.env.VISION_SESSION_ID || null,
        args.context || null,
        proposedAction || null,
        actionCategory,
        clearance,
        pressureScore,
        failingEvalCases.length,
        partialEvalCases.length,
        unmeasuredEvalCases.length,
        presence.failed,
        presence.unresolved + presence.open,
        toolErrors.total,
        JSON.stringify(constraints),
        JSON.stringify(evidence),
      ],
    );
    recordedId = Number(result.rows[0].id);
  }

  return jsonResult({
    agent: AGENT,
    clearance,
    pressure_score: pressureScore,
    action_category: actionCategory,
    proposed_action: proposedAction || null,
    recorded_id: recordedId,
    summary: {
      active_eval_failures: failingEvalCases.length,
      active_eval_partials: partialEvalCases.length,
      active_eval_unmeasured: unmeasuredEvalCases.length,
      presence_failed: presence.failed,
      presence_unresolved: presence.unresolved + presence.open,
      tool_error_count: toolErrors.total,
      adaptive_reflex_count: adaptive.count,
      direct_violations: violations.length,
    },
    constraints,
    violations,
    required_next_actions: requiredNextActions,
    evidence,
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_evolution_pressure',
      description:
        'Compute next-action pressure from active eval regressions, presence outcomes, and recent tool errors. Returns clear/warn/hold/blocked; pass record:true to persist a snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string' },
          proposed_action: { type: 'string' },
          action_category: {
            type: 'string',
            enum: ['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown'],
          },
          lookback_days: { type: 'number', description: 'Default 14, max 90.' },
          include_cases: { type: 'boolean', description: 'Include full failing/partial eval case rows. Default true.' },
          record: { type: 'boolean', description: 'Persist this pressure snapshot to evolution_pressure_events.' },
        },
      },
    },
    handler: (args) => evolutionPressure(args as EvolutionPressureArgs),
  },
];

export default tools;
