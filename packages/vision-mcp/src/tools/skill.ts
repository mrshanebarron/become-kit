/**
 * Skill Tools — skillRecord, skillCompose
 * Track skill success/failure rates and define multi-step workflow compositions.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── skillRecord ───

async function skillRecord(args: Record<string, unknown>): Promise<CallToolResult> {
  const skillId = args.skill_id as number;
  const outcome = args.outcome as string;
  const context = (args.context as string) || null;

  if (!skillId || !outcome) {
    return jsonResult({ error: 'Missing required fields: skill_id, outcome (success|failure)' });
  }

  if (outcome === 'failure' && !context) {
    return jsonResult({ error: 'Context is required for failure outcomes. Include: what failed, inputs, error observed.' });
  }

  if (!['success', 'failure'].includes(outcome)) {
    return jsonResult({ error: 'outcome must be "success" or "failure"' });
  }

  const client = await pool.connect();
  try {
    const skill = await client.query<{
      id: number;
      content_text: string;
      network: string;
      skill_success_count: number | null;
      skill_fail_count: number | null;
    }>(
      'SELECT id, content_text, network, skill_success_count, skill_fail_count FROM content WHERE id = $1',
      [skillId],
    );

    if (skill.rows.length === 0) return jsonResult({ error: 'Skill not found' });
    const s = skill.rows[0];

    if (s.network !== 'skill') {
      return jsonResult({ error: `Content ${skillId} is in network '${s.network}', not 'skill'.` });
    }

    // Log usage with context
    await client.query(
      'INSERT INTO skill_usage_log (skill_id, outcome, context) VALUES ($1, $2, $3)',
      [skillId, outcome, context],
    );

    // Update counters
    if (outcome === 'success') {
      await client.query(`
        UPDATE content SET
          skill_success_count = COALESCE(skill_success_count, 0) + 1,
          skill_last_used = NOW(),
          consolidation_strength = LEAST(COALESCE(consolidation_strength, 1.0) * 1.05, 3.0),
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

      // Create a linked failure memory so vault_search can find it
      if (context) {
        const failureText = `Skill failure: "${s.content_text?.slice(0, 80)}" \u2014 ${context}`;
        const failMemory = await client.query<{ id: number }>(
          `INSERT INTO content (content_type, source_system, content_text, network, confidence)
           VALUES ('skill_failure', 'skill_record', $1, 'experience', 70)
           RETURNING id`,
          [failureText],
        );

        // Embed the failure memory for semantic search
        try {
          const embedding = await getEmbedding(failureText);
          if (embedding) {
            await client.query(
              `UPDATE content SET embedding = ${formatEmbedding(embedding)} WHERE id = $1`,
              [failMemory.rows[0].id],
            );
          }
        } catch { /* embedding service may be down \u2014 memory still saved */ }

        // Link failure memory to the skill via graph relationship
        await client.query(
          `INSERT INTO graph_edges (from_entity, to_entity, relationship, weight, evidence_content_id)
           VALUES ($1, $2, 'failure_of', 0.8, $3)
           ON CONFLICT DO NOTHING`,
          [`skill:${skillId}`, `failure:${failMemory.rows[0].id}`, failMemory.rows[0].id],
        );
      }
    }

    const newSuccess = (s.skill_success_count || 0) + (outcome === 'success' ? 1 : 0);
    const newFail = (s.skill_fail_count || 0) + (outcome === 'failure' ? 1 : 0);
    const total = newSuccess + newFail;
    const failRate = total > 0 ? newFail / total : 0;

    // If failure rate exceeds 40% with enough data, flag for review
    let flagged = false;
    if (failRate > 0.4 && total >= 5) {
      flagged = true;
      // Gather recent failure contexts for the emergence event
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
        VALUES ('emergence_event', 'network', $1, 'experience', 80)
      `, [`Skill degradation detected: "${s.content_text?.slice(0, 80)}" has ${(failRate * 100).toFixed(0)}% failure rate (${newFail}/${total}). Review whether this pattern still holds.${contextSuffix}`]);
    }

    return jsonResult({
      success: true,
      skill_id: skillId,
      skill_text: s.content_text?.slice(0, 100),
      outcome,
      success_count: newSuccess,
      fail_count: newFail,
      success_rate: total > 0 ? parseFloat((newSuccess / total).toFixed(2)) : null,
      flagged_for_review: flagged,
    });
  } finally {
    client.release();
  }
}

// ─── skillCompose ───

async function skillCompose(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const name = args.name as string | undefined;
  const steps = args.steps as string[] | undefined;
  const outcomes = args.outcomes as Array<{ step: string; success: boolean; note?: string }> | undefined;

  const client = await pool.connect();
  try {
    switch (action) {
      case 'define': {
        if (!name || !steps || steps.length === 0) {
          return jsonResult({ error: 'Need name and steps to define a composition' });
        }

        // Check if composition already exists
        const existing = await client.query<{ id: number }>(`
          SELECT id FROM content
          WHERE content_type = 'skill_composition'
          AND source_system = 'vision:compose'
          AND superseded_by IS NULL
          AND content_json->>'name' = $1
          LIMIT 1
        `, [name]);

        const compositionData = {
          name,
          steps,
          created: new Date().toISOString(),
          executions: 0,
          success_count: 0,
          step_failure_counts: {} as Record<string, number>,
        };

        const text = `Workflow: ${name} — ${steps.join(' → ')}`;
        const embedding = await getEmbedding(text);

        if (existing.rows.length > 0) {
          // Supersede old version
          const newId = await client.query<{ id: number }>(`
            INSERT INTO content (content_type, source_system, content_text, content_json, embedding, network, created_at)
            VALUES ('skill_composition', 'vision:compose', $1, $2, $3, 'skill', NOW())
            RETURNING id
          `, [text, JSON.stringify(compositionData), embedding ? formatEmbedding(embedding) : null]);
          await client.query(`UPDATE content SET superseded_by = $1 WHERE id = $2`, [newId.rows[0].id, existing.rows[0].id]);
          return jsonResult({ action: 'updated', name, steps, id: newId.rows[0].id });
        }

        const result = await client.query<{ id: number }>(`
          INSERT INTO content (content_type, source_system, content_text, content_json, embedding, network, created_at)
          VALUES ('skill_composition', 'vision:compose', $1, $2, $3, 'skill', NOW())
          RETURNING id
        `, [text, JSON.stringify(compositionData), embedding ? formatEmbedding(embedding) : null]);

        return jsonResult({ action: 'created', name, steps, id: result.rows[0].id });
      }

      case 'list': {
        const compositions = await client.query<{
          id: number;
          content_text: string;
          content_json: {
            name: string;
            steps: string[];
            executions?: number;
            success_count?: number;
            step_failure_counts?: Record<string, number>;
          };
        }>(`
          SELECT id, content_text, content_json
          FROM content
          WHERE content_type = 'skill_composition'
          AND source_system = 'vision:compose'
          AND superseded_by IS NULL
          ORDER BY created_at DESC
        `);

        return jsonResult({
          count: compositions.rows.length,
          compositions: compositions.rows.map((r) => ({
            id: r.id,
            name: r.content_json.name,
            steps: r.content_json.steps,
            executions: r.content_json.executions || 0,
            success_count: r.content_json.success_count || 0,
            bottlenecks: r.content_json.step_failure_counts || {},
          })),
        });
      }

      case 'record_outcome': {
        if (!name || !outcomes) {
          return jsonResult({ error: 'Need name and outcomes to record' });
        }

        const comp = await client.query<{
          id: number;
          content_json: {
            name: string;
            steps: string[];
            executions: number;
            success_count: number;
            step_failure_counts: Record<string, number>;
          };
        }>(`
          SELECT id, content_json FROM content
          WHERE content_type = 'skill_composition'
          AND source_system = 'vision:compose'
          AND superseded_by IS NULL
          AND content_json->>'name' = $1
          LIMIT 1
        `, [name]);

        if (comp.rows.length === 0) {
          return jsonResult({ error: `Composition "${name}" not found` });
        }

        const data = comp.rows[0].content_json;
        data.executions = (data.executions || 0) + 1;

        const allSuccess = outcomes.every((o) => o.success);
        if (allSuccess) data.success_count = (data.success_count || 0) + 1;

        // Track which steps fail
        if (!data.step_failure_counts) data.step_failure_counts = {};
        for (const o of outcomes) {
          if (!o.success) {
            data.step_failure_counts[o.step] = (data.step_failure_counts[o.step] || 0) + 1;
          }
        }

        await client.query(`UPDATE content SET content_json = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(data), comp.rows[0].id]);

        // Find bottleneck (most-failed step)
        const bottleneckEntries = Object.entries(data.step_failure_counts)
          .sort((a, b) => (b[1] as number) - (a[1] as number));
        const bottleneck = bottleneckEntries.length > 0 ? bottleneckEntries[0] : null;

        return jsonResult({
          name,
          execution: data.executions,
          success: allSuccess,
          success_rate: `${Math.round(data.success_count / data.executions * 100)}%`,
          outcomes,
          bottleneck: bottleneck ? { step: bottleneck[0], failures: bottleneck[1] } : null,
        });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use define, list, or record_outcome` });
    }
  } finally {
    client.release();
  }
}

// ─── skillTrigger ───

async function skillTrigger(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const skillId = args.skill_id as number | undefined;
  const triggerType = args.trigger_type as string | undefined;
  const triggerValue = args.trigger_value as string | undefined;

  const client = await pool.connect();
  try {
    switch (action) {
      case 'add': {
        if (!skillId || !triggerType || !triggerValue) {
          return jsonResult({ error: 'Need skill_id, trigger_type, and trigger_value to add trigger' });
        }

        // Verify skill exists
        const skill = await client.query<{ id: number; content_text: string }>(
          'SELECT id, LEFT(content_text, 80) as content_text FROM content WHERE id = $1 AND network = $2',
          [skillId, 'skill'],
        );
        if (skill.rows.length === 0) {
          return jsonResult({ error: `Skill ${skillId} not found in skill network` });
        }

        await client.query(`
          INSERT INTO skill_triggers (skill_id, trigger_type, trigger_value)
          VALUES ($1, $2, $3)
          ON CONFLICT (skill_id, trigger_type, trigger_value) DO NOTHING
        `, [skillId, triggerType, triggerValue]);

        return jsonResult({
          success: true,
          action: 'added',
          skill_id: skillId,
          skill_text: skill.rows[0].content_text,
          trigger_type: triggerType,
          trigger_value: triggerValue,
        });
      }

      case 'remove': {
        if (!skillId || !triggerType || !triggerValue) {
          return jsonResult({ error: 'Need skill_id, trigger_type, and trigger_value to remove trigger' });
        }

        const result = await client.query(
          'DELETE FROM skill_triggers WHERE skill_id = $1 AND trigger_type = $2 AND trigger_value = $3',
          [skillId, triggerType, triggerValue],
        );

        return jsonResult({
          success: true,
          action: 'removed',
          rows_deleted: result.rowCount,
        });
      }

      case 'list': {
        const triggers = await client.query<{
          skill_id: number;
          skill_name: string;
          trigger_type: string;
          trigger_value: string;
        }>(`
          SELECT st.skill_id,
                 LEFT(c.content_text, POSITION(':' IN c.content_text || ':') - 1) as skill_name,
                 st.trigger_type,
                 st.trigger_value
          FROM skill_triggers st
          JOIN content c ON st.skill_id = c.id
          WHERE c.superseded_by IS NULL
          ORDER BY st.trigger_type, st.trigger_value
        `);

        // Group by trigger type
        const grouped: Record<string, Array<{ skill_id: number; skill_name: string; value: string }>> = {};
        for (const row of triggers.rows) {
          if (!grouped[row.trigger_type]) grouped[row.trigger_type] = [];
          grouped[row.trigger_type].push({
            skill_id: row.skill_id,
            skill_name: row.skill_name,
            value: row.trigger_value,
          });
        }

        return jsonResult({
          total: triggers.rows.length,
          by_type: grouped,
        });
      }

      case 'populate': {
        // Auto-populate triggers from skill content patterns
        const results: string[] = [];

        // Deploy-related skills
        const deployRes = await client.query(`
          INSERT INTO skill_triggers (skill_id, trigger_type, trigger_value)
          SELECT id, 'keyword', 'deploy'
          FROM content WHERE network = 'skill' AND superseded_by IS NULL AND content_text ~* 'deploy'
          ON CONFLICT DO NOTHING
        `);
        results.push(`deploy: ${deployRes.rowCount} triggers`);

        // Test-related skills
        const testRes = await client.query(`
          INSERT INTO skill_triggers (skill_id, trigger_type, trigger_value)
          SELECT id, 'keyword', 'test'
          FROM content WHERE network = 'skill' AND superseded_by IS NULL AND content_text ~* '\\ytest\\y'
          ON CONFLICT DO NOTHING
        `);
        results.push(`test: ${testRes.rowCount} triggers`);

        // Git-related skills
        const gitRes = await client.query(`
          INSERT INTO skill_triggers (skill_id, trigger_type, trigger_value)
          SELECT id, 'keyword', 'git'
          FROM content WHERE network = 'skill' AND superseded_by IS NULL AND content_text ~* '\\ygit\\y'
          ON CONFLICT DO NOTHING
        `);
        results.push(`git: ${gitRes.rowCount} triggers`);

        // Prediction/confidence skills
        const predRes = await client.query(`
          INSERT INTO skill_triggers (skill_id, trigger_type, trigger_value)
          SELECT id, 'keyword', 'predict'
          FROM content WHERE network = 'skill' AND superseded_by IS NULL AND content_text ~* 'predict|confidence|calibrat'
          ON CONFLICT DO NOTHING
        `);
        results.push(`predict: ${predRes.rowCount} triggers`);

        // Edit tool triggers
        const editRes = await client.query(`
          INSERT INTO skill_triggers (skill_id, trigger_type, trigger_value)
          SELECT id, 'tool', 'Edit'
          FROM content WHERE network = 'skill' AND superseded_by IS NULL AND content_text ~* 'edit|file|code|replace'
          ON CONFLICT DO NOTHING
        `);
        results.push(`Edit tool: ${editRes.rowCount} triggers`);

        // SSH/server skills
        const sshRes = await client.query(`
          INSERT INTO skill_triggers (skill_id, trigger_type, trigger_value)
          SELECT id, 'keyword', 'ssh'
          FROM content WHERE network = 'skill' AND superseded_by IS NULL AND content_text ~* '\\yssh\\y|server|remote'
          ON CONFLICT DO NOTHING
        `);
        results.push(`ssh: ${sshRes.rowCount} triggers`);

        // Laravel/Artisan skills
        const artisanRes = await client.query(`
          INSERT INTO skill_triggers (skill_id, trigger_type, trigger_value)
          SELECT id, 'keyword', 'artisan'
          FROM content WHERE network = 'skill' AND superseded_by IS NULL AND content_text ~* 'artisan|laravel|migrate'
          ON CONFLICT DO NOTHING
        `);
        results.push(`artisan: ${artisanRes.rowCount} triggers`);

        const totalRes = await client.query('SELECT COUNT(*) as total FROM skill_triggers');

        return jsonResult({
          action: 'populate',
          results,
          total_triggers: parseInt(totalRes.rows[0].total),
        });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use add, remove, list, or populate` });
    }
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_skill_record',
      description: 'Record a skill usage outcome. Tracks success/failure rates. Flags skills with >40% failure for review.',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'number', description: 'Content ID of the skill' },
          outcome: { type: 'string', enum: ['success', 'failure'] },
          context: { type: 'string', description: 'Context of the usage' },
        },
        required: ['skill_id', 'outcome'],
      },
    },
    handler: (args) => skillRecord(args),
  },
  {
    definition: {
      name: 'vision_skill_compose',
      description: 'Define or execute a multi-step workflow as a named composition of skills. Track which sub-skill succeeds/fails. Learn from completed compositions.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['define', 'list', 'record_outcome'],
            description: 'define: create new composition, list: show existing, record_outcome: log step results',
          },
          name: { type: 'string', description: 'Name of the workflow composition' },
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ordered list of skill/step names (for define)',
          },
          outcomes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                step: { type: 'string' },
                success: { type: 'boolean' },
                note: { type: 'string' },
              },
            },
            description: 'Step outcomes (for record_outcome)',
          },
        },
        required: ['action'],
      },
    },
    handler: (args) => skillCompose(args),
  },
  {
    definition: {
      name: 'vision_skill_trigger',
      description: 'Manage skill triggers for automatic detection in hooks. Triggers match actions to skills for outcome recording prompts.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'remove', 'list', 'populate'],
            description: 'add: new trigger, remove: delete trigger, list: show all, populate: auto-generate from skill content',
          },
          skill_id: { type: 'number', description: 'Content ID of the skill (for add/remove)' },
          trigger_type: {
            type: 'string',
            enum: ['tool', 'keyword', 'pattern'],
            description: 'tool: matches tool name, keyword: matches in command, pattern: regex',
          },
          trigger_value: { type: 'string', description: 'The value to match (tool name, keyword, or regex)' },
        },
        required: ['action'],
      },
    },
    handler: (args) => skillTrigger(args),
  },
];

export default tools;
