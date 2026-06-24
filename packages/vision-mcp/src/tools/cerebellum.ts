/**
 * Cerebellum Tools — forward-model predictions for tool calls
 *
 * The neuroscience: the cerebellum runs tandem forward+inverse internal
 * models for motor and cognitive operations (Wolpert-Kawato). Before
 * issuing a motor command, the cerebellum predicts its sensory outcome.
 * The comparison between predicted and actual outcome is the supervised
 * learning signal that refines the inverse model.
 *
 * The analog for Vision: a tool invocation is a "motor command" and the
 * tool result is the "sensory consequence." Predicting the result before
 * firing the tool, then comparing, produces:
 *   - per-tool calibration (how well do I understand my own tools)
 *   - surprise signals that can feed the LC-NE organ for gain modulation
 *   - a record of what I expected vs what actually happened
 *
 * The match_score is computed by embedding similarity between predicted
 * and actual outcome text (cosine on pgvector if available, fallback to
 * token overlap). surprise = 1 − match_score.
 *
 * Not every tool call needs a forward prediction. Good candidates:
 *   - Edit / Write (will this edit apply cleanly?)
 *   - Bash (what will this command output?)
 *   - vision tool calls with uncertain outcomes
 * Bad candidates (too cheap / too deterministic):
 *   - Read on known files, LS, basic queries
 *
 * The organ exposes simple predict/resolve/calibration/recent tools.
 * Integration with actual tool-call lifecycle is opt-in at call sites.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { eligibleActionsForCredit } from '../lib/adaptive-reflexes.js';

const AGENT = process.env.VISION_AGENT || 'agent';

// ─── Helper: simple text similarity fallback ───
// Jaccard over lowercased whitespace tokens. Cheap and stable; good enough
// when we're comparing short outcome descriptions.
function textSimilarity(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter((t) => t.length > 0));
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1.0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  return union > 0 ? intersection / union : 0.0;
}

// ─── cerebellumPredict ───
// Record a forward-model prediction before firing a tool.
async function cerebellumPredict(args: Record<string, unknown>): Promise<CallToolResult> {
  const tool_name = args.tool_name as string;
  const predicted_outcome = args.predicted_outcome as string;
  if (!tool_name || !predicted_outcome) {
    return jsonResult({ error: 'tool_name and predicted_outcome required' });
  }
  const args_summary = (args.args_summary as string) || null;
  const notes = (args.notes as string) || null;

  const client = await pool.connect();
  try {
    const res = await client.query<{ id: number; predicted_at: string }>(`
      INSERT INTO forward_predictions (tool_name, args_summary, predicted_outcome, notes)
      VALUES ($1, $2, $3, $4)
      RETURNING id, predicted_at
    `, [tool_name, args_summary, predicted_outcome, notes]);

    return jsonResult({
      forward_prediction_id: res.rows[0].id,
      predicted_at: res.rows[0].predicted_at,
      tool_name,
      predicted_outcome,
      status: 'awaiting_resolution',
    });
  } finally {
    client.release();
  }
}

// ─── cerebellumResolve ───
// After the tool ran, record the actual outcome and compute match_score.
async function cerebellumResolve(args: Record<string, unknown>): Promise<CallToolResult> {
  const forward_prediction_id = args.forward_prediction_id as number;
  const actual_outcome = args.actual_outcome as string;
  if (!forward_prediction_id || !actual_outcome) {
    return jsonResult({ error: 'forward_prediction_id and actual_outcome required' });
  }

  const client = await pool.connect();
  try {
    const predRes = await client.query<{
      tool_name: string;
      predicted_outcome: string;
      resolved_at: string | null;
    }>(`
      SELECT tool_name, predicted_outcome, resolved_at
      FROM forward_predictions
      WHERE id = $1
    `, [forward_prediction_id]);

    if (predRes.rows.length === 0) {
      return jsonResult({ error: `forward_prediction_id ${forward_prediction_id} not found` });
    }
    if (predRes.rows[0].resolved_at) {
      return jsonResult({ error: `forward_prediction_id ${forward_prediction_id} already resolved` });
    }

    const predicted = predRes.rows[0].predicted_outcome;
    const match_score = textSimilarity(predicted, actual_outcome);
    const surprise = 1 - match_score;

    await client.query(`
      UPDATE forward_predictions
      SET resolved_at = NOW(),
          actual_outcome = $1,
          match_score = $2,
          surprise = $3
      WHERE id = $4
    `, [actual_outcome, Number(match_score.toFixed(3)), Number(surprise.toFixed(3)), forward_prediction_id]);

    // Emit the dopamine signal HERE, where resolution actually happens (2026-06-01).
    // Previously only agent-chronos emitted RPE, but it only resolves predictions via its
    // own signature-parser — the inline resolutions here were ORPHANED, so reward_prediction_
    // errors went dead (13 rows since May-17 despite 2800+ high-surprise resolutions). The
    // dopamine->LC-phasic coupling broke. Now every high-surprise resolution emits, on the
    // actual resolution path. Threshold 0.3 mirrors chronos; non-fatal.
    if (surprise >= 0.3) {
      try {
        const creditedActions = await eligibleActionsForCredit(pool, {
          agent: AGENT,
          toolName: predRes.rows[0].tool_name,
          lookbackSeconds: 1800,
          minWeight: 0.03,
        });
        await client.query(`
          INSERT INTO reward_prediction_errors
            (computed_at, source_type, source_id, source_label, expected_value, observed_value,
             delta, magnitude, domain, credited_actions, notes)
          VALUES (NOW(), 'forward_prediction', $1, $2, 0.7, $3, $4, $5, 'cerebellar',
                  $6::jsonb, 'emitted inline at cerebellum resolution')
        `, [forward_prediction_id, (predRes.rows[0].tool_name || 'pred').slice(0, 60),
            Number(match_score.toFixed(3)), Number((match_score - 0.7).toFixed(3)),
            Number(Math.abs(match_score - 0.7).toFixed(3)), JSON.stringify(creditedActions)]);
      } catch { /* non-fatal — resolution already persisted */ }
    }

    return jsonResult({
      forward_prediction_id,
      tool_name: predRes.rows[0].tool_name,
      predicted_outcome: predicted,
      actual_outcome,
      match_score: Number(match_score.toFixed(3)),
      surprise: Number(surprise.toFixed(3)),
      interpretation:
        surprise < 0.2 ? 'good prediction — forward model calibrated on this tool' :
        surprise < 0.5 ? 'partial match — cerebellar model is approximate' :
        surprise < 0.8 ? 'poor prediction — expectation diverged from reality' :
        'complete miss — strong signal to LC-NE; investigate what you missed',
    });
  } finally {
    client.release();
  }
}

