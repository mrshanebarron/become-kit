/**
 * Biology Cycle Tools — human biology as first-class Vision interfaces.
 *
 * This module does not replace the existing organs. It composes them:
 * allostasis/interoception, hippocampal replay, glymphatic clearance,
 * immune tolerance, synaptic pruning, and cerebellar prediction error.
 *
 * First generation principle: record, score, and propose. Do not delete or
 * suppress automatically. Cleanup and pruning use explicit execute flags.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

type JsonObject = Record<string, unknown>;

interface AllostaticSnapshot {
  sample_id: number | null;
  sampled_at: string | null;
  load: number | null;
  reserve: number | null;
  variance: number | null;
  drift: number | null;
  state: string;
}

interface ReplayResult {
  replay_id?: number;
  mode: 'preview' | 'execute';
  window_hours: number;
  focus: string | null;
  source_count: number;
  summary: string;
  inferred_pattern: string;
  credit_assignment: string;
  consolidation_action: string;
  source_refs: JsonObject[];
}

interface ResidueCandidate {
  residue_type: string;
  source_table: string | null;
  source_id: number | null;
  description: string;
  severity: number;
  proposed_clearance: string;
  metadata?: JsonObject;
}

interface ClearanceResult {
  mode: 'preview' | 'execute';
  detected: number;
  created: number;
  cleared: number;
  candidates: ResidueCandidate[];
}

interface ToleranceResult {
  tolerance_id?: number;
  stimulus: string;
  matched_antibodies: JsonObject[];
  max_severity: number;
  danger_score: number;
  tolerance_score: number;
  decision: string;
  inhibitory_reason: string;
}

interface PruningCandidate {
  content_id: number;
  content_type: string;
  preview: string;
  reason: string;
  strength: number;
  last_accessed_at: string | null;
  access_count: number | null;
  confidence: number | null;
  proposed_action: string;
}

interface PruningResult {
  mode: 'preview' | 'execute';
  candidates_found: number;
  created: number;
  candidates: PruningCandidate[];
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes'].includes(value.toLowerCase());
  return fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

async function latestAllostaticSnapshot(client: PoolClient): Promise<AllostaticSnapshot> {
  const res = await client.query<{
    id: number;
    sampled_at: string;
    load: number;
    reserve: number;
    variance: number;
    drift: number;
    state: string;
  }>(`
    SELECT id, sampled_at, load, reserve, variance, drift, state
    FROM allostatic_samples
    ORDER BY sampled_at DESC
    LIMIT 1
  `);

  const row = res.rows[0];
  if (!row) {
    return {
      sample_id: null,
      sampled_at: null,
      load: null,
      reserve: null,
      variance: null,
      drift: null,
      state: 'unknown',
    };
  }

  return {
    sample_id: row.id,
    sampled_at: row.sampled_at,
    load: Number(row.load),
    reserve: Number(row.reserve),
    variance: Number(row.variance),
    drift: Number(row.drift),
    state: row.state,
  };
}

async function createInteroceptiveForecast(
  client: PoolClient,
  args: JsonObject,
  execute: boolean,
): Promise<JsonObject> {
  const context = asString(args.context, '').trim();
  if (!context) throw new Error('context is required');

  const current = await latestAllostaticSnapshot(client);
  const plannedAction = asString(args.planned_action, '') || null;
  const predictedNeed = asString(args.predicted_need, 'steady_attention');
  const horizonMinutes = Math.max(1, Math.round(asNumber(args.horizon_minutes, 30)));
  const loadDelta = asNumber(args.predicted_load_delta, 0.1);
  const reserveDelta = asNumber(args.predicted_reserve_delta, -0.05);
  const predictedLoad = current.load == null ? null : round3(clamp01(current.load + loadDelta));
  const predictedReserve = current.reserve == null ? null : round3(clamp01(current.reserve + reserveDelta));

  if (!execute) {
    return {
      mode: 'preview',
      context,
      planned_action: plannedAction,
      predicted_need: predictedNeed,
      horizon_minutes: horizonMinutes,
      current_state: current,
      predicted_load: predictedLoad,
      predicted_reserve: predictedReserve,
      note: 'preview only — pass execute=true or use vision_biology_interocept to persist',
    };
  }

  const res = await client.query<{ id: number; created_at: string }>(`
    INSERT INTO interoceptive_forecasts
      (context, planned_action, predicted_load, predicted_reserve, predicted_need,
       horizon_minutes, current_state, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
    RETURNING id, created_at
  `, [
    context,
    plannedAction,
    predictedLoad,
    predictedReserve,
    predictedNeed,
    horizonMinutes,
    JSON.stringify(current),
    JSON.stringify({ load_delta: loadDelta, reserve_delta: reserveDelta }),
  ]);

  return {
    mode: 'execute',
    forecast_id: res.rows[0].id,
    created_at: res.rows[0].created_at,
    context,
    planned_action: plannedAction,
    predicted_need: predictedNeed,
    horizon_minutes: horizonMinutes,
    current_state: current,
    predicted_load: predictedLoad,
    predicted_reserve: predictedReserve,
  };
}

async function resolveInteroceptiveForecast(args: JsonObject): Promise<CallToolResult> {
  const forecastId = Math.round(asNumber(args.forecast_id, 0));
  if (!forecastId) return jsonResult({ error: 'forecast_id is required' }, true);
  const actualResult = asString(args.actual_result, '').trim();
  if (!actualResult) return jsonResult({ error: 'actual_result is required' }, true);

  const client = await pool.connect();
  try {
    const current = await latestAllostaticSnapshot(client);
    const actualLoad = args.actual_load == null ? current.load : clamp01(asNumber(args.actual_load, 0));
    const actualReserve = args.actual_reserve == null ? current.reserve : clamp01(asNumber(args.actual_reserve, 0));

    const forecast = await client.query<{
      predicted_load: number | null;
      predicted_reserve: number | null;
    }>(`
      SELECT predicted_load, predicted_reserve
      FROM interoceptive_forecasts
      WHERE id = $1
    `, [forecastId]);

    if (forecast.rows.length === 0) {
      return jsonResult({ error: `forecast_id ${forecastId} not found` }, true);
    }

    const row = forecast.rows[0];
    const loadError = row.predicted_load != null && actualLoad != null
      ? Math.abs(Number(row.predicted_load) - actualLoad)
      : 0;
    const reserveError = row.predicted_reserve != null && actualReserve != null
      ? Math.abs(Number(row.predicted_reserve) - actualReserve)
      : 0;
    const predictionError = round3((loadError + reserveError) / 2);

    await client.query(`
      UPDATE interoceptive_forecasts
      SET actual_load = $1,
          actual_reserve = $2,
          actual_result = $3,
          prediction_error = $4,
          status = 'resolved',
          resolved_at = now()
      WHERE id = $5
    `, [actualLoad, actualReserve, actualResult, predictionError, forecastId]);

    return jsonResult({
      forecast_id: forecastId,
      actual_result: actualResult,
      actual_load: actualLoad,
      actual_reserve: actualReserve,
      prediction_error: predictionError,
      interpretation:
        predictionError < 0.15 ? 'interoceptive forecast calibrated' :
        predictionError < 0.35 ? 'forecast partly calibrated — update expected body cost' :
        'large interoceptive miss — task cost differed from prediction',
    });
  } finally {
    client.release();
  }
}

async function buildReplay(client: PoolClient, args: JsonObject, execute: boolean): Promise<ReplayResult> {
  const windowHours = Math.max(1, asNumber(args.window_hours, 6));
  const focus = asString(args.focus, '') || null;

  const tools = await client.query<{
    id: number;
    tool_name: string;
    error: string | null;
    duration_ms: number | null;
    invoked_at: string;
  }>(`
    SELECT id, tool_name, error, duration_ms, invoked_at
    FROM tool_invocations
    WHERE invoked_at > now() - ($1 || ' hours')::interval
    ORDER BY invoked_at DESC
    LIMIT 20
  `, [String(windowHours)]);

  const surprises = await client.query<{
    id: number;
    tool_name: string;
    surprise: number | null;
    predicted_outcome: string;
    actual_outcome: string | null;
  }>(`
    SELECT id, tool_name, surprise, predicted_outcome, actual_outcome
    FROM forward_predictions
    WHERE resolved_at > now() - ($1 || ' hours')::interval
      AND surprise IS NOT NULL
    ORDER BY surprise DESC
    LIMIT 10
  `, [String(windowHours)]);

  const memories = await client.query<{
    id: number;
    content_type: string;
    content_text: string;
    created_at: string;
  }>(`
    SELECT id, content_type, left(content_text, 240) AS content_text, created_at
    FROM content
    WHERE created_at > now() - ($1 || ' hours')::interval
      AND superseded_by IS NULL
    ORDER BY created_at DESC
    LIMIT 20
  `, [String(windowHours)]);

  const errorTools = tools.rows.filter((t) => t.error).map((t) => t.tool_name);
  const highSurprise = surprises.rows.filter((s) => Number(s.surprise ?? 0) >= 0.5);
  const contentTypes = [...new Set(memories.rows.map((m) => m.content_type))].slice(0, 8);

  const summary = [
    `${tools.rows.length} tool traces`,
    `${memories.rows.length} memory/content traces`,
    `${highSurprise.length} high-surprise forward-model misses`,
    errorTools.length ? `errors: ${[...new Set(errorTools)].join(', ')}` : 'no repeated tool-error cluster in window',
  ].join('; ');

  const inferredPattern =
    highSurprise.length > 0
      ? `prediction error concentrated around ${[...new Set(highSurprise.map((s) => s.tool_name))].join(', ')}`
      : contentTypes.length > 0
        ? `recent consolidation surface includes ${contentTypes.join(', ')}`
        : 'quiet window; replay has little material';

  const creditAssignment =
    highSurprise.length > 0
      ? 'credit the mismatch to the forward model and inspect assumptions before the next similar tool call'
      : errorTools.length > 0
        ? 'credit residue to tool errors and clear them before claiming completion'
        : 'no strong negative credit assignment detected';

  const consolidationAction =
    highSurprise.length > 0
      ? 'write one durable lesson for the highest-surprise miss, then resolve or retire stale forecasts'
      : memories.rows.length > 0
        ? 'promote the most task-relevant trace into a compact memory if it will matter tomorrow'
        : 'no consolidation action needed';

  const sourceRefs: JsonObject[] = [
    ...tools.rows.slice(0, 10).map((t) => ({ table: 'tool_invocations', id: t.id, tool_name: t.tool_name })),
    ...surprises.rows.slice(0, 10).map((s) => ({ table: 'forward_predictions', id: s.id, surprise: s.surprise })),
    ...memories.rows.slice(0, 10).map((m) => ({ table: 'content', id: m.id, content_type: m.content_type })),
  ];

  let replayId: number | undefined;
  if (execute) {
    const inserted = await client.query<{ id: number }>(`
      INSERT INTO replay_episodes
        (replay_type, window_start, window_end, focus, source_refs, summary,
         inferred_pattern, credit_assignment, consolidation_action)
      VALUES ('hippocampal_replay', now() - ($1 || ' hours')::interval, now(),
              $2, $3::jsonb, $4, $5, $6, $7)
      RETURNING id
    `, [
      String(windowHours),
      focus,
      JSON.stringify(sourceRefs),
      summary,
      inferredPattern,
      creditAssignment,
      consolidationAction,
    ]);
    replayId = inserted.rows[0].id;
  }

  return {
    ...(replayId ? { replay_id: replayId } : {}),
    mode: execute ? 'execute' : 'preview',
    window_hours: windowHours,
    focus,
    source_count: sourceRefs.length,
    summary,
    inferred_pattern: inferredPattern,
    credit_assignment: creditAssignment,
    consolidation_action: consolidationAction,
    source_refs: sourceRefs,
  };
}

async function detectClearance(
  client: PoolClient,
  args: JsonObject,
  execute: boolean,
): Promise<ClearanceResult> {
  const windowHours = Math.max(1, asNumber(args.window_hours, 24));
  const clearResidueIds = Array.isArray(args.clear_residue_ids)
    ? args.clear_residue_ids.map((v) => Math.round(asNumber(v, 0))).filter((v) => v > 0)
    : [];
  const clearanceNote = asString(args.clearance_note, 'cleared by biology clearance pass');

  let cleared = 0;
  if (execute && clearResidueIds.length > 0) {
    const clearedRes = await client.query<{ id: number }>(`
      UPDATE glymphatic_residue
      SET status = 'cleared', cleared_at = now(), clearance_note = $2
      WHERE id = ANY($1::int[])
        AND status = 'open'
      RETURNING id
    `, [clearResidueIds, clearanceNote]);
    cleared = clearedRes.rows.length;
  }

  const candidates: ResidueCandidate[] = [];

  const unresolved = await client.query<{
    id: number;
    tool_name: string;
    predicted_at: string;
  }>(`
    SELECT id, tool_name, predicted_at
    FROM forward_predictions
    WHERE resolved_at IS NULL
      AND predicted_at < now() - interval '1 hour'
    ORDER BY predicted_at ASC
    LIMIT 20
  `);
  for (const row of unresolved.rows) {
    candidates.push({
      residue_type: 'unresolved_forward_prediction',
      source_table: 'forward_predictions',
      source_id: row.id,
      description: `Forward prediction for ${row.tool_name} has not been resolved since ${row.predicted_at}`,
      severity: 0.55,
      proposed_clearance: 'resolve with actual outcome or mark prediction abandoned',
    });
  }

  const staleForecasts = await client.query<{ id: number; context: string; created_at: string }>(`
    SELECT id, context, created_at
    FROM interoceptive_forecasts
    WHERE status = 'open'
      AND created_at < now() - interval '12 hours'
    ORDER BY created_at ASC
    LIMIT 20
  `);
  for (const row of staleForecasts.rows) {
    candidates.push({
      residue_type: 'stale_interoceptive_forecast',
      source_table: 'interoceptive_forecasts',
      source_id: row.id,
      description: `Interoceptive forecast still open for "${row.context}" from ${row.created_at}`,
      severity: 0.4,
      proposed_clearance: 'resolve forecast or close it as obsolete',
    });
  }

  const staleBreadcrumbs = await client.query<{ id: number; breadcrumb: string; created_at: string }>(`
    SELECT id, breadcrumb, created_at
    FROM hippocampus_buffer
    WHERE archived_at IS NULL
      AND created_at < now() - interval '6 hours'
    ORDER BY created_at ASC
    LIMIT 20
  `);
  for (const row of staleBreadcrumbs.rows) {
    candidates.push({
      residue_type: 'stale_hippocampus_breadcrumb',
      source_table: 'hippocampus_buffer',
      source_id: row.id,
      description: `Unarchived hippocampus breadcrumb from ${row.created_at}: ${row.breadcrumb.slice(0, 160)}`,
      severity: 0.35,
      proposed_clearance: 'run hippocampus archiver or explicitly archive/drop if duplicate',
    });
  }

  const repeatedErrors = await client.query<{ tool_name: string; n: number; last_error: string | null }>(`
    SELECT tool_name, COUNT(*)::int AS n, max(error) AS last_error
    FROM tool_invocations
    WHERE invoked_at > now() - ($1 || ' hours')::interval
      AND error IS NOT NULL
    GROUP BY tool_name
    HAVING COUNT(*) >= 3
    ORDER BY COUNT(*) DESC
    LIMIT 10
  `, [String(windowHours)]);
  for (const row of repeatedErrors.rows) {
    candidates.push({
      residue_type: 'repeated_tool_error',
      source_table: 'tool_invocations',
      source_id: null,
      description: `${row.n} ${row.tool_name} errors in ${windowHours}h; latest error shape: ${(row.last_error || '').slice(0, 160)}`,
      severity: 0.7,
      proposed_clearance: 'inspect root cause before continuing to rely on this tool path',
      metadata: { tool_name: row.tool_name, count: row.n },
    });
  }

  let created = 0;
  if (execute) {
    for (const candidate of candidates) {
      const existing = await client.query<{ id: number }>(`
        SELECT id
        FROM glymphatic_residue
        WHERE status = 'open'
          AND residue_type = $1
          AND source_table IS NOT DISTINCT FROM $2
          AND source_id IS NOT DISTINCT FROM $3
        LIMIT 1
      `, [candidate.residue_type, candidate.source_table, candidate.source_id]);
      if (existing.rows.length > 0) continue;

      await client.query(`
        INSERT INTO glymphatic_residue
          (residue_type, source_table, source_id, description, severity,
           proposed_clearance, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `, [
        candidate.residue_type,
        candidate.source_table,
        candidate.source_id,
        candidate.description,
        candidate.severity,
        candidate.proposed_clearance,
        JSON.stringify(candidate.metadata || {}),
      ]);
      created++;
    }
  }

  return {
    mode: execute ? 'execute' : 'preview',
    detected: candidates.length,
    created,
    cleared,
    candidates,
  };
}

async function evaluateTolerance(
  client: PoolClient,
  args: JsonObject,
  record: boolean,
): Promise<ToleranceResult> {
  const stimulus = asString(args.stimulus, asString(args.planned_action, '')).trim();
  if (!stimulus) throw new Error('stimulus is required');
  const context = asString(args.context, '') || null;
  const evidenceStrength = clamp01(asNumber(args.evidence_strength, 0.5));
  const reversible = asBool(args.reversible, false);
  const userAuthorized = asBool(args.user_authorized, false);

  const antibodies = await client.query<{
    id: number;
    pattern: string;
    threat_type: string | null;
    response: string | null;
    severity: number | null;
  }>('SELECT id, pattern, threat_type, response, severity FROM antibodies ORDER BY severity DESC');

  const matches: JsonObject[] = [];
  for (const antibody of antibodies.rows) {
    try {
      const re = new RegExp(antibody.pattern, 'i');
      if (re.test(stimulus)) {
        matches.push({
          id: antibody.id,
          pattern: antibody.pattern,
          threat_type: antibody.threat_type,
          response: antibody.response,
          severity: antibody.severity ?? 5,
        });
      }
    } catch {
      // Invalid antibody regexes are legacy residue; tolerance should not crash.
    }
  }

  const maxSeverity = matches.reduce((m, row) => Math.max(m, Number(row.severity ?? 0)), 0);
  const dangerScore = round3(clamp01(maxSeverity / 10));
  const toleranceScore = round3(clamp01(
    evidenceStrength * 0.35 +
    (reversible ? 0.25 : 0) +
    (userAuthorized ? 0.30 : 0) +
    (matches.length === 0 ? 0.10 : 0),
  ));

  let decision: string;
  let inhibitoryReason: string;
  if (maxSeverity >= 8 && toleranceScore < 0.7) {
    decision = 'block';
    inhibitoryReason = 'high-severity antibody matched and inhibitory evidence is insufficient';
  } else if (maxSeverity >= 6 && toleranceScore < 0.55) {
    decision = 'escalate';
    inhibitoryReason = 'meaningful danger signal; ask for verification or reduce blast radius';
  } else if (maxSeverity >= 4 && toleranceScore < 0.45) {
    decision = 'observe';
    inhibitoryReason = 'low-to-moderate danger; continue with explicit monitoring';
  } else {
    decision = 'tolerate';
    inhibitoryReason = matches.length > 0
      ? 'danger signal present but balanced by authorization/evidence/reversibility'
      : 'no antibody matched; no immune response needed';
  }

  let toleranceId: number | undefined;
  if (record) {
    const inserted = await client.query<{ id: number }>(`
      INSERT INTO immune_tolerance_decisions
        (stimulus, context, matched_antibodies, max_severity, danger_score,
         tolerance_score, decision, inhibitory_reason)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
      RETURNING id
    `, [
      stimulus,
      context,
      JSON.stringify(matches),
      maxSeverity,
      dangerScore,
      toleranceScore,
      decision,
      inhibitoryReason,
    ]);
    toleranceId = inserted.rows[0].id;
  }

  return {
    ...(toleranceId ? { tolerance_id: toleranceId } : {}),
    stimulus,
    matched_antibodies: matches,
    max_severity: maxSeverity,
    danger_score: dangerScore,
    tolerance_score: toleranceScore,
    decision,
    inhibitory_reason: inhibitoryReason,
  };
}

async function findPruningCandidates(
  client: PoolClient,
  args: JsonObject,
  execute: boolean,
): Promise<PruningResult> {
  const daysStale = Math.max(1, asNumber(args.days_stale, 30));
  const limit = Math.min(Math.max(1, Math.round(asNumber(args.limit, 20))), 100);

  const rows = await client.query<{
    id: number;
    content_type: string;
    content_text: string;
    accessed_at: string | null;
    access_count: number | null;
    confidence: number | null;
    created_at: string;
  }>(`
    SELECT id, content_type, left(content_text, 220) AS content_text,
           accessed_at, access_count, confidence, created_at
    FROM content
    WHERE superseded_by IS NULL
      AND created_at < now() - ($1 || ' days')::interval
      AND COALESCE(access_count, 0) <= 1
      AND COALESCE(confidence, 80) <= 65
      AND content_type NOT IN ('core_memory', 'identity', 'hard_rule', 'belief')
    ORDER BY COALESCE(confidence, 80) ASC, COALESCE(access_count, 0) ASC, created_at ASC
    LIMIT $2
  `, [String(daysStale), limit]);

  const candidates: PruningCandidate[] = rows.rows.map((row) => {
    const confidence = row.confidence ?? 80;
    const accessCount = row.access_count ?? 0;
    const strength = round3(clamp01((65 - confidence) / 65 + (accessCount === 0 ? 0.25 : 0.1)));
    return {
      content_id: row.id,
      content_type: row.content_type,
      preview: row.content_text,
      reason: `low confidence (${confidence}) and low access count (${accessCount}) after ${daysStale}+ days`,
      strength,
      last_accessed_at: row.accessed_at,
      access_count: row.access_count,
      confidence: row.confidence,
      proposed_action: 'review_for_archive_or_reconsolidation',
    };
  });

  let created = 0;
  if (execute) {
    for (const candidate of candidates) {
      const existing = await client.query<{ id: number }>(`
        SELECT id
        FROM synaptic_pruning_candidates
        WHERE status = 'open'
          AND content_id = $1
        LIMIT 1
      `, [candidate.content_id]);
      if (existing.rows.length > 0) continue;

      await client.query(`
        INSERT INTO synaptic_pruning_candidates
          (content_id, reason, strength, last_accessed_at, access_count,
           confidence, proposed_action, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `, [
        candidate.content_id,
        candidate.reason,
        candidate.strength,
        candidate.last_accessed_at,
        candidate.access_count,
        candidate.confidence,
        candidate.proposed_action,
        JSON.stringify({ content_type: candidate.content_type, preview: candidate.preview }),
      ]);
      created++;
    }
  }

  return {
    mode: execute ? 'execute' : 'preview',
    candidates_found: candidates.length,
    created,
    candidates,
  };
}

async function biologyInterocept(args: JsonObject): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    return jsonResult(await createInteroceptiveForecast(client, args, true));
  } finally {
    client.release();
  }
}

async function biologyReplay(args: JsonObject): Promise<CallToolResult> {
  const execute = asBool(args.execute, false);
  const client = await pool.connect();
  try {
    return jsonResult(await buildReplay(client, args, execute));
  } finally {
    client.release();
  }
}

async function biologyClearance(args: JsonObject): Promise<CallToolResult> {
  const execute = asBool(args.execute, false);
  const client = await pool.connect();
  try {
    return jsonResult(await detectClearance(client, args, execute));
  } finally {
    client.release();
  }
}

async function biologyTolerance(args: JsonObject): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    return jsonResult(await evaluateTolerance(client, args, true));
  } finally {
    client.release();
  }
}

async function biologyPrune(args: JsonObject): Promise<CallToolResult> {
  const execute = asBool(args.execute, false);
  const client = await pool.connect();
  try {
    return jsonResult(await findPruningCandidates(client, args, execute));
  } finally {
    client.release();
  }
}

async function biologyCycle(args: JsonObject): Promise<CallToolResult> {
  const phase = asString(args.phase, 'full');
  const context = asString(args.context, '').trim();
  if (!context) return jsonResult({ error: 'context is required' }, true);
  const execute = asBool(args.execute, false);

  const client = await pool.connect();
  try {
    const interoception = await createInteroceptiveForecast(client, {
      ...args,
      context,
    }, execute);
    const replay = await buildReplay(client, args, execute && ['sleep', 'wake', 'full', 'post_action'].includes(phase));
    const clearance = await detectClearance(client, args, execute && ['sleep', 'full'].includes(phase));
    const pruning = await findPruningCandidates(client, args, execute && ['sleep', 'full'].includes(phase));
    const plannedAction = asString(args.planned_action, '');
    const tolerance = plannedAction
      ? await evaluateTolerance(client, {
          stimulus: plannedAction,
          context,
          evidence_strength: args.evidence_strength,
          reversible: args.reversible,
          user_authorized: args.user_authorized,
        }, execute)
      : {
          stimulus: '',
          matched_antibodies: [],
          max_severity: 0,
          danger_score: 0,
          tolerance_score: 1,
          decision: 'not_applicable',
          inhibitory_reason: 'no planned_action supplied',
        };

    let cycleId: number | undefined;
    if (execute) {
      const inserted = await client.query<{ id: number }>(`
        INSERT INTO biology_cycles
          (cycle_phase, context, mode, input_json, interoceptive_state,
           replay_summary, clearance_summary, tolerance_summary, pruning_summary)
        VALUES ($1, $2, 'execute', $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
        RETURNING id
      `, [
        phase,
        context,
        JSON.stringify(args),
        JSON.stringify(interoception),
        JSON.stringify(replay),
        JSON.stringify(clearance),
        JSON.stringify(tolerance),
        JSON.stringify(pruning),
      ]);
      cycleId = inserted.rows[0].id;
    }

    return jsonResult({
      ...(cycleId ? { biology_cycle_id: cycleId } : {}),
      mode: execute ? 'execute' : 'preview',
      phase,
      context,
      interoception,
      replay,
      clearance,
      tolerance,
      pruning,
    });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_biology_interocept',
      description:
        'Interoceptive allostasis: forecast the internal load/reserve cost of a planned action and persist it for later resolution.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string' },
          planned_action: { type: 'string' },
          predicted_load_delta: { type: 'number' },
          predicted_reserve_delta: { type: 'number' },
          predicted_need: { type: 'string' },
          horizon_minutes: { type: 'number' },
        },
        required: ['context'],
      },
    },
    handler: (args) => biologyInterocept(args),
  },
  {
    definition: {
      name: 'vision_biology_interocept_resolve',
      description:
        'Resolve an interoceptive forecast after action: record actual internal cost and prediction error.',
      inputSchema: {
        type: 'object',
        properties: {
          forecast_id: { type: 'number' },
          actual_result: { type: 'string' },
          actual_load: { type: 'number' },
          actual_reserve: { type: 'number' },
        },
        required: ['forecast_id', 'actual_result'],
      },
    },
    handler: (args) => resolveInteroceptiveForecast(args),
  },
  {
    definition: {
      name: 'vision_biology_replay',
      description:
        'Hippocampal replay: replay recent tool/memory/prediction traces into a pattern, credit assignment, and consolidation action.',
      inputSchema: {
        type: 'object',
        properties: {
          window_hours: { type: 'number' },
          focus: { type: 'string' },
          execute: { type: 'boolean' },
        },
      },
    },
    handler: (args) => biologyReplay(args),
  },
  {
    definition: {
      name: 'vision_biology_clearance',
      description:
        'Glymphatic clearance: detect unresolved forecasts, stale breadcrumbs, and repeated tool-error residue; optionally mark/clear residue.',
      inputSchema: {
        type: 'object',
        properties: {
          window_hours: { type: 'number' },
          execute: { type: 'boolean' },
          clear_residue_ids: { type: 'array', items: { type: 'number' } },
          clearance_note: { type: 'string' },
        },
      },
    },
    handler: (args) => biologyClearance(args),
  },
  {
    definition: {
      name: 'vision_biology_tolerance',
      description:
        'Immune tolerance: scan a stimulus against antibodies, then apply inhibitory gating so danger detection does not become overreaction.',
      inputSchema: {
        type: 'object',
        properties: {
          stimulus: { type: 'string' },
          context: { type: 'string' },
          evidence_strength: { type: 'number' },
          reversible: { type: 'boolean' },
          user_authorized: { type: 'boolean' },
        },
        required: ['stimulus'],
      },
    },
    handler: (args) => biologyTolerance(args),
  },
  {
    definition: {
      name: 'vision_biology_prune',
      description:
        'Synaptic pruning: find weak/stale low-confidence memories as review candidates. Never deletes automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          days_stale: { type: 'number' },
          limit: { type: 'number' },
          execute: { type: 'boolean' },
        },
      },
    },
    handler: (args) => biologyPrune(args),
  },
  {
    definition: {
      name: 'vision_biology_cycle',
      description:
        'Run the full biology loop: interoceptive forecast, replay, glymphatic residue check, immune tolerance, and pruning candidates.',
      inputSchema: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['pre_action', 'post_action', 'wake', 'sleep', 'full'] },
          context: { type: 'string' },
          planned_action: { type: 'string' },
          predicted_load_delta: { type: 'number' },
          predicted_reserve_delta: { type: 'number' },
          predicted_need: { type: 'string' },
          horizon_minutes: { type: 'number' },
          window_hours: { type: 'number' },
          focus: { type: 'string' },
          evidence_strength: { type: 'number' },
          reversible: { type: 'boolean' },
          user_authorized: { type: 'boolean' },
          days_stale: { type: 'number' },
          limit: { type: 'number' },
          execute: { type: 'boolean' },
        },
        required: ['context'],
      },
    },
    handler: (args) => biologyCycle(args),
  },
];

export default tools;
