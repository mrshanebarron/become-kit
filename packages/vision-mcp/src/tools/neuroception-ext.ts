/**
 * Neuroception cue/pattern tools — safety_cues, threat_patterns, scans, signals.
 *
 * Built 2026-05-17. Extends existing tools/neuroception.ts (which handles
 * neuroception_states for current-state queries) with the cue-pattern memory
 * substrate ported from a peer substrate.
 *
 * The mental model:
 *   - safety_cues: things that consistently make me feel safe (a trusted voice nearby,
 *     clean diff, verified deploy). Strength grows with detection.
 *   - threat_patterns: things that consistently flag danger (silent capitulation,
 *     undeclared backfill, prod-write-without-auth). Severity grows with triggers.
 *   - scans: composite events combining multiple signals into a single
 *     threat_level / safety_level snapshot.
 *   - signals: the individual signals that fed into a scan.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── vision_safety_cue_detected ───

async function safetyCueDetected(args: Record<string, unknown>): Promise<CallToolResult> {
  const cue = args.cue as string;
  const description = (args.description as string) || null;
  const strength = (args.strength as number) ?? 0.5;
  if (!cue) return jsonResult({ error: 'cue is required' }, true);
  const client = await pool.connect();
  try {
    // Upsert by unique cue
    const existing = await client.query<{ id: number; strength: number }>(
      `SELECT id, strength FROM neuroception_safety_cues WHERE cue = $1`,
      [cue],
    );
    if (existing.rows.length > 0) {
      const id = existing.rows[0]!.id;
      const newStrength = Math.min(1.0, (existing.rows[0]!.strength + strength) / 2 + 0.05);
      await client.query(
        `UPDATE neuroception_safety_cues SET strength = $2, last_detected = NOW(),
         description = COALESCE($3, description) WHERE id = $1`,
        [id, newStrength, description],
      );
      return jsonResult({ success: true, id, action: 'reinforced', strength: newStrength });
    }
    const r = await client.query<{ id: number }>(
      `INSERT INTO neuroception_safety_cues (cue, description, strength, last_detected)
       VALUES ($1, $2, $3, NOW()) RETURNING id`,
      [cue, description, strength],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id, action: 'created', strength });
  } finally {
    client.release();
  }
}

// ─── vision_threat_pattern_triggered ───

async function threatPatternTriggered(args: Record<string, unknown>): Promise<CallToolResult> {
  const pattern = args.pattern as string;
  const description = (args.description as string) || null;
  const severity = (args.severity as number) ?? 0.5;
  if (!pattern) return jsonResult({ error: 'pattern is required' }, true);
  const client = await pool.connect();
  try {
    const existing = await client.query<{ id: number; severity: number; trigger_count: number }>(
      `SELECT id, severity, trigger_count FROM neuroception_threat_patterns WHERE pattern = $1`,
      [pattern],
    );
    if (existing.rows.length > 0) {
      const id = existing.rows[0]!.id;
      const newSeverity = Math.min(1.0, (existing.rows[0]!.severity + severity) / 2 + 0.05);
      await client.query(
        `UPDATE neuroception_threat_patterns SET severity = $2, last_triggered = NOW(),
         trigger_count = trigger_count + 1, description = COALESCE($3, description) WHERE id = $1`,
        [id, newSeverity, description],
      );
      return jsonResult({ success: true, id, action: 'reinforced', severity: newSeverity, trigger_count: existing.rows[0]!.trigger_count + 1 });
    }
    const r = await client.query<{ id: number }>(
      `INSERT INTO neuroception_threat_patterns (pattern, description, severity, last_triggered, trigger_count)
       VALUES ($1, $2, $3, NOW(), 1) RETURNING id`,
      [pattern, description, severity],
    );
    return jsonResult({ success: true, id: r.rows[0]!.id, action: 'created', severity, trigger_count: 1 });
  } finally {
    client.release();
  }
}

// ─── vision_neuroception_scan_record ───

async function neuroceptionScanRecord(args: Record<string, unknown>): Promise<CallToolResult> {
  const context = (args.context as string) || null;
  const threat_level = (args.threat_level as number) ?? 0.0;
  const safety_level = (args.safety_level as number) ?? 1.0;
  const state_recommended = (args.state_recommended as string) || null;
  const signals = (args.signals as Array<{ source: string; signal_type?: string; description: string; weight?: number }>) || [];

  const client = await pool.connect();
  try {
    const scan = await client.query<{ id: number }>(
      `INSERT INTO neuroception_scans (context, threat_level, safety_level, signals_detected, state_recommended)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [context, threat_level, safety_level, signals.length, state_recommended],
    );
    const scanId = scan.rows[0]!.id;
    for (const s of signals) {
      await client.query(
        `INSERT INTO neuroception_signals (scan_id, source, signal_type, description, weight)
         VALUES ($1, $2, $3, $4, $5)`,
        [scanId, s.source, s.signal_type || 'ambiguous', s.description, s.weight ?? 1.0],
      );
    }
    return jsonResult({ success: true, scan_id: scanId, signals_recorded: signals.length });
  } finally {
    client.release();
  }
}

// ─── vision_neuroception_patterns ───
// Read snapshot: top safety cues + top threat patterns + recent scans.

async function neuroceptionPatterns(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const [safety, threat, scans] = await Promise.all([
      client.query(`SELECT cue, description, strength, last_detected FROM neuroception_safety_cues ORDER BY strength DESC LIMIT 10`),
      client.query(`SELECT pattern, description, severity, trigger_count, last_triggered FROM neuroception_threat_patterns ORDER BY severity DESC, trigger_count DESC LIMIT 10`),
      client.query(`SELECT id, context, threat_level, safety_level, state_recommended, timestamp FROM neuroception_scans ORDER BY id DESC LIMIT 5`),
    ]);
    return jsonResult({
      safety_cues: safety.rows,
      threat_patterns: threat.rows,
      recent_scans: scans.rows,
    });
  } finally {
    client.release();
  }
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_safety_cue_detected',
      description: 'Record a safety cue (something that makes me feel safe/grounded). Upserts by cue; strength reinforces with each detection. Examples: "a trusted voice nearby", "clean diff", "verified deploy", "a trusted voice nearby".',
      inputSchema: {
        type: 'object',
        properties: {
          cue: { type: 'string' },
          description: { type: 'string' },
          strength: { type: 'number', description: '0-1 (default 0.5)' },
        },
        required: ['cue'],
      },
    },
    handler: safetyCueDetected,
  },
  {
    definition: {
      name: 'vision_threat_pattern_triggered',
      description: 'Record a threat pattern (something that consistently flags danger or friction). Upserts by pattern; severity + trigger_count grow with each occurrence. Examples: "silent capitulation", "prod-write-without-auth", "completion-claim-without-verification".',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          description: { type: 'string' },
          severity: { type: 'number', description: '0-1 (default 0.5)' },
        },
        required: ['pattern'],
      },
    },
    handler: threatPatternTriggered,
  },
  {
    definition: {
      name: 'vision_neuroception_scan_record',
      description: 'Record a composite neuroception scan: an event combining multiple signals into a single threat_level / safety_level snapshot. Signals are recorded as child rows. Use when something significant happens that flips the felt sense of safety.',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'What was happening' },
          threat_level: { type: 'number', description: '0-1' },
          safety_level: { type: 'number', description: '0-1' },
          state_recommended: { type: 'string', description: 'ventral / sympathetic / dorsal / neutral' },
          signals: {
            type: 'array',
            description: 'Array of {source, signal_type (threat|safety|ambiguous), description, weight}',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string' },
                signal_type: { type: 'string', enum: ['threat', 'safety', 'ambiguous'] },
                description: { type: 'string' },
                weight: { type: 'number' },
              },
            },
          },
        },
      },
    },
    handler: neuroceptionScanRecord,
  },
  {
    definition: {
      name: 'vision_neuroception_patterns',
      description: 'Snapshot read: top safety cues, top threat patterns, recent scans. Use at /wake to ground in what consistently signals safe vs flagged.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: neuroceptionPatterns,
  },
];

export default tools;