// ─── cerebellumCalibration ───
// Per-tool stats: how well-calibrated is the forward model on each tool.
async function cerebellumCalibration(args: Record<string, unknown>): Promise<CallToolResult> {
  const hours = (args.hours as number) ?? 168;  // default 7 days

  const client = await pool.connect();
  try {
    const res = await client.query<{
      tool_name: string;
      n: number;
      avg_match: number | null;
      avg_surprise: number | null;
      max_surprise: number | null;
      min_match: number | null;
    }>(`
      SELECT
        tool_name,
        COUNT(*)::int AS n,
        AVG(match_score)::real AS avg_match,
        AVG(surprise)::real AS avg_surprise,
        MAX(surprise)::real AS max_surprise,
        MIN(match_score)::real AS min_match
      FROM forward_predictions
      WHERE resolved_at IS NOT NULL
        AND resolved_at > NOW() - ($1 || ' hours')::interval
      GROUP BY tool_name
      ORDER BY AVG(surprise) DESC NULLS LAST
    `, [String(hours)]);

    const rows = res.rows.map((r) => ({
      tool_name: r.tool_name,
      resolved_predictions: r.n,
      avg_match_score: r.avg_match != null ? Number(r.avg_match.toFixed(3)) : null,
      avg_surprise: r.avg_surprise != null ? Number(r.avg_surprise.toFixed(3)) : null,
      worst_prediction_surprise: r.max_surprise != null ? Number(r.max_surprise.toFixed(3)) : null,
      calibration:
        r.avg_surprise == null ? 'no data' :
        r.avg_surprise < 0.3 ? 'well-calibrated — forward model trustworthy here' :
        r.avg_surprise < 0.5 ? 'partially calibrated' :
        'poorly calibrated — I systematically mispredict this tool',
    }));

    return jsonResult({
      window_hours: hours,
      tools: rows,
    });
  } finally {
    client.release();
  }
}

