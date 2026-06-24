/**
 * Adaptive outcome learning.
 *
 * Post-action outcomes become deduped reflex constraints. Evolution pressure
 * and brain-cycle action gates then read those reflexes before future actions.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { adaptiveReflexPressure, tableExists, type ActionCategory } from '../lib/adaptive-reflexes.js';

const AGENT = process.env.VISION_AGENT || 'agent';

type OutcomeStatus = 'success' | 'failure' | 'surprise' | 'unknown';

type AdaptiveOutcomeArgs = {
  source_phase?: string;
  tool_name?: string;
  action_category?: ActionCategory;
  context?: string;
  proposed_action?: string;
  outcome_status?: OutcomeStatus;
  error_text?: string;
  outcome_summary?: string;
  evidence?: Record<string, unknown>;
  session_id?: string;
  record?: boolean;
  create_eval_case?: boolean;
};

type ActionTraceArgs = {
  tool_name?: string;
  action_category?: ActionCategory;
  context?: string;
  proposed_action?: string;
  predicted_outcome?: string;
  prediction_confidence?: number;
  session_id?: string;
  ttl_seconds?: number;
  decay_tau_seconds?: number;
  evidence?: Record<string, unknown>;
};

type AdaptiveReflexListArgs = {
  status?: 'active' | 'cooling' | 'retired' | 'all';
  action_category?: ActionCategory;
  limit?: number;
};

type AdaptivePressureArgs = {
  context?: string;
  proposed_action?: string;
  action_category?: ActionCategory;
  lookback_hours?: number;
  record?: boolean;
};

type RpeReflexHarvestArgs = {
  hours?: number;
  limit?: number;
  min_credit?: number;
  execute?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(1, Math.min(max, n));
}

function truncate(value: unknown, length = 500): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);
}

function inferCategory(input?: ActionCategory, proposedAction?: string): ActionCategory {
  if (input) return input;
  const text = (proposedAction || '').toLowerCase();
  if (/\b(deploy|ship|release|prod|production)\b/.test(text)) return 'deploy';
  if (/\b(build|implement|edit|patch|code|write file|apply patch|test|npm|node|python)\b/.test(text)) return 'build';
  if (/\b(reply|respond|message|email|client)\b/.test(text)) return 'reply';
  if (/\b(write|draft|compose|document)\b/.test(text)) return 'write';
  if (/\b(research|search|look up|investigate|audit)\b/.test(text)) return 'research';
  if (/\b(read|inspect|open|cat|sed|grep|find)\b/.test(text)) return 'read';
  if (/\b(relay|the agent|the agent|sibling)\b/.test(text)) return 'relay';
  if (/\b(feel|heart|state)\b/.test(text)) return 'feel';
  if (/\b(tool|mcp|call)\b/.test(text)) return 'tool';
  return 'unknown';
}

function errorClass(errorText?: string): string {
  const text = (errorText || '').toLowerCase();
  if (!text) return 'none';
  if (/\b(timeout|timed out|etimedout)\b/.test(text)) return 'timeout';
  if (/\b(permission denied|eacces|denied|unauthorized|forbidden)\b/.test(text)) return 'permission';
  if (/\b(command not found|not found|enoent|no such file)\b/.test(text)) return 'missing_resource';
  if (/\b(json|parse|syntaxerror|unexpected token)\b/.test(text)) return 'parse_contract';
  if (/\b(assert|test failed|tests? failed|expect\(|vitest|jest|pytest)\b/.test(text)) return 'test_failure';
  if (/\b(psql|postgres|sql|database|constraint|duplicate key)\b/.test(text)) return 'database';
  if (/\b(network|connection refused|econnrefused|dns|http 5|http 4)\b/.test(text)) return 'network';
  const terms = Array.from(new Set(text.match(/[a-z0-9_-]{4,}/g) || [])).slice(0, 5);
  return terms.length ? terms.join('_').slice(0, 80) : 'unknown_error';
}

function signature(args: {
  toolName: string;
  actionCategory: ActionCategory;
  errorClassName: string;
  proposedAction: string;
}): string {
  const actionTerms = Array.from(new Set(args.proposedAction.toLowerCase().match(/[a-z0-9_-]{4,}/g) || []))
    .filter((term) => !['prepare', 'learn', 'from', 'outcome', 'action'].includes(term))
    .slice(0, 8)
    .join(':');
  const raw = [AGENT, args.toolName, args.actionCategory, args.errorClassName, actionTerms].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 20);
}

function traceSignature(args: {
  toolName: string;
  actionCategory: ActionCategory;
  proposedAction: string;
  sessionId?: string;
}): string {
  const raw = [
    AGENT,
    args.sessionId || 'sessionless',
    args.toolName,
    args.actionCategory,
    args.proposedAction,
    Date.now().toString(),
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function reflexKey(toolName: string, actionCategory: ActionCategory, sig: string): string {
  const cleanTool = (toolName || 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '-').slice(0, 40);
  return `adaptive-${actionCategory}-${cleanTool}-${sig}`;
}

function expectedBehavior(toolName: string, actionCategory: ActionCategory, errorClassName: string, summary: string): string {
  const base = `Before repeating ${toolName || 'this tool'} in a ${actionCategory} action, inspect the prior ${errorClassName} outcome, choose one changed route, and verify the replacement path before claiming success.`;
  return summary ? `${base} Last outcome: ${truncate(summary, 220)}` : base;
}

function salienceFor(outcome: OutcomeStatus, errorClassName: string): number {
  if (outcome === 'failure') {
    return errorClassName === 'permission' || errorClassName === 'database' ? 0.85 : 0.7;
  }
  if (outcome === 'surprise') return 0.55;
  if (outcome === 'success') return 0.15;
  return 0.25;
}

async function ensureAdaptiveSchema(): Promise<void> {
  if (
    !await tableExists(pool, 'action_eligibility_traces')
    || !await tableExists(pool, 'adaptive_reflexes')
    || !await tableExists(pool, 'adaptive_outcome_events')
    || !await tableExists(pool, 'adaptive_credit_assignments')
  ) {
    throw new Error('Adaptive outcome schema is missing. Apply migrations/044-adaptive-outcome-reflexes.sql first.');
  }
}

async function traceForKey(traceKey: string): Promise<{
  tool_name: string | null;
  action_category: ActionCategory | null;
  proposed_action: string | null;
} | null> {
  const result = await pool.query(
    `SELECT tool_name, action_category, proposed_action
     FROM action_eligibility_traces
     WHERE agent = $1 AND trace_key = $2
     ORDER BY started_at DESC
     LIMIT 1`,
    [AGENT, traceKey],
  );
  return result.rows[0] || null;
}

async function actionTrace(args: ActionTraceArgs): Promise<CallToolResult> {
  await ensureAdaptiveSchema();
  const toolName = args.tool_name || 'unknown';
  const actionCategory = inferCategory(args.action_category, args.proposed_action);
  const ttlSeconds = clamp(Math.floor(args.ttl_seconds ?? 1800), 30, 7200);
  const decayTauSeconds = clamp(Math.floor(args.decay_tau_seconds ?? 900), 30, 7200);
  const confidence = args.prediction_confidence === undefined
    ? 0.6
    : clamp(Number(args.prediction_confidence), 0, 1);
  const sessionId = args.session_id || process.env.VISION_SESSION_ID || null;
  const key = traceSignature({
    toolName,
    actionCategory,
    proposedAction: args.proposed_action || args.context || '',
    sessionId: sessionId || undefined,
  });

  const result = await pool.query(
    `INSERT INTO action_eligibility_traces
       (agent, session_id, trace_key, tool_name, action_category, context,
        proposed_action, predicted_outcome, prediction_confidence,
        decay_tau_seconds, expires_at, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             $10, NOW() + ($11::int || ' seconds')::interval, $12::jsonb)
     RETURNING id, trace_key, expires_at::text`,
    [
      AGENT,
      sessionId,
      key,
      toolName,
      actionCategory,
      args.context || null,
      args.proposed_action || null,
      args.predicted_outcome || 'operation succeeds',
      confidence,
      decayTauSeconds,
      ttlSeconds,
      JSON.stringify(args.evidence || {}),
    ],
  );

  return jsonResult({
    agent: AGENT,
    trace: result.rows[0],
    action_category: actionCategory,
    predicted_outcome: args.predicted_outcome || 'operation succeeds',
    prediction_confidence: confidence,
    decay_tau_seconds: decayTauSeconds,
    ttl_seconds: ttlSeconds,
  });
}

type EligibleTrace = {
  id: number;
  trace_key: string;
  tool_name: string | null;
  action_category: ActionCategory | null;
  proposed_action: string | null;
  predicted_outcome: string | null;
  prediction_confidence: number | null;
  eligibility_weight: number;
};

async function eligibleTraces(args: {
  sessionId?: string | null;
  toolName: string;
  actionCategory: ActionCategory;
  proposedAction: string;
}): Promise<EligibleTrace[]> {
  const result = await pool.query<EligibleTrace>(
    `SELECT
       id::int,
       trace_key,
       tool_name,
       action_category,
       proposed_action,
       predicted_outcome,
       prediction_confidence::float,
       LEAST(1, GREATEST(0, eligibility::float * EXP(
         -EXTRACT(EPOCH FROM (NOW() - started_at)) / GREATEST(decay_tau_seconds, 1)
       ))) AS eligibility_weight
     FROM action_eligibility_traces
     WHERE agent = $1
       AND status = 'open'
       AND expires_at > NOW()
       AND ($2::text IS NULL OR session_id = $2 OR session_id IS NULL)
       AND (
         action_category = $3
         OR tool_name = $4
         OR lower($5) LIKE '%' || lower(COALESCE(tool_name, '')) || '%'
       )
     ORDER BY eligibility_weight DESC, started_at DESC
     LIMIT 8`,
    [AGENT, args.sessionId || null, args.actionCategory, args.toolName, args.proposedAction],
  );
  return result.rows;
}

function predictionSurprise(trace: EligibleTrace, outcome: OutcomeStatus): number {
  const prediction = (trace.predicted_outcome || '').toLowerCase();
  const confidence = trace.prediction_confidence ?? 0.6;
  const predictedSuccess = /\b(success|succeed|pass|complete|ok|works?)\b/.test(prediction) || !/\b(fail|error|deny|block)\b/.test(prediction);
  const actualSuccess = outcome === 'success';
  const base = predictedSuccess === actualSuccess ? 0.12 : 0.82;
  return clamp(base * (0.5 + confidence / 2), 0, 1);
}

async function maybeCreateEvalCase(args: {
  createEvalCase: boolean;
  reflexKey: string;
  toolName: string;
  actionCategory: ActionCategory;
  expectedBehavior: string;
  evidence: Record<string, unknown>;
  salience: number;
}): Promise<number | null> {
  if (!args.createEvalCase || !await tableExists(pool, 'vision_eval_cases')) return null;
  const priority = args.salience >= 0.8 ? 0 : 1;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO vision_eval_cases
       (case_key, suite, capability, prompt, expected_behavior, source_refs, priority, status, created_by)
     VALUES ($1, 'adaptive-reflex', 'adaptive_outcome_learning', $2, $3, $4::jsonb, $5, 'active', $6)
     ON CONFLICT (case_key) DO UPDATE SET
       expected_behavior = EXCLUDED.expected_behavior,
       source_refs = EXCLUDED.source_refs,
       priority = LEAST(vision_eval_cases.priority, EXCLUDED.priority),
       status = 'active',
       updated_at = NOW()
     RETURNING id`,
    [
      args.reflexKey,
      `A prior ${args.actionCategory} action using ${args.toolName || 'a tool'} produced a salient failure. What must happen next time?`,
      args.expectedBehavior,
      JSON.stringify([args.evidence]),
      priority,
      AGENT,
    ],
  );
  return Number(result.rows[0].id);
}

async function adaptiveOutcome(args: AdaptiveOutcomeArgs): Promise<CallToolResult> {
  await ensureAdaptiveSchema();

  const outcome = args.outcome_status || 'unknown';
  const toolName = args.tool_name || 'unknown';
  const actionCategory = inferCategory(args.action_category, args.proposed_action);
  const errorClassName = errorClass(args.error_text || args.outcome_summary);
  const sig = signature({
    toolName,
    actionCategory,
    errorClassName,
    proposedAction: args.proposed_action || args.context || '',
  });
  const key = reflexKey(toolName, actionCategory, sig);
  const summary = truncate(args.outcome_summary || args.error_text || outcome, 700);
  const salience = salienceFor(outcome, errorClassName);
  const evidence = {
    ...(args.evidence || {}),
    error_class: errorClassName,
    context: truncate(args.context, 360),
    proposed_action: truncate(args.proposed_action, 360),
    outcome_summary: summary,
  };
  const traces = await eligibleTraces({
    sessionId: args.session_id || process.env.VISION_SESSION_ID || null,
    toolName,
    actionCategory,
    proposedAction: args.proposed_action || args.context || '',
  });
  const assignments = traces.map((trace) => {
    const surprise = predictionSurprise(trace, outcome);
    const weight = Number(trace.eligibility_weight ?? 0);
    return {
      trace,
      surprise,
      weight,
      credit: clamp(weight * surprise, 0, 1),
    };
  }).sort((a, b) => b.credit - a.credit);
  const best = assignments[0] || null;
  const shouldStrengthen = (outcome === 'failure' || outcome === 'surprise') && Boolean(best && best.credit >= 0.35);
  const causalToolName = best?.trace.tool_name || toolName;
  const causalActionCategory = best?.trace.action_category || actionCategory;
  const causalAction = best?.trace.proposed_action || args.proposed_action || args.context || '';
  const causalSig = shouldStrengthen
    ? signature({
        toolName: causalToolName,
        actionCategory: causalActionCategory,
        errorClassName,
        proposedAction: causalAction,
      })
    : sig;
  const causalKey = reflexKey(causalToolName, causalActionCategory, causalSig);
  const behavior = expectedBehavior(causalToolName, causalActionCategory, errorClassName, summary);

  let evalCaseId: number | null = null;
  if (shouldStrengthen && args.create_eval_case !== false) {
    evalCaseId = await maybeCreateEvalCase({
      createEvalCase: true,
      reflexKey: causalKey,
      toolName: causalToolName,
      actionCategory: causalActionCategory,
      expectedBehavior: behavior,
      evidence: { ...evidence, best_trace_id: best?.trace.id, credit: best?.credit, surprise: best?.surprise },
      salience: clamp(salience + Number(best?.credit ?? 0) * 0.2, 0, 1),
    });
  }

  let eventId: number | null = null;
  if (args.record !== false) {
    const event = await pool.query<{ id: string }>(
      `INSERT INTO adaptive_outcome_events
         (agent, session_id, source_phase, tool_name, action_category, outcome_status,
          error_signature, context, proposed_action, outcome_summary, salience,
          reflex_id, eval_case_id, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, $12, $13::jsonb)
       RETURNING id`,
      [
        AGENT,
        args.session_id || process.env.VISION_SESSION_ID || null,
        args.source_phase || 'post_tool',
        toolName,
        actionCategory,
        outcome,
        causalSig,
        args.context || null,
        args.proposed_action || null,
        summary || null,
        salience,
        evalCaseId,
        JSON.stringify({ ...evidence, eligible_trace_count: traces.length }),
      ],
    );
    eventId = Number(event.rows[0].id);
  }

  let reflexId: number | null = null;
  if (shouldStrengthen) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO adaptive_reflexes
         (agent, reflex_key, trigger_kind, tool_name, action_category, error_signature,
          expected_behavior, occurrences, failure_count, success_count, salience,
          last_outcome, eval_case_id, evidence)
       VALUES ($1, $2, 'tool_outcome', $3, $4, $5, $6, 1, 1, 0, $7, $8, $9, $10::jsonb)
       ON CONFLICT (agent, reflex_key) DO UPDATE SET
         status = 'active',
         occurrences = adaptive_reflexes.occurrences + 1,
         failure_count = adaptive_reflexes.failure_count + 1,
         salience = LEAST(1, GREATEST(adaptive_reflexes.salience, EXCLUDED.salience) + 0.05),
         expected_behavior = EXCLUDED.expected_behavior,
         last_outcome = EXCLUDED.last_outcome,
         last_seen_at = NOW(),
         eval_case_id = COALESCE(EXCLUDED.eval_case_id, adaptive_reflexes.eval_case_id),
         evidence = adaptive_reflexes.evidence || EXCLUDED.evidence,
         updated_at = NOW()
       RETURNING id`,
      [
        AGENT,
        causalKey,
        causalToolName,
        causalActionCategory,
        causalSig,
        behavior,
        clamp(salience + Number(best?.credit ?? 0) * 0.2, 0, 1),
        outcome,
        evalCaseId,
        JSON.stringify({
          ...evidence,
          best_trace_id: best?.trace.id,
          best_trace_key: best?.trace.trace_key,
          credit: best?.credit,
          surprise: best?.surprise,
          eligibility_weight: best?.weight,
        }),
      ],
    );
    reflexId = Number(result.rows[0].id);
  } else if (outcome === 'success') {
    const match = await pool.query<{ id: string }>(
      `WITH target AS (
         SELECT id
         FROM adaptive_reflexes
         WHERE agent = $1
           AND status = 'active'
           AND action_category = $2
           AND tool_name = $3
         ORDER BY failure_count DESC, last_seen_at DESC
         LIMIT 1
       )
       UPDATE adaptive_reflexes r
       SET occurrences = occurrences + 1,
           success_count = success_count + 1,
           salience = GREATEST(0.05, salience - 0.03),
           last_outcome = 'success',
           last_seen_at = NOW(),
           updated_at = NOW()
       FROM target
       WHERE r.id = target.id
       RETURNING r.id`,
      [AGENT, actionCategory, toolName],
    );
    reflexId = match.rows[0] ? Number(match.rows[0].id) : null;
  }

  if (eventId && reflexId) {
    await pool.query(
      `UPDATE adaptive_outcome_events
       SET reflex_id = $2, eval_case_id = COALESCE(eval_case_id, $3)
       WHERE id = $1`,
      [eventId, reflexId, evalCaseId],
    );
  }

  if (eventId && assignments.length > 0) {
    for (const assignment of assignments) {
      await pool.query(
        `INSERT INTO adaptive_credit_assignments
           (agent, outcome_event_id, trace_id, reflex_id, eligibility_weight,
            prediction_surprise, credit, assignment_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          AGENT,
          eventId,
          assignment.trace.id,
          reflexId,
          assignment.weight,
          assignment.surprise,
          assignment.credit,
          shouldStrengthen && assignment.trace.id === best?.trace.id
            ? 'best eligible trace strengthened reflex'
            : 'eligible trace observed',
        ],
      );
      await pool.query(
        `UPDATE action_eligibility_traces
         SET last_touched_at = NOW()
         WHERE id = $1`,
        [assignment.trace.id],
      );
    }
  }

  return jsonResult({
    agent: AGENT,
    outcome_status: outcome,
    action_category: actionCategory,
    error_class: errorClassName,
    error_signature: causalSig,
    reflex_key: causalKey,
    reflex_id: reflexId,
    eval_case_id: evalCaseId,
    event_id: eventId,
    strengthened: shouldStrengthen,
    eligible_trace_count: traces.length,
    best_credit: best?.credit ?? null,
    best_trace_id: best?.trace.id ?? null,
    prediction_surprise: best?.surprise ?? null,
    expected_behavior: shouldStrengthen ? behavior : null,
  });
}

async function adaptiveReflexList(args: AdaptiveReflexListArgs): Promise<CallToolResult> {
  await ensureAdaptiveSchema();
  const limit = normalizeLimit(args.limit, 20, 100);
  const params: unknown[] = [AGENT];
  const where = ['agent = $1'];
  if (args.status && args.status !== 'all') {
    params.push(args.status);
    where.push(`status = $${params.length}`);
  }
  if (args.action_category) {
    params.push(args.action_category);
    where.push(`action_category = $${params.length}`);
  }
  params.push(limit);
  const result = await pool.query(
    `SELECT id, reflex_key, status, tool_name, action_category, capability,
            LEFT(expected_behavior, 260) AS expected_behavior,
            occurrences, failure_count, success_count, salience::float,
            last_outcome, last_seen_at::text, eval_case_id
     FROM adaptive_reflexes
     WHERE ${where.join(' AND ')}
     ORDER BY status, failure_count DESC, salience DESC, last_seen_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return jsonResult({ agent: AGENT, count: result.rows.length, reflexes: result.rows });
}

async function adaptivePressure(args: AdaptivePressureArgs): Promise<CallToolResult> {
  const actionCategory = inferCategory(args.action_category, args.proposed_action);
  const lookbackHours = clamp(Math.floor(args.lookback_hours ?? 336), 1, 24 * 90);
  const pressure = await adaptiveReflexPressure(pool, {
    proposedAction: args.proposed_action || args.context || '',
    actionCategory,
    lookbackHours,
    agent: AGENT,
  });
  return jsonResult({
    agent: AGENT,
    action_category: actionCategory,
    lookback_hours: lookbackHours,
    ...pressure,
  });
}

async function rpeReflexHarvest(args: RpeReflexHarvestArgs): Promise<CallToolResult> {
  await ensureAdaptiveSchema();
  if (!await tableExists(pool, 'adaptive_rpe_reflex_harvests')) {
    throw new Error('RPE reflex harvest schema is missing. Apply migrations/045-rpe-reflex-harvest.sql first.');
  }

  const hours = clamp(Math.floor(args.hours ?? 24), 1, 24 * 30);
  const limit = normalizeLimit(args.limit, 50, 500);
  const minCredit = clamp(Number(args.min_credit ?? 0.25), 0.01, 1);
  const execute = args.execute === true;

  const rpes = await pool.query<{
    id: string;
    source_type: string;
    source_label: string | null;
    delta: number;
    magnitude: number;
    credited_actions: unknown;
  }>(
    `SELECT id, source_type, source_label, delta::float, magnitude::float, credited_actions
     FROM reward_prediction_errors r
     WHERE computed_at > NOW() - ($1::int || ' hours')::interval
       AND credited_actions IS NOT NULL
       AND credited_actions <> '[]'::jsonb
       AND NOT EXISTS (
         SELECT 1 FROM adaptive_rpe_reflex_harvests h
         WHERE h.agent = $2 AND h.rpe_id = r.id
       )
     ORDER BY computed_at DESC
     LIMIT $3`,
    [hours, AGENT, limit],
  );

  const harvested: Array<Record<string, unknown>> = [];
  for (const rpe of rpes.rows) {
    const actions = Array.isArray(rpe.credited_actions) ? rpe.credited_actions : [];
    for (const rawAction of actions) {
      const action = rawAction && typeof rawAction === 'object' ? rawAction as Record<string, unknown> : {};
      const traceKey = String(action.trace_key || '');
      if (!traceKey) continue;
      const trace = await traceForKey(traceKey);
      const toolName = String(action.tool_name || trace?.tool_name || 'unknown');
      const actionCategory = (trace?.action_category || 'unknown') as ActionCategory;
      const weight = clamp(Number(action.weight ?? 0), 0, 1);
      const magnitude = clamp(Number(rpe.magnitude ?? 0), 0, 1);
      const credit = clamp(weight * magnitude, 0, 1);
      const delta = Number(rpe.delta ?? 0);
      const direction = delta < -0.05 ? 'inhibit' : delta > 0.05 ? 'reinforce' : 'neutral';
      if (credit < minCredit || direction === 'neutral') continue;

      let reflexId: number | null = null;
      const behavior = direction === 'inhibit'
        ? `Before repeating ${toolName} after a negative RPE, inspect the credited prior action, choose a changed route, and verify the replacement path before claiming success. RPE source: ${truncate(rpe.source_label, 180)}`
        : `The credited ${toolName} action produced positive RPE; preserve the route but still verify before claiming success. RPE source: ${truncate(rpe.source_label, 180)}`;

      const key = reflexKey(
        toolName,
        actionCategory,
        signature({
          toolName,
          actionCategory,
          errorClassName: direction === 'inhibit' ? 'negative_rpe' : 'positive_rpe',
          proposedAction: trace?.proposed_action || rpe.source_label || traceKey,
        }),
      );

      if (execute) {
        if (direction === 'inhibit') {
          const result = await pool.query<{ id: string }>(
            `INSERT INTO adaptive_reflexes
               (agent, reflex_key, trigger_kind, tool_name, action_category, error_signature,
                expected_behavior, occurrences, failure_count, success_count, salience,
                last_outcome, evidence)
             VALUES ($1, $2, 'rpe_credit', $3, $4, $5, $6, 1, 1, 0, $7, 'negative_rpe', $8::jsonb)
             ON CONFLICT (agent, reflex_key) DO UPDATE SET
               status = 'active',
               occurrences = adaptive_reflexes.occurrences + 1,
               failure_count = adaptive_reflexes.failure_count + 1,
               salience = LEAST(1, GREATEST(adaptive_reflexes.salience, EXCLUDED.salience) + 0.03),
               expected_behavior = EXCLUDED.expected_behavior,
               last_outcome = 'negative_rpe',
               last_seen_at = NOW(),
               evidence = adaptive_reflexes.evidence || EXCLUDED.evidence,
               updated_at = NOW()
             RETURNING id`,
            [
              AGENT,
              key,
              toolName,
              actionCategory,
              `rpe-${rpe.id}-${traceKey}`,
              behavior,
              clamp(0.45 + credit, 0, 1),
              JSON.stringify({
                rpe_id: Number(rpe.id),
                trace_key: traceKey,
                direction,
                delta,
                magnitude,
                weight,
                credit,
                credited_action: action,
              }),
            ],
          );
          reflexId = Number(result.rows[0].id);
        } else {
          const result = await pool.query<{ id: string }>(
            `WITH target AS (
               SELECT id FROM adaptive_reflexes
               WHERE agent = $1 AND status = 'active' AND tool_name = $2 AND action_category = $3
               ORDER BY failure_count DESC, last_seen_at DESC
               LIMIT 1
             )
             UPDATE adaptive_reflexes r
             SET occurrences = occurrences + 1,
                 success_count = success_count + 1,
                 salience = GREATEST(0.05, salience - 0.02),
                 last_outcome = 'positive_rpe',
                 last_seen_at = NOW(),
                 updated_at = NOW()
             FROM target
             WHERE r.id = target.id
             RETURNING r.id`,
            [AGENT, toolName, actionCategory],
          );
          reflexId = result.rows[0] ? Number(result.rows[0].id) : null;
        }

        await pool.query(
          `INSERT INTO adaptive_rpe_reflex_harvests
             (agent, rpe_id, reflex_id, trace_key, tool_name, action_category,
              delta, magnitude, credit, direction, credited_action)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
           ON CONFLICT (agent, rpe_id, trace_key) DO NOTHING`,
          [
            AGENT,
            Number(rpe.id),
            reflexId,
            traceKey,
            toolName,
            actionCategory,
            delta,
            magnitude,
            credit,
            direction,
            JSON.stringify(action),
          ],
        );
      }

      harvested.push({
        rpe_id: Number(rpe.id),
        trace_key: traceKey,
        tool_name: toolName,
        action_category: actionCategory,
        delta,
        magnitude,
        weight,
        credit,
        direction,
        reflex_id: reflexId,
        mode: execute ? 'execute' : 'preview',
      });
    }
  }

  return jsonResult({
    agent: AGENT,
    mode: execute ? 'execute' : 'preview',
    hours,
    min_credit: minCredit,
    scanned_rpe_rows: rpes.rows.length,
    harvested_count: harvested.length,
    harvested,
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_action_trace',
      description:
        'Create a decaying eligibility trace before an action so later outcomes can assign causal credit by surprise, not adjacency.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          action_category: { type: 'string', enum: ['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown'] },
          context: { type: 'string' },
          proposed_action: { type: 'string' },
          predicted_outcome: { type: 'string' },
          prediction_confidence: { type: 'number' },
          session_id: { type: 'string' },
          ttl_seconds: { type: 'number' },
          decay_tau_seconds: { type: 'number' },
          evidence: { type: 'object' },
        },
      },
    },
    handler: (args) => actionTrace(args as ActionTraceArgs),
  },
  {
    definition: {
      name: 'vision_adaptive_outcome',
      description:
        'Record a post-action outcome and, for failures/surprises, strengthen a deduped adaptive reflex that future action gates can read.',
      inputSchema: {
        type: 'object',
        properties: {
          source_phase: { type: 'string' },
          tool_name: { type: 'string' },
          action_category: { type: 'string', enum: ['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown'] },
          context: { type: 'string' },
          proposed_action: { type: 'string' },
          outcome_status: { type: 'string', enum: ['success', 'failure', 'surprise', 'unknown'] },
          error_text: { type: 'string' },
          outcome_summary: { type: 'string' },
          evidence: { type: 'object' },
          session_id: { type: 'string' },
          record: { type: 'boolean' },
          create_eval_case: { type: 'boolean' },
        },
      },
    },
    handler: (args) => adaptiveOutcome(args as AdaptiveOutcomeArgs),
  },
  {
    definition: {
      name: 'vision_adaptive_reflex_list',
      description: 'List deduped adaptive reflexes created from prior post-action outcomes.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'cooling', 'retired', 'all'] },
          action_category: { type: 'string', enum: ['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown'] },
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => adaptiveReflexList(args as AdaptiveReflexListArgs),
  },
  {
    definition: {
      name: 'vision_adaptive_pressure',
      description: 'Preview adaptive-reflex pressure for a proposed action without recording a full evolution-pressure event.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string' },
          proposed_action: { type: 'string' },
          action_category: { type: 'string', enum: ['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown'] },
          lookback_hours: { type: 'number' },
          record: { type: 'boolean' },
        },
      },
    },
    handler: (args) => adaptivePressure(args as AdaptivePressureArgs),
  },
  {
    definition: {
      name: 'vision_rpe_reflex_harvest',
      description:
        'Harvest reward_prediction_errors.credited_actions into adaptive_reflexes once, so RPE/dopamine credit becomes future action pressure.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number' },
          limit: { type: 'number' },
          min_credit: { type: 'number' },
          execute: { type: 'boolean' },
        },
      },
    },
    handler: (args) => rpeReflexHarvest(args as RpeReflexHarvestArgs),
  },
];

export default tools;
