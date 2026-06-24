/**
 * Shared Skill Recording — used by session_evolve and vault_remember
 *
 * Records success/failure outcomes for skill-network content.
 * Tracks usage counts, detects skill degradation, boosts consolidation on success.
 */
import type { PoolClient } from 'pg';

export interface SkillRecordResult {
  success?: boolean;
  error?: string;
  skill_id?: number;
  skill_text?: string;
  outcome?: string;
  success_count?: number;
  fail_count?: number;
  total_uses?: number;
  fail_rate?: string;
}

export async function skillRecordInline(
  client: PoolClient,
  skillId: number,
  outcome: string,
  context: string | null,
): Promise<SkillRecordResult> {
  if (!skillId || !outcome) {
    return { error: 'Missing required fields: skill_id, outcome (success|failure)' };
  }

  if (!['success', 'failure'].includes(outcome)) {
    return { error: 'outcome must be "success" or "failure"' };
  }

  const skill = await client.query<{
    id: number; content_text: string; network: string;
    skill_success_count: number | null; skill_fail_count: number | null;
  }>(
    'SELECT id, content_text, network, skill_success_count, skill_fail_count FROM content WHERE id = $1',
    [skillId],
  );

  if (skill.rows.length === 0) return { error: 'Skill not found' };
  const s = skill.rows[0];

  if (s.network !== 'skill') {
    return { error: `Content ${skillId} is in network '${s.network}', not 'skill'.` };
  }

  // Log usage with context
  await client.query(
    'INSERT INTO skill_usage_log (skill_id, outcome, context) VALUES ($1, $2, $3)',
    [skillId, outcome, context],
  );

  if (outcome === 'success') {
    await client.query(`
      UPDATE content SET
        skill_success_count = COALESCE(skill_success_count, 0) + 1,
        skill_last_used = NOW(),
        consolidation_strength = LEAST(COALESCE(consolidation_strength, 1.0::numeric) * 1.05::numeric, 3.0::numeric),
        updated_at = NOW()
      WHERE id = $1
    `, [skillId]);
  } else {
    await client.query(`
      UPDATE content SET
        skill_fail_count = COALESCE(skill_fail_count, 0) + 1,
        skill_last_used = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `, [skillId]);
  }

  const newSuccess = (s.skill_success_count || 0) + (outcome === 'success' ? 1 : 0);
  const newFail = (s.skill_fail_count || 0) + (outcome === 'failure' ? 1 : 0);
  const total = newSuccess + newFail;
  const failRate = total > 0 ? newFail / total : 0;

  // If failure rate exceeds 40% with enough data, flag for review
  if (failRate > 0.4 && total >= 5) {
    const recentFailures = await client.query<{ context: string }>(
      `SELECT context FROM skill_usage_log
       WHERE skill_id = $1 AND outcome = 'failure' AND context IS NOT NULL
       ORDER BY created_at DESC LIMIT 5`,
      [skillId],
    );
    const failureContexts = recentFailures.rows.map(r => r.context).join(' | ');
    const contextSuffix = failureContexts ? ` Recent failure contexts: ${failureContexts.slice(0, 300)}` : '';
    await client.query(`
      INSERT INTO content (content_type, source_system, content_text, network, confidence)
      SELECT 'emergence_event', 'network', $1, 'experience', 80
    `, [`Skill degradation detected: "${s.content_text?.slice(0, 80)}" has ${(failRate * 100).toFixed(0)}% failure rate (${newFail}/${total}). Review whether this pattern still holds.${contextSuffix}`]);
  }

  return {
    success: true,
    skill_id: skillId,
    skill_text: s.content_text?.slice(0, 100),
    outcome,
    success_count: newSuccess,
    fail_count: newFail,
    total_uses: total,
    fail_rate: total > 0 ? Math.round(failRate * 100) + '%' : 'N/A',
  };
}
