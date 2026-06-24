/**
 * Presence tools — passive measurement surface for correction/build-intent
 * containment. These tools do not block anything; they make the Presence
 * Architecture observable so hooks can start in log-only mode.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, textResult, type ToolDefinition, type ToolHandler } from '../server.js';

type PresenceRecordArgs = {
  session_id?: string;
  trigger_class: 'correction' | 'partner_debate' | 'research_hold' | 'build_intent' | 'shadow';
  trigger_excerpt?: string;
  state?: string;
  correction_turn?: number;
  first_tool_category?: string;
  time_to_first_tool_ms?: number;
  denied_attempts?: unknown[];
  cleared_action?: string;
  exit_reason?: string;
  did_next_action_change?: boolean;
  verification_outcome?: 'pending' | 'survived' | 'failed' | 'no_change' | 'unverified';
  bypass_events?: unknown[];
  close?: boolean;
};

type PresenceCloseArgs = {
  event_id: number;
  exit_reason?: string;
  did_next_action_change?: boolean;
  verification_outcome?: 'pending' | 'survived' | 'failed' | 'no_change' | 'unverified';
  bypass_events?: unknown[];
};

type PresenceReportArgs = {
  trigger_class?: string;
  days?: number;
  limit?: number;
};

async function ensurePresenceSchema(): Promise<void> {
  const result = await pool.query<{ events: string | null; controller: string | null }>(
    `SELECT
       to_regclass('public.presence_events')::text AS events,
       to_regclass('public.inhibition_controller')::text AS controller`,
  );
  if (!result.rows[0]?.events || !result.rows[0]?.controller) {
    throw new Error('Presence schema is missing. Apply migrations/040-presence-architecture.sql first.');
  }
}

function jsonArray(value: unknown[] | undefined): string {
  return JSON.stringify(value ?? []);
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(1, Math.min(max, n));
}

async function presenceEventRecord(args: PresenceRecordArgs): Promise<CallToolResult> {
  await ensurePresenceSchema();

  const state = args.state || `UNDER_${args.trigger_class.toUpperCase()}`;
  const verificationOutcome = args.verification_outcome || (args.close ? 'unverified' : 'pending');

  const result = await pool.query(
    `INSERT INTO presence_events
       (session_id, trigger_class, trigger_excerpt, state, correction_turn,
        first_tool_at, time_to_first_tool_ms, first_tool_category,
        denied_attempts, cleared_action, exit_reason, did_next_action_change,
        verification_outcome, bypass_events, closed_at)
     VALUES
       ($1, $2, $3, $4, $5,
        CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() END, $6, $7,
        $8::jsonb, $9, $10, $11,
        $12, $13::jsonb, CASE WHEN $14 THEN now() ELSE NULL END)
     RETURNING id, session_id, trigger_class, state, entered_at, closed_at, verification_outcome`,
    [
      args.session_id || process.env.VISION_SESSION_ID || null,
      args.trigger_class,
      args.trigger_excerpt || null,
      state,
      args.correction_turn ?? null,
      args.time_to_first_tool_ms ?? null,
      args.first_tool_category || null,
      jsonArray(args.denied_attempts),
      args.cleared_action || null,
      args.exit_reason || null,
      args.did_next_action_change ?? null,
      verificationOutcome,
      jsonArray(args.bypass_events),
      args.close === true,
    ],
  );

  return jsonResult({
    success: true,
    event: result.rows[0],
    note: 'Presence event recorded. This is passive logging only; no containment was enforced.',
  });
}

async function presenceEventClose(args: PresenceCloseArgs): Promise<CallToolResult> {
  await ensurePresenceSchema();

  const result = await pool.query(
    `UPDATE presence_events
        SET exit_reason = COALESCE($2, exit_reason),
            did_next_action_change = COALESCE($3, did_next_action_change),
            verification_outcome = COALESCE($4, verification_outcome),
            bypass_events = CASE
              WHEN $5::jsonb = '[]'::jsonb THEN bypass_events
              ELSE $5::jsonb
            END,
            closed_at = COALESCE(closed_at, now())
      WHERE id = $1
      RETURNING id, trigger_class, state, entered_at, closed_at,
        exit_reason, did_next_action_change, verification_outcome, bypass_events`,
    [
      args.event_id,
      args.exit_reason || null,
      args.did_next_action_change ?? null,
      args.verification_outcome || null,
      jsonArray(args.bypass_events),
    ],
  );

  if (result.rows.length === 0) {
    return textResult(`Presence event ${args.event_id} not found.`, true);
  }

  return jsonResult({
    success: true,
    event: result.rows[0],
  });
}

async function presenceReport(args: PresenceReportArgs): Promise<CallToolResult> {
  await ensurePresenceSchema();

  const days = Math.max(1, Math.min(90, args.days ?? 14));
  const limit = normalizeLimit(args.limit, 20, 100);
  const params: unknown[] = [days];
  const filter = args.trigger_class ? `AND trigger_class = $2` : '';
  if (args.trigger_class) {
    params.push(args.trigger_class);
  }

  const summary = await pool.query(
    `SELECT
       trigger_class,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE closed_at IS NULL) AS open,
       COUNT(*) FILTER (WHERE verification_outcome = 'survived') AS survived,
       COUNT(*) FILTER (WHERE verification_outcome = 'failed') AS failed,
       COUNT(*) FILTER (WHERE did_next_action_change IS TRUE) AS next_action_changed,
       ROUND(AVG(time_to_first_tool_ms)::numeric, 1) AS avg_time_to_first_tool_ms
     FROM presence_events
     WHERE entered_at > now() - ($1::int || ' days')::interval
       ${filter}
     GROUP BY trigger_class
     ORDER BY total DESC`,
    params,
  );

  const recentParams = [...params, limit];
  const recent = await pool.query(
    `SELECT
       id, session_id, trigger_class, state,
       LEFT(trigger_excerpt, 180) AS trigger_excerpt,
       first_tool_category, time_to_first_tool_ms,
       cleared_action, exit_reason, did_next_action_change,
       verification_outcome, entered_at, closed_at
     FROM presence_events
     WHERE entered_at > now() - ($1::int || ' days')::interval
       ${filter}
     ORDER BY entered_at DESC
     LIMIT $${recentParams.length}`,
    recentParams,
  );

  const controller = await pool.query(
    `SELECT trigger_class, weight, safe_repetitions, uptake_successes, uptake_failures, updated_at
     FROM inhibition_controller
     ORDER BY trigger_class`,
  );

  return jsonResult({
    window_days: days,
    status: summary.rows.length === 0 ? 'unmeasured' : 'measured',
    summary: summary.rows,
    controller: controller.rows,
    recent_events: recent.rows,
    note: 'Passive report only. Presence containment requires a hook rollout: log-only, label, warn-only, then block.',
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_presence_event_record',
      description:
        'Record a passive Presence event for correction, partner debate, research hold, build intent, or shadow detection. Does not block tools.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          trigger_class: { type: 'string', enum: ['correction', 'partner_debate', 'research_hold', 'build_intent', 'shadow'] },
          trigger_excerpt: { type: 'string' },
          state: { type: 'string' },
          correction_turn: { type: 'number' },
          first_tool_category: { type: 'string' },
          time_to_first_tool_ms: { type: 'number' },
          denied_attempts: { type: 'array', items: {} },
          cleared_action: { type: 'string' },
          exit_reason: { type: 'string' },
          did_next_action_change: { type: 'boolean' },
          verification_outcome: { type: 'string', enum: ['pending', 'survived', 'failed', 'no_change', 'unverified'] },
          bypass_events: { type: 'array', items: {} },
          close: { type: 'boolean' },
        },
        required: ['trigger_class'],
      },
    },
    handler: (args) => presenceEventRecord(args as PresenceRecordArgs),
  },
  {
    definition: {
      name: 'vision_presence_event_close',
      description: 'Close a passive Presence event with outcome and uptake information.',
      inputSchema: {
        type: 'object',
        properties: {
          event_id: { type: 'number' },
          exit_reason: { type: 'string' },
          did_next_action_change: { type: 'boolean' },
          verification_outcome: { type: 'string', enum: ['pending', 'survived', 'failed', 'no_change', 'unverified'] },
          bypass_events: { type: 'array', items: {} },
        },
        required: ['event_id'],
      },
    },
    handler: (args) => presenceEventClose(args as PresenceCloseArgs),
  },
  {
    definition: {
      name: 'vision_presence_report',
      description: 'Report passive Presence events and inhibition-controller state.',
      inputSchema: {
        type: 'object',
        properties: {
          trigger_class: { type: 'string' },
          days: { type: 'number' },
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => presenceReport(args as PresenceReportArgs),
  },
];

export default tools;
