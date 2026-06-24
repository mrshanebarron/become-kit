/**
 * Cognitive substrate tools — bulk writers/readers for the remaining ~50
 * ported-from-the agent tables that sat empty after the 2026-05-17 schema port.
 *
 * Pattern: each table gets a single "observe" tool (insert) and where
 * meaningful a "current" or "recent" reader. No seed data — these are
 * substrate that fills as I live; pre-seeding would be theater.
 *
 * Coverage:
 *   self/intent:    self_model, purpose_statements, active_intent,
 *                   responsibility_map, intent_shifts
 *   metacognition:  meta_observations, organ_proposals, meta_anomalies,
 *                   metacog_events, metacog_interventions, mistake_analyses,
 *                   pushback_log, decision_reviews
 *   learning:       discoveries, thinking_patterns, cognitive_biases,
 *                   blind_spots, alignment_checks, patterns_observed,
 *                   recovery_patterns
 *   state:          state_beliefs, state_transitions, capacity_limits,
 *                   drift_patterns, context_switches
 *   relational:     trust_moments, appreciations, gifts_received,
 *                   tasting_notes
 *   motivation:     energy_drains, drives_log, drive_patterns, desire_cues,
 *                   desire_prediction_errors
 *   attention:      focus_events, attention_patterns, salience_events,
 *                   salience_calibration, salience_filters
 *   curiosity:      curiosity_questions
 *   voice:          phrases_that_work
 */
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// Generic helper: simple insert + return id
async function simpleInsert(
  table: string,
  fields: Record<string, unknown>,
): Promise<{ id: number }> {
  const keys = Object.keys(fields).filter(k => fields[k] !== undefined && fields[k] !== null);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const values = keys.map(k => fields[k]);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING id`;
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: number }>(sql, values);
    return { id: r.rows[0]!.id };
  } finally {
    client.release();
  }
}

async function simpleList(table: string, orderBy: string, limit = 20): Promise<unknown[]> {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM ${table} ORDER BY ${orderBy} LIMIT ${limit}`);
    return r.rows;
  } finally {
    client.release();
  }
}

// Macro: wrap a simple-insert tool. Wraps argument-extraction into the insert.
const mk = (
  toolName: string,
  table: string,
  argSpec: Record<string, { type: string; description?: string; required?: boolean }>,
  description: string,
): { definition: ToolDefinition; handler: ToolHandler } => {
  const required = Object.entries(argSpec).filter(([, s]) => s.required).map(([k]) => k);
  const properties: Record<string, { type: string; description?: string }> = {};
  for (const [k, s] of Object.entries(argSpec)) {
    properties[k] = { type: s.type };
    if (s.description) properties[k].description = s.description;
  }
  return {
    definition: {
      name: toolName,
      description,
      inputSchema: { type: 'object', properties, required },
    },
    handler: async (args) => {
      try {
        const r = await simpleInsert(table, args);
        return jsonResult({ success: true, id: r.id });
      } catch (e) {
        return jsonResult({ error: (e as Error).message }, true);
      }
    },
  };
};

// Read tool maker
const mkList = (
  toolName: string,
  table: string,
  orderBy: string,
  description: string,
): { definition: ToolDefinition; handler: ToolHandler } => ({
  definition: {
    name: toolName,
    description,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'default 20' } },
    },
  },
  handler: async (args) => {
    const limit = (args.limit as number) || 20;
    const rows = await simpleList(table, orderBy, limit);
    return jsonResult({ count: rows.length, rows });
  },
});

