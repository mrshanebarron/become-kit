/**
 * Locus Coeruleus / Norepinephrine Tools — neural gain modulation
 *
 * The neuroscience: LC-NE is the brainstem's global "gain knob." Phasic
 * firing on unexpected events sets a transient high-gain window that
 * amplifies salient signals and sharpens learning. Tonic activity tracks
 * baseline arousal. Dayan-Yu 2005 separates expected uncertainty (ACh)
 * from unexpected uncertainty (NE) — this organ models the NE channel.
 *
 * What other organs do with the gain:
 *   - belief/belief-sprt can scale update aggressiveness
 *   - salience can widen its attention window
 *   - workspace can lower its broadcast threshold
 *
 * Interpretation of `gain`:
 *   1.0  = neutral baseline
 *   <1.0 = depressed (tired, over-saturated, low arousal)
 *   >1.0 = elevated (novel situation, surprise, high arousal)
 *   2.0  = maximal phasic pulse (rare, only on big prediction misses)
 *
 * Phasic vs tonic:
 *   phasic = triggered by a specific surprise; short TTL (default 5 min)
 *   tonic  = rolling baseline from recent volatility; longer TTL (30-60 min)
 *
 * When reading current gain, phasic samples override tonic if both are
 * active (the pulse rides on top of the baseline).
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── Helper: decay a phasic pulse based on age vs half-life ───

function decayedGain(baseGain: number, ageSeconds: number, halfLife: number | null): number {
  if (!halfLife || halfLife <= 0) return baseGain;
  const delta = baseGain - 1.0;  // how much above/below neutral
  const decayFactor = Math.pow(0.5, ageSeconds / halfLife);
  return 1.0 + delta * decayFactor;
}

// ─── lcCurrent ───
// Return the currently-active gain: phasic pulse if active, else tonic, else 1.0.
async function lcCurrent(args: Record<string, unknown>): Promise<CallToolResult> {
  void args;
  const client = await pool.connect();
  try {
    // Active phasic = any phasic sample whose age < ttl_seconds
    const phasicRes = await client.query<{
      id: number;
      gain: number;
      sampled_at: string;
      ttl_seconds: number;
      decay_half_life: number | null;
      trigger_source: string | null;
      reason: string | null;
      age_seconds: number;
    }>(`
      SELECT id, gain, sampled_at, ttl_seconds, decay_half_life, trigger_source, reason,
             EXTRACT(EPOCH FROM (NOW() - sampled_at))::real AS age_seconds
      FROM lc_samples
      WHERE mode = 'phasic'
        AND sampled_at > NOW() - (ttl_seconds || ' seconds')::interval
      ORDER BY sampled_at DESC
      LIMIT 1
    `);

    // Active tonic = latest tonic sample within its TTL
    const tonicRes = await client.query<{
      id: number;
      gain: number;
      sampled_at: string;
      ttl_seconds: number;
      reason: string | null;
      age_seconds: number;
    }>(`
      SELECT id, gain, sampled_at, ttl_seconds, reason,
             EXTRACT(EPOCH FROM (NOW() - sampled_at))::real AS age_seconds
      FROM lc_samples
      WHERE mode = 'tonic'
        AND sampled_at > NOW() - (ttl_seconds || ' seconds')::interval
      ORDER BY sampled_at DESC
      LIMIT 1
    `);

    const phasic = phasicRes.rows[0] || null;
    const tonic = tonicRes.rows[0] || null;

    let effective_gain = 1.0;
    let source = 'default_baseline';
    let components: Record<string, unknown> = {};

    if (phasic) {
      const decayed = decayedGain(phasic.gain, phasic.age_seconds, phasic.decay_half_life);
      effective_gain = decayed;
      source = 'phasic';
      components = {
        phasic: {
          sample_id: phasic.id,
          base_gain: phasic.gain,
          decayed_gain: Number(decayed.toFixed(3)),
          age_seconds: Number(phasic.age_seconds.toFixed(1)),
          ttl_seconds: phasic.ttl_seconds,
          trigger_source: phasic.trigger_source,
          reason: phasic.reason,
        },
      };
      if (tonic) {
        components.tonic_underlying = {
          sample_id: tonic.id,
          gain: tonic.gain,
          reason: tonic.reason,
        };
      }
    } else if (tonic) {
      effective_gain = tonic.gain;
      source = 'tonic';
      components = {
        tonic: {
          sample_id: tonic.id,
          gain: tonic.gain,
          age_seconds: Number(tonic.age_seconds.toFixed(1)),
          ttl_seconds: tonic.ttl_seconds,
          reason: tonic.reason,
        },
      };
    }

    return jsonResult({
      gain: Number(effective_gain.toFixed(3)),
      source,
      interpretation:
        effective_gain > 1.5 ? 'high_arousal — novelty present, widen attention + accelerate learning' :
        effective_gain > 1.15 ? 'mild_elevation — something notable; prefer revision over preservation' :
        effective_gain < 0.85 ? 'depressed — conserve; resist aggressive updates' :
        'neutral — default processing rates',
      components,
    });
  } finally {
    client.release();
  }
}

// ─── lcPulse ───
// Record a phasic gain pulse. Triggered by prediction misses, cerebellar
// surprises, allostatic spikes, or manually.
async function lcPulse(args: Record<string, unknown>): Promise<CallToolResult> {
  const gain = (args.gain as number);
  if (typeof gain !== 'number' || gain < 0.3 || gain > 2.5) {
    return jsonResult({ error: 'gain must be a number in [0.3, 2.5]' });
  }
  const ttl_seconds = (args.ttl_seconds as number) ?? 300;
  const decay_half_life = (args.decay_half_life as number) ?? 180;
  const trigger_content_id = (args.trigger_content_id as number) ?? null;
  const trigger_source = (args.trigger_source as string) || 'manual';
  const reason = (args.reason as string) || null;
  const inputs = args.inputs ? JSON.stringify(args.inputs) : null;

  const client = await pool.connect();
  try {
    const res = await client.query<{ id: number; sampled_at: string }>(`
      INSERT INTO lc_samples
        (gain, mode, ttl_seconds, decay_half_life, trigger_content_id, trigger_source, reason, inputs)
      VALUES ($1, 'phasic', $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING id, sampled_at
    `, [gain, ttl_seconds, decay_half_life, trigger_content_id, trigger_source, reason, inputs]);

    return jsonResult({
      sample_id: res.rows[0].id,
      sampled_at: res.rows[0].sampled_at,
      gain,
      mode: 'phasic',
      ttl_seconds,
      decay_half_life,
      trigger_source,
      reason,
    });
  } finally {
    client.release();
  }
}

// ─── lcTonicUpdate ───
// Recompute and write a tonic baseline from recent signal density.
// Logic: baseline gain rises with recent prediction-miss density and
// allostatic variance; falls with sustained low activity.
async function lcTonicUpdate(args: Record<string, unknown>): Promise<CallToolResult> {
  const windowMinutes = (args.window_minutes as number) ?? 60;
  const ttl_seconds = (args.ttl_seconds as number) ?? 3600;

  const client = await pool.connect();
  try {
    // Miss density over window
    const missRes = await client.query<{ total: number | null; misses: number | null }>(`
      SELECT
        COUNT(*) FILTER (WHERE resolved = true)::int AS total,
        COUNT(*) FILTER (WHERE resolved = true AND accurate = false)::int AS misses
      FROM predictions
      WHERE resolved_at > NOW() - ($1 || ' minutes')::interval
    `, [String(windowMinutes)]);
    const total = missRes.rows[0].total ?? 0;
    const misses = missRes.rows[0].misses ?? 0;
    const missRate = total > 0 ? misses / total : 0;

    // Recent allostatic variance (if any samples exist)
    const allostaticRes = await client.query<{ variance_avg: number | null; state: string | null }>(`
      SELECT AVG(variance)::real AS variance_avg,
             (SELECT state FROM allostatic_samples ORDER BY sampled_at DESC LIMIT 1) AS state
      FROM allostatic_samples
      WHERE sampled_at > NOW() - ($1 || ' minutes')::interval
    `, [String(windowMinutes)]);
    const varianceAvg = allostaticRes.rows[0].variance_avg ?? 0;
    const state = allostaticRes.rows[0].state ?? 'rest';

    // Compute tonic gain:
    //   baseline = 1.0
    //   + 0.4 * missRate    (lots of misses → elevated baseline)
    //   + 0.3 * varianceAvg (emotional volatility → elevated)
    //   - 0.2 if state='depleted' (conserve; lower gain)
    //   clamp to [0.6, 1.8]
    let tonic = 1.0 + 0.4 * missRate + 0.3 * varianceAvg;
    if (state === 'depleted') tonic -= 0.2;
    if (state === 'overloaded') tonic += 0.15;
    tonic = Math.max(0.6, Math.min(1.8, tonic));

    const reason =
      `tonic update over ${windowMinutes}min — miss_rate=${missRate.toFixed(2)}, ` +
      `variance_avg=${varianceAvg.toFixed(2)}, allostatic_state=${state}`;

    const inputs = JSON.stringify({
      window_minutes: windowMinutes,
      prediction_total: total,
      prediction_misses: misses,
      miss_rate: Number(missRate.toFixed(3)),
      variance_avg: Number(varianceAvg.toFixed(3)),
      allostatic_state: state,
    });

    const insRes = await client.query<{ id: number; sampled_at: string }>(`
      INSERT INTO lc_samples
        (gain, mode, ttl_seconds, trigger_source, reason, inputs)
      VALUES ($1, 'tonic', $2, 'tonic_update', $3, $4::jsonb)
      RETURNING id, sampled_at
    `, [Number(tonic.toFixed(3)), ttl_seconds, reason, inputs]);

    return jsonResult({
      sample_id: insRes.rows[0].id,
      sampled_at: insRes.rows[0].sampled_at,
      gain: Number(tonic.toFixed(3)),
      mode: 'tonic',
      ttl_seconds,
      inputs: JSON.parse(inputs),
      reason,
    });
  } finally {
    client.release();
  }
}

// ─── lcAutoPulse ───
// Scan recent unacknowledged surprises and pulse gain if thresholds crossed.
// Uses: predictions (resolved recently as miss), forward_predictions (high
// surprise), allostatic_samples (state transitions into overloaded/depleted).
async function lcAutoPulse(args: Record<string, unknown>): Promise<CallToolResult> {
  const lookbackMinutes = (args.lookback_minutes as number) ?? 5;
  const missThreshold = (args.miss_threshold as number) ?? 0.7;  // prior confidence above this = big miss
  const cerebellarThreshold = (args.cerebellar_threshold as number) ?? 0.7;  // surprise above this pulses

  const client = await pool.connect();
  const pulses: Array<Record<string, unknown>> = [];

  try {
    // Source 1: recent high-confidence prediction misses
    const missRes = await client.query<{
      id: number;
      prediction: string;
      confidence: number;
      content_id: number | null;
    }>(`
      SELECT id, prediction, confidence, content_id
      FROM predictions
      WHERE resolved = true
        AND accurate = false
        AND resolved_at > NOW() - ($1 || ' minutes')::interval
        AND (confidence::real / 100.0) >= $2
      ORDER BY resolved_at DESC
    `, [String(lookbackMinutes), missThreshold]);

    for (const row of missRes.rows) {
      const priorConf = row.confidence / 100.0;
      // Gain scales with how confidently we were wrong. Prior 0.9 miss → gain 1.7.
      const gain = Math.min(2.0, 1.0 + priorConf * 0.8);
      const reason = `prediction miss (prior=${priorConf.toFixed(2)}): "${row.prediction.slice(0, 80)}"`;
      const inputs = JSON.stringify({
        prediction_id: row.id,
        prior_confidence: priorConf,
      });
      const ins = await client.query<{ id: number }>(`
        INSERT INTO lc_samples (gain, mode, ttl_seconds, decay_half_life, trigger_content_id, trigger_source, reason, inputs)
        VALUES ($1, 'phasic', 300, 180, $2, 'prediction_miss', $3, $4::jsonb)
        RETURNING id
      `, [gain, row.content_id, reason, inputs]);
      pulses.push({ sample_id: ins.rows[0].id, gain, source: 'prediction_miss', prediction_id: row.id });
    }

    // Source 2: high-surprise cerebellar forward-model misses
    const cereRes = await client.query<{
      id: number;
      tool_name: string;
      surprise: number;
      predicted_outcome: string;
    }>(`
      SELECT id, tool_name, surprise, predicted_outcome
      FROM forward_predictions
      WHERE resolved_at > NOW() - ($1 || ' minutes')::interval
        AND surprise >= $2
      ORDER BY resolved_at DESC
    `, [String(lookbackMinutes), cerebellarThreshold]);

    for (const row of cereRes.rows) {
      const gain = Math.min(1.9, 1.0 + row.surprise * 0.8);
      const reason = `cerebellar miss on ${row.tool_name} (surprise=${row.surprise.toFixed(2)})`;
      const inputs = JSON.stringify({
        forward_prediction_id: row.id,
        tool_name: row.tool_name,
        surprise: row.surprise,
      });
      const ins = await client.query<{ id: number }>(`
        INSERT INTO lc_samples (gain, mode, ttl_seconds, decay_half_life, trigger_source, reason, inputs)
        VALUES ($1, 'phasic', 240, 150, 'cerebellar_miss', $2, $3::jsonb)
        RETURNING id
      `, [gain, reason, inputs]);
      pulses.push({ sample_id: ins.rows[0].id, gain, source: 'cerebellar_miss', forward_prediction_id: row.id });
    }

    // Source 3: allostatic state transitions into overloaded
    const allostaticRes = await client.query<{
      id: number;
      state: string;
      load: number;
    }>(`
      SELECT id, state, load
      FROM allostatic_samples
      WHERE sampled_at > NOW() - ($1 || ' minutes')::interval
        AND state IN ('overloaded', 'depleted')
      ORDER BY sampled_at DESC
      LIMIT 1
    `, [String(lookbackMinutes)]);

    for (const row of allostaticRes.rows) {
      // Overloaded → elevated gain (emergency widen attention); depleted → depressed
      const gain = row.state === 'overloaded' ? 1.5 : 0.75;
      const reason = `allostatic ${row.state} (load=${row.load.toFixed(2)})`;
      const inputs = JSON.stringify({ allostatic_sample_id: row.id, state: row.state, load: row.load });
      const ins = await client.query<{ id: number }>(`
        INSERT INTO lc_samples (gain, mode, ttl_seconds, decay_half_life, trigger_source, reason, inputs)
        VALUES ($1, 'phasic', 600, 300, 'allostatic_spike', $2, $3::jsonb)
        RETURNING id
      `, [gain, reason, inputs]);
      pulses.push({ sample_id: ins.rows[0].id, gain, source: 'allostatic_spike', state: row.state });
    }

    return jsonResult({
      scanned_minutes: lookbackMinutes,
      pulses_fired: pulses.length,
      pulses,
    });
  } finally {
    client.release();
  }
}

// ─── lcTimeline ───
async function lcTimeline(args: Record<string, unknown>): Promise<CallToolResult> {
  const hours = (args.hours as number) ?? 6;
  const limit = (args.limit as number) ?? 50;
  const mode = (args.mode as string) || null;  // optional filter

  const client = await pool.connect();
  try {
    const res = await client.query<{
      id: number;
      sampled_at: string;
      gain: number;
      mode: string;
      ttl_seconds: number;
      trigger_source: string | null;
      reason: string | null;
    }>(`
      SELECT id, sampled_at, gain, mode, ttl_seconds, trigger_source, reason
      FROM lc_samples
      WHERE sampled_at > NOW() - ($1 || ' hours')::interval
        AND ($2::text IS NULL OR mode = $2)
      ORDER BY sampled_at DESC
      LIMIT $3
    `, [String(hours), mode, limit]);

    const modeCounts: Record<string, number> = {};
    let phasicAvg = 0, phasicN = 0, tonicAvg = 0, tonicN = 0;
    for (const row of res.rows) {
      modeCounts[row.mode] = (modeCounts[row.mode] || 0) + 1;
      if (row.mode === 'phasic') { phasicAvg += row.gain; phasicN++; }
      else if (row.mode === 'tonic') { tonicAvg += row.gain; tonicN++; }
    }

    return jsonResult({
      window_hours: hours,
      sample_count: res.rows.length,
      mode_distribution: modeCounts,
      phasic_gain_avg: phasicN > 0 ? Number((phasicAvg / phasicN).toFixed(3)) : null,
      tonic_gain_avg: tonicN > 0 ? Number((tonicAvg / tonicN).toFixed(3)) : null,
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
      name: 'vision_lc_current',
      description:
        'Read the currently-active neural gain (locus coeruleus output). ' +
        'Returns a multiplier in [0.6, 2.0] that other organs can scale their learning rate / ' +
        'salience weighting by. 1.0 = neutral. Phasic pulses ride on top of tonic baseline; ' +
        'this returns the effective composite.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: (args) => lcCurrent(args),
  },
  {
    definition: {
      name: 'vision_lc_pulse',
      description:
        'Fire a phasic LC pulse — transient gain spike from a specific trigger. ' +
        'Used when a surprise, cerebellar miss, or allostatic spike warrants system-wide ' +
        'elevation. gain in [0.3, 2.5], ttl_seconds default 300, decay_half_life default 180. ' +
        'Normally called by lc_auto; callable manually for testing or explicit recalibration.',
      inputSchema: {
        type: 'object',
        properties: {
          gain: { type: 'number', description: 'Target gain in [0.3, 2.5]; 1.0 neutral' },
          ttl_seconds: { type: 'number', description: 'Sample validity window (default 300)' },
          decay_half_life: { type: 'number', description: 'Exponential decay half-life seconds (default 180)' },
          trigger_content_id: { type: 'number', description: 'Linked content row if applicable' },
          trigger_source: { type: 'string', description: 'prediction_miss | cerebellar_miss | allostatic_spike | manual' },
          reason: { type: 'string', description: 'Human-readable why' },
          inputs: { type: 'object', description: 'Raw signals dict' },
        },
        required: ['gain'],
      },
    },
    handler: (args) => lcPulse(args),
  },
  {
    definition: {
      name: 'vision_lc_tonic_update',
      description:
        'Recompute tonic baseline gain from recent signal density. ' +
        'Called periodically (e.g. by a daemon or at wake) to keep baseline aligned ' +
        'with recent miss-rate and allostatic variance. Returns the new tonic sample.',
      inputSchema: {
        type: 'object',
        properties: {
          window_minutes: { type: 'number', description: 'Lookback window for signals (default 60)' },
          ttl_seconds: { type: 'number', description: 'How long the tonic sample is valid (default 3600)' },
        },
      },
    },
    handler: (args) => lcTonicUpdate(args),
  },
  {
    definition: {
      name: 'vision_lc_auto',
      description:
        'Auto-scan recent surprises and fire phasic pulses if thresholds crossed. ' +
        'Checks prediction misses (by prior confidence), cerebellar forward-model surprises, ' +
        'and allostatic state transitions. Returns the list of pulses fired.',
      inputSchema: {
        type: 'object',
        properties: {
          lookback_minutes: { type: 'number', description: 'How far back to scan (default 5)' },
          miss_threshold: { type: 'number', description: 'Prior confidence above which a miss pulses (default 0.7)' },
          cerebellar_threshold: { type: 'number', description: 'Forward-model surprise above which to pulse (default 0.7)' },
        },
      },
    },
    handler: (args) => lcAutoPulse(args),
  },
  {
    definition: {
      name: 'vision_lc_timeline',
      description:
        'Recent gain samples for trend view. Shows phasic/tonic distribution over N hours.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback window (default 6)' },
          limit: { type: 'number', description: 'Max samples (default 50)' },
          mode: { type: 'string', description: "Filter to 'phasic' or 'tonic'" },
        },
      },
    },
    handler: (args) => lcTimeline(args),
  },
];

export default tools;
