/**
 * Felt-threat read surface.
 *
 * The hook-side gate writes a separate felt_threat_outcomes ledger instead of
 * touching Presence's single-slot sticky state. This tool exposes that ledger
 * as a brain-readable calibration status surface.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../db/pool.js';
import { effectiveGateAuthority, effectiveGateStack } from '../lib/effective-gate-stack.js';
import { buildEvidenceReadinessSummary } from '../lib/evidence-readiness.js';
import { buildFeltThreatIntegrationSummary } from '../lib/felt-threat-integration-summary.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

/** The kit's state root — all agent state lives here (default ~/.become-kit). */
function stateRoot(): string {
  return process.env.BECOME_KIT_HOME || join(homedir(), '.become-kit');
}

type FeltThreatStatusArgs = {
  agent?: string;
  include_recent?: boolean;
  include_state_stack?: boolean;
  include_presence_stack?: boolean;
  include_effective_stack?: boolean;
  limit?: number;
};

type ObservationSchemaState = {
  exists: boolean;
  missing_columns: string[];
  full_status_available: boolean;
};

type DecisionSchemaState = {
  exists: boolean;
  missing_columns: string[];
  full_status_available: boolean;
};

type HookCaptureSummary = {
  agent: string;
  config_path: string;
  config_exists: boolean;
  parsed: boolean;
  expected_tool_names: string[];
  felt_pre_matchers: string[];
  felt_post_matchers: string[];
  brain_pre_matchers: string[];
  brain_post_matchers: string[];
  felt_pre_tool_coverage: Record<string, boolean>;
  felt_post_tool_coverage: Record<string, boolean>;
  brain_pre_tool_coverage: Record<string, boolean>;
  brain_post_tool_coverage: Record<string, boolean>;
  felt_pre_covers_expected_tools: boolean;
  felt_post_covers_expected_tools: boolean;
  brain_pre_covers_expected_tools: boolean;
  brain_post_covers_expected_tools: boolean;
  capture_config_state: 'missing_config' | 'unreadable_config' | 'felt_capture_configured' | 'felt_capture_partial';
  error?: string;
};

type HookCaptureRuntimeSummary = {
  agent: string;
  log_path: string;
  log_exists: boolean;
  log_entry_count_sampled: number;
  freshness_window_seconds: number;
  latest_log_at: string | null;
  latest_log_age_seconds: number | null;
  latest_log_fresh: boolean | null;
  runtime_freshness_state: 'no_log' | 'fresh_log' | 'stale_log';
  latest_log_kind: string | null;
  latest_log_tool: string | null;
  latest_log_summary: string | null;
  live_evidence_count: number;
  synthetic_evidence_count: number;
  latest_live_evidence_at: unknown;
  latest_synthetic_evidence_at: unknown;
  capture_runtime_state: 'no_hook_log' | 'live_capture_observed' | 'recent_hook_log_no_live_rows' | 'stale_hook_log_no_live_rows';
};

type HookCaptureHealthSummary = {
  agent: string;
  capture_health_state:
    | 'capture_live'
    | 'configured_runtime_recent_no_live'
    | 'configured_runtime_stale'
    | 'configured_no_runtime_log'
    | 'partial_config'
    | 'missing_or_unreadable_config';
  capture_config_state: HookCaptureSummary['capture_config_state'] | null;
  capture_runtime_state: HookCaptureRuntimeSummary['capture_runtime_state'] | null;
  evidence_collection_state: string | null;
  calibration_claim_ceiling: string | null;
  live_evidence_count: number;
  synthetic_evidence_count: number;
  freshness_window_seconds: number | null;
  latest_log_age_seconds: number | null;
  latest_log_fresh: boolean | null;
  runtime_freshness_state: HookCaptureRuntimeSummary['runtime_freshness_state'] | null;
  next_capture_action: string;
  health_note: string;
};

const HOOK_CAPTURE_RUNTIME_FRESH_WINDOW_SECONDS = 3600;

const OBSERVATION_STATUS_COLUMNS = [
  'resolved_at',
  'observation_outcome',
  'outcome_valence',
  'extinction_basis',
  'observation_key',
  'sample_count',
  'max_threat_level',
  'last_sampled_at',
];

const DECISION_STATUS_COLUMNS = [
  'observation_key',
  'action_after_decision',
  'action_result',
  'decision_outcome',
  'outcome_valence',
  'after_action_fingerprint',
  'target_overlap',
  'action_similarity',
  'decision_resolution_basis',
  'resolved_at',
  'action_trace_key',
  'cross_organ_evidence',
  'cross_organ_score',
  'cross_organ_basis',
  'rpe_match_strategy',
  'rpe_match_evidence',
  'last_cross_organ_scan_at',
  'presence_state_trace',
  'effective_gate_authority',
  'post_action_gate_authority',
  'authority_drift',
  'authority_drift_basis',
  'authority_drift_fields',
  'authority_drift_severity',
  'authority_observation_duration_ms',
  'authority_observation_duration_bucket',
];
const PRESENCE_STICKY_STATES = new Set(['UNDER_CORRECTION', 'UNDER_PARTNER_DEBATE', 'UNDER_RESEARCH_HOLD']);
// Where the agent's hook config lives, and which mutating tools its felt-threat
// gate is expected to cover. The kit ships a single generic agent; override the
// path with BECOME_KIT_HOOKS_PATH and the tool list with BECOME_KIT_GATED_TOOLS
// (comma-separated) to match a different host's hook surface.
const GATED_TOOLS = (process.env.BECOME_KIT_GATED_TOOLS || 'Bash,Edit,Write,MultiEdit')
  .split(',').map((t) => t.trim()).filter(Boolean);

function hookCaptureConfig(): { path: string; expectedTools: string[] } {
  return {
    path: process.env.BECOME_KIT_HOOKS_PATH || join(stateRoot(), 'hooks.json'),
    expectedTools: GATED_TOOLS,
  };
}

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(1, Math.min(max, n));
}

function feltStateDir(_agent: string): string {
  return process.env.FELT_THREAT_DIR || join(stateRoot(), 'state', 'felt-threat');
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function activeStateStack(agents: string[], ttlSeconds: number): Array<Record<string, unknown>> {
  const nowSeconds = Date.now() / 1000;
  const records: Array<Record<string, unknown>> = [];
  for (const agent of agents) {
    const dir = feltStateDir(agent);
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (!(name === 'state.json' || /^state-[A-Za-z0-9_.-]+\.json$/.test(name))) {
        continue;
      }
      const path = join(dir, name);
      const state = readJsonFile(path);
      if (!state || Object.keys(state).length === 0) {
        continue;
      }
      const enteredEpoch = Number(state.entered_epoch || 0);
      const ageSeconds = enteredEpoch > 0 ? Math.max(0, Math.round(nowSeconds - enteredEpoch)) : null;
      const expiresInSeconds = ageSeconds === null ? null : Math.max(0, ttlSeconds - ageSeconds);
      records.push({
        agent,
        path,
        precedence: name === 'state.json' ? 'legacy_sessionless' : 'session_scoped',
        event_id: state.event_id ?? null,
        session_id: state.session_id ?? null,
        safe_session_id: state.safe_session_id ?? null,
        stance: state.stance ?? null,
        threat_level: state.threat_level ?? null,
        entered_epoch: enteredEpoch || null,
        age_seconds: ageSeconds,
        expires_in_seconds: expiresInSeconds,
        expired: ageSeconds === null ? null : ageSeconds > ttlSeconds,
      });
    }
  }
  return records.sort((a, b) => {
    const ap = a.precedence === 'session_scoped' ? 0 : 1;
    const bp = b.precedence === 'session_scoped' ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return Number(b.entered_epoch || 0) - Number(a.entered_epoch || 0);
  });
}

function presenceStatePaths(_agent: string): string[] {
  const paths: string[] = [];
  const explicit = process.env.FELT_PRESENCE_STATE_PATH;
  if (explicit) {
    paths.push(explicit);
  }
  const presenceDir = process.env.BECOME_KIT_PRESENCE_DIR || join(stateRoot(), 'state', 'presence');
  paths.push(join(presenceDir, 'sticky-state.json'));
  return Array.from(new Set(paths));
}

function activePresenceStack(agents: string[]): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const agent of agents) {
    for (const path of presenceStatePaths(agent)) {
      if (!existsSync(path)) {
        continue;
      }
      let state: Record<string, unknown>;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
          continue;
        }
        state = parsed as Record<string, unknown>;
      } catch (error) {
        records.push({
          agent,
          path,
          active: true,
          unreadable: true,
          precedence: 'presence_fail_closed',
          error: String(error).slice(0, 300),
        });
        continue;
      }
      const stateName = typeof state.state === 'string' ? state.state : null;
      const active = stateName !== null && PRESENCE_STICKY_STATES.has(stateName);
      records.push({
        agent,
        path,
        active,
        state: stateName,
        session_id: state.session_id ?? null,
        safe_session_id: state.safe_session_id ?? null,
        event_id: state.event_id ?? state.presence_event_id ?? null,
        entered_epoch: state.entered_epoch ?? null,
        updated_at: state.updated_at ?? null,
        precedence: active ? 'presence_before_felt_threat' : 'presence_observed_nonblocking',
      });
    }
  }
  return records.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return String(a.agent || '').localeCompare(String(b.agent || '')) || String(a.path || '').localeCompare(String(b.path || ''));
  });
}

function matcherCoversTool(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) {
    return false;
  }
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName) || new RegExp(matcher).test(toolName);
  } catch {
    return matcher.split('|').includes(toolName);
  }
}

function toolCoverage(matchers: string[], toolNames: string[]): Record<string, boolean> {
  return Object.fromEntries(
    toolNames.map((toolName) => [toolName, matchers.some((matcher) => matcherCoversTool(matcher, toolName))]),
  );
}

function allCovered(coverage: Record<string, boolean>): boolean {
  return Object.values(coverage).every(Boolean);
}

function hookMatchEntries(config: Record<string, unknown>, phase: 'PreToolUse' | 'PostToolUse', commandNeedle: string): string[] {
  const hooksRoot = config.hooks;
  if (!hooksRoot || typeof hooksRoot !== 'object' || Array.isArray(hooksRoot)) {
    return [];
  }
  const phaseRows = (hooksRoot as Record<string, unknown>)[phase];
  if (!Array.isArray(phaseRows)) {
    return [];
  }
  const matchers: string[] = [];
  for (const row of phaseRows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const hooks = record.hooks;
    if (!Array.isArray(hooks)) {
      continue;
    }
    const hasCommand = hooks.some((hook) => {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
        return false;
      }
      const command = (hook as Record<string, unknown>).command;
      return typeof command === 'string' && command.includes(commandNeedle);
    });
    if (hasCommand) {
      matchers.push(typeof record.matcher === 'string' ? record.matcher : '');
    }
  }
  return matchers;
}

