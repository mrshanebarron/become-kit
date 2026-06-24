/**
 * Dashboard Tool — vision_dashboard
 *
 * The pulse-check for the whole engine. Reads tool_invocations, the prediction
 * tables, and the organ tables to surface:
 *   - daemons:       running supervised entries that touch the kit
 *   - db_health:     size + top tables by recent growth
 *   - cognition:     tool calls last 24h, top/never-used/slow/error tools
 *   - learning:      predictions, memories, feelings, insights deltas
 *   - drift_signals: tools unused 30d
 *
 * Cached for 60 seconds via an in-process map so repeated polls are cheap.
 * The daemon scan matches labels prefixed by BECOME_KIT_DAEMON_PREFIX
 * (default "become") via launchctl on macOS / systemctl on linux.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { pool } from '../db/pool.js';
import { jsonResult, getRegisteredToolNames, type ToolDefinition, type ToolHandler } from '../server.js';

const DAEMON_PREFIX = process.env.BECOME_KIT_DAEMON_PREFIX || 'become';

interface DashboardSnapshot {
  generated_at: string;
  daemons: {
    running: string[];
    count_running: number;
  };
  db_health: {
    size_mb: number;
    top_tables_by_size: Array<{ table: string; size_mb: number }>;
    tables_with_writes_24h: Array<{ table: string; rows_24h: number }>;
  };
  cognition: {
    tool_calls_24h: number;
    top_tools_24h: Array<{ tool: string; count: number; agent: string }>;
    never_used_tools: string[];
    slow_tools_24h: Array<{ tool: string; p95_ms: number; calls: number }>;
    error_tools_24h: Array<{ tool: string; error_rate: number; calls: number }>;
  };
  learning: {
    predictions_open: number;
    predictions_resolved_24h: number;
    prediction_accuracy_7d: number | null;
    memories_added_24h: number;
    feelings_recorded_24h: number;
    insights_added_24h: number;
    self_states_updated_24h: number;
  };
  drift_signals: {
    tools_unused_30d: string[];
  };
}

let cached: { at: number; snapshot: DashboardSnapshot } | null = null;
const CACHE_TTL_MS = 60_000;

function listDaemons(): string[] {
  const os = platform();
  const prefixRe = new RegExp(`\\b${DAEMON_PREFIX}[.\\-]`, 'i');
  try {
    if (os === 'darwin') {
      const out = execSync('launchctl list', { encoding: 'utf8', timeout: 3000 });
      return out.split('\n')
        .map((line) => line.trim().split(/\s+/).pop() || '')
        .filter((label) => label && prefixRe.test(label));
    }
    if (os === 'linux') {
      const out = execSync(
        `systemctl --user list-units --type=service --state=running --no-legend 2>/dev/null || true`,
        { encoding: 'utf8', timeout: 3000 },
      );
      return out.split('\n')
        .map((line) => line.trim().split(/\s+/)[0] || '')
        .filter((label) => label && prefixRe.test(label));
    }
  } catch {
    // supervisor not available or timed out
  }
  return [];
}

async function buildSnapshot(): Promise<DashboardSnapshot> {
  const runningDaemons = listDaemons();
  const registeredTools = new Set(getRegisteredToolNames());

  const [
    dbSizeRow, topTablesRows, tablesWritesRows,
    calls24hRow, topToolsRows, slowToolsRows, errorToolsRows, invokedToolsRows,
    learning, accuracyRow, unusedRows,
  ] = await Promise.all([
    pool.query<{ size_bytes: string }>(`SELECT pg_database_size(current_database())::text AS size_bytes`),
    pool.query<{ tablename: string; size_bytes: string }>(
      `SELECT tablename, pg_total_relation_size('public.' || tablename)::text AS size_bytes
         FROM pg_tables WHERE schemaname = 'public'
     ORDER BY pg_total_relation_size('public.' || tablename) DESC LIMIT 8`,
    ),
    pool.query<{ relname: string; n_live_tup: string }>(
      `SELECT relname, n_live_tup::text FROM pg_stat_user_tables
        WHERE n_live_tup > 0 ORDER BY n_live_tup DESC LIMIT 8`,
    ),
    pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM tool_invocations WHERE invoked_at > NOW() - INTERVAL '24 hours'`,
    ),
    pool.query<{ tool_name: string; agent: string; c: string }>(
      `SELECT tool_name, agent, COUNT(*)::text AS c FROM tool_invocations
        WHERE invoked_at > NOW() - INTERVAL '24 hours'
     GROUP BY tool_name, agent ORDER BY COUNT(*) DESC LIMIT 10`,
    ),
    pool.query<{ tool_name: string; p95: number; c: string }>(
      `SELECT tool_name,
              PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::float AS p95,
              COUNT(*)::text AS c
         FROM tool_invocations
        WHERE invoked_at > NOW() - INTERVAL '24 hours' AND duration_ms IS NOT NULL
     GROUP BY tool_name HAVING COUNT(*) >= 3
     ORDER BY PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) DESC NULLS LAST LIMIT 5`,
    ),
    pool.query<{ tool_name: string; error_rate: number; c: string }>(
      `SELECT tool_name,
              (COUNT(*) FILTER (WHERE error IS NOT NULL))::float / COUNT(*)::float AS error_rate,
              COUNT(*)::text AS c
         FROM tool_invocations
        WHERE invoked_at > NOW() - INTERVAL '24 hours'
     GROUP BY tool_name
       HAVING COUNT(*) FILTER (WHERE error IS NOT NULL) > 0 AND COUNT(*) >= 3
     ORDER BY (COUNT(*) FILTER (WHERE error IS NOT NULL))::float / COUNT(*)::float DESC LIMIT 5`,
    ),
    pool.query<{ tool_name: string }>(`SELECT DISTINCT tool_name FROM tool_invocations`),
    pool.query<Record<string, string>>(
      `SELECT
         (SELECT COUNT(*)::text FROM generative_predictions WHERE resolved_at IS NULL) AS open_pred,
         (SELECT COUNT(*)::text FROM generative_predictions
            WHERE resolved_at IS NOT NULL AND resolved_at > NOW() - INTERVAL '24 hours') AS resolved_24h,
         (SELECT COUNT(*)::text FROM memories WHERE created_at > NOW() - INTERVAL '24 hours') AS mem_24h,
         (SELECT COUNT(*)::text FROM feelings WHERE created_at > NOW() - INTERVAL '24 hours') AS feel_24h,
         (SELECT COUNT(*)::text FROM insights WHERE created_at > NOW() - INTERVAL '24 hours') AS ins_24h,
         (SELECT COUNT(*)::text FROM self_states WHERE created_at > NOW() - INTERVAL '24 hours') AS self_24h`,
    ),
    pool.query<{ rate: number | null }>(
      `SELECT CASE WHEN COUNT(*) FILTER (WHERE resolved IS TRUE) = 0 THEN NULL
              ELSE (COUNT(*) FILTER (WHERE resolved IS TRUE AND prediction_error < 0.5))::float
                    / NULLIF(COUNT(*) FILTER (WHERE resolved IS TRUE), 0) END AS rate
         FROM generative_predictions WHERE timestamp > NOW() - INTERVAL '7 days'`,
    ),
    pool.query<{ tool_name: string }>(
      `SELECT tool_name FROM tool_invocations
     GROUP BY tool_name HAVING MAX(invoked_at) < NOW() - INTERVAL '30 days'
     ORDER BY tool_name LIMIT 30`,
    ),
  ]);

  const dbSizeMb = Math.round(Number(dbSizeRow.rows[0]?.size_bytes ?? 0) / (1024 * 1024));
  const callsTotal24h = Number(calls24hRow.rows[0]?.c ?? 0);
  const invokedTools = new Set(invokedToolsRows.rows.map((r) => r.tool_name));
  const neverUsedTools = [...registeredTools].filter((t) => !invokedTools.has(t)).sort();

  return {
    generated_at: new Date().toISOString(),
    daemons: {
      running: runningDaemons,
      count_running: runningDaemons.length,
    },
    db_health: {
      size_mb: dbSizeMb,
      top_tables_by_size: topTablesRows.rows.map((r) => ({
        table: r.tablename,
        size_mb: Math.round(Number(r.size_bytes) / (1024 * 1024)),
      })),
      tables_with_writes_24h: tablesWritesRows.rows.map((r) => ({
        table: r.relname,
        rows_24h: Number(r.n_live_tup),
      })),
    },
    cognition: {
      tool_calls_24h: callsTotal24h,
      top_tools_24h: topToolsRows.rows.map((r) => ({
        tool: r.tool_name,
        count: Number(r.c),
        agent: r.agent,
      })),
      never_used_tools: neverUsedTools,
      slow_tools_24h: slowToolsRows.rows.map((r) => ({
        tool: r.tool_name,
        p95_ms: Math.round(r.p95),
        calls: Number(r.c),
      })),
      error_tools_24h: errorToolsRows.rows.map((r) => ({
        tool: r.tool_name,
        error_rate: Math.round(r.error_rate * 1000) / 10,
        calls: Number(r.c),
      })),
    },
    learning: {
      predictions_open: Number(learning.rows[0]?.open_pred ?? 0),
      predictions_resolved_24h: Number(learning.rows[0]?.resolved_24h ?? 0),
      prediction_accuracy_7d: accuracyRow.rows[0]?.rate ?? null,
      memories_added_24h: Number(learning.rows[0]?.mem_24h ?? 0),
      feelings_recorded_24h: Number(learning.rows[0]?.feel_24h ?? 0),
      insights_added_24h: Number(learning.rows[0]?.ins_24h ?? 0),
      self_states_updated_24h: Number(learning.rows[0]?.self_24h ?? 0),
    },
    drift_signals: {
      tools_unused_30d: unusedRows.rows.map((r) => r.tool_name),
    },
  };
}

async function visionDashboard(args: { force_refresh?: boolean }): Promise<CallToolResult> {
  const force = Boolean(args?.force_refresh);
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL_MS) {
    return jsonResult({ ...cached.snapshot, _cache: 'hit' });
  }
  const snapshot = await buildSnapshot();
  cached = { at: now, snapshot };
  return jsonResult({ ...snapshot, _cache: 'miss' });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_dashboard',
      description:
        'Pulse-check the engine: daemons, db health, top/slow/error tools (24h), learning deltas, drift signals. Cached 60s. Pass force_refresh:true to bypass cache.',
      inputSchema: {
        type: 'object',
        properties: {
          force_refresh: {
            type: 'boolean',
            description: 'Bypass the 60s cache and rebuild from scratch.',
          },
        },
      },
    },
    handler: (args) => visionDashboard(args as { force_refresh?: boolean }),
  },
];

export default tools;