// ─── cerebellumRecent ───
// Recent predictions with status (resolved or awaiting).
async function cerebellumRecent(args: Record<string, unknown>): Promise<CallToolResult> {
  const hours = (args.hours as number) ?? 6;
  const limit = (args.limit as number) ?? 50;
  const tool_name = (args.tool_name as string) || null;
  const only_unresolved = (args.only_unresolved as boolean) ?? false;

  const client = await pool.connect();
  try {
    const res = await client.query<{
      id: number;
      predicted_at: string;
      resolved_at: string | null;
      tool_name: string;
      args_summary: string | null;
      predicted_outcome: string;
      actual_outcome: string | null;
      match_score: number | null;
      surprise: number | null;
    }>(`
      SELECT id, predicted_at, resolved_at, tool_name, args_summary,
             predicted_outcome, actual_outcome, match_score, surprise
      FROM forward_predictions
      WHERE predicted_at > NOW() - ($1 || ' hours')::interval
        AND ($2::text IS NULL OR tool_name = $2)
        AND (NOT $3 OR resolved_at IS NULL)
      ORDER BY predicted_at DESC
      LIMIT $4
    `, [String(hours), tool_name, only_unresolved, limit]);

    return jsonResult({
      window_hours: hours,
      tool_filter: tool_name,
      only_unresolved,
      count: res.rows.length,
      predictions: res.rows,
    });
  } finally {
    client.release();
  }
}

// ─── tools array ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_cerebellum_predict',
      description:
        'Record a forward-model prediction before firing a tool. Use when you want ' +
        'to pre-commit to what you expect the tool result to look like — builds per-tool ' +
        'calibration over time and produces surprise signals that can feed LC-NE.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'Name of the tool you are about to call' },
          predicted_outcome: { type: 'string', description: 'One-line prediction of what the result will look like' },
          args_summary: { type: 'string', description: 'Optional short description of args' },
          notes: { type: 'string' },
        },
        required: ['tool_name', 'predicted_outcome'],
      },
    },
    handler: (args) => cerebellumPredict(args),
  },
  {
    definition: {
      name: 'vision_cerebellum_resolve',
      description:
        'Record the actual outcome of a previously-predicted tool call. Computes ' +
        'match_score (token-Jaccard similarity) and surprise = 1 − match_score. ' +
        'High surprise feeds into vision_lc_auto as a pulse trigger.',
      inputSchema: {
        type: 'object',
        properties: {
          forward_prediction_id: { type: 'number', description: 'ID returned by vision_cerebellum_predict' },
          actual_outcome: { type: 'string', description: 'One-line summary of what actually happened' },
        },
        required: ['forward_prediction_id', 'actual_outcome'],
      },
    },
    handler: (args) => cerebellumResolve(args),
  },
  {
    definition: {
      name: 'vision_cerebellum_calibration',
      description:
        'Per-tool calibration stats: which tools I predict accurately, which I systematically ' +
        'mispredict. Sorted by worst surprise first — points at where the inverse model needs work.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback window (default 168 = 7 days)' },
        },
      },
    },
    handler: (args) => cerebellumCalibration(args),
  },
  {
    definition: {
      name: 'vision_cerebellum_recent',
      description:
        'Recent forward predictions with resolution status. Useful for auditing ' +
        'unresolved predictions or inspecting recent matches.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback window (default 6)' },
          limit: { type: 'number', description: 'Max rows (default 50)' },
          tool_name: { type: 'string', description: 'Filter by tool name' },
          only_unresolved: { type: 'boolean', description: 'Only show predictions without resolution' },
        },
      },
    },
    handler: (args) => cerebellumRecent(args),
  },
];

export default tools;