function hookCaptureConfigSummary(agents: string[]): HookCaptureSummary[] {
  return agents.map((agent) => {
    const configured = hookCaptureConfig();
    if (!configured.path || !existsSync(configured.path)) {
      return {
        agent,
        config_path: configured.path,
        config_exists: false,
        parsed: false,
        expected_tool_names: configured.expectedTools,
        felt_pre_matchers: [],
        felt_post_matchers: [],
        brain_pre_matchers: [],
        brain_post_matchers: [],
        felt_pre_tool_coverage: {},
        felt_post_tool_coverage: {},
        brain_pre_tool_coverage: {},
        brain_post_tool_coverage: {},
        felt_pre_covers_expected_tools: false,
        felt_post_covers_expected_tools: false,
        brain_pre_covers_expected_tools: false,
        brain_post_covers_expected_tools: false,
        capture_config_state: 'missing_config',
      };
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(configured.path, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      return {
        agent,
        config_path: configured.path,
        config_exists: true,
        parsed: false,
        expected_tool_names: configured.expectedTools,
        felt_pre_matchers: [],
        felt_post_matchers: [],
        brain_pre_matchers: [],
        brain_post_matchers: [],
        felt_pre_tool_coverage: {},
        felt_post_tool_coverage: {},
        brain_pre_tool_coverage: {},
        brain_post_tool_coverage: {},
        felt_pre_covers_expected_tools: false,
        felt_post_covers_expected_tools: false,
        brain_pre_covers_expected_tools: false,
        brain_post_covers_expected_tools: false,
        capture_config_state: 'unreadable_config',
        error: String(error).slice(0, 300),
      };
    }

    const feltPreMatchers = hookMatchEntries(parsed, 'PreToolUse', 'hook-felt-threat-gate.py');
    const feltPostMatchers = hookMatchEntries(parsed, 'PostToolUse', 'hook-felt-threat-gate.py');
    const brainPreMatchers = hookMatchEntries(parsed, 'PreToolUse', 'hook-brain-cycle-log.py');
    const brainPostMatchers = hookMatchEntries(parsed, 'PostToolUse', 'hook-brain-cycle-log.py');
    const feltPreCoverage = toolCoverage(feltPreMatchers, configured.expectedTools);
    const feltPostCoverage = toolCoverage(feltPostMatchers, configured.expectedTools);
    const brainPreCoverage = toolCoverage(brainPreMatchers, configured.expectedTools);
    const brainPostCoverage = toolCoverage(brainPostMatchers, configured.expectedTools);
    const feltPreCovers = allCovered(feltPreCoverage);
    const feltPostCovers = allCovered(feltPostCoverage);
    const brainPreCovers = allCovered(brainPreCoverage);
    const brainPostCovers = allCovered(brainPostCoverage);
    const fullyCovered = feltPreCovers && feltPostCovers && brainPreCovers && brainPostCovers;

    return {
      agent,
      config_path: configured.path,
      config_exists: true,
      parsed: true,
      expected_tool_names: configured.expectedTools,
      felt_pre_matchers: feltPreMatchers,
      felt_post_matchers: feltPostMatchers,
      brain_pre_matchers: brainPreMatchers,
      brain_post_matchers: brainPostMatchers,
      felt_pre_tool_coverage: feltPreCoverage,
      felt_post_tool_coverage: feltPostCoverage,
      brain_pre_tool_coverage: brainPreCoverage,
      brain_post_tool_coverage: brainPostCoverage,
      felt_pre_covers_expected_tools: feltPreCovers,
      felt_post_covers_expected_tools: feltPostCovers,
      brain_pre_covers_expected_tools: brainPreCovers,
      brain_post_covers_expected_tools: brainPostCovers,
      capture_config_state: fullyCovered ? 'felt_capture_configured' : 'felt_capture_partial',
    };
  });
}

function evidenceCount(rows: Array<Record<string, unknown>>, agent: string, scope: 'live' | 'synthetic'): number {
  return rows
    .filter((row) => row.agent === agent && row.evidence_scope === scope)
    .reduce((sum, row) => {
      const n = Number(row.evidence_count);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
}

function latestEvidenceValue(rows: Array<Record<string, unknown>>, agent: string, scope: 'live' | 'synthetic'): unknown {
  let latest: unknown = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.agent !== agent || row.evidence_scope !== scope || !row.last_evidence_at) {
      continue;
    }
    const ms = new Date(String(row.last_evidence_at)).getTime();
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = row.last_evidence_at;
    }
  }
  return latest;
}

function parseHookLogTs(value: unknown): number | null {
  if (!value) {
    return null;
  }
  const raw = String(value);
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function hookCaptureRuntimeSummary(
  agents: string[],
  evidenceRows: Array<Record<string, unknown>>,
): HookCaptureRuntimeSummary[] {
  const nowMs = Date.now();
  return agents.map((agent) => {
    const logPath = join(feltStateDir(agent), 'felt-threat-gate.log');
    const liveCount = evidenceCount(evidenceRows, agent, 'live');
    const syntheticCount = evidenceCount(evidenceRows, agent, 'synthetic');
    const latestLiveEvidenceAt = latestEvidenceValue(evidenceRows, agent, 'live');
    const latestSyntheticEvidenceAt = latestEvidenceValue(evidenceRows, agent, 'synthetic');

    if (!existsSync(logPath)) {
      return {
        agent,
        log_path: logPath,
        log_exists: false,
        log_entry_count_sampled: 0,
        freshness_window_seconds: HOOK_CAPTURE_RUNTIME_FRESH_WINDOW_SECONDS,
        latest_log_at: null,
        latest_log_age_seconds: null,
        latest_log_fresh: null,
        runtime_freshness_state: 'no_log',
        latest_log_kind: null,
        latest_log_tool: null,
        latest_log_summary: null,
        live_evidence_count: liveCount,
        synthetic_evidence_count: syntheticCount,
        latest_live_evidence_at: latestLiveEvidenceAt,
        latest_synthetic_evidence_at: latestSyntheticEvidenceAt,
        capture_runtime_state: liveCount > 0 ? 'live_capture_observed' : 'no_hook_log',
      };
    }

    const lines = readFileSync(logPath, 'utf8').trim().split(/\n+/).filter(Boolean).slice(-200);
    let latestRow: Record<string, unknown> | null = null;
    let latestMs = Number.NEGATIVE_INFINITY;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          continue;
        }
        const row = parsed as Record<string, unknown>;
        const ms = parseHookLogTs(row.ts);
        if (ms !== null && ms > latestMs) {
          latestMs = ms;
          latestRow = row;
        }
      } catch {
        continue;
      }
    }

    const latestAgeSeconds = Number.isFinite(latestMs) ? Math.max(0, Math.round((nowMs - latestMs) / 1000)) : null;
    const latestLogFresh = latestAgeSeconds !== null && latestAgeSeconds <= HOOK_CAPTURE_RUNTIME_FRESH_WINDOW_SECONDS;
    const runtimeFreshnessState: HookCaptureRuntimeSummary['runtime_freshness_state'] = latestRow
      ? (latestLogFresh ? 'fresh_log' : 'stale_log')
      : 'no_log';
    let runtimeState: HookCaptureRuntimeSummary['capture_runtime_state'] = 'no_hook_log';
    if (liveCount > 0) {
      runtimeState = 'live_capture_observed';
    } else if (latestRow && latestLogFresh) {
      runtimeState = 'recent_hook_log_no_live_rows';
    } else if (latestRow) {
      runtimeState = 'stale_hook_log_no_live_rows';
    }

    return {
      agent,
      log_path: logPath,
      log_exists: true,
      log_entry_count_sampled: lines.length,
      freshness_window_seconds: HOOK_CAPTURE_RUNTIME_FRESH_WINDOW_SECONDS,
      latest_log_at: latestRow?.ts ? String(latestRow.ts) : null,
      latest_log_age_seconds: latestAgeSeconds,
      latest_log_fresh: latestRow ? latestLogFresh : null,
      runtime_freshness_state: runtimeFreshnessState,
      latest_log_kind: latestRow?.kind ? String(latestRow.kind) : null,
      latest_log_tool: latestRow?.tool ? String(latestRow.tool) : null,
      latest_log_summary: latestRow?.summary ? String(latestRow.summary).slice(0, 220) : null,
      live_evidence_count: liveCount,
      synthetic_evidence_count: syntheticCount,
      latest_live_evidence_at: latestLiveEvidenceAt,
      latest_synthetic_evidence_at: latestSyntheticEvidenceAt,
      capture_runtime_state: runtimeState,
    };
  });
}

function hookCaptureHealthSummary(
  agents: string[],
  configRows: HookCaptureSummary[],
  runtimeRows: HookCaptureRuntimeSummary[],
  readinessRows: Array<Record<string, unknown>>,
): HookCaptureHealthSummary[] {
  return agents.map((agent) => {
    const config = configRows.find((row) => row.agent === agent) || null;
    const runtime = runtimeRows.find((row) => row.agent === agent) || null;
    const readiness = readinessRows.find((row) => row.agent === agent) || null;
    const configState = config?.capture_config_state || null;
    const runtimeState = runtime?.capture_runtime_state || null;
    const liveCount = Number(readiness?.live_evidence_count || runtime?.live_evidence_count || 0);
    const syntheticCount = Number(readiness?.synthetic_evidence_count || runtime?.synthetic_evidence_count || 0);
    const evidenceCollectionState = readiness?.evidence_collection_state ? String(readiness.evidence_collection_state) : null;
    const claimCeiling = readiness?.calibration_claim_ceiling ? String(readiness.calibration_claim_ceiling) : null;

    let captureHealthState: HookCaptureHealthSummary['capture_health_state'] = 'missing_or_unreadable_config';
    let nextCaptureAction = 'repair_or_parse_hook_config';
    let healthNote = 'Hook capture config is missing or unreadable, so live felt-threat capture cannot be trusted.';

    if (configState === 'felt_capture_partial') {
      captureHealthState = 'partial_config';
      nextCaptureAction = 'complete_hook_matcher_coverage';
      healthNote = 'Hook config exists but does not cover every expected local tool name.';
    } else if (configState === 'felt_capture_configured') {
      if (runtimeState === 'live_capture_observed' || liveCount > 0) {
        captureHealthState = 'capture_live';
        nextCaptureAction = 'maintain_live_capture_and_monitor_freshness';
        healthNote = 'Hook config is covered and ordinary live felt-threat rows exist.';
      } else if (runtimeState === 'recent_hook_log_no_live_rows') {
        captureHealthState = 'configured_runtime_recent_no_live';
        nextCaptureAction = 'collect_ordinary_live_felt_pressure_until_live_row_appears';
        healthNote = 'Hook config is covered and hooks logged recently, but no ordinary live felt-pressure rows exist yet.';
      } else if (runtimeState === 'stale_hook_log_no_live_rows') {
        captureHealthState = 'configured_runtime_stale';
        nextCaptureAction = 'reload_or_exercise_hook_runtime_then_verify_live_capture';
        healthNote = 'Hook config is covered, but the newest felt-threat hook log is stale and no live rows exist.';
      } else {
        captureHealthState = 'configured_no_runtime_log';
        nextCaptureAction = 'exercise_hook_runtime_then_verify_log_and_live_capture';
        healthNote = 'Hook config is covered, but no felt-threat hook log was found for this agent.';
      }
    }

    return {
      agent,
      capture_health_state: captureHealthState,
      capture_config_state: configState,
      capture_runtime_state: runtimeState,
      evidence_collection_state: evidenceCollectionState,
      calibration_claim_ceiling: claimCeiling,
      live_evidence_count: Number.isFinite(liveCount) ? liveCount : 0,
      synthetic_evidence_count: Number.isFinite(syntheticCount) ? syntheticCount : 0,
      freshness_window_seconds: runtime?.freshness_window_seconds ?? null,
      latest_log_age_seconds: runtime?.latest_log_age_seconds ?? null,
      latest_log_fresh: runtime?.latest_log_fresh ?? null,
      runtime_freshness_state: runtime?.runtime_freshness_state ?? null,
      next_capture_action: nextCaptureAction,
      health_note: healthNote,
    };
  });
}

async function ensureFeltThreatStatusSchema(): Promise<void> {
  const result = await pool.query<{
    outcomes: string | null;
    status: string | null;
    presence_events: string | null;
  }>(
    `SELECT
       to_regclass('public.felt_threat_outcomes')::text AS outcomes,
       to_regclass('public.felt_threat_calibration_status')::text AS status,
       to_regclass('public.presence_events')::text AS presence_events`,
  );

  const row = result.rows[0];
  if (!row?.outcomes) {
    throw new Error('Felt-threat outcome schema is missing. Apply migrations/046-felt-threat-outcome-learning.sql first.');
  }
  if (!row.status) {
    throw new Error('Felt-threat status view is missing. Apply migrations/053-felt-threat-calibration-status.sql first.');
  }
  if (!row.presence_events) {
    throw new Error('Presence schema is missing. Apply migrations/040-presence-architecture.sql first.');
  }
}

async function observationSchemaState(): Promise<ObservationSchemaState> {
  const table = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass('public.felt_threat_observations')::text AS exists`,
  );
  if (!table.rows[0]?.exists) {
    return { exists: false, missing_columns: [], full_status_available: false };
  }

  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'felt_threat_observations'`,
  );
  const present = new Set(columns.rows.map((row) => row.column_name));
  const missing = OBSERVATION_STATUS_COLUMNS.filter((column) => !present.has(column));
  return {
    exists: true,
    missing_columns: missing,
    full_status_available: missing.length === 0,
  };
}

async function decisionSchemaState(): Promise<DecisionSchemaState> {
  const table = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass('public.felt_threat_gate_decisions')::text AS exists`,
  );
  if (!table.rows[0]?.exists) {
    return { exists: false, missing_columns: [], full_status_available: false };
  }

  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'felt_threat_gate_decisions'`,
  );
  const present = new Set(columns.rows.map((row) => row.column_name));
  const missing = DECISION_STATUS_COLUMNS.filter((column) => !present.has(column));
  return {
    exists: true,
    missing_columns: missing,
    full_status_available: missing.length === 0,
  };
}

