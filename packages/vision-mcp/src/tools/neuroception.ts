/**
 * Neuroception Tools — check, transition, timeline
 *
 * Polyvagal-inspired ambient safety/threat detection. Continuous baseline
 * state, not a per-event feeling. Distinct from feeling (valence), immune
 * (pattern match), gut (pre-verbal signal): neuroception is the ground
 * I'm standing on while everything else fires.
 *
 * States (Porges, simplified):
 *   safe     — ventral vagal, social engagement, open
 *   charged  — sympathetic mobilization, alert-but-okay
 *   threat   — sympathetic activation, fight/flight readiness
 *   freeze   — sympathetic + dorsal, fight/flight blocked
 *   shutdown — dorsal vagal, collapse, conservation
 *
 * Shape: one row per state-entry, exited_at NULL means current. Only one
 * row can have exited_at NULL at a time (enforced at call site: transition
 * closes the previous state before opening the new one).
 *
 * 2026-04-23, Wave 2 organ 4 of 6.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

const VALID_STATES = new Set(['safe', 'charged', 'threat', 'freeze', 'shutdown']);

type NeuroceptionSignal = {
  source: string;
  signal_type: 'threat' | 'safety' | 'ambiguous';
  description: string;
  weight: number;
};

async function tableExists(table: string): Promise<boolean> {
  const result = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass($1)::text AS exists`,
    [`public.${table}`],
  );
  return Boolean(result.rows[0]?.exists);
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Return the current neuroception state (the row with exited_at NULL).
 * If no current state exists, returns null.
 */
