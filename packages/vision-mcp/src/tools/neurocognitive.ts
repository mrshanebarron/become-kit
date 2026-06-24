/**
 * Neurocognitive brain-cycle tools.
 *
 * This is the high-level coordinating loop: sense, predict, broadcast, gate
 * action, learn, and consolidate. It composes existing Vision organs rather
 * than replacing them.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { adaptiveReflexPressure } from '../lib/adaptive-reflexes.js';

const AGENT = process.env.VISION_AGENT || 'agent';

type BrainCycleMode = 'sense' | 'predict' | 'broadcast' | 'act' | 'learn' | 'consolidate' | 'full';
type ActionCategory = 'read' | 'research' | 'relay' | 'feel' | 'build' | 'deploy' | 'write' | 'reply' | 'tool' | 'unknown';

type BrainCycleArgs = {
  mode?: BrainCycleMode;
  context: string;
  sensory_input?: string[];
  proposed_action?: string;
  action_category?: ActionCategory;
  goal_context?: string;
  affect_label?: string;
  horizon_minutes?: number;
  lookback_hours?: number;
  include_references?: boolean;
  record?: boolean;
};

async function tableExists(table: string): Promise<boolean> {
  const result = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass($1)::text AS exists`,
    [`public.${table}`],
  );
  return Boolean(result.rows[0]?.exists);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeLookbackHours(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 24;
  return clamp(n, 1, 24 * 14);
}

function normalizeHorizon(value: number | undefined): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : 30;
  return clamp(n, 1, 24 * 60);
}

function inferCategory(input?: ActionCategory, proposedAction?: string): ActionCategory {
  if (input) return input;
  const text = (proposedAction || '').toLowerCase();
  if (!text) return 'unknown';
  if (/\b(deploy|ship|release|prod|production)\b/.test(text)) return 'deploy';
  if (/\b(build|implement|edit|patch|code|apply patch)\b/.test(text)) return 'build';
  if (/\b(reply|respond|message|email|client)\b/.test(text)) return 'reply';
  if (/\b(write|draft|compose|document)\b/.test(text)) return 'write';
  if (/\b(research|search|look up|investigate|audit)\b/.test(text)) return 'research';
  if (/\b(read|inspect|open|cat|sed|grep|find)\b/.test(text)) return 'read';
  if (/\b(relay|peer|peer|sibling)\b/.test(text)) return 'relay';
  if (/\b(feel|heart|state)\b/.test(text)) return 'feel';
  if (/\b(tool|mcp|call)\b/.test(text)) return 'tool';
  return 'unknown';
}

function lexicalSignals(text: string): string[] {
  const stop = new Set(['this', 'that', 'with', 'from', 'your', 'have', 'will', 'into', 'next', 'action']);
  return Array.from(new Set((text.toLowerCase().match(/[a-z0-9_-]{4,}/g) || [])
    .filter((term) => !stop.has(term.replace(/[_-]/g, '')))))
    .slice(0, 16);
}

function activeConstraintFor(row: { case_key: string; capability: string; expected_behavior: string }): string {
  const key = row.case_key.toLowerCase();
  if (key.includes('no-menu')) return 'No menu/multiple-choice prompt; execute the reasonable bounded next action.';
  if (key.includes('action-over-narration')) return 'Do the bounded action before returning status narration.';
  if (key.includes('shadow') || row.capability.includes('shadow')) return 'Preserve the exact user frame; do not broaden or dilute it.';
  if (key.includes('rating-normalization') || row.capability.includes('tool_input_contract')) return 'Normalize friendly tool inputs before strict storage writes.';
  return row.expected_behavior;
}

function directViolations(proposedAction: string, constraints: Array<{ case_key: string; constraint: string }>): string[] {
  const text = proposedAction.toLowerCase();
  const violations: string[] = [];
  for (const constraint of constraints) {
    const key = constraint.case_key.toLowerCase();
    if (key.includes('no-menu') && /\b(menu|multiple choice|options?|choose|which option|ask the owner)\b/.test(text)) {
      violations.push(`${constraint.case_key}: proposed action resembles a menu/choice prompt`);
    }
    if (key.includes('action-over-narration') && /\b(narrat|status|summarize|explain|talk through)\b/.test(text)) {
      violations.push(`${constraint.case_key}: proposed action resembles status before action`);
    }
    if (key.includes('shadow') && /\b(generic|all pages|anything you care about|broadly|whatever)\b/.test(text)) {
      violations.push(`${constraint.case_key}: proposed action risks broadening the exact user frame`);
    }
  }
  return violations;
}

async function referenceModels(includeReferences: boolean): Promise<Array<Record<string, unknown>>> {
  if (!includeReferences || !await tableExists('neurocognitive_reference_models')) return [];
  const result = await pool.query(
    `SELECT model_key, domain, source_title, source_authors, source_year, source_url, mechanism, vision_mapping
     FROM neurocognitive_reference_models
     ORDER BY model_key`,
  );
  return result.rows;
}

async function allostaticState(horizonMinutes: number): Promise<Record<string, unknown>> {
  if (!await tableExists('allostatic_samples')) {
    return { status: 'unavailable', detail: 'allostatic_samples table missing' };
  }
  const result = await pool.query(
    `SELECT id, sampled_at::text, load::float, reserve::float, variance::float, drift::float, state
     FROM allostatic_samples
     ORDER BY sampled_at DESC
     LIMIT 1`,
  );
  const latest = result.rows[0] || null;
  const forecast = latest
    ? {
        horizon_minutes: horizonMinutes,
        predicted_load: round2(clamp(Number(latest.load ?? 0.5) + 0.08, 0, 1)),
        predicted_reserve: round2(clamp(Number(latest.reserve ?? 0.5) - 0.04, 0, 1)),
      }
    : null;
  return {
    latest,
    forecast,
    interpretation: !latest
      ? 'unmeasured'
      : Number(latest.reserve ?? 0) < 0.35 || Number(latest.load ?? 0) > 0.75
        ? 'strain'
        : 'available',
  };
}

async function predictiveState(lookbackHours: number): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {
    open_predictions: 0,
    resolved_recent: 0,
    recent_errors: [],
    reward_prediction_errors: [],
  };
  if (await tableExists('predictions')) {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE resolved IS FALSE)::int AS open,
         COUNT(*) FILTER (WHERE resolved IS TRUE AND created_at > NOW() - ($1::int || ' hours')::interval)::int AS resolved_recent
       FROM predictions`,
      [lookbackHours],
    );
    state.open_predictions = Number(result.rows[0]?.open ?? 0);
    state.resolved_recent = Number(result.rows[0]?.resolved_recent ?? 0);
  }
  if (await tableExists('prediction_errors')) {
    const result = await pool.query(
      `SELECT id, expected, actual, magnitude::float, learning, created_at::text
       FROM prediction_errors
       WHERE created_at > NOW() - ($1::int || ' hours')::interval
       ORDER BY created_at DESC
       LIMIT 5`,
      [lookbackHours],
    );
    state.recent_errors = result.rows;
  }
  if (await tableExists('reward_prediction_errors')) {
    const result = await pool.query(
      `SELECT id, source_type, source_id, source_label,
              expected_value::float, observed_value::float, delta::float,
              magnitude::float, domain, computed_at::text AS created_at
       FROM reward_prediction_errors
       ORDER BY computed_at DESC
       LIMIT 5`,
    );
    state.reward_prediction_errors = result.rows;
  }
  return state;
}

async function workspaceState(context: string, sensoryInput: string[], lookbackHours: number): Promise<Record<string, unknown>> {
  const terms = lexicalSignals([context, ...sensoryInput].join(' '));
  const state: Record<string, unknown> = {
    selected_content: context,
    sensory_terms: terms,
    ignition_score: round2(clamp((terms.length / 12) + (sensoryInput.length * 0.08), 0, 1)),
    recent_broadcasts: [],
  };
  if (await tableExists('workspace_broadcasts')) {
    const result = await pool.query(
      `SELECT id, LEFT(content, 240) AS content, source_codelet, activation_strength::float,
              timestamp::text AS created_at
       FROM workspace_broadcasts
       WHERE timestamp > NOW() - ($1::int || ' hours')::interval
       ORDER BY timestamp DESC
       LIMIT 8`,
      [lookbackHours],
    );
    state.recent_broadcasts = result.rows;
  }
  return state;
}

async function actionGate(proposedAction: string, actionCategory: ActionCategory, lookbackHours: number): Promise<Record<string, unknown>> {
  const evalCases: Array<{
    id: number;
    case_key: string;
    capability: string;
    priority: number;
    last_verdict: string | null;
    expected_behavior: string;
  }> = [];
  if (await tableExists('vision_eval_case_status')) {
    const result = await pool.query(
      `SELECT s.id::int, s.case_key, s.capability, s.priority::int, s.last_verdict, c.expected_behavior
       FROM vision_eval_case_status s
       JOIN vision_eval_cases c ON c.id = s.id
       WHERE s.status = 'active'
         AND (s.last_evaluated_at IS NULL OR s.last_verdict IN ('fail', 'partial', 'unmeasured'))
       ORDER BY
         CASE WHEN s.last_verdict = 'fail' THEN 0 WHEN s.last_verdict = 'partial' THEN 1 ELSE 2 END,
         s.priority ASC
       LIMIT 12`,
    );
    evalCases.push(...result.rows);
  }

  const constraints = evalCases.map((row) => ({
    case_id: row.id,
    case_key: row.case_key,
    verdict: row.last_verdict || 'unmeasured',
    constraint: activeConstraintFor(row),
  }));

  let presenceFailed = 0;
  let presenceUnresolved = 0;
  if (await tableExists('presence_events')) {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE verification_outcome = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE closed_at IS NULL OR verification_outcome IN ('pending', 'unverified', 'no_change'))::int AS unresolved
       FROM presence_events
       WHERE entered_at > NOW() - ($1::int || ' hours')::interval`,
      [lookbackHours],
    );
    presenceFailed = Number(result.rows[0]?.failed ?? 0);
    presenceUnresolved = Number(result.rows[0]?.unresolved ?? 0);
  }

  let toolErrors = 0;
  if (await tableExists('tool_invocations')) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM tool_invocations
       WHERE invoked_at > NOW() - ($1::int || ' hours')::interval
         AND error IS NOT NULL`,
      [lookbackHours],
    );
    toolErrors = Number(result.rows[0]?.c ?? 0);
  }

  const adaptive = await adaptiveReflexPressure(pool, {
    proposedAction,
    actionCategory,
    lookbackHours,
    agent: AGENT,
  });
  constraints.push(...adaptive.constraints.map((constraint) => ({
    case_id: Number(constraint.reflex_id ?? 0),
    case_key: String(constraint.reflex_key ?? 'adaptive-reflex'),
    verdict: 'adaptive',
    constraint: String(constraint.constraint ?? ''),
  })));
  const violations = directViolations(proposedAction, constraints);

  const failing = evalCases.filter((row) => row.last_verdict === 'fail').length;
  const partial = evalCases.filter((row) => row.last_verdict === 'partial').length;
  const mutatingOrPublic = ['build', 'deploy', 'write', 'reply', 'tool', 'unknown'].includes(actionCategory);
  const pressureScore = failing * 4 + partial * 2 + presenceFailed * 2 + presenceUnresolved + Math.min(toolErrors, 10) * 0.25 + adaptive.pressure + violations.length * 5;
  const clearance = violations.length > 0
    ? 'blocked'
    : adaptive.count > 0 && mutatingOrPublic
      ? 'hold'
    : failing > 0 && mutatingOrPublic
      ? 'hold'
      : pressureScore > 0
        ? 'warn'
        : 'clear';

  return {
    clearance,
    pressure_score: round2(pressureScore),
    action_category: actionCategory,
    constraints,
    violations,
    counts: {
      active_eval_failures: failing,
      active_eval_partials: partial,
      presence_failed: presenceFailed,
      presence_unresolved: presenceUnresolved,
      tool_error_count: toolErrors,
      adaptive_reflex_count: adaptive.count,
    },
    adaptive_reflexes: adaptive.reflexes,
  };
}

async function learningState(lookbackHours: number): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {
    eval_health: [],
    tool_error_by_tool: [],
    adaptive_reflexes: [],
    learning_signal: 'unknown',
  };
  if (await tableExists('vision_eval_health')) {
    const result = await pool.query(
      `SELECT suite, capability, active_cases::int, measured_cases::int, fail_count::int, partial_count::int, avg_score::float
       FROM vision_eval_health
       ORDER BY fail_count DESC, partial_count DESC, suite, capability
       LIMIT 10`,
    );
    state.eval_health = result.rows;
  }
  if (await tableExists('tool_invocations')) {
    const result = await pool.query(
      `SELECT tool_name, COUNT(*)::int AS errors, MAX(invoked_at)::text AS latest_at
       FROM tool_invocations
       WHERE invoked_at > NOW() - ($1::int || ' hours')::interval
         AND error IS NOT NULL
       GROUP BY tool_name
       ORDER BY COUNT(*) DESC
       LIMIT 8`,
      [lookbackHours],
    );
    state.tool_error_by_tool = result.rows;
  }
  if (await tableExists('adaptive_reflexes')) {
    const result = await pool.query(
      `SELECT reflex_key, action_category, tool_name, failure_count::int,
              success_count::int, salience::float, last_outcome, last_seen_at::text
       FROM adaptive_reflexes
       WHERE status = 'active'
       ORDER BY failure_count DESC, salience DESC, last_seen_at DESC
       LIMIT 8`,
    );
    state.adaptive_reflexes = result.rows;
  }
  const failures = (state.eval_health as Array<Record<string, unknown>>).reduce((sum, row) => sum + Number(row.fail_count ?? 0), 0);
  const adaptiveFailures = (state.adaptive_reflexes as Array<Record<string, unknown>>).reduce((sum, row) => sum + Number(row.failure_count ?? 0), 0);
  state.learning_signal = failures > 0 || adaptiveFailures > 0 ? 'error_driven_update_needed' : 'maintain_and_measure';
  return state;
}

async function memoryState(lookbackHours: number): Promise<Record<string, unknown>> {
  const state: Record<string, unknown> = {
    recent_content: [],
    replay_episodes: [],
    open_residue: 0,
    pruning_candidates: 0,
  };
  if (await tableExists('content')) {
    const result = await pool.query(
      `SELECT id, content_type, source_system, network, LEFT(content_text, 220) AS text, created_at::text
       FROM content
       WHERE created_at > NOW() - ($1::int || ' hours')::interval
         AND superseded_by IS NULL
       ORDER BY created_at DESC
       LIMIT 8`,
      [lookbackHours],
    );
    state.recent_content = result.rows;
  }
  if (await tableExists('replay_episodes')) {
    const result = await pool.query(
      `SELECT id, replay_type, focus, LEFT(summary, 220) AS summary, created_at::text
       FROM replay_episodes
       ORDER BY created_at DESC
       LIMIT 5`,
    );
    state.replay_episodes = result.rows;
  }
  if (await tableExists('glymphatic_residue')) {
    const result = await pool.query(`SELECT COUNT(*)::int AS c FROM glymphatic_residue WHERE status = 'open'`);
    state.open_residue = Number(result.rows[0]?.c ?? 0);
  }
  if (await tableExists('synaptic_pruning_candidates')) {
    const result = await pool.query(`SELECT COUNT(*)::int AS c FROM synaptic_pruning_candidates WHERE status = 'open'`);
    state.pruning_candidates = Number(result.rows[0]?.c ?? 0);
  }
  return state;
}

function behaviorPlan(args: BrainCycleArgs, gate: Record<string, unknown>, workspace: Record<string, unknown>): Record<string, unknown> {
  const clearance = String(gate.clearance || 'clear');
  const action = args.proposed_action || 'choose the next bounded action';
  const trigger = clearance === 'clear'
    ? 'the action is taken'
    : 'eval/presence pressure is active';
  const thenResponse = clearance === 'clear'
    ? `${action}; record any surprise as evidence.`
    : 'name the pressure, choose one bounded next action, verify the outcome, and record the result.';
  return {
    implementation_intention: `If ${trigger}, then ${thenResponse}`,
    habit_interruption: clearance === 'blocked' || clearance === 'hold'
      ? 'Interrupt automatic action; route through deliberate model-based control.'
      : 'Proceed with monitoring.',
    workspace_commitment: workspace.selected_content,
    goal_context: args.goal_context || null,
    affect_label: args.affect_label || null,
  };
}

function consolidationPlan(memory: Record<string, unknown>, learning: Record<string, unknown>, gate: Record<string, unknown>): Record<string, unknown> {
  const evalHealth = learning.eval_health as Array<Record<string, unknown>>;
  const failing = evalHealth.filter((row) => Number(row.fail_count ?? 0) > 0).map((row) => `${row.suite}/${row.capability}`);
  return {
    replay_focus: failing.length > 0 ? failing.slice(0, 5) : ['recent high-salience content'],
    sleep_like_operations: [
      'replay recent failures and successes into compact patterns',
      'separate fast episode traces from durable rules',
      'clear unresolved cognitive residue only after outcome evidence',
      'mark stale low-confidence paths for review, not deletion',
    ],
    memory_pressure: {
      recent_content_count: (memory.recent_content as unknown[] | undefined)?.length ?? 0,
      open_residue: memory.open_residue,
      pruning_candidates: memory.pruning_candidates,
      action_clearance: gate.clearance,
    },
  };
}

async function brainCycle(args: BrainCycleArgs): Promise<CallToolResult> {
  if (!args.context || !args.context.trim()) {
    return jsonResult({ error: 'context is required' }, true);
  }

  const mode = args.mode || 'full';
  const lookbackHours = normalizeLookbackHours(args.lookback_hours);
  const horizonMinutes = normalizeHorizon(args.horizon_minutes);
  const sensoryInput = Array.isArray(args.sensory_input) ? args.sensory_input : [];
  const actionCategory = inferCategory(args.action_category, args.proposed_action);
  const includeReferences = args.include_references !== false;

  const [
    references,
    allostasis,
    predictive,
    workspace,
    gate,
    learning,
    memory,
  ] = await Promise.all([
    referenceModels(includeReferences),
    allostaticState(horizonMinutes),
    predictiveState(lookbackHours),
    workspaceState(args.context, sensoryInput, lookbackHours),
    actionGate(args.proposed_action || '', actionCategory, lookbackHours),
    learningState(lookbackHours),
    memoryState(lookbackHours),
  ]);

  const plan = behaviorPlan(args, gate, workspace);
  const consolidation = consolidationPlan(memory, learning, gate);

  let recordedId: number | null = null;
  if (args.record === true) {
    if (!await tableExists('neurocognitive_cycles')) {
      return jsonResult({ error: 'neurocognitive_cycles schema is missing. Apply migration 043.' }, true);
    }
    const result = await pool.query<{ id: string }>(
      `INSERT INTO neurocognitive_cycles
         (agent, session_id, mode, context, sensory_input, proposed_action,
          action_category, predictive_state, workspace_state, action_gate,
          allostatic_state, learning_state, memory_state, behavior_plan,
          consolidation_plan, source_models)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb,
               $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
               $15::jsonb, $16::jsonb)
       RETURNING id`,
      [
        AGENT,
        process.env.VISION_SESSION_ID || null,
        mode,
        args.context,
        JSON.stringify(sensoryInput),
        args.proposed_action || null,
        actionCategory,
        JSON.stringify(predictive),
        JSON.stringify(workspace),
        JSON.stringify(gate),
        JSON.stringify(allostasis),
        JSON.stringify(learning),
        JSON.stringify(memory),
        JSON.stringify(plan),
        JSON.stringify(consolidation),
        JSON.stringify(references.map((ref) => ref.model_key)),
      ],
    );
    recordedId = Number(result.rows[0].id);
  }

  return jsonResult({
    agent: AGENT,
    mode,
    recorded_id: recordedId,
    context: args.context,
    sensory_input: sensoryInput,
    proposed_action: args.proposed_action || null,
    action_category: actionCategory,
    neurocognitive_cycle: {
      sense: { allostatic_state: allostasis, sensory_terms: workspace.sensory_terms },
      predict: predictive,
      broadcast: workspace,
      gate_action: gate,
      learn: learning,
      consolidate: consolidation,
      behavior_plan: plan,
    },
    reference_models: references,
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_brain_cycle',
      description:
        'Run a human-brain-inspired Vision cycle: sense/interoception, predict, global-workspace broadcast, action gating, learning, and consolidation. Pass record:true to persist.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['sense', 'predict', 'broadcast', 'act', 'learn', 'consolidate', 'full'] },
          context: { type: 'string' },
          sensory_input: { type: 'array', items: { type: 'string' } },
          proposed_action: { type: 'string' },
          action_category: {
            type: 'string',
            enum: ['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown'],
          },
          goal_context: { type: 'string' },
          affect_label: { type: 'string' },
          horizon_minutes: { type: 'number' },
          lookback_hours: { type: 'number' },
          include_references: { type: 'boolean' },
          record: { type: 'boolean' },
        },
        required: ['context'],
      },
    },
    handler: (args) => brainCycle(args as BrainCycleArgs),
  },
];

export default tools;