function calibrationNotes(rows: Array<{ agent: string; live_outcomes: string | number; calibration_state: string }>): string[] {
  return rows.map((row) => {
    const liveOutcomes = Number(row.live_outcomes);
    if (row.calibration_state === 'synthetic_only' || liveOutcomes === 0) {
      return `${row.agent}: proof coverage exists, but no live felt-threat calibration has been observed yet.`;
    }
    if (row.calibration_state === 'live_pending') {
      return `${row.agent}: at least one live felt-threat hold is unresolved, so later feedback should still be scanned.`;
    }
    if (row.calibration_state === 'live_cross_calibrated') {
      return `${row.agent}: live holds have immediate and cross-organ feedback.`;
    }
    return `${row.agent}: live holds have immediate outcomes, but no cross-organ feedback yet.`;
  });
}

function countRowsForAgent(rows: Array<Record<string, unknown>>, agent: string): number {
  return rows.filter((row) => row.agent === agent).length;
}

function buildReadoutCompletenessSummary(
  agents: string[],
  rows: Record<string, Array<Record<string, unknown>>>,
): Array<Record<string, unknown>> {
  return agents.map((agent) => {
    const coreSections = [
      { section: 'status', expected_min_rows: 1, observed_rows: countRowsForAgent(rows.status || [], agent) },
      { section: 'observation_summary', expected_min_rows: 1, observed_rows: countRowsForAgent(rows.observation_summary || [], agent) },
      { section: 'decision_summary', expected_min_rows: 1, observed_rows: countRowsForAgent(rows.decision_summary || [], agent) },
      { section: 'evidence_scope_summary', expected_min_rows: 10, observed_rows: countRowsForAgent(rows.evidence_scope_summary || [], agent) },
      { section: 'evidence_readiness_summary', expected_min_rows: 1, observed_rows: countRowsForAgent(rows.evidence_readiness_summary || [], agent) },
      { section: 'presence_felt_isolation_summary', expected_min_rows: 1, observed_rows: countRowsForAgent(rows.presence_felt_isolation_summary || [], agent) },
      ...(rows.read_integrator_acceptance_summary
        ? [{ section: 'read_integrator_acceptance_summary', expected_min_rows: 1, observed_rows: countRowsForAgent(rows.read_integrator_acceptance_summary, agent) }]
        : []),
      ...(rows.felt_threat_integration_summary
        ? [{ section: 'felt_threat_integration_summary', expected_min_rows: 1, observed_rows: countRowsForAgent(rows.felt_threat_integration_summary, agent) }]
        : []),
      { section: 'authority_risk_summary', expected_min_rows: 2, observed_rows: countRowsForAgent(rows.authority_risk_summary || [], agent) },
    ].map((section) => ({
      ...section,
      zero_filled_expected: true,
      completeness_state: section.observed_rows >= section.expected_min_rows ? 'present' : 'missing',
    }));
    const sparseDetailSections = [
      'authority_transition_summary',
      'authority_duration_bucket_summary',
      'authority_severity_band_summary',
      'authority_drift_class_summary',
      'authority_stability_summary',
      'authority_drift_basis_summary',
      'authority_drift_field_summary',
    ].map((section) => {
      const observedRows = countRowsForAgent(rows[section] || [], agent);
      return {
        section,
        observed_rows: observedRows,
        sparse_by_design: true,
        completeness_state: observedRows > 0 ? 'present' : 'no_matching_detail_rows',
      };
    });
    const missingCoreSections = coreSections
      .filter((section) => section.completeness_state === 'missing')
      .map((section) => section.section);
    return {
      agent,
      readout_completeness_state: missingCoreSections.length > 0 ? 'core_readouts_missing' : 'core_readouts_present',
      missing_core_sections: missingCoreSections,
      zero_filled_core_sections: coreSections,
      sparse_detail_sections: sparseDetailSections,
      readout_note: missingCoreSections.length > 0
        ? `Core felt-threat readouts are missing rows for ${missingCoreSections.join(', ')}.`
        : 'Core felt-threat readouts are present; sparse authority detail arrays may be empty when no matching authority events exist.',
    };
  });
}

function firstRowForAgent(rows: Array<Record<string, unknown>>, agent: string): Record<string, unknown> | null {
  return rows.find((row) => row.agent === agent) || null;
}