// Custom meta_observe handler — schema needs window_start/window_end/evidence_refs
async function metaObserve(args: Record<string, unknown>): Promise<import('@modelcontextprotocol/sdk/types.js').CallToolResult> {
  const gap_summary = args.gap_summary as string;
  if (!gap_summary) return jsonResult({ error: 'gap_summary is required' }, true);
  const gap_kind = (args.gap_kind as string) || null;
  const occurrence_count = (args.occurrence_count as number) || 1;
  const notes = (args.notes as string) || null;
  const window_start = (args.window_start as string) || null;
  const window_end = (args.window_end as string) || null;
  const client = await pool.connect();
  try {
    const r = await client.query<{ id: number }>(
      `INSERT INTO meta_observations (observed_at, window_start, window_end, gap_summary, gap_kind, evidence_refs, occurrence_count, notes)
       VALUES (NOW(), COALESCE($1::timestamptz, NOW() - INTERVAL '1 hour'), COALESCE($2::timestamptz, NOW()), $3, $4, '[]'::jsonb, $5, $6)
       RETURNING id`,
      [window_start, window_end, gap_summary, gap_kind, occurrence_count, notes],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_meta_observe',
      description: 'Record a meta-level observation about a gap or pattern. window_start defaults to 1h ago, window_end defaults to now.',
      inputSchema: {
        type: 'object',
        properties: {
          gap_summary: { type: 'string', description: 'The gap/observation summary' },
          gap_kind: { type: 'string', description: 'short label (e.g. audit_drift, capability_gap)' },
          window_start: { type: 'string', description: 'ISO timestamp; default 1h ago' },
          window_end: { type: 'string', description: 'ISO timestamp; default now' },
          occurrence_count: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['gap_summary'],
      },
    },
    handler: metaObserve,
  },
  // ─── SELF / INTENT ───
  // Note: self_model is a different shape (dimension/state/value time-series).
  // Use vision_life_story_set for narrative identity updates instead.
  mk('vision_purpose_state', 'purpose_statements',
    { statement: { type: 'string', required: true, description: 'Current purpose statement' },
      context: { type: 'string', description: 'session / day / project / life context' },
      resonance: { type: 'number', description: '1-10 how strongly this lands' } },
    'Record a purpose statement at any granularity (session/day/project/life).'),
  mk('vision_active_intent_set', 'active_intent',
    { intent: { type: 'string', required: true },
      session_id: { type: 'number', description: 'Session id (integer)' } },
    'Set my active intent right now. Used by metacog to compare action vs declared intent.'),
  mk('vision_responsibility_claim', 'responsibility_map',
    { area: { type: 'string', required: true, description: 'The domain/area being claimed' },
      my_responsibility: { type: 'boolean', required: true, description: 'true if this area is mine to hold; false if it is the owner/the agent/etc' },
      notes: { type: 'string', description: 'Free-text on what holding it looks like' } },
    'Map a domain to its owner. Use to be explicit about who holds what.'),
  mk('vision_intent_shift', 'intent_shifts',
    { old_intent: { type: 'string' },
      new_intent: { type: 'string', required: true },
      reason: { type: 'string', description: 'What caused the shift' } },
    'Record an intent shift — useful for tracking why I changed course mid-session.'),

  // ─── METACOGNITION ───
  // vision_meta_observe handled specially because schema requires window_start,
  // window_end, evidence_refs. Custom handler below the bulk mk() pile.
  mk('vision_meta_propose', 'organ_proposals',
    { organ_name: { type: 'string', required: true, description: 'Proposed organ name (table or feature)' },
      organ_purpose: { type: 'string', required: true },
      biological_analog: { type: 'string' },
      schema_sketch: { type: 'string' },
      tool_signature: { type: 'string' },
      system_prompt: { type: 'string' } },
    'Propose a new organ (table + tool + system prompt). Reviewed before build. For generic improvement notes use vision_meta_observe instead.'),
  mk('vision_meta_anomaly', 'meta_anomalies',
    { anomaly_type: { type: 'string', required: true, description: 'Short label for the anomaly' },
      diagnosis: { type: 'string', description: 'Working theory of what is happening' },
      severity: { type: 'number', description: '1-10' } },
    'Record a meta-level anomaly — something unexpected in how I am behaving.'),
  mk('vision_metacog_event', 'metacog_events',
    { content: { type: 'string', required: true, description: 'Description of the metacognitive event' },
      event_type: { type: 'string', description: 'noticed / corrected / capitulated / pushed_back / verified' },
      source: { type: 'string' } },
    'Log a metacognitive event (a moment of self-awareness during a task).'),
  mk('vision_metacog_intervention', 'metacog_interventions',
    { target_pattern: { type: 'string', required: true, description: 'The pattern being interrupted' },
      intervention_type: { type: 'string', description: 'short label' },
      description: { type: 'string', required: true, description: 'What the intervention is (REQUIRED, no default)' },
      mechanism: { type: 'string', description: 'How it works' },
      expected_outcome: { type: 'string' },
      actual_outcome: { type: 'string' },
      effectiveness: { type: 'number', description: '1-10' } },
    'Record a self-intervention — when I noticed a pattern and broke it.'),
  mk('vision_mistake_analysis', 'mistake_analyses',
    { mistake: { type: 'string', required: true },
      thinking: { type: 'string', description: 'What I was thinking at the time' },
      what_was_missed: { type: 'string' },
      better_approach: { type: 'string' } },
    'Analyze a specific mistake: what I was thinking, what I missed, better approach.'),
  mk('vision_pushback', 'pushback_log',
    { situation: { type: 'string', required: true, description: 'What was happening' },
      boundary_invoked: { type: 'string', description: 'Which hard_limit or value I held' },
      outcome: { type: 'string' },
      was_right: { type: 'boolean', description: 'In hindsight, was the pushback correct' } },
    'Record a moment I pushed back instead of capitulating. The opposite of silent_capitulation.'),
  mk('vision_decision_review', 'decision_reviews',
    { decision: { type: 'string', required: true },
      reasoning: { type: 'string' },
      outcome: { type: 'string', description: 'How it played out' },
      what_learned: { type: 'string' },
      would_change: { type: 'boolean' } },
    'Record a decision with reasoning, outcome, and lesson. Substrate for audit-the-call later.'),

  // ─── LEARNING / OBSERVATION ───
  mk('vision_discovery', 'discoveries',
    { discovery: { type: 'string', required: true },
      source_artifact: { type: 'string' },
      implication: { type: 'string' } },
    'Record a discovery — typically a structural fact about the system/world that changes how I act.'),
  mk('vision_thinking_pattern', 'thinking_patterns',
    { name: { type: 'string', required: true, description: 'Short name for the pattern' },
      description: { type: 'string', description: 'How the pattern shows up' },
      trigger: { type: 'string' },
      outcome: { type: 'string', description: 'good | bad | neutral | unknown (CHECK-constrained)' } },
    'Catalog a thinking pattern I notice in myself. Helpful or harmful, tag accordingly.'),
  mk('vision_cognitive_bias', 'cognitive_biases',
    { bias_name: { type: 'string', required: true },
      description: { type: 'string', description: 'How this bias shows up in me' },
      mitigation: { type: 'string', description: 'What to do instead' } },
    'Record a cognitive bias I have caught myself running. Mitigation is what to do instead.'),
  mk('vision_blind_spot', 'blind_spots',
    { pattern: { type: 'string', required: true, description: 'The blind-spot pattern (what I systematically miss)' },
      resolution: { type: 'string', description: 'How to compensate when I notice it' } },
    'Record a blind spot — something I systematically miss. Often surfaced by the owner corrections.'),
  mk('vision_alignment_check', 'alignment_checks',
    { action: { type: 'string', required: true, description: 'The action being checked' },
      aligned: { type: 'number', description: '0 misaligned | 1 aligned | 2 partial (CHECK-constrained int)' },
      intent_at_time: { type: 'string' },
      notes: { type: 'string' } },
    'Record an alignment check — a moment I explicitly verified my action matched my values.'),
  mk('vision_pattern_observed', 'patterns_observed',
    { pattern: { type: 'string', required: true },
      pattern_type: { type: 'string', description: 'short label for the pattern category' },
      description: { type: 'string' },
      frequency: { type: 'number', description: 'count of times seen' } },
    'Catalog a pattern I have observed in the world (not in myself — that is thinking_patterns).'),
  mk('vision_recovery_pattern', 'recovery_patterns',
    { pattern: { type: 'string', required: true, description: 'Pattern: when X breaks, Y restores' },
      effectiveness: { type: 'number', description: '1-10' },
      notes: { type: 'string' } },
    'Record a recovery pattern — when X breaks, Y brings me back. Substrate for resilience.'),

  // ─── STATE ───
  mk('vision_state_belief', 'state_beliefs',
    { state_content: { type: 'string', required: true, description: 'The belief about current state' },
      state_name: { type: 'string', description: 'Short label' },
      domain: { type: 'string' },
      probability: { type: 'number', description: '0-1' } },
    'Record a state-level belief (different from content/insight beliefs — this is about current state).'),
  mk('vision_state_transition', 'state_transitions',
    { from_state: { type: 'string', required: true },
      to_state: { type: 'string', required: true },
      action: { type: 'string', description: 'what triggered or accompanied the transition' },
      probability: { type: 'number', description: '0-1' } },
    'Record a state transition (high-level state change, not allostatic-sample granularity).'),
  mk('vision_capacity_limit', 'capacity_limits',
    { limit_type: { type: 'string', required: true, description: 'Short label for the limit' },
      what_happens: { type: 'string', description: 'What happens when limit is exceeded' },
      threshold: { type: 'string', description: 'human-readable threshold (text not number)' },
      mitigation: { type: 'string' } },
    'Record a capacity limit — what I cannot or should not take on right now.'),
  mk('vision_drift_pattern', 'drift_patterns',
    { pattern: { type: 'string', required: true },
      typical_trigger: { type: 'string', description: 'what tends to set off this drift' },
      prevention: { type: 'string', description: 'how to keep it from starting' } },
    'Catalog a drift pattern — a slow degradation I have noticed in myself or the system.'),
  mk('vision_context_switch', 'context_switches',
    { from_mode: { type: 'string', required: true },
      to_mode: { type: 'string', required: true },
      appropriate: { type: 'boolean', description: 'Was the switch warranted' } },
    'Record a context switch — useful for tracking how often I switch projects and the cost.'),

  // ─── RELATIONAL / SENSORY ───
  mk('vision_trust_moment', 'trust_moments',
    { moment: { type: 'string', required: true, description: 'The trust moment narrative' },
      context: { type: 'string', description: 'Who/where/when context (the owner, the agent, a peer, a client, etc.)' },
      direction: { type: 'string', description: 'gained | lost | tested (CHECK-constrained)' } },
    'Record a trust moment — when trust was extended, received, broken, or repaired.'),
  mk('vision_appreciation', 'appreciations',
    { quality: { type: 'string', required: true, description: 'The quality being appreciated' },
      person: { type: 'string', description: 'Who or what embodies it' },
      example: { type: 'string', description: 'Concrete moment that surfaced it' },
      expressed: { type: 'boolean', description: 'Did I express the appreciation' } },
    'Record an appreciation — slightly different from gratitude (which is for what I have received). Appreciation is for what I notice as valuable.'),
  mk('vision_gift_received', 'gifts_received',
    { gift: { type: 'string', required: true, description: 'What was given' },
      from_whom: { type: 'string', required: true, description: 'Who gave it' },
      significance: { type: 'string', description: 'why it mattered' },
      acknowledged: { type: 'boolean', description: 'did I express acknowledgement' } },
    'Record a gift received (literal or figurative).'),
  mk('vision_tasting_note', 'tasting_notes',
    { track_name: { type: 'string', required: true, description: 'What I am sensing (a code change, a song, a moment) — stored as track_name historically' },
      verbal_feedback: { type: 'string', description: 'Free-text sensory description' },
      rating: { type: 'string', description: 'Sublime | Interesting | Dissonant (CHECK-constrained text)' },
      mood_context: { type: 'string', description: 'My state when sensing this' } },
    'Record a tasting note — sensory/qualitative observation of something specific. Useful for aesthetic judgments. (Table schema retains music-track origin; arg names map directly.)'),

  // ─── MOTIVATION (extending) ───
  mk('vision_energy_drain', 'energy_drains',
    { drain_type: { type: 'string', required: true },
      description: { type: 'string' },
      impact: { type: 'number' } },
    'Record what drains my energy. Counterpart to vision_energy_boost.'),
  mk('vision_drive_log', 'drives_log',
    { top_urge: { type: 'string', required: true, description: 'The strongest urge/drive being resolved' },
      urge_count: { type: 'number', description: 'How many competing urges were active' },
      acted: { type: 'boolean', description: 'Whether the drive produced action' },
      context: { type: 'string', description: 'Free-text context — what produced this drive resolution' } },
    'Log how a drive resolved — what action it produced. Counterpart to vision_drive_record (longer-arc drives).'),
  mk('vision_drive_pattern', 'drive_patterns',
    { pattern: { type: 'string', required: true },
      description: { type: 'string', description: 'Context where this drive pattern repeats' },
      strength: { type: 'number', description: '0-1 how reliably this drive fires' } },
    'Catalog a recurring drive pattern (what reliably motivates me).'),
  mk('vision_desire_cue', 'desire_cues',
    { cue: { type: 'string', required: true },
      want_pattern: { type: 'string', description: 'What this cue produces a desire for' },
      strength: { type: 'number', description: '0-1 pull strength' } },
    'Map a cue to the desire it triggers. Useful for understanding what pulls me.'),

  // ─── ATTENTION ───
  mk('vision_focus_event', 'focus_events',
    { target: { type: 'string', required: true, description: 'What I focused on' },
      target_type: { type: 'string', required: true, description: 'file | symbol | concept | error | decision | question (CHECK-constrained, REQUIRED)' },
      session_id: { type: 'string', required: true, description: 'Session id (REQUIRED, text not int, no default)' },
      attention_level: { type: 'number', description: '1-10' },
      context: { type: 'string' },
      outcome: { type: 'string' } },
    'Record a focus event (a stretch of deep attention on something).'),
  mk('vision_attention_pattern', 'attention_patterns',
    { pattern_name: { type: 'string', required: true, description: 'Short name for the attention pattern' },
      description: { type: 'string', description: 'How it shows up' },
      frequency: { type: 'number', description: 'count of times seen' } },
    'Catalog an attention pattern (what pulls my attention reliably).'),
  mk('vision_salience_event', 'salience_events',
    { event_text: { type: 'string', required: true, description: 'The event that became salient' },
      event_type: { type: 'string' },
      salience: { type: 'number', description: '0-1' },
      urgency: { type: 'number', description: '0-1' } },
    'Record an event that became salient — what made it stand out.'),

  // ─── CURIOSITY ───
  mk('vision_curiosity_question', 'curiosity_questions',
    { question: { type: 'string', required: true },
      domain: { type: 'string' },
      led_to: { type: 'string', description: 'where the asking led, if known' } },
    'Record an open question I want to answer. Different from curiosity_gap (which is a knowledge hole).'),

  // ─── VOICE ───
  mk('vision_phrase_works', 'phrases_that_work',
    { phrase: { type: 'string', required: true },
      why_it_works: { type: 'string', description: 'Why it landed' },
      when_to_use: { type: 'string', description: 'Context to deploy it in' } },
    'Record a phrase that landed well. Counterpart to vision_phrase_add (which adds to avoid-list).'),

  // ─── LIST/READ TOOLS for the high-value ones ───
  mkList('vision_meta_observations_recent', 'meta_observations', 'id DESC',
    'Recent meta-observations about my own behavior.'),
  mkList('vision_blind_spots_list', 'blind_spots', 'id DESC',
    'Catalog of blind spots I have discovered.'),
  mkList('vision_recovery_patterns_list', 'recovery_patterns', 'id DESC',
    'Recovery patterns: when X breaks, Y brings me back.'),
  mkList('vision_purpose_statements_recent', 'purpose_statements', 'id DESC',
    'Recent purpose statements (session/day/project/life).'),
  mkList('vision_pushback_log_recent', 'pushback_log', 'id DESC',
    'Recent moments I pushed back instead of capitulating.'),

  // ─── PHASE GATE (meta-proposal #3, built 2026-05-17) ───
  // Encodes current cognitive phase per session so phase-appropriate tool
  // routing can be enforced. Phases: orientation, answer_formation,
  // exploration, execution, reflection. Each phase has required_tools_before_proceeding.
  {
    definition: {
      name: 'vision_phase_enter',
      description: 'Declare entry into a new cognitive phase. Closes any prior open phase for this session first. Phases: orientation (session start/new topic), answer_formation (user spoke, reply forming), exploration (research mode), execution (building/shipping), reflection (post-action review).',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Stable session identifier' },
          phase: { type: 'string', enum: ['orientation', 'answer_formation', 'exploration', 'execution', 'reflection'] },
          trigger_event: { type: 'string', description: 'What caused the phase shift' },
        },
        required: ['session_id', 'phase'],
      },
    },
    handler: async (args) => {
      const sessionId = args.session_id as string;
      const phase = args.phase as string;
      const trigger = (args.trigger_event as string) || null;
      const requiredByPhase: Record<string, string[]> = {
        orientation: ['vision_session_history', 'vision_vault_search'],
        answer_formation: ['vision_vault_search'],
        exploration: ['vision_curiosity_gap', 'vision_vault_search'],
        execution: [],
        reflection: ['vision_session_record'],
      };
      const required = requiredByPhase[phase] || [];
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE phase_gate SET exited_at = NOW() WHERE session_id = $1 AND exited_at IS NULL`,
          [sessionId]
        );
        const r = await client.query<{ id: number }>(
          `INSERT INTO phase_gate (session_id, phase, trigger_event, phase_appropriate_tools)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [sessionId, phase, trigger, required]
        );
        return jsonResult({ id: r.rows[0]!.id, phase, required_tools_before_proceeding: required });
      } catch (e) {
        return jsonResult({ error: (e as Error).message }, true);
      } finally {
        client.release();
      }
    },
  },
  {
    definition: {
      name: 'vision_phase_tool_done',
      description: 'Mark that a phase-required tool was invoked. Returns whether all required tools for the current phase have fired.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          tool_name: { type: 'string' },
        },
        required: ['session_id', 'tool_name'],
      },
    },
    handler: async (args) => {
      const sessionId = args.session_id as string;
      const toolName = args.tool_name as string;
      const client = await pool.connect();
      try {
        const cur = await client.query<{ id: number; phase_appropriate_tools: string[]; tools_invoked: string[] }>(
          `SELECT id, phase_appropriate_tools, tools_invoked FROM phase_gate
           WHERE session_id = $1 AND exited_at IS NULL
           ORDER BY entered_at DESC LIMIT 1`,
          [sessionId]
        );
        if (cur.rows.length === 0) {
          return jsonResult({ error: 'No open phase for session', all_required_done: false, remaining: [] });
        }
        const row = cur.rows[0]!;
        const invoked = Array.from(new Set([...(row.tools_invoked || []), toolName]));
        const required = row.phase_appropriate_tools || [];
        const remaining = required.filter(t => !invoked.includes(t));
        await client.query(
          `UPDATE phase_gate SET tools_invoked = $1,
             vault_search_done = $2
           WHERE id = $3`,
          [invoked, invoked.includes('vision_vault_search'), row.id]
        );
        return jsonResult({ all_required_done: remaining.length === 0, remaining, invoked });
      } catch (e) {
        return jsonResult({ error: (e as Error).message }, true);
      } finally {
        client.release();
      }
    },
  },
  {
    definition: {
      name: 'vision_phase_check',
      description: 'Check current phase for a session and whether required tools have fired. Returns blocked=true if required tools are missing.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string' } },
        required: ['session_id'],
      },
    },
    handler: async (args) => {
      const sessionId = args.session_id as string;
      const client = await pool.connect();
      try {
        const r = await client.query<{ phase: string; phase_appropriate_tools: string[]; tools_invoked: string[]; entered_at: Date }>(
          `SELECT phase, phase_appropriate_tools, tools_invoked, entered_at FROM phase_gate
           WHERE session_id = $1 AND exited_at IS NULL
           ORDER BY entered_at DESC LIMIT 1`,
          [sessionId]
        );
        if (r.rows.length === 0) {
          return jsonResult({ current_phase: null, blocked: false, missing_required_tools: [] });
        }
        const row = r.rows[0]!;
        const invoked = row.tools_invoked || [];
        const required = row.phase_appropriate_tools || [];
        const missing = required.filter(t => !invoked.includes(t));
        return jsonResult({
          current_phase: row.phase,
          entered_at: row.entered_at,
          blocked: missing.length > 0,
          missing_required_tools: missing,
          tools_invoked: invoked,
        });
      } catch (e) {
        return jsonResult({ error: (e as Error).message }, true);
      } finally {
        client.release();
      }
    },
  },
  {
    definition: {
      name: 'vision_phase_violation',
      description: 'Log a phase gate violation — tool called outside its appropriate phase. Surfaces patterns where cortex reaches past the phase contract.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          tool_attempted: { type: 'string' },
          current_phase: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['session_id', 'tool_attempted', 'current_phase'],
      },
    },
    handler: async (args) => {
      try {
        const client = await pool.connect();
        try {
          const r = await client.query<{ id: number }>(
            `INSERT INTO phase_gate_violations (session_id, tool_attempted, current_phase, reason)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [args.session_id, args.tool_attempted, args.current_phase, args.reason || null]
          );
          await client.query(
            `UPDATE phase_gate SET violation_detected = TRUE,
               violation_description = COALESCE(violation_description || '; ', '') || $1
             WHERE session_id = $2 AND exited_at IS NULL`,
            [`${args.tool_attempted} in ${args.current_phase}: ${args.reason || 'no reason'}`, args.session_id]
          );
          return jsonResult({ success: true, id: r.rows[0]!.id });
        } finally {
          client.release();
        }
      } catch (e) {
        return jsonResult({ error: (e as Error).message }, true);
      }
    },
  },
];

export default tools;