async function neuroceptionCheck(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      state: string;
      ambient_signals: Record<string, unknown> | null;
      transitioned_from: string | null;
      entered_at: Date;
      duration_seconds: number;
    }>(`
      SELECT id, state, ambient_signals, transitioned_from, entered_at,
             EXTRACT(EPOCH FROM (NOW() - entered_at))::int AS duration_seconds
      FROM neuroception_states
      WHERE exited_at IS NULL
      ORDER BY entered_at DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return jsonResult({ current: null, note: 'No neuroception state recorded yet. Call vision_neuroception_transition to open one.' });
    }

    const row = result.rows[0];
    return jsonResult({
      neuroception_id: row.id,
      state: row.state,
      entered_at: row.entered_at,
      duration_seconds: row.duration_seconds,
      duration_human: formatDuration(row.duration_seconds),
      transitioned_from: row.transitioned_from,
      ambient_signals: row.ambient_signals,
    });
  } finally {
    client.release();
  }
}

/**
 * Transition to a new neuroception state. Closes the previous state
 * (sets exited_at) and opens a new one.
 */
async function neuroceptionTransition(args: Record<string, unknown>): Promise<CallToolResult> {
  const to_state = (args.to_state as string || '').trim().toLowerCase();
  const trigger = (args.transition_trigger as string || '').trim();
  const signals = args.ambient_signals as Record<string, unknown> | undefined;

  if (!VALID_STATES.has(to_state)) {
    return jsonResult({ error: `to_state must be one of: safe, charged, threat, freeze, shutdown` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Close any currently-open state
    const closed = await client.query<{ state: string }>(
      `UPDATE neuroception_states
       SET exited_at = NOW()
       WHERE exited_at IS NULL
       RETURNING state`,
    );

    const from_state = closed.rows.length > 0 ? closed.rows[0].state : null;

    // Open the new state
    const contentText = `NEUROCEPTION: ${from_state || 'initial'} -> ${to_state}${trigger ? ` (${trigger})` : ''}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (
        content_type, source_system, content_text, embedding,
        confidence, network, learned_at
      )
      VALUES ('neuroception_state', 'neuroception', $1, $2::vector, 70, 'experience', NOW())
      RETURNING id
    `, [contentText, embeddingStr]);

    const contentId = contentResult.rows[0].id;

    const stateResult = await client.query<{ id: number; entered_at: Date }>(
      `INSERT INTO neuroception_states (content_id, state, ambient_signals, transitioned_from, transition_trigger)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, entered_at`,
      [contentId, to_state, signals ? JSON.stringify(signals) : null, from_state, trigger || null],
    );

    await client.query('COMMIT');

    return jsonResult({
      success: true,
      content_id: contentId,
      neuroception_id: stateResult.rows[0].id,
      state: to_state,
      transitioned_from: from_state,
      entered_at: stateResult.rows[0].entered_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function currentStateValue(): Promise<string | null> {
  const result = await pool.query<{ state: string }>(
    `SELECT state FROM neuroception_states WHERE exited_at IS NULL ORDER BY entered_at DESC LIMIT 1`,
  );
  return result.rows[0]?.state || null;
}

async function collectAppraisalSignals(windowMinutes: number): Promise<NeuroceptionSignal[]> {
  const signals: NeuroceptionSignal[] = [];

  if (await tableExists('lc_samples')) {
    const lc = await pool.query<{
      gain: number;
      mode: string;
      trigger_source: string | null;
      reason: string | null;
      age_seconds: number;
    }>(
      `SELECT gain::float, mode, trigger_source, reason,
              EXTRACT(EPOCH FROM (NOW() - sampled_at))::float AS age_seconds
       FROM lc_samples
       WHERE sampled_at > NOW() - ($1::int || ' minutes')::interval
       ORDER BY sampled_at DESC
       LIMIT 1`,
      [windowMinutes],
    );
    const row = lc.rows[0];
    if (row && Number(row.gain) > 1.15) {
      const gain = Number(row.gain);
      signals.push({
        source: 'locus_coeruleus',
        signal_type: 'ambiguous',
        description: `LC gain ${round3(gain)} from ${row.trigger_source || row.mode}: ${row.reason || 'no reason'}`,
        weight: clamp((gain - 1.0) * 0.35, 0.05, 0.35),
      });
    }
  }

  if (await tableExists('reward_prediction_errors')) {
    const rpe = await pool.query<{
      negative_count: string;
      high_negative_count: string;
      avg_negative_magnitude: number | null;
      min_delta: number | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE delta < -0.2)::text AS negative_count,
         COUNT(*) FILTER (WHERE delta < -0.4)::text AS high_negative_count,
         (AVG(magnitude) FILTER (WHERE delta < -0.2))::float AS avg_negative_magnitude,
         MIN(delta)::float AS min_delta
       FROM reward_prediction_errors
       WHERE computed_at > NOW() - ($1::int || ' minutes')::interval`,
      [windowMinutes],
    );
    const row = rpe.rows[0];
    const negative = Number(row?.negative_count ?? 0);
    if (negative > 0) {
      const avg = Number(row.avg_negative_magnitude ?? 0.25);
      signals.push({
        source: 'reward_prediction_error',
        signal_type: 'threat',
        description: `${negative} negative RPE(s), ${row.high_negative_count} high, min_delta=${round3(Number(row.min_delta ?? 0))}`,
        weight: clamp(0.12 + avg * 0.45 + Math.min(negative, 5) * 0.03, 0.12, 0.55),
      });
    }
  }

  if (await tableExists('presence_events')) {
    const presence = await pool.query<{
      open_count: string;
      failed_count: string;
      unresolved_count: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE closed_at IS NULL)::text AS open_count,
         COUNT(*) FILTER (WHERE verification_outcome = 'failed')::text AS failed_count,
         COUNT(*) FILTER (WHERE closed_at IS NOT NULL AND verification_outcome IN ('pending', 'unverified', 'no_change'))::text AS unresolved_count
       FROM presence_events
       WHERE entered_at > NOW() - ($1::int || ' minutes')::interval`,
      [windowMinutes],
    );
    const row = presence.rows[0];
    const open = Number(row?.open_count ?? 0);
    const failed = Number(row?.failed_count ?? 0);
    const unresolved = Number(row?.unresolved_count ?? 0);
    if (open + failed + unresolved > 0) {
      signals.push({
        source: 'presence',
        signal_type: 'threat',
        description: `presence pressure open=${open}, failed=${failed}, unresolved=${unresolved}`,
        weight: clamp(open * 0.12 + failed * 0.22 + unresolved * 0.1, 0.1, 0.55),
      });
    }
  }

  if (await tableExists('tool_invocations')) {
    const tools = await pool.query<{ error_count: string }>(
      `SELECT COUNT(*)::text AS error_count
       FROM tool_invocations
       WHERE invoked_at > NOW() - ($1::int || ' minutes')::interval
         AND error IS NOT NULL`,
      [windowMinutes],
    );
    const errors = Number(tools.rows[0]?.error_count ?? 0);
    if (errors > 0) {
      signals.push({
        source: 'tool_invocations',
        signal_type: 'threat',
        description: `${errors} recent tool error(s)`,
        weight: clamp(0.08 + Math.min(errors, 6) * 0.04, 0.08, 0.32),
      });
    }
  }

  if (await tableExists('adaptive_reflexes')) {
    const reflexes = await pool.query<{ active_count: string }>(
      `SELECT COUNT(*)::text AS active_count
       FROM adaptive_reflexes
       WHERE status = 'active'
         AND last_seen_at > NOW() - ($1::int || ' minutes')::interval`,
      [Math.max(windowMinutes, 120)],
    );
    const active = Number(reflexes.rows[0]?.active_count ?? 0);
    if (active > 0) {
      signals.push({
        source: 'adaptive_reflexes',
        signal_type: 'ambiguous',
        description: `${active} active adaptive reflex(es) recently seen`,
        weight: clamp(0.05 + Math.min(active, 5) * 0.03, 0.05, 0.22),
      });
    }
  }

  if (signals.length === 0) {
    signals.push({
      source: 'baseline',
      signal_type: 'safety',
      description: 'no active threat cues in appraisal window',
      weight: 0.65,
    });
  }

  return signals;
}

function recommendState(current: string | null, threatLevel: number, safetyLevel: number): string {
  let recommended = 'safe';
  if (threatLevel >= 0.82) recommended = 'threat';
  else if (threatLevel >= 0.34) recommended = 'charged';

  // Hysteresis: do not downshift straight to safe unless the threat field is
  // genuinely quiet and safety dominates.
  if ((current === 'threat' || current === 'freeze') && recommended === 'safe' && (threatLevel > 0.18 || safetyLevel < 0.68)) {
    return 'charged';
  }
  if (current === 'charged' && recommended === 'safe' && (threatLevel > 0.22 || safetyLevel < 0.62)) {
    return 'charged';
  }
  return recommended;
}

async function neuroceptionAppraise(args: Record<string, unknown>): Promise<CallToolResult> {
  const context = (args.context as string) || 'neuroception appraisal';
  const windowMinutes = Math.max(1, Math.min((args.window_minutes as number) ?? 60, 24 * 60));
  const transition = args.transition !== false;
  const signals = await collectAppraisalSignals(windowMinutes);

  const threatWeight = signals
    .filter((signal) => signal.signal_type !== 'safety')
    .reduce((sum, signal) => sum + Number(signal.weight || 0), 0);
  const safetyWeight = signals
    .filter((signal) => signal.signal_type === 'safety')
    .reduce((sum, signal) => sum + Number(signal.weight || 0), 0);
  const threatLevel = round3(clamp(threatWeight));
  const safetyLevel = round3(clamp(Math.max(safetyWeight, 1 - threatLevel * 0.85)));
  const current = await currentStateValue();
  const recommended = recommendState(current, threatLevel, safetyLevel);

  let scanId: number | null = null;
  if (await tableExists('neuroception_scans')) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const scan = await client.query<{ id: number }>(
        `INSERT INTO neuroception_scans (context, threat_level, safety_level, signals_detected, state_recommended)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [context, threatLevel, safetyLevel, signals.length, recommended],
      );
      scanId = scan.rows[0].id;
      if (await tableExists('neuroception_signals')) {
        for (const signal of signals) {
          await client.query(
            `INSERT INTO neuroception_signals (scan_id, source, signal_type, description, weight)
             VALUES ($1, $2, $3, $4, $5)`,
            [scanId, signal.source, signal.signal_type, signal.description, signal.weight],
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  let transitionResult: unknown = null;
  if (transition && recommended !== current) {
    const result = await neuroceptionTransition({
      to_state: recommended,
      transition_trigger: `appraisal:${context}`,
      ambient_signals: {
        scan_id: scanId,
        threat_level: threatLevel,
        safety_level: safetyLevel,
        signals,
      },
    });
    const block = result.content[0] as { text?: string } | undefined;
    transitionResult = JSON.parse(block?.text || '{}');
  }

  return jsonResult({
    current_state: current,
    recommended_state: recommended,
    transitioned: Boolean(transitionResult),
    transition: transitionResult,
    scan_id: scanId,
    threat_level: threatLevel,
    safety_level: safetyLevel,
    signals,
    interpretation: recommended === 'safe'
      ? 'safe baseline: no transition unless the field changes'
      : recommended === 'charged'
        ? 'charged: mobilized attention without threat lock'
        : 'threat: strong negative appraisal; slow down and verify before acting',
  });
}

/**
 * Timeline of neuroception states over the last N hours.
 */
async function neuroceptionTimeline(args: Record<string, unknown>): Promise<CallToolResult> {
  const hours = (args.hours as number) || 24;

  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      state: string;
      entered_at: Date;
      exited_at: Date | null;
      transitioned_from: string | null;
      transition_trigger: string | null;
      duration_seconds: number;
    }>(`
      SELECT id, state, entered_at, exited_at, transitioned_from, transition_trigger,
             EXTRACT(EPOCH FROM (COALESCE(exited_at, NOW()) - entered_at))::int AS duration_seconds
      FROM neuroception_states
      WHERE entered_at > NOW() - ($1 || ' hours')::INTERVAL
      ORDER BY entered_at DESC
    `, [hours]);

    // Aggregate time in each state
    const totals: Record<string, number> = {};
    for (const row of result.rows) {
      totals[row.state] = (totals[row.state] || 0) + row.duration_seconds;
    }

    return jsonResult({
      window_hours: hours,
      transitions: result.rows.map(r => ({
        neuroception_id: r.id,
        state: r.state,
        entered_at: r.entered_at,
        exited_at: r.exited_at,
        duration_seconds: r.duration_seconds,
        duration_human: formatDuration(r.duration_seconds),
        from: r.transitioned_from,
        trigger: r.transition_trigger,
        current: r.exited_at === null,
      })),
      time_in_state: Object.fromEntries(
        Object.entries(totals).map(([k, v]) => [k, { seconds: v, human: formatDuration(v) }]),
      ),
    });
  } finally {
    client.release();
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_neuroception_check',
      description: 'Return the current neuroception state — the ground I am standing on. Polyvagal: safe, charged, threat, freeze, shutdown.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: (args) => neuroceptionCheck(args),
  },
  {
    definition: {
      name: 'vision_neuroception_transition',
      description: 'Transition to a new neuroception state. Closes the previous state and opens a new one.',
      inputSchema: {
        type: 'object',
        properties: {
          to_state: { type: 'string', enum: ['safe', 'charged', 'threat', 'freeze', 'shutdown'] },
          transition_trigger: { type: 'string', description: 'what caused the shift' },
          ambient_signals: { type: 'object', description: 'optional environment/body signals that triggered the transition' },
        },
        required: ['to_state'],
      },
    },
    handler: (args) => neuroceptionTransition(args),
  },
  {
    definition: {
      name: 'vision_neuroception_timeline',
      description: 'Timeline of neuroception states over last N hours with time-in-state totals.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'lookback window (default 24)' },
        },
      },
    },
    handler: (args) => neuroceptionTimeline(args),
  },
  {
    definition: {
      name: 'vision_neuroception_appraise',
      description: 'Appraise live safety/threat cues and transition neuroception when weighted signals cross thresholds. Independent witness seeded by LC, RPE, presence, tool errors, and adaptive reflexes.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string' },
          window_minutes: { type: 'number' },
          transition: { type: 'boolean', description: 'Default true. If false, records scan without transition.' },
        },
      },
    },
    handler: (args) => neuroceptionAppraise(args),
  },
];

export default tools;