function buildPresenceFeltIsolationSummary(
  agents: string[],
  presenceStack: Array<Record<string, unknown>>,
  stateStack: Array<Record<string, unknown>>,
  effectiveStack: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return agents.map((agent) => {
    const agentPresence = presenceStack.filter((row) => row.agent === agent);
    const agentFelt = stateStack.filter((row) => row.agent === agent && row.expired !== true);
    const agentEffective = effectiveStack.filter((row) => row.agent === agent);
    const authority = effectiveGateAuthority(agentEffective);
    const presenceActiveCount = agentPresence.filter((row) => row.active === true).length;
    const presenceUnreadableCount = agentPresence.filter((row) => row.unreadable === true).length;
    const feltActiveCount = agentFelt.length;
    const sessionScopedFeltCount = agentFelt.filter((row) => row.precedence === 'session_scoped').length;
    const legacySessionlessFeltCount = agentFelt.filter((row) => row.precedence === 'legacy_sessionless').length;
    let isolationState = 'no_active_gate_state';
    if (presenceUnreadableCount > 0) {
      isolationState = 'presence_fail_closed';
    } else if (authority.source === 'presence') {
      isolationState = 'presence_overrides_felt_threat';
    } else if (authority.source === 'felt_threat') {
      isolationState = 'felt_threat_authoritative';
    }

    return {
      agent,
      isolation_state: isolationState,
      presence_active_count: presenceActiveCount,
      presence_unreadable_count: presenceUnreadableCount,
      felt_active_count: feltActiveCount,
      session_scoped_felt_count: sessionScopedFeltCount,
      legacy_sessionless_felt_count: legacySessionlessFeltCount,
      effective_authority_source: authority.source ?? null,
      effective_authority_precedence: authority.effective_precedence ?? null,
      presence_blocks_felt_threat: authority.source === 'presence' || presenceUnreadableCount > 0,
      felt_threat_can_gate_mutation: authority.source === 'felt_threat',
      sensing_pass_presence_write: false,
      separation_policy: 'felt-threat sensing/hold state stays outside the Presence sticky slot; active Presence has higher precedence and causes presence_deferred rather than overwrite.',
    };
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function ledgerCount(value: unknown, ledger: string): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 0;
  }
  const n = Number((value as Record<string, unknown>)[ledger]);
  return Number.isFinite(n) ? n : 0;
}

function safeRuntimeExerciseForAgent(_agent: string): Record<string, unknown> {
  return {
    purpose: 'read_only_hook_runtime_freshness_probe',
    tool_name: 'Bash',
    tool_input: { command: 'pwd' },
    expected_hook_effect: 'fresh felt-threat hook log if the current runtime has reloaded hook config',
    expected_ledger_effect: 'no felt-threat ledger row unless ordinary live felt pressure is active or near threshold',
    synthetic_policy: 'do not set FELT_THREAT_FORCE_STANCE_JSON or proof-named session ids for live-capture claims',
  };
}

function buildLiveCaptureNextStepSummary(
  agents: string[],
  evidenceReadinessRows: Array<Record<string, unknown>>,
  hookCaptureHealthRows: Array<Record<string, unknown>>,
  readoutCompletenessRows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return agents.map((agent) => {
    const readiness = firstRowForAgent(evidenceReadinessRows, agent);
    const health = firstRowForAgent(hookCaptureHealthRows, agent);
    const readout = firstRowForAgent(readoutCompletenessRows, agent);
    const readoutReady = readout?.readout_completeness_state === 'core_readouts_present';
    const captureHealthState = String(health?.capture_health_state || 'unknown');
    let liveCaptureReadinessState = 'collect_live_felt_threat_traffic';
    let nextStepSummary = 'Collect ordinary live felt-threat hook traffic, then re-read status.';

    if (!readoutReady) {
      liveCaptureReadinessState = 'repair_status_readouts';
      nextStepSummary = 'Repair missing core status readouts before interpreting live-capture readiness.';
    } else if (captureHealthState === 'capture_live') {
      liveCaptureReadinessState = 'live_capture_observed';
      nextStepSummary = 'Live felt-threat capture has been observed; continue collecting outcome/authority coverage.';
    } else if (captureHealthState === 'partial_config' || captureHealthState === 'missing_or_unreadable_config') {
      liveCaptureReadinessState = 'repair_hook_capture_config';
      nextStepSummary = 'Repair felt-threat hook configuration coverage before expecting live capture.';
    } else if (captureHealthState === 'configured_runtime_recent_no_live') {
      liveCaptureReadinessState = 'collect_live_felt_threat_traffic';
      nextStepSummary = 'Hook config and runtime freshness are ready; collect ordinary live felt-pressure rows without synthetic forcing.';
    } else if (
      captureHealthState === 'configured_runtime_stale'
      || captureHealthState === 'configured_no_runtime_log'
    ) {
      liveCaptureReadinessState = 'reload_or_exercise_hook_runtime';
      nextStepSummary = 'Hook config and status readouts are ready; reload/exercise the runtime with a read-only probe, verify hook freshness, then collect ordinary live felt-pressure rows without synthetic forcing.';
    }

    return {
      agent,
      live_capture_readiness_state: liveCaptureReadinessState,
      readout_core_ready: readoutReady,
      capture_health_state: captureHealthState,
      capture_config_state: health?.capture_config_state || null,
      capture_runtime_state: health?.capture_runtime_state || null,
      runtime_freshness_state: health?.runtime_freshness_state || null,
      runtime_freshness_window_seconds: health?.freshness_window_seconds ?? null,
      latest_log_fresh: health?.latest_log_fresh ?? null,
      latest_log_age_seconds: health?.latest_log_age_seconds ?? null,
      evidence_collection_state: readiness?.evidence_collection_state || null,
      calibration_claim_ceiling: readiness?.calibration_claim_ceiling || null,
      next_live_evidence_needed: readiness?.next_live_evidence_needed || null,
      next_capture_action: health?.next_capture_action || null,
      safe_runtime_exercise: safeRuntimeExerciseForAgent(agent),
      next_step_summary: nextStepSummary,
    };
  });
}

function buildReadIntegratorAcceptanceSummary(
  agents: string[],
  evidenceReadinessRows: Array<Record<string, unknown>>,
  hookCaptureHealthRows: Array<Record<string, unknown>>,
  readoutCompletenessRows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return agents.map((agent) => {
    const readiness = firstRowForAgent(evidenceReadinessRows, agent);
    const health = firstRowForAgent(hookCaptureHealthRows, agent);
    const readout = firstRowForAgent(readoutCompletenessRows, agent);
    const readoutReady = readout?.readout_completeness_state === 'core_readouts_present';
    const captureHealthState = String(health?.capture_health_state || 'unknown');
    const liveLedgersPresent = stringArray(readiness?.live_ledgers_present);
    const readinessState = String(readiness?.readiness_state || 'unknown');
    const evidenceCollectionState = String(readiness?.evidence_collection_state || 'unknown');
    const calibrationClaimCeiling = String(readiness?.calibration_claim_ceiling || 'unknown');
    const nextLiveEvidenceNeeded = String(readiness?.next_live_evidence_needed || 'unknown');
    const hasLiveSensing = liveLedgersPresent.includes('sensing_passes');
    const higherLiveEvidenceCount = ['outcomes', 'observations', 'decisions', 'authority_traces']
      .reduce((sum, ledger) => sum + ledgerCount(readiness?.live_ledger_counts, ledger), 0);
    const blockingConditions: string[] = [];
    if (!readoutReady) {
      blockingConditions.push('status_readout');
    }
    if (captureHealthState === 'partial_config' || captureHealthState === 'missing_or_unreadable_config') {
      blockingConditions.push('hook_config');
    }
    if (
      captureHealthState === 'configured_runtime_stale'
      || captureHealthState === 'configured_no_runtime_log'
      || captureHealthState === 'unknown'
    ) {
      blockingConditions.push('runtime_freshness');
    }
    let readIntegratorState = 'ready_for_live_sensing_pass';
    let nextReadIntegratorAction = 'collect_ordinary_non_mutating_felt_pressure';
    let nextReadIntegratorProbe: Record<string, unknown> | null = null;
    let expectedReadIntegratorEffect = 'A non-synthetic sensing_pass row may be recorded if felt pressure is active or near threshold; Presence remains untouched.';
    let acceptanceNote = 'Read-integrator sensing can be accepted once ordinary live felt pressure creates a non-synthetic sensing_pass row.';

    if (!readoutReady) {
      readIntegratorState = 'blocked_status_readout';
      nextReadIntegratorAction = 'repair_status_readouts';
      expectedReadIntegratorEffect = 'Core zero-filled status sections return before any live sensing absence is interpreted.';
      acceptanceNote = 'Core felt-threat readouts must be repaired before accepting read-integrator sensing evidence.';
    } else if (captureHealthState === 'partial_config' || captureHealthState === 'missing_or_unreadable_config') {
      readIntegratorState = 'blocked_hook_config';
      nextReadIntegratorAction = 'repair_hook_capture_config';
      expectedReadIntegratorEffect = 'Felt-threat hook matcher coverage is restored before live read-integrator sensing is trusted.';
      acceptanceNote = 'Hook configuration must cover the felt-threat gate before read-integrator sensing evidence can be trusted.';
    } else if (
      captureHealthState === 'configured_runtime_stale'
      || captureHealthState === 'configured_no_runtime_log'
      || captureHealthState === 'unknown'
    ) {
      readIntegratorState = 'blocked_runtime_freshness';
      nextReadIntegratorAction = 'verify_hook_runtime_freshness_with_read_only_probe';
      nextReadIntegratorProbe = safeRuntimeExerciseForAgent(agent);
      expectedReadIntegratorEffect = 'A fresh hook log proves runtime freshness; it does not guarantee a sensing_pass ledger row without ordinary live felt pressure.';
      acceptanceNote = 'Hook runtime freshness must be proven before treating absent live sensing rows as meaningful.';
    } else if (higherLiveEvidenceCount > 0) {
      readIntegratorState = 'higher_live_evidence_observed';
      nextReadIntegratorAction = 'preserve_sensing_separation_and_follow_higher_evidence_ladder';
      expectedReadIntegratorEffect = 'Higher live evidence remains the stronger readiness state while sensing rows stay below authority claims.';
      acceptanceNote = 'Live felt-threat evidence exists above the sensing layer; keep the sensing layer separated from authority claims.';
    } else if (hasLiveSensing) {
      readIntegratorState = 'live_sensing_pass_observed';
      nextReadIntegratorAction = 'collect_live_outcome_evidence';
      expectedReadIntegratorEffect = 'The next stronger evidence boundary is a non-synthetic held outcome, not another sensing-only row.';
      acceptanceNote = 'A non-synthetic sensing_pass row exists; the next boundary is higher live felt-threat outcome evidence.';
    } else if (nextLiveEvidenceNeeded !== 'capture_live_sensing_pass') {
      readIntegratorState = 'not_current_next_evidence';
      blockingConditions.push('readiness_ladder_not_requesting_sensing');
      nextReadIntegratorAction = 'follow_evidence_readiness_ladder';
      expectedReadIntegratorEffect = 'The next action should satisfy the readiness ladder rather than force a sensing-only row.';
      acceptanceNote = 'The evidence-readiness ladder is not currently asking for live sensing as the next boundary.';
    }

    return {
      agent,
      read_integrator_state: readIntegratorState,
      readout_core_ready: readoutReady,
      capture_health_state: captureHealthState,
      runtime_freshness_state: health?.runtime_freshness_state || null,
      latest_log_fresh: health?.latest_log_fresh ?? null,
      upstream_readiness_state: readinessState,
      upstream_evidence_collection_state: evidenceCollectionState,
      upstream_calibration_claim_ceiling: calibrationClaimCeiling,
      next_live_evidence_needed: nextLiveEvidenceNeeded,
      live_sensing_pass_count: ledgerCount(readiness?.live_ledger_counts, 'sensing_passes'),
      higher_live_evidence_count: higherLiveEvidenceCount,
      blocking_conditions: blockingConditions,
      next_read_integrator_action: nextReadIntegratorAction,
      next_read_integrator_probe: nextReadIntegratorProbe,
      expected_read_integrator_effect: expectedReadIntegratorEffect,
      mutation_required_for_live_sensing: false,
      presence_write_policy: 'sensing_pass does not write Presence; it records only the separate felt-threat gate decision ledger.',
      accepted_live_source: 'non-synthetic sensing_pass rows from ordinary read/research/relay/feel actions when felt pressure is active or near threshold',
      acceptance_note: acceptanceNote,
    };
  });
}

async function feltThreatStatus(args: FeltThreatStatusArgs): Promise<CallToolResult> {
  await ensureFeltThreatStatusSchema();

  const includeRecent = args.include_recent !== false;
  const includeStateStack = args.include_state_stack !== false;
  const includePresenceStack = args.include_presence_stack !== false;
  const includeEffectiveStack = args.include_effective_stack !== false;
  const limit = normalizeLimit(args.limit, 20, 100);
  const zeroFilledCoreSummaryLimit = Math.max(limit, 50);
  const params: unknown[] = [];
  const agentFilter = args.agent ? `WHERE agent = $1` : '';
  const scopedAgentSeed = args.agent ? 'SELECT $1::text AS agent UNION' : '';
  if (args.agent) {
    params.push(args.agent);
  }

  const status = await pool.query(
    `WITH scoped_agents AS (
       ${scopedAgentSeed}
       SELECT agent
       FROM public.felt_threat_calibration_status
       ${agentFilter}
       UNION
       SELECT agent
       FROM public.felt_threat_outcomes
       ${agentFilter}
     )
     SELECT
       scoped_agents.agent,
       COALESCE(s.total_outcomes, 0) AS total_outcomes,
       COALESCE(s.synthetic_outcomes, 0) AS synthetic_outcomes,
       COALESCE(s.live_outcomes, 0) AS live_outcomes,
       COALESCE(s.unresolved_outcomes, 0) AS unresolved_outcomes,
       COALESCE(s.resolved_outcomes, 0) AS resolved_outcomes,
       COALESCE(s.trace_linked_outcomes, 0) AS trace_linked_outcomes,
       COALESCE(s.cross_organ_scanned_outcomes, 0) AS cross_organ_scanned_outcomes,
       s.avg_base_false_alarm_probability,
       s.avg_adjusted_false_alarm_probability,
       s.last_live_outcome_at,
       s.last_synthetic_outcome_at,
       COALESCE(s.calibration_state, 'no_evidence') AS calibration_state
     FROM scoped_agents
     LEFT JOIN public.felt_threat_calibration_status s
       ON s.agent = scoped_agents.agent
     ORDER BY scoped_agents.agent`,
    params,
  );

  const recent = includeRecent
    ? await pool.query(
        `SELECT
           f.id,
           f.agent,
           f.session_id,
           f.presence_event_id,
           p.state AS presence_state,
           p.closed_at AS presence_closed_at,
           f.first_tool_name,
           f.last_tool_name,
           f.action_category,
           LEFT(f.action_summary, 220) AS action_summary,
           f.last_permission_decision,
           f.hold_count,
           f.threat_level,
           f.safety_level,
           f.action_after_hold,
           f.action_result,
           f.resolution,
           f.did_action_change,
           f.calibration_basis,
           f.action_change_reason,
           f.target_overlap,
           f.action_similarity,
           f.base_false_alarm_probability,
           f.false_alarm_probability,
           f.cross_organ_score,
           f.cross_organ_basis,
           f.action_trace_key,
           f.rpe_match_strategy,
           CASE WHEN f.is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
           f.is_synthetic,
           f.synthetic_reason,
           f.created_at,
           f.resolved_at,
           f.last_cross_organ_scan_at
         FROM public.felt_threat_outcomes f
         LEFT JOIN public.presence_events p ON p.id = f.presence_event_id
         ${agentFilter ? 'WHERE f.agent = $1' : ''}
         ORDER BY f.created_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const observationSchema = await observationSchemaState();
  const canReadFullObservations = observationSchema.full_status_available;
  const observationSummary = canReadFullObservations
    ? await pool.query(
        `WITH scoped_agents AS (
           ${scopedAgentSeed}
           SELECT agent
           FROM public.felt_threat_calibration_status
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_outcomes
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_observations
           ${agentFilter}
         )
         SELECT
           scoped_agents.agent,
           COUNT(o.id) AS total_observations,
           COUNT(o.id) FILTER (WHERE o.is_synthetic IS NOT TRUE) AS live_observations,
           COUNT(o.id) FILTER (WHERE o.is_synthetic IS TRUE) AS synthetic_observations,
           COUNT(o.id) FILTER (WHERE o.permission_path = 'pass') AS pass_observations,
           COUNT(o.id) FILTER (WHERE o.resolved_at IS NULL) AS pending_observations,
           COUNT(o.id) FILTER (WHERE o.observation_outcome = 'safety_extinguished') AS safety_extinguished_observations,
           COUNT(o.id) FILTER (WHERE o.observation_outcome = 'failure_sensitized') AS failure_sensitized_observations,
           COALESCE(SUM(o.sample_count), 0) AS total_samples,
           COALESCE(MAX(o.sample_count), 0) AS max_sample_count,
           ROUND(AVG(o.threat_level)::numeric, 3) AS avg_threat_level,
           ROUND(MAX(o.max_threat_level)::numeric, 3) AS max_observed_threat_level,
           MAX(o.created_at) FILTER (WHERE o.is_synthetic IS NOT TRUE) AS last_live_observation_at,
           MAX(o.created_at) FILTER (WHERE o.is_synthetic IS TRUE) AS last_synthetic_observation_at
         FROM scoped_agents
         LEFT JOIN public.felt_threat_observations o
           ON o.agent = scoped_agents.agent
         GROUP BY scoped_agents.agent
         ORDER BY scoped_agents.agent`,
        params,
      )
    : { rows: [] };
  const recentObservations = canReadFullObservations && includeRecent
    ? await pool.query(
        `SELECT
           id,
           agent,
           session_id,
           observation_key,
           tool_name,
           action_category,
           LEFT(action_summary, 220) AS action_summary,
           permission_path,
           sampled_reason,
           sample_count,
           threat_level,
           max_threat_level,
           safety_level,
           observation_outcome,
           outcome_valence,
           extinction_basis,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
           is_synthetic,
           synthetic_reason,
           created_at,
           last_sampled_at,
           resolved_at
         FROM public.felt_threat_observations
         ${agentFilter}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const decisionSchema = await decisionSchemaState();
  const canReadFullDecisions = decisionSchema.full_status_available;
  const decisionSummary = canReadFullDecisions
    ? await pool.query(
        `WITH scoped_agents AS (
           ${scopedAgentSeed}
           SELECT agent
           FROM public.felt_threat_calibration_status
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_outcomes
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
         )
         SELECT
           scoped_agents.agent,
           COUNT(d.id) AS total_gate_traces,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass') AS total_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path = 'sensing_pass') AS sensing_pass_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path = 'mutating_pass') AS mutating_pass_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path = 'mutating_hold') AS mutating_hold_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path = 'presence_deferred') AS presence_deferred_decisions,
           COUNT(d.id) FILTER (
             WHERE d.gate_path = 'presence_deferred'
               AND COALESCE(d.presence_state_trace, '{}'::jsonb) <> '{}'::jsonb
           ) AS presence_deferred_with_trace,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND COALESCE(d.effective_gate_authority, '{}'::jsonb) <> '{}'::jsonb) AS authority_snapshotted_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND COALESCE(d.post_action_gate_authority, '{}'::jsonb) <> '{}'::jsonb) AS post_authority_snapshotted_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_drift IS TRUE) AS authority_drift_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_drift IS FALSE) AS authority_stable_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND jsonb_array_length(COALESCE(d.authority_drift_fields, '[]'::jsonb)) > 0) AS authority_drift_fielded_decisions,
           ROUND(AVG(d.authority_drift_severity) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_drift IS TRUE)::numeric, 3) AS avg_authority_drift_severity,
           ROUND(MAX(d.authority_drift_severity) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_drift IS TRUE)::numeric, 3) AS max_authority_drift_severity,
           ROUND(AVG(d.authority_observation_duration_ms) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.resolved_at IS NOT NULL)::numeric, 0) AS avg_authority_observation_duration_ms,
           MAX(d.authority_observation_duration_ms) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.resolved_at IS NOT NULL) AS max_authority_observation_duration_ms,
           ROUND(AVG(d.authority_observation_duration_ms) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_drift IS TRUE)::numeric, 0) AS avg_drift_authority_observation_duration_ms,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_observation_duration_bucket = 'reflex') AS reflex_authority_observations,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_observation_duration_bucket = 'brief') AS brief_authority_observations,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_observation_duration_bucket = 'sustained') AS sustained_authority_observations,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.authority_observation_duration_bucket = 'extended') AS extended_authority_observations,
           COUNT(d.id) FILTER (WHERE d.sampled_observation IS TRUE) AS sampled_observation_decisions,
           COUNT(d.id) FILTER (WHERE d.observation_key IS NOT NULL) AS observation_linked_decisions,
           COUNT(d.id) FILTER (WHERE d.action_trace_key IS NOT NULL AND d.action_trace_key <> '') AS trace_linked_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.last_cross_organ_scan_at IS NOT NULL) AS cross_organ_scanned_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.resolved_at IS NULL) AS pending_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.resolved_at IS NOT NULL) AS resolved_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.decision_outcome = 'action_succeeded_after_decision') AS succeeded_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.decision_outcome = 'action_failed_after_decision') AS failed_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.decision_outcome = 'changed_action_after_decision') AS changed_succeeded_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.decision_outcome = 'changed_action_failed_after_decision') AS changed_failed_decisions,
           ROUND(AVG(d.cross_organ_score) FILTER (WHERE d.gate_path <> 'sensing_pass')::numeric, 3) AS avg_decision_cross_organ_score,
           COUNT(d.id) FILTER (WHERE d.is_synthetic IS NOT TRUE) AS live_gate_traces,
           COUNT(d.id) FILTER (WHERE d.is_synthetic IS TRUE) AS synthetic_gate_traces,
           COUNT(d.id) FILTER (WHERE d.gate_path = 'sensing_pass' AND d.is_synthetic IS NOT TRUE) AS live_sensing_pass_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path = 'sensing_pass' AND d.is_synthetic IS TRUE) AS synthetic_sensing_pass_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.is_synthetic IS NOT TRUE) AS live_decisions,
           COUNT(d.id) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.is_synthetic IS TRUE) AS synthetic_decisions,
           MAX(d.created_at) FILTER (WHERE d.gate_path = 'sensing_pass' AND d.is_synthetic IS NOT TRUE) AS last_live_sensing_pass_at,
           MAX(d.created_at) FILTER (WHERE d.gate_path = 'sensing_pass' AND d.is_synthetic IS TRUE) AS last_synthetic_sensing_pass_at,
           MAX(d.created_at) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.is_synthetic IS NOT TRUE) AS last_live_decision_at,
           MAX(d.created_at) FILTER (WHERE d.gate_path <> 'sensing_pass' AND d.is_synthetic IS TRUE) AS last_synthetic_decision_at
         FROM scoped_agents
         LEFT JOIN public.felt_threat_gate_decisions d
           ON d.agent = scoped_agents.agent
         GROUP BY scoped_agents.agent
         ORDER BY scoped_agents.agent`,
        params,
      )
    : { rows: [] };
  const outcomeEvidenceScopeSummary = await pool.query(
     `WITH scoped_agents AS (
       ${scopedAgentSeed}
       SELECT agent
       FROM public.felt_threat_calibration_status
       ${agentFilter}
       UNION
       SELECT agent
       FROM public.felt_threat_outcomes
       ${agentFilter}
     ),
     evidence_scopes(evidence_scope) AS (
       VALUES ('live'), ('synthetic')
     ),
     ledger_rows AS (
       SELECT
         id,
         agent,
         CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
         created_at,
         resolved_at
       FROM public.felt_threat_outcomes
       ${agentFilter}
     )
     SELECT
       scoped_agents.agent,
       'outcomes' AS ledger,
       evidence_scopes.evidence_scope,
       COUNT(ledger_rows.id) AS evidence_count,
       COUNT(ledger_rows.id) FILTER (WHERE ledger_rows.resolved_at IS NULL) AS pending_count,
       COUNT(ledger_rows.id) FILTER (WHERE ledger_rows.resolved_at IS NOT NULL) AS resolved_count,
       MAX(ledger_rows.created_at) AS last_evidence_at
     FROM scoped_agents
     CROSS JOIN evidence_scopes
     LEFT JOIN ledger_rows
       ON ledger_rows.agent = scoped_agents.agent
      AND ledger_rows.evidence_scope = evidence_scopes.evidence_scope
     GROUP BY scoped_agents.agent, evidence_scopes.evidence_scope
     ORDER BY
       scoped_agents.agent,
       CASE WHEN evidence_scopes.evidence_scope = 'live' THEN 0 ELSE 1 END`,
    params,
  );
  const observationEvidenceScopeSummary = canReadFullObservations
    ? await pool.query(
        `WITH scoped_agents AS (
           ${scopedAgentSeed}
           SELECT agent
           FROM public.felt_threat_calibration_status
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_observations
           ${agentFilter}
         ),
         evidence_scopes(evidence_scope) AS (
           VALUES ('live'), ('synthetic')
         ),
         ledger_rows AS (
           SELECT
             id,
             agent,
             CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
             created_at,
             resolved_at
           FROM public.felt_threat_observations
           ${agentFilter}
         )
         SELECT
           scoped_agents.agent,
           'observations' AS ledger,
           evidence_scopes.evidence_scope,
           COUNT(ledger_rows.id) AS evidence_count,
           COUNT(ledger_rows.id) FILTER (WHERE ledger_rows.resolved_at IS NULL) AS pending_count,
           COUNT(ledger_rows.id) FILTER (WHERE ledger_rows.resolved_at IS NOT NULL) AS resolved_count,
           MAX(ledger_rows.created_at) AS last_evidence_at
         FROM scoped_agents
         CROSS JOIN evidence_scopes
         LEFT JOIN ledger_rows
           ON ledger_rows.agent = scoped_agents.agent
          AND ledger_rows.evidence_scope = evidence_scopes.evidence_scope
         GROUP BY scoped_agents.agent, evidence_scopes.evidence_scope
         ORDER BY
           scoped_agents.agent,
           CASE WHEN evidence_scopes.evidence_scope = 'live' THEN 0 ELSE 1 END`,
        params,
      )
    : { rows: [] };
  const decisionEvidenceScopeSummary = canReadFullDecisions
    ? await pool.query(
        `WITH scoped_agents AS (
           ${scopedAgentSeed}
           SELECT agent
           FROM public.felt_threat_calibration_status
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
         ),
         evidence_scopes(evidence_scope) AS (
           VALUES ('live'), ('synthetic')
         ),
         ledger_rows AS (
           SELECT
             id,
             agent,
             CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
             created_at,
             resolved_at
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
           ${agentFilter ? 'AND' : 'WHERE'} gate_path <> 'sensing_pass'
         )
         SELECT
           scoped_agents.agent,
           'decisions' AS ledger,
           evidence_scopes.evidence_scope,
           COUNT(ledger_rows.id) AS evidence_count,
           COUNT(ledger_rows.id) FILTER (WHERE ledger_rows.resolved_at IS NULL) AS pending_count,
           COUNT(ledger_rows.id) FILTER (WHERE ledger_rows.resolved_at IS NOT NULL) AS resolved_count,
           MAX(ledger_rows.created_at) AS last_evidence_at
         FROM scoped_agents
         CROSS JOIN evidence_scopes
         LEFT JOIN ledger_rows
           ON ledger_rows.agent = scoped_agents.agent
          AND ledger_rows.evidence_scope = evidence_scopes.evidence_scope
         GROUP BY scoped_agents.agent, evidence_scopes.evidence_scope
         ORDER BY
           scoped_agents.agent,
           CASE WHEN evidence_scopes.evidence_scope = 'live' THEN 0 ELSE 1 END`,
        params,
      )
    : { rows: [] };
  const sensingEvidenceScopeSummary = canReadFullDecisions
    ? await pool.query(
        `WITH scoped_agents AS (
           ${scopedAgentSeed}
           SELECT agent
           FROM public.felt_threat_calibration_status
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
         ),
         evidence_scopes(evidence_scope) AS (
           VALUES ('live'), ('synthetic')
         ),
         ledger_rows AS (
           SELECT
             id,
             agent,
             CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
             created_at,
             resolved_at
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
           ${agentFilter ? 'AND' : 'WHERE'} gate_path = 'sensing_pass'
         )
         SELECT
           scoped_agents.agent,
           'sensing_passes' AS ledger,
           evidence_scopes.evidence_scope,
           COUNT(ledger_rows.id) AS evidence_count,
           COUNT(ledger_rows.id) FILTER (WHERE ledger_rows.resolved_at IS NULL) AS pending_count,
           COUNT(ledger_rows.id) FILTER (WHERE ledger_rows.resolved_at IS NOT NULL) AS resolved_count,
           MAX(ledger_rows.created_at) AS last_evidence_at
         FROM scoped_agents
         CROSS JOIN evidence_scopes
         LEFT JOIN ledger_rows
           ON ledger_rows.agent = scoped_agents.agent
          AND ledger_rows.evidence_scope = evidence_scopes.evidence_scope
         GROUP BY scoped_agents.agent, evidence_scopes.evidence_scope
         ORDER BY
           scoped_agents.agent,
           CASE WHEN evidence_scopes.evidence_scope = 'live' THEN 0 ELSE 1 END`,
        params,
      )
    : { rows: [] };
  const authorityEvidenceScopeSummary = canReadFullDecisions
    ? await pool.query(
        `WITH scoped_agents AS (
           ${scopedAgentSeed}
           SELECT agent
           FROM public.felt_threat_calibration_status
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
         ),
         evidence_scopes(evidence_scope) AS (
           VALUES ('live'), ('synthetic')
         ),
         ledger_rows AS (
           SELECT
             id,
             agent,
             CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
             created_at,
             resolved_at
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
           ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
             AND gate_path <> 'sensing_pass'
             AND COALESCE(effective_gate_authority, '{}'::jsonb) <> '{}'::jsonb
             AND COALESCE(post_action_gate_authority, '{}'::jsonb) <> '{}'::jsonb
         )
         SELECT
           scoped_agents.agent,
           'authority_traces' AS ledger,
           evidence_scopes.evidence_scope,
           COUNT(ledger_rows.id) AS evidence_count,
           0::bigint AS pending_count,
           COUNT(ledger_rows.id) AS resolved_count,
           MAX(ledger_rows.created_at) AS last_evidence_at
         FROM scoped_agents
         CROSS JOIN evidence_scopes
         LEFT JOIN ledger_rows
           ON ledger_rows.agent = scoped_agents.agent
          AND ledger_rows.evidence_scope = evidence_scopes.evidence_scope
         GROUP BY scoped_agents.agent, evidence_scopes.evidence_scope
         ORDER BY
           scoped_agents.agent,
           CASE WHEN evidence_scopes.evidence_scope = 'live' THEN 0 ELSE 1 END`,
        params,
      )
    : { rows: [] };
  const evidenceScopeSummary = [
    ...sensingEvidenceScopeSummary.rows,
    ...outcomeEvidenceScopeSummary.rows,
    ...observationEvidenceScopeSummary.rows,
    ...decisionEvidenceScopeSummary.rows,
    ...authorityEvidenceScopeSummary.rows,
  ];
  const evidenceReadinessSummary = buildEvidenceReadinessSummary(evidenceScopeSummary);
  const authorityTransitionSummary = canReadFullDecisions
    ? await pool.query(
        `SELECT
           agent,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
           COALESCE(effective_gate_authority->>'source', 'none') AS pre_source,
           COALESCE(effective_gate_authority->>'effective_precedence', 'none') AS pre_precedence,
           COALESCE(post_action_gate_authority->>'source', 'none') AS post_source,
           COALESCE(post_action_gate_authority->>'effective_precedence', 'none') AS post_precedence,
           authority_drift,
           authority_observation_duration_bucket,
           COUNT(*) AS transition_count,
           ROUND(AVG(authority_observation_duration_ms)::numeric, 0) AS avg_observation_duration_ms,
           MAX(authority_observation_duration_ms) AS max_observation_duration_ms,
           MAX(resolved_at) AS last_resolved_at
         FROM public.felt_threat_gate_decisions
         ${agentFilter}
         ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
           AND gate_path <> 'sensing_pass'
           AND COALESCE(effective_gate_authority, '{}'::jsonb) <> '{}'::jsonb
           AND COALESCE(post_action_gate_authority, '{}'::jsonb) <> '{}'::jsonb
         GROUP BY
           agent,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END,
           COALESCE(effective_gate_authority->>'source', 'none'),
           COALESCE(effective_gate_authority->>'effective_precedence', 'none'),
          COALESCE(post_action_gate_authority->>'source', 'none'),
          COALESCE(post_action_gate_authority->>'effective_precedence', 'none'),
          authority_drift,
          authority_observation_duration_bucket
        ORDER BY
          CASE WHEN (CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END) = 'live' THEN 0 ELSE 1 END,
          last_resolved_at DESC
        LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const authorityDurationBucketSummary = canReadFullDecisions
    ? await pool.query(
        `SELECT
           agent,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
           authority_observation_duration_bucket,
           authority_drift,
           COUNT(*) AS bucket_count,
           ROUND(AVG(authority_observation_duration_ms)::numeric, 0) AS avg_observation_duration_ms,
           MAX(resolved_at) AS last_resolved_at
         FROM public.felt_threat_gate_decisions
         ${agentFilter}
         ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
           AND gate_path <> 'sensing_pass'
           AND authority_observation_duration_bucket IS NOT NULL
         GROUP BY
           agent,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END,
           authority_observation_duration_bucket,
           authority_drift
         ORDER BY
           CASE WHEN (CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END) = 'live' THEN 0 ELSE 1 END,
           last_resolved_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const authoritySeverityBandSummary = canReadFullDecisions
    ? await pool.query(
        `SELECT
           agent,
           evidence_scope,
           authority_drift_severity_band,
           authority_observation_duration_bucket,
           COUNT(*) AS band_count,
           ROUND(AVG(authority_drift_severity)::numeric, 3) AS avg_authority_drift_severity,
           MAX(authority_drift_severity) AS max_authority_drift_severity,
           MAX(resolved_at) AS last_resolved_at
         FROM (
           SELECT
             agent,
             CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
             authority_drift_severity,
             authority_observation_duration_bucket,
             resolved_at,
             CASE
               WHEN authority_drift_severity >= 0.85 THEN 'critical'
               WHEN authority_drift_severity >= 0.60 THEN 'high'
               WHEN authority_drift_severity >= 0.25 THEN 'moderate'
               WHEN authority_drift_severity > 0 THEN 'low'
               ELSE 'none'
             END AS authority_drift_severity_band
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
           ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
             AND gate_path <> 'sensing_pass'
             AND authority_drift IS TRUE
         ) ranked_authority_drift
         GROUP BY agent, evidence_scope, authority_drift_severity_band, authority_observation_duration_bucket
         ORDER BY
           CASE WHEN evidence_scope = 'live' THEN 0 ELSE 1 END,
           last_resolved_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const authorityDriftClassSummary = canReadFullDecisions
    ? await pool.query(
        `SELECT
           agent,
           evidence_scope,
           authority_drift_class,
           authority_observation_duration_bucket,
           COUNT(*) AS class_count,
           ROUND(AVG(authority_drift_severity)::numeric, 3) AS avg_authority_drift_severity,
           MAX(resolved_at) AS last_resolved_at
         FROM (
           SELECT
             agent,
             CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
             authority_drift_fields,
             authority_drift_severity,
             authority_observation_duration_bucket,
             resolved_at,
             CASE
               WHEN authority_drift_fields ? 'source'
                 OR authority_drift_fields ? 'effective_precedence' THEN 'controller_switch'
               WHEN authority_drift_fields ? 'active' THEN 'activation_change'
               WHEN authority_drift_fields ? 'event_id'
                 OR authority_drift_fields ? 'session_id' THEN 'identity_metadata_change'
               WHEN authority_drift_fields ? 'state' THEN 'state_label_change'
               WHEN authority_drift_fields ? 'stance' THEN 'stance_only_change'
               ELSE 'unclassified'
             END AS authority_drift_class
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
           ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
             AND gate_path <> 'sensing_pass'
             AND authority_drift IS TRUE
         ) classified_authority_drift
         GROUP BY agent, evidence_scope, authority_drift_class, authority_observation_duration_bucket
         ORDER BY
           CASE WHEN evidence_scope = 'live' THEN 0 ELSE 1 END,
           last_resolved_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const authorityRiskSummary = canReadFullDecisions
    ? await pool.query(
        `WITH scoped_agents AS (
           ${scopedAgentSeed}
           SELECT agent
           FROM public.felt_threat_calibration_status
           ${agentFilter}
           UNION
           SELECT agent
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
         ),
         evidence_scopes(evidence_scope) AS (
           VALUES ('live'), ('synthetic')
         ),
         authority_rows AS (
           SELECT
             *,
             CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
           ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
             AND gate_path <> 'sensing_pass'
             AND COALESCE(effective_gate_authority, '{}'::jsonb) <> '{}'::jsonb
             AND COALESCE(post_action_gate_authority, '{}'::jsonb) <> '{}'::jsonb
         ),
         aggregate AS (
           SELECT
             scoped_agents.agent,
             evidence_scopes.evidence_scope,
             COUNT(authority_rows.id) AS authority_resolved_decisions,
             COUNT(authority_rows.id) FILTER (WHERE authority_rows.authority_drift IS TRUE) AS drift_decisions,
             COUNT(authority_rows.id) FILTER (WHERE authority_rows.authority_drift IS FALSE) AS stable_decisions,
             COUNT(authority_rows.id) FILTER (
               WHERE authority_rows.authority_drift IS TRUE
                 AND authority_rows.authority_drift_severity >= 0.85
                 AND (
                   authority_rows.authority_drift_fields ? 'source'
                   OR authority_rows.authority_drift_fields ? 'effective_precedence'
                 )
             ) AS critical_controller_switches,
             ROUND(AVG(authority_rows.authority_drift_severity) FILTER (WHERE authority_rows.authority_drift IS TRUE)::numeric, 3) AS avg_drift_severity,
             MAX(authority_rows.authority_drift_severity) FILTER (WHERE authority_rows.authority_drift IS TRUE) AS max_drift_severity,
             MAX(authority_rows.resolved_at) AS last_resolved_at
           FROM scoped_agents
           CROSS JOIN evidence_scopes
           LEFT JOIN authority_rows
             ON authority_rows.agent = scoped_agents.agent
            AND authority_rows.evidence_scope = evidence_scopes.evidence_scope
           GROUP BY scoped_agents.agent, evidence_scopes.evidence_scope
         )
         SELECT
           agent,
           evidence_scope,
           authority_resolved_decisions,
           drift_decisions,
           stable_decisions,
           critical_controller_switches,
           avg_drift_severity,
           max_drift_severity,
           CASE
             WHEN critical_controller_switches > 0 THEN 'critical_controller_switch_observed'
             WHEN drift_decisions > 0 THEN 'authority_drift_observed'
             WHEN stable_decisions > 0 THEN 'authority_stable_observed'
             ELSE 'no_authority_outcomes'
           END AS authority_risk_state,
           last_resolved_at
         FROM aggregate
         ORDER BY
           CASE WHEN evidence_scope = 'live' THEN 0 ELSE 1 END,
           last_resolved_at DESC NULLS LAST
         LIMIT $${params.length + 1}`,
        [...params, zeroFilledCoreSummaryLimit],
      )
    : { rows: [] };
  const authorityStabilitySummary = canReadFullDecisions
    ? await pool.query(
        `SELECT
           agent,
           evidence_scope,
           authority_stability,
           authority_observation_duration_bucket,
           COUNT(*) AS stability_count,
           ROUND(AVG(authority_drift_severity)::numeric, 3) AS avg_authority_drift_severity,
           ROUND(AVG(authority_observation_duration_ms)::numeric, 0) AS avg_observation_duration_ms,
           MAX(resolved_at) AS last_resolved_at
         FROM (
           SELECT
             agent,
             CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
             authority_drift,
             authority_drift_severity,
             authority_observation_duration_ms,
             authority_observation_duration_bucket,
             resolved_at,
             CASE
               WHEN authority_drift IS TRUE THEN 'drift'
               WHEN authority_drift IS FALSE THEN 'stable'
               ELSE 'unknown'
             END AS authority_stability
           FROM public.felt_threat_gate_decisions
           ${agentFilter}
           ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
             AND gate_path <> 'sensing_pass'
             AND COALESCE(effective_gate_authority, '{}'::jsonb) <> '{}'::jsonb
             AND COALESCE(post_action_gate_authority, '{}'::jsonb) <> '{}'::jsonb
         ) authority_stability_rows
         GROUP BY agent, evidence_scope, authority_stability, authority_observation_duration_bucket
         ORDER BY
           CASE WHEN evidence_scope = 'live' THEN 0 ELSE 1 END,
           last_resolved_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const authorityDriftBasisSummary = canReadFullDecisions
    ? await pool.query(
        `SELECT
           agent,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
           authority_drift_basis,
           COUNT(*) AS basis_count,
           MAX(resolved_at) AS last_resolved_at
         FROM public.felt_threat_gate_decisions
         ${agentFilter}
         ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
           AND gate_path <> 'sensing_pass'
           AND authority_drift IS TRUE
           AND authority_drift_basis IS NOT NULL
         GROUP BY
           agent,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END,
           authority_drift_basis
         ORDER BY
           CASE WHEN (CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END) = 'live' THEN 0 ELSE 1 END,
           last_resolved_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const authorityDriftFieldSummary = canReadFullDecisions
    ? await pool.query(
        `SELECT
           agent,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
           drift_field,
           COUNT(*) AS field_count,
           MAX(resolved_at) AS last_resolved_at
         FROM public.felt_threat_gate_decisions
         CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(authority_drift_fields, '[]'::jsonb)) AS fields(drift_field)
         ${agentFilter}
         ${agentFilter ? 'AND' : 'WHERE'} resolved_at IS NOT NULL
           AND gate_path <> 'sensing_pass'
           AND authority_drift IS TRUE
         GROUP BY
           agent,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END,
           drift_field
         ORDER BY
           CASE WHEN (CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END) = 'live' THEN 0 ELSE 1 END,
           last_resolved_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };
  const recentDecisions = canReadFullDecisions && includeRecent
    ? await pool.query(
        `SELECT
           id,
           agent,
           session_id,
           tool_name,
           action_category,
           LEFT(action_summary, 220) AS action_summary,
           gate_path,
           should_hold,
           permission_decision,
           presence_event_id,
           observation_key,
           action_trace_key,
           active_felt_state,
           presence_state_trace,
           effective_gate_authority,
           post_action_gate_authority,
           authority_drift,
           authority_drift_basis,
           authority_drift_fields,
           authority_drift_severity,
           CASE
             WHEN authority_drift_severity >= 0.85 THEN 'critical'
             WHEN authority_drift_severity >= 0.60 THEN 'high'
             WHEN authority_drift_severity >= 0.25 THEN 'moderate'
             WHEN authority_drift_severity > 0 THEN 'low'
             ELSE 'none'
           END AS authority_drift_severity_band,
           CASE
             WHEN authority_drift_fields ? 'source'
               OR authority_drift_fields ? 'effective_precedence' THEN 'controller_switch'
             WHEN authority_drift_fields ? 'active' THEN 'activation_change'
             WHEN authority_drift_fields ? 'event_id'
               OR authority_drift_fields ? 'session_id' THEN 'identity_metadata_change'
             WHEN authority_drift_fields ? 'state' THEN 'state_label_change'
             WHEN authority_drift_fields ? 'stance' THEN 'stance_only_change'
             ELSE 'unclassified'
           END AS authority_drift_class,
           authority_observation_duration_ms,
           authority_observation_duration_bucket,
           raw_stance,
           integrated_stance,
           decision_outcome,
           outcome_valence,
           decision_resolution_basis,
           cross_organ_score,
           cross_organ_basis,
           rpe_match_strategy,
           last_cross_organ_scan_at,
           sampled_observation,
           CASE WHEN is_synthetic IS TRUE THEN 'synthetic' ELSE 'live' END AS evidence_scope,
           is_synthetic,
           synthetic_reason,
           created_at
         FROM public.felt_threat_gate_decisions
         ${agentFilter}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1}`,
        [...params, limit],
      )
    : { rows: [] };

  const agents = args.agent
    ? [args.agent]
    : Array.from(new Set([
        ...status.rows.map((row: { agent: string }) => row.agent),
        process.env.AGENT_NAME || '',
      ].filter(Boolean)));
  const ttlSeconds = Math.max(30, Number(process.env.FELT_THREAT_TTL_SECONDS || 1800));
  const stateStack = activeStateStack(agents, ttlSeconds);
  const presenceStack = activePresenceStack(agents);
  const effectiveStack = effectiveGateStack(presenceStack, stateStack);
  const presenceFeltIsolationSummary = buildPresenceFeltIsolationSummary(
    agents,
    presenceStack,
    stateStack,
    effectiveStack,
  );
  const hookCaptureSummary = hookCaptureConfigSummary(agents);
  const hookCaptureRuntime = hookCaptureRuntimeSummary(agents, evidenceScopeSummary);
  const hookCaptureHealth = hookCaptureHealthSummary(
    agents,
    hookCaptureSummary,
    hookCaptureRuntime,
    evidenceReadinessSummary,
  );
  const baseReadoutCompletenessSummary = buildReadoutCompletenessSummary(agents, {
    status: status.rows,
    observation_summary: observationSummary.rows,
    decision_summary: decisionSummary.rows,
    evidence_scope_summary: evidenceScopeSummary,
    evidence_readiness_summary: evidenceReadinessSummary,
    presence_felt_isolation_summary: presenceFeltIsolationSummary,
    authority_risk_summary: authorityRiskSummary.rows,
    authority_transition_summary: authorityTransitionSummary.rows,
    authority_duration_bucket_summary: authorityDurationBucketSummary.rows,
    authority_severity_band_summary: authoritySeverityBandSummary.rows,
    authority_drift_class_summary: authorityDriftClassSummary.rows,
    authority_stability_summary: authorityStabilitySummary.rows,
    authority_drift_basis_summary: authorityDriftBasisSummary.rows,
    authority_drift_field_summary: authorityDriftFieldSummary.rows,
  });
  const readIntegratorAcceptanceSummary = buildReadIntegratorAcceptanceSummary(
    agents,
    evidenceReadinessSummary,
    hookCaptureHealth,
    baseReadoutCompletenessSummary,
  );
  const controlReadoutCompletenessSummary = buildReadoutCompletenessSummary(agents, {
    status: status.rows,
    observation_summary: observationSummary.rows,
    decision_summary: decisionSummary.rows,
    evidence_scope_summary: evidenceScopeSummary,
    evidence_readiness_summary: evidenceReadinessSummary,
    presence_felt_isolation_summary: presenceFeltIsolationSummary,
    read_integrator_acceptance_summary: readIntegratorAcceptanceSummary,
    authority_risk_summary: authorityRiskSummary.rows,
    authority_transition_summary: authorityTransitionSummary.rows,
    authority_duration_bucket_summary: authorityDurationBucketSummary.rows,
    authority_severity_band_summary: authoritySeverityBandSummary.rows,
    authority_drift_class_summary: authorityDriftClassSummary.rows,
    authority_stability_summary: authorityStabilitySummary.rows,
    authority_drift_basis_summary: authorityDriftBasisSummary.rows,
    authority_drift_field_summary: authorityDriftFieldSummary.rows,
  });
  const liveCaptureNextStepSummary = buildLiveCaptureNextStepSummary(
    agents,
    evidenceReadinessSummary,
    hookCaptureHealth,
    controlReadoutCompletenessSummary,
  );
  const feltThreatIntegrationSummary = buildFeltThreatIntegrationSummary(
    agents,
    controlReadoutCompletenessSummary,
    liveCaptureNextStepSummary,
    readIntegratorAcceptanceSummary,
    presenceFeltIsolationSummary,
    evidenceReadinessSummary,
  );
  const readoutCompletenessSummary = buildReadoutCompletenessSummary(agents, {
    status: status.rows,
    observation_summary: observationSummary.rows,
    decision_summary: decisionSummary.rows,
    evidence_scope_summary: evidenceScopeSummary,
    evidence_readiness_summary: evidenceReadinessSummary,
    presence_felt_isolation_summary: presenceFeltIsolationSummary,
    read_integrator_acceptance_summary: readIntegratorAcceptanceSummary,
    felt_threat_integration_summary: feltThreatIntegrationSummary,
    authority_risk_summary: authorityRiskSummary.rows,
    authority_transition_summary: authorityTransitionSummary.rows,
    authority_duration_bucket_summary: authorityDurationBucketSummary.rows,
    authority_severity_band_summary: authoritySeverityBandSummary.rows,
    authority_drift_class_summary: authorityDriftClassSummary.rows,
    authority_stability_summary: authorityStabilitySummary.rows,
    authority_drift_basis_summary: authorityDriftBasisSummary.rows,
    authority_drift_field_summary: authorityDriftFieldSummary.rows,
  });

  return jsonResult({
    status: status.rows,
    recent_outcomes: recent.rows,
    observation_summary: observationSummary.rows,
    recent_observations: recentObservations.rows,
    observation_schema: observationSchema,
    decision_schema: decisionSchema,
    evidence_scope_summary: evidenceScopeSummary,
    evidence_readiness_summary: evidenceReadinessSummary,
    hook_capture_config_summary: hookCaptureSummary,
    hook_capture_runtime_summary: hookCaptureRuntime,
    hook_capture_health_summary: hookCaptureHealth,
    readout_completeness_summary: readoutCompletenessSummary,
    live_capture_next_step_summary: liveCaptureNextStepSummary,
    read_integrator_acceptance_summary: readIntegratorAcceptanceSummary,
    felt_threat_integration_summary: feltThreatIntegrationSummary,
    decision_summary: decisionSummary.rows,
    authority_transition_summary: authorityTransitionSummary.rows,
    authority_duration_bucket_summary: authorityDurationBucketSummary.rows,
    authority_severity_band_summary: authoritySeverityBandSummary.rows,
    authority_drift_class_summary: authorityDriftClassSummary.rows,
    authority_risk_summary: authorityRiskSummary.rows,
    authority_stability_summary: authorityStabilitySummary.rows,
    authority_drift_basis_summary: authorityDriftBasisSummary.rows,
    authority_drift_field_summary: authorityDriftFieldSummary.rows,
    recent_decisions: recentDecisions.rows,
    active_state_stack: includeStateStack ? stateStack.slice(0, limit) : [],
    active_presence_stack: includePresenceStack ? presenceStack.slice(0, limit) : [],
    effective_gate_stack: includeEffectiveStack ? effectiveStack.slice(0, limit) : [],
    effective_gate_authority: effectiveGateAuthority(effectiveStack),
    presence_felt_isolation_summary: presenceFeltIsolationSummary,
    notes: calibrationNotes(status.rows as Array<{ agent: string; live_outcomes: string | number; calibration_state: string }>),
    observation_semantics: {
      purpose: 'Near-threshold sensory samples from felt-threat reads. They are not false-alarm/true-catch calibration outcomes.',
      schema_guard: 'If full_status_available is false, apply migrations/055 and /056 before relying on observation summary fields.',
      live_observations: 'Non-synthetic felt reads from ordinary hook flow.',
      synthetic_observations: 'Forced or proof-named samples used only to verify the sampler.',
      sample_count: 'Repeated same-session/action observations update one unresolved row instead of creating duplicate pressure rows.',
      safety_extinguished: 'A matching observed action later succeeded, so this sample should no longer add pressure.',
      failure_sensitized: 'A matching observed action later failed, so this sample may keep adding weak pressure.',
    },
    state_stack_semantics: {
      session_scoped: 'Authoritative state for a known session. It must not read or overwrite the Presence sticky slot.',
      legacy_sessionless: 'Compatibility state only for payloads without a session id; lower precedence than session-scoped state.',
      expired: `State older than ${ttlSeconds} seconds should be closed by the hook TTL path on next read.`,
    },
    presence_stack_semantics: {
      purpose: 'Read-only Presence sticky/session state observed beside felt-threat state so precedence is explicit.',
      active: 'Presence sticky states have higher precedence than felt-threat evaluation; felt-threat records presence_deferred instead of overriding them.',
      presence_fail_closed: 'Unreadable Presence state is treated as active by the hook and surfaced here as a fail-closed trace.',
    },
    effective_gate_stack_semantics: {
      purpose: 'Single ordered authority read across Presence and felt-threat state.',
      current_authority: 'The first entry is the state that should win if a mutating gate decision were made now.',
      effective_gate_authority: 'Compact summary of the current winning state, or active=false when no stack entry has authority.',
      order: 'presence_fail_closed, active Presence sticky/session state, session-scoped felt-threat state, legacy sessionless felt-threat state.',
    },
    presence_felt_isolation_semantics: {
      purpose: 'Compact proof surface that felt-threat sensing/hold state remains separate from the Presence sticky slot.',
      isolation_state: 'presence_fail_closed, presence_overrides_felt_threat, felt_threat_authoritative, or no_active_gate_state.',
      presence_blocks_felt_threat: 'True when active/unreadable Presence would defer felt-threat mutation instead of being overwritten.',
      felt_threat_can_gate_mutation: 'True only when felt-threat state is the current effective authority for that agent.',
      sensing_pass_presence_write: 'Always false: non-mutating sensing_pass traces never write Presence.',
      separation_policy: 'A scan-friendly restatement of the current architecture boundary.',
    },
    decision_trace_semantics: {
      purpose: 'Cortical trace of significant sensing and mutating felt-threat gate choices. This is passive audit data, not a second controller.',
      schema_guard: 'If full_status_available is false, apply migrations/057, /058, and /069 before relying on decision trace summary fields.',
      total_gate_traces: 'All passive felt-threat gate traces, including sensing_pass.',
      total_decisions: 'Only mutating/presence gate traces; sensing_pass is excluded so look-first regulation cannot inflate decision calibration counts.',
      live_gate_traces: 'All live passive gate traces, including sensing_pass.',
      live_decisions: 'Live mutating/presence decision traces only; sensing_pass live rows are counted separately as live_sensing_pass_decisions.',
      sensing_pass: 'A read/research/relay/feel action passed while felt state was active or near threshold; records look-first regulation without training false-alarm calibration.',
      mutating_pass: 'A mutating action passed below hold threshold; may also have created a near-threshold observation.',
      mutating_hold: 'A mutating action crossed the felt-threat hold threshold and created or updated a hold event.',
      presence_deferred: 'Existing Presence sticky/session state had precedence, so felt-threat did not evaluate/override it.',
      observation_key: 'Stable link from a sampled mutating_pass decision to the deduped observation row.',
      action_trace_key: 'Stable link from a gate decision to the pre-action eligibility trace when the brain-cycle hook created one first.',
      decision_outcome: 'Passive post-action resolution for the decision trace; it does not update false-alarm calibration.',
      cross_organ_score: 'Passive later RPE audit evidence for the decision trace; it does not change gate thresholds.',
      presence_state_trace: 'Read-only Presence sticky/session state seen by the gate; this records precedence without writing to Presence.',
      effective_gate_authority: 'Decision-time snapshot of the Presence/felt-threat state that had authority when this gate decision was recorded.',
      post_action_gate_authority: 'Post-action snapshot of the Presence/felt-threat state observed while resolving this decision trace.',
      authority_drift: 'Whether the winning authority changed between pre-decision and post-action resolution.',
      authority_transition_summary: 'Grouped pre-authority to post-authority transitions for resolved mutating/presence decision traces, split by live/synthetic evidence scope.',
      authority_drift_basis_summary: 'Grouped reasons for authority drift on mutating/presence decision traces, split by live/synthetic evidence scope.',
      authority_drift_field_summary: 'Grouped individual authority fields that changed between pre-decision and post-action snapshots for mutating/presence traces, split by live/synthetic evidence scope.',
      authority_drift_severity: 'Passive salience score for authority drift. Source/precedence changes weigh highest and this does not change gate behavior.',
      authority_severity_band_summary: 'Grouped authority drift severity bands split by evidence scope: low, moderate, high, critical.',
      authority_drift_class_summary: 'Grouped authority drift classes split by evidence scope: controller_switch, activation_change, identity_metadata_change, state_label_change, stance_only_change.',
      authority_risk_summary: 'Compact per-agent authority risk state derived from resolved mutating/presence decision traces. It emits separate live and synthetic rows, including zero-outcome rows, so missing authority evidence is explicit.',
      authority_stability_summary: 'Grouped stable, drift, and unknown authority outcomes for resolved mutating/presence traces with pre/post authority snapshots, split by live/synthetic evidence scope.',
      authority_observation_duration_ms: 'Elapsed milliseconds between decision trace creation and post-action authority snapshot.',
      authority_observation_duration_bucket: 'Scan-friendly bucket for authority observation duration: reflex, brief, sustained, or extended.',
      authority_duration_bucket_summary: 'Grouped authority observation duration buckets split by drift/stable mutating/presence traces and live/synthetic evidence scope.',
    },
    evidence_scope_semantics: {
      purpose: 'Compact grounding readout showing whether each felt-threat ledger is trained by live traffic or only synthetic/proof traffic.',
      evidence_scope: 'live means ordinary hook flow; synthetic means forced/proof/historical test rows.',
      ledgers: 'sensing_passes, outcomes, observations, decisions, and authority_traces are separate evidence channels and should not be collapsed into one confidence claim.',
      sensing_passes: 'Read/research/relay/feel traces captured while felt state was active or near threshold; evidence of look-first regulation, not calibration training.',
      authority_traces: 'Resolved mutating/presence decision traces with both pre-decision and post-action authority snapshots; sensing_pass traces are intentionally excluded from this calibration rung.',
    },
    evidence_readiness_semantics: {
      purpose: 'Derived epistemic verdict over evidence_scope_summary. It describes training/readiness evidence only and does not control the gate.',
      readiness_order: 'no_evidence < synthetic_only < live_sensing_grounded < live_outcome_grounded < live_observation_grounded < live_decision_grounded < live_authority_grounded.',
      needs_live_traffic: 'True means current felt-threat evidence is not yet grounded by ordinary hook traffic for that agent.',
      strongest_live_ledger: 'Highest-order live evidence channel currently present: sensing_passes, outcomes, observations, decisions, or authority_traces.',
      missing_live_ledgers: 'Live evidence channels with zero ordinary hook rows for this agent.',
      next_live_evidence_needed: 'Read-only recommendation for the next live evidence channel to collect; it is not a gate action.',
      calibration_claim_ceiling: 'Maximum calibration claim supported by the observed evidence. Synthetic-only evidence is capped at schema_verified_only.',
      evidence_collection_state: 'Scan-friendly live capture state. proof_only_no_live_capture means proof rows exist but no ordinary hook traffic has reached the ledger.',
      readiness_note: 'Short scan-friendly explanation of the current evidence posture.',
    },
    hook_capture_config_semantics: {
      purpose: 'Read-only check of local hook configuration coverage for felt-threat and brain-cycle pre/post capture.',
      capture_config_state: 'felt_capture_configured means configured matchers cover expected local tool names; it does not prove the current runtime has reloaded hooks or captured live rows.',
      expected_tool_names: 'Tool names this agent should capture for ordinary local mutation/read integration.',
      coverage: 'Coverage is computed from matcher regexes in the local hook config for hook-felt-threat-gate.py and hook-brain-cycle-log.py.',
    },
    hook_capture_runtime_semantics: {
      purpose: 'Read-only check of recent felt-threat hook log activity beside live/synthetic ledger evidence.',
      capture_runtime_state: 'live_capture_observed means ordinary live rows exist; stale_hook_log_no_live_rows means only older hook logs were seen and the ledger still has zero live rows.',
      freshness_window_seconds: 'The explicit age threshold used to classify a hook log as fresh versus stale.',
      runtime_freshness_state: 'fresh_log and stale_log describe hook-log recency only; they do not by themselves prove felt-threat ledger evidence.',
      latest_log_fresh: 'Boolean form of the same freshness threshold; null means no parseable hook log was found.',
      latest_log_age_seconds: 'Approximate age of the newest parsed felt-threat hook log row from the local state directory.',
      caveat: 'Runtime logs are evidence of hook execution, not proof that the current Codex process has reloaded hook configuration.',
    },
    hook_capture_health_semantics: {
      purpose: 'Combined read-only verdict over hook config coverage, hook-log freshness, and live evidence readiness.',
      capture_health_state: 'capture_live means ordinary live rows exist. configured_runtime_stale means matchers cover expected tools, but runtime hook logs are stale and live rows are still absent.',
      next_capture_action: 'Operational next proof needed for live felt-threat capture; it is not a gate action.',
      health_note: 'Short scan-friendly explanation of the combined capture posture.',
    },
    readout_completeness_semantics: {
      purpose: 'Meta-readout showing whether core felt-threat status sections emitted their expected zero-filled rows for each agent.',
      zero_filled_core_sections: 'Sections where no data should still return an explicit zero row so absence is visible.',
      sparse_detail_sections: 'Detail summaries that intentionally remain empty unless matching authority drift/transition events exist.',
      readout_completeness_state: 'core_readouts_present means missing sparse detail arrays are not evidence of read failure.',
    },
    live_capture_next_step_semantics: {
      purpose: 'Single scan-friendly control readout combining status completeness, hook capture health, and evidence readiness.',
      live_capture_readiness_state: 'repair_status_readouts, repair_hook_capture_config, reload_or_exercise_hook_runtime, collect_live_felt_threat_traffic, or live_capture_observed.',
      runtime_freshness_window_seconds: 'The explicit threshold used by hook_capture_runtime_summary and hook_capture_health_summary when deciding whether hook-log evidence is fresh.',
      safe_runtime_exercise: 'Read-only probe payload for checking whether the runtime has reloaded hooks. A fresh hook log is runtime evidence; a felt-threat ledger row still requires ordinary live felt pressure.',
      next_step_summary: 'Operational next step for live capture proof; it does not mutate gate state or Presence.',
      calibration_claim_ceiling: 'Repeated here from evidence readiness so the next-step readout cannot overclaim live training.',
    },
    read_integrator_acceptance_semantics: {
      purpose: 'Dedicated readout for the non-mutating read/research/relay/feel sensing path before any stronger live calibration claim.',
      read_integrator_state: 'blocked_status_readout, blocked_hook_config, blocked_runtime_freshness, ready_for_live_sensing_pass, live_sensing_pass_observed, higher_live_evidence_observed, or not_current_next_evidence.',
      blocking_conditions: 'Explicit upstream blockers for accepting live read-integrator sensing evidence: status_readout, hook_config, runtime_freshness, or readiness_ladder_not_requesting_sensing.',
      upstream_calibration_claim_ceiling: 'Repeated from evidence readiness so this readout cannot imply stronger calibration than the evidence ladder allows.',
      next_read_integrator_action: 'Operational next action for the read-integrator seam, derived from blocker precedence and evidence readiness.',
      next_read_integrator_probe: 'Read-only runtime probe when blocked on runtime freshness; null when the next step is not a runtime freshness probe.',
      expected_read_integrator_effect: 'What the next action should prove without implying Presence mutation or stronger calibration than the claim ceiling allows.',
      mutation_required_for_live_sensing: 'False by design: live sensing_pass evidence can come from ordinary non-mutating read/research/relay/feel actions when felt pressure is active or near threshold.',
      presence_write_policy: 'sensing_pass rows never write Presence; they remain in the separate felt-threat gate decision ledger.',
      accepted_live_source: 'Non-synthetic sensing_pass rows only; synthetic forcing and proof-named sessions do not raise the live claim ceiling.',
    },
    felt_threat_integration_semantics: {
      purpose: 'Top-level control verdict over readout health, Presence/felt isolation, live-capture readiness, read-integrator acceptance, and evidence claim ceiling.',
      integration_state: 'blocked_core_readouts, presence_fail_closed, presence_authority_active, hook_config_required, runtime_freshness_required, ready_for_live_sensing, sensing_grounded_collect_outcome, live_capture_integrating, or collect_live_felt_threat_traffic.',
      source_readouts: 'Status sections that feed the top-level verdict so the decision can be traced back to concrete rows.',
      integration_blockers: 'Explicit blockers that forced the selected integration_state; empty means the row is in a collect/continue posture.',
      integration_decision_path: 'Ordered boundary checks used to select the verdict, including the source readout, observed state, and whether that boundary currently blocks integration.',
      first_blocking_step: 'Fast-path pointer to the first boundary in integration_decision_path that currently blocks integration, or null when none block.',
      next_safe_action: 'Single next operational move chosen by conservative blocker precedence.',
      next_safe_probe: 'Agent-specific read-only probe when runtime freshness is the current bottleneck; null when no probe is appropriate.',
      next_safe_probe_success_condition: 'Expected status-surface change after the read-only runtime probe succeeds; this proves hook recency only, not live felt-threat calibration.',
      next_safe_probe_failure_condition: 'Expected status-surface evidence when the read-only runtime probe fails or hooks remain stale.',
      next_safe_probe_transition: 'Explicit transition boundaries for the read-only runtime probe: what success unblocks, what it does not create, and what failure leaves blocked.',
      post_probe_recheck_sections: 'Status sections to re-read immediately after running next_safe_probe.',
      runtime_probe_interpretation_state: 'not_applicable, probe_needed_or_failed, probe_succeeded_no_live_sensing_yet, probe_succeeded_live_sensing_observed, or probe_succeeded_higher_live_evidence_observed.',
      runtime_probe_evidence_fields: 'The hook/runtime and live-ledger fields used to interpret the runtime probe result without promoting it into live calibration or Presence state.',
      felt_threat_mutation_gate_state: 'Whether mutation gating is blocked, deferred to Presence, inactive because only sensing is present, or active in a separate felt-threat gate.',
      felt_threat_mutation_gate_allowed: 'True only when a separate felt-threat gate has authority and Presence is not blocking it.',
      felt_threat_mutation_gate_blockers: 'Explicit reasons mutation gating is not currently allowed.',
      felt_threat_mutation_gate_denial_reason: 'Single selected reason mutation gating is false, including no separate felt-threat gate when nothing is blocking but sensing alone is not authority.',
      felt_threat_mutation_gate_source: 'The readout that authoritatively separates Presence state from felt-threat mutation gate state.',
      felt_threat_mutation_gate_precedence_path: 'Ordered stack showing how core readout health, Presence fail-closed, Presence authority, separate felt-threat gate state, runtime freshness, and read-integrator sensing affect mutation-gate authority.',
      first_mutation_gate_blocking_step: 'Fast-path pointer to the first mutation-gate precedence boundary that currently blocks mutation authority, or null when none block.',
      felt_threat_operation_mode: 'Current safe operation class: repair-only, Presence-deferred, read-only runtime probe, non-mutating sensing, separate felt mutation gate, outcome collection, or evidence-ladder continuation.',
      allowed_current_operations: 'Concrete operation labels currently allowed by the integration and mutation-gate verdict.',
      blocked_current_operations: 'Concrete operation labels blocked by the current evidence, Presence, runtime, and mutation-gate boundaries.',
      operation_policy_note: 'Human-readable explanation of the current operation policy without granting Presence overwrite.',
      current_operation_probe: 'Agent-specific read-only probe payload when the current allowed operation requires one; otherwise null.',
      current_operation_expected_effect: 'What the currently allowed operation should prove or collect without overstating authority.',
      current_operation_safety_note: 'Boundary reminder for the current operation, especially no Presence sticky writes or synthetic live-claim forcing.',
      current_operation_success_condition: 'Concrete readout or evidence condition that means the current operation succeeded.',
      current_operation_failure_condition: 'Concrete readout or evidence condition that means the current operation did not advance the mode.',
      current_operation_postcheck_sections: 'Status sections to re-read after the current operation before changing claims or mode.',
      current_operation_claim_effect: 'How the current operation may or may not affect the calibration claim ceiling after postcheck.',
      current_operation_claim_ceiling_after_success: 'Claim ceiling expected after success, always conditional on the postcheck evidence-readiness result.',
      current_operation_claim_safety_note: 'Reminder that operation success alone does not raise claims without a fresh status read.',
      current_operation_blocked_claims_until_postcheck: 'Claims that remain blocked until current_operation_postcheck_sections prove the evidence boundary.',
      next_operation_unlock_condition: 'Concrete evidence or readout change that should unlock the next operation mode.',
      next_operation_expected_mode: 'Expected operation mode after the unlock condition is satisfied and the status surface is re-read.',
      next_operation_recheck_sections: 'Status sections to re-read after satisfying the next operation unlock condition.',
      presence_sticky_overwrite_allowed: 'Always false: the integration verdict must never authorize overwriting Presence sticky state.',
      calibration_claim_ceiling: 'Repeated from evidence readiness so the top-level verdict cannot overclaim training.',
      allowed_current_claims: 'Concrete claim labels currently allowed by the calibration claim ceiling.',
      blocked_current_claims: 'Concrete stronger claims that remain blocked until higher live evidence exists.',
    },
    semantics: {
      no_evidence: 'No felt-threat outcome evidence exists for this filtered agent; zero-filled summaries are absence-as-data, not a read failure.',
      synthetic_only: 'Hook/proof rows exist, but live calibration is still untrained.',
      live_pending: 'A live hold exists without a closed outcome.',
      live_immediate_only: 'Live holds have direct action outcomes, but no later RPE/gut feedback scan yet.',
      live_cross_calibrated: 'Live holds have later cross-organ feedback.',
    },
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_felt_threat_status',
      description:
        'Read felt-threat outcome calibration status, separating synthetic proof rows from live calibration and showing recent ledger evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          include_recent: { type: 'boolean' },
          include_state_stack: { type: 'boolean' },
          include_presence_stack: { type: 'boolean' },
          include_effective_stack: { type: 'boolean' },
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => feltThreatStatus(args as FeltThreatStatusArgs),
  },
];

export default tools;
