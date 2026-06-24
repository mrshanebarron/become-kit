/**
 * Regulation Tools — Phase 3 of Vision evolution (apparatus history) + the agent).
 *
 * Where Phase 2 added observability (tool_invocations, dashboard, telemetry),
 * Phase 3 closes the loop: data we now collect must CHANGE behavior.
 *
 * First tool: vision_skills_degrading
 *   Surfaces skills with high failure rates so we revise broken reflexes
 *   instead of failing silently. Hooked into /think and /wake via
 *   hook-think-degrading-skill-surface.sh.
 *
 * Schema reference (from skill_usage_log):
 *   skill_id (FK to content.id), outcome ('success' | 'failure'), created_at
 *   Skill name lives in content.content_text via the FK join.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

interface DegradingSkill {
  skill_id: number;
  skill_name: string;
  content_type: string;
  uses: number;
  failures: number;
  fail_pct: number;
  last_used: string | null;
}

async function visionSkillsDegrading(args: {
  threshold?: number;
  min_uses?: number;
  window_days?: number;
  limit?: number;
}): Promise<CallToolResult> {
  const threshold = args.threshold ?? 0.30;
  const minUses = args.min_uses ?? 3;
  const windowDays = args.window_days ?? 30;
  const limit = Math.min(args.limit ?? 10, 50);

  // Schema clarification (2026-05-02): "skills" aren't a single content_type;
  // they're spread across learned_reflex, skill_composition, thinking_pattern,
  // insight, memory, etc. The truth lives in two parallel surfaces:
  //   1. content.skill_success_count / skill_fail_count / skill_last_used —
  //      now kept in sync via trigger trg_sync_skill_counters (migration 020)
  //   2. skill_usage_log table (raw event log, FK to content.id)
  //
  // We query the counter columns: faster, no JOIN, all-time view. The
  // window_days arg is honored by also requiring skill_last_used > cutoff
  // (so a skill that failed last year doesn't keep showing up forever).
  const result = await pool.query<{
    skill_id: number;
    skill_name: string;
    content_type: string;
    uses: string;
    failures: string;
    fail_pct: string;
    last_used: string | null;
  }>(
    `SELECT
       id                                                          AS skill_id,
       LEFT(content_text, 120)                                     AS skill_name,
       content_type,
       (skill_success_count + skill_fail_count)::text              AS uses,
       skill_fail_count::text                                      AS failures,
       ROUND(100.0 * skill_fail_count / NULLIF(skill_success_count + skill_fail_count, 0), 1)::text AS fail_pct,
       skill_last_used::date::text                                 AS last_used
     FROM content
     WHERE (skill_success_count + skill_fail_count) >= $1
       AND (skill_fail_count::float / NULLIF(skill_success_count + skill_fail_count, 0)) > $2
       AND (skill_last_used IS NULL OR skill_last_used > NOW() - ($3 || ' days')::INTERVAL)
     ORDER BY (skill_fail_count::float / NULLIF(skill_success_count + skill_fail_count, 0)) DESC,
              (skill_success_count + skill_fail_count) DESC
     LIMIT $4`,
    [minUses, threshold, windowDays, limit],
  );

  const skills: DegradingSkill[] = result.rows.map((r) => ({
    skill_id: r.skill_id,
    skill_name: r.skill_name,
    content_type: r.content_type,
    uses: Number(r.uses),
    failures: Number(r.failures),
    fail_pct: Number(r.fail_pct),
    last_used: r.last_used,
  }));

  return jsonResult({
    threshold_pct: threshold * 100,
    min_uses: minUses,
    window_days: windowDays,
    degrading_count: skills.length,
    skills,
    note:
      skills.length > 0
        ? 'Each entry below has crossed the failure threshold. Revise the underlying skill before relying on it again. Use /correct to formally retire or rewrite.'
        : 'No degrading skills detected in the configured window.',
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_skills_degrading',
      description:
        'Surface skills with failure rates above threshold over min_uses in window_days. Phase 3 regulation: catch broken reflexes before they fail again.',
      inputSchema: {
        type: 'object',
        properties: {
          threshold: {
            type: 'number',
            description: 'Failure rate above this is flagged (0.0–1.0). Default 0.30.',
          },
          min_uses: {
            type: 'number',
            description: 'Minimum uses in window for stat significance. Default 3.',
          },
          window_days: {
            type: 'number',
            description: 'Look-back window. Default 30.',
          },
          limit: {
            type: 'number',
            description: 'Max skills returned. Default 10, max 50.',
          },
        },
      },
    },
    handler: (args) =>
      visionSkillsDegrading(
        args as { threshold?: number; min_uses?: number; window_days?: number; limit?: number },
      ),
  },
];

export default tools;
