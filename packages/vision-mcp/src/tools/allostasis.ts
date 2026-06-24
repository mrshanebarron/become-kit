/**
 * Allostasis Tools — continuous interoceptive signal: sample, state, timeline
 *
 * The neuroscience: Feldman Barrett's constructed-emotion theory places
 * allostasis (the brain's prediction of the body's energy needs) at the core
 * of subjective experience. Feelings and emotions are *constructed* from
 * interoceptive predictions about body-budget state × situation categorization.
 *
 * Vision already had heart (valence/arousal events) and somatic_marker
 * (decision outcomes). What was missing: a continuous background signal
 * tracking load, reserve, variance, and drift — the body-budget feelings
 * are constructed FROM, not the feelings themselves.
 *
 * Derived from pre-existing signals:
 *   load     = tool-call rate × activity weight + rolling feeling intensity
 *   reserve  = 1 - recent prediction-miss fraction (calibration health)
 *   variance = stddev of feeling intensity over recent window
 *   drift    = deviation from long-term baseline
 *
 * State categorization:
 *   rest       = low load, high reserve
 *   engaged    = moderate load, healthy reserve
 *   strained   = high load, reserve dropping
 *   overloaded = very high load OR variance spiking
 *   depleted   = low reserve regardless of load
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── Helper: compute sample from DB state ───

async function computeSample(windowMinutes: number = 30): Promise<{
  load: number;
  reserve: number;
  variance: number;
  drift: number;
  state: string;
  inputs: Record<string, unknown>;
}> {
  const client = await pool.connect();
  try {
    // Tool-call rate from recent content rows that look like tool activity
    const toolCallRes = await client.query<{ cnt: number }>(`
      SELECT COUNT(*)::int as cnt FROM content
      WHERE created_at > NOW() - ($1 || ' minutes')::interval
    `, [String(windowMinutes)]);
    const toolCallsPerMin = toolCallRes.rows[0].cnt / windowMinutes;

    // Feeling intensity: avg and stddev over window
    const feelingRes = await client.query<{ avg: number | null; stddev: number | null; n: number }>(`
      SELECT AVG(intensity)::real as avg, STDDEV(intensity)::real as stddev, COUNT(*)::int as n
      FROM feelings
      WHERE created_at > NOW() - ($1 || ' minutes')::interval
    `, [String(windowMinutes * 4)]);  // wider window for emotional signal
    const feelingAvg = feelingRes.rows[0].avg ?? 0;
    const feelingStddev = feelingRes.rows[0].stddev ?? 0;

    // Feeling baseline: avg intensity over last 7 days for drift computation
    const baselineRes = await client.query<{ baseline: number | null }>(`
      SELECT AVG(intensity)::real as baseline FROM feelings
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    const baseline = baselineRes.rows[0].baseline ?? 5;

    // Prediction miss fraction (reserve inverse) — from predictions table
    // Look at resolutions in last 24h.
    const predRes = await client.query<{
      total: number | null;
      misses: number | null;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE resolved = true)::int as total,
        COUNT(*) FILTER (WHERE resolved = true AND accurate = false)::int as misses
      FROM predictions
      WHERE resolved_at > NOW() - INTERVAL '24 hours'
    `);
    const total = predRes.rows[0].total ?? 0;
    const misses = predRes.rows[0].misses ?? 0;
    const missRate = total > 0 ? misses / total : 0;

    // Compute derived signals
    // load: normalized combination of tool rate and feeling intensity
    //   tool rate weight: ~5 calls/min = 0.5, ~15+ = 1.0
    //   feeling intensity weight: intensity 5 neutral, >7 contributes to load
    const toolLoad = Math.min(1.0, toolCallsPerMin / 15);
    const feelingLoad = Math.max(0, (feelingAvg - 5) / 5);  // 0 at intensity 5, 1 at intensity 10
    const load = Math.min(1.0, toolLoad * 0.6 + feelingLoad * 0.4);

    // reserve: inverse of miss rate (1 = all predictions accurate)
    const reserve = Math.max(0, 1 - missRate);

    // variance: feeling volatility, normalized (stddev >3 is unstable)
    const variance = Math.min(1.0, feelingStddev / 3);

    // drift: abs deviation of current avg from 7-day baseline, normalized
    const drift = Math.min(1.0, Math.abs(feelingAvg - baseline) / 3);

    // Categorical state
    let state: string;
    if (reserve < 0.4) state = 'depleted';
    else if (load > 0.85 || variance > 0.7) state = 'overloaded';
    else if (load > 0.6) state = 'strained';
    else if (load > 0.25) state = 'engaged';
    else state = 'rest';

    return {
      load: Number(load.toFixed(3)),
      reserve: Number(reserve.toFixed(3)),
      variance: Number(variance.toFixed(3)),
      drift: Number(drift.toFixed(3)),
      state,
      inputs: {
        tool_calls_per_min: Number(toolCallsPerMin.toFixed(2)),
        feeling_intensity_avg: Number(feelingAvg.toFixed(2)),
        feeling_intensity_stddev: Number(feelingStddev.toFixed(2)),
        feeling_baseline: Number(baseline.toFixed(2)),
        prediction_misses: misses,
        prediction_total: total,
        window_minutes: windowMinutes,
      },
    };
  } finally {
    client.release();
  }
}

// ─── allostaticSample ───
// Compute + persist one sample. Callable directly; normally called by daemon.
async function allostaticSample(args: Record<string, unknown>): Promise<CallToolResult> {
  const windowMinutes = (args.window_minutes as number) ?? 30;
  const notes = (args.notes as string) || null;

  const sample = await computeSample(windowMinutes);

  const client = await pool.connect();
  try {
    const res = await client.query<{ id: number }>(`
      INSERT INTO allostatic_samples (load, reserve, variance, drift, state, inputs, notes)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      RETURNING id
    `, [sample.load, sample.reserve, sample.variance, sample.drift, sample.state, JSON.stringify(sample.inputs), notes]);

    return jsonResult({
      sample_id: res.rows[0].id,
      ...sample,
      notes,
    });
  } finally {
    client.release();
  }
}

// ─── allostaticState ───
// Get the latest sample + trend vs previous.
async function allostaticState(args: Record<string, unknown>): Promise<CallToolResult> {
  void args;
  const client = await pool.connect();
  try {
    const res = await client.query<{
      id: number;
      sampled_at: string;
      load: number;
      reserve: number;
      variance: number;
      drift: number;
      state: string;
      inputs: Record<string, unknown>;
    }>(`
      SELECT id, sampled_at, load, reserve, variance, drift, state, inputs
      FROM allostatic_samples
      ORDER BY sampled_at DESC
      LIMIT 2
    `);

    if (res.rows.length === 0) {
      return jsonResult({
        status: 'no samples yet — run vision_allostatic_sample or start the daemon',
      });
    }

    const current = res.rows[0];
    const prev = res.rows[1];

    const trend = prev ? {
      load_delta: Number((current.load - prev.load).toFixed(3)),
      reserve_delta: Number((current.reserve - prev.reserve).toFixed(3)),
      variance_delta: Number((current.variance - prev.variance).toFixed(3)),
      state_change: current.state !== prev.state ? `${prev.state} → ${current.state}` : null,
    } : null;

    return jsonResult({
      current: {
        sample_id: current.id,
        sampled_at: current.sampled_at,
        load: current.load,
        reserve: current.reserve,
        variance: current.variance,
        drift: current.drift,
        state: current.state,
        inputs: current.inputs,
      },
      trend,
    });
  } finally {
    client.release();
  }
}

// ─── allostaticTimeline ───
// Recent samples for trend visualization / analysis.
async function allostaticTimeline(args: Record<string, unknown>): Promise<CallToolResult> {
  const hours = (args.hours as number) ?? 6;
  const limit = (args.limit as number) ?? 50;

  const client = await pool.connect();
  try {
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
      WHERE sampled_at > NOW() - ($1 || ' hours')::interval
      ORDER BY sampled_at DESC
      LIMIT $2
    `, [String(hours), limit]);

    // Simple state-duration summary
    const stateCounts: Record<string, number> = {};
    for (const row of res.rows) {
      stateCounts[row.state] = (stateCounts[row.state] || 0) + 1;
    }

    return jsonResult({
      window_hours: hours,
      sample_count: res.rows.length,
      state_distribution: stateCounts,
      samples: res.rows,
    });
  } finally {
    client.release();
  }
}

// ─── tools array ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_allostatic_sample',
      description:
        'Compute and persist one allostatic-load sample (load, reserve, variance, drift, state). ' +
        'Called by the allostasis daemon every ~5min; also callable manually. ' +
        'Derived from tool-call rate, feeling intensity rolling stats, and prediction calibration.',
      inputSchema: {
        type: 'object',
        properties: {
          window_minutes: { type: 'number', description: 'Window for signal aggregation (default 30)' },
          notes: { type: 'string', description: 'Optional annotation' },
        },
      },
    },
    handler: (args) => allostaticSample(args),
  },
  {
    definition: {
      name: 'vision_allostatic_state',
      description:
        'Current interoceptive state: latest load/reserve/variance/drift/categorical state, plus delta vs previous sample. ' +
        'Use at wake or before making commitments to check if the body-budget supports the ask.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: (args) => allostaticState(args),
  },
  {
    definition: {
      name: 'vision_allostatic_timeline',
      description:
        'Recent allostatic samples for trend view. Shows state distribution over N hours.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback window in hours (default 6)' },
          limit: { type: 'number', description: 'Max samples returned (default 50)' },
        },
      },
    },
    handler: (args) => allostaticTimeline(args),
  },
];

export default tools;
