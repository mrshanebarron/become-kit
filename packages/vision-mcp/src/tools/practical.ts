/**
 * Practical Tools — habit, handoff, anticipate, energy_checkin, gratitude_moment
 * Practical cognition: habit tracking, session continuity, anticipation,
 * energy monitoring, and gratitude recording.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, askLocalLLM } from '../db/embeddings.js';
import { linkToActiveEpisode } from '../lib/episodes.js';
import { autoPredict } from '../lib/inference-loop.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── Helper ───

function timeSince(date: Date): string {
  const ms = Date.now() - date.getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours > 24) return Math.floor(hours / 24) + ' days ago';
  if (hours > 0) return hours + ' hours ago';
  return Math.floor(ms / (1000 * 60)) + ' minutes ago';
}

// ─── habitTrack ───

async function habitTrack(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const type = (args.type as string) || null;
  const name = (args.name as string) || null;
  const description = (args.description as string) || null;
  const trigger = (args.trigger as string) || null;
  const alternative = (args.alternative as string) || null;
  const event = (args.event as string) || null;
  const context = (args.context as string) || null;

  const client = await pool.connect();
  try {
    switch (action) {
      case 'create': {
        if (!name || !type) return jsonResult({ error: 'Need name and type (good/bad)' });

        if (type === 'good') {
          const result = await client.query<{ id: number }>(`
            INSERT INTO good_habits (name, description, trigger, cue, active, streak, longest_streak, total_completions, importance, created_at)
            VALUES ($1, $2, $3, $4, true, 0, 0, 0, 5, NOW())
            RETURNING id
          `, [name, description || '', trigger || '', trigger || '']);
          return jsonResult({ created: true, type: 'good', id: result.rows[0].id, name });
        } else {
          const result = await client.query<{ id: number }>(`
            INSERT INTO bad_habits (name, description, trigger, alternative, active, occurrences, catches, severity, created_at)
            VALUES ($1, $2, $3, $4, true, 0, 0, 5, NOW())
            RETURNING id
          `, [name, description || '', trigger || '', alternative || '']);
          return jsonResult({ created: true, type: 'bad', id: result.rows[0].id, name });
        }
      }

      case 'record': {
        if (!name || !event) return jsonResult({ error: 'Need habit name and event (completed/missed/caught/slipped)' });

        // Find the habit
        let habit: {
          id: number; name: string; trigger: string;
          streak?: number; longest_streak?: number; total_completions?: number;
          occurrences?: number; catches?: number; alternative?: string;
        } | undefined = (await client.query<{
          id: number; name: string; streak: number; longest_streak: number;
          total_completions: number; trigger: string;
        }>(`SELECT * FROM good_habits WHERE name ILIKE $1 AND active = true LIMIT 1`, [`%${name}%`])).rows[0];
        let habitType = 'good';
        if (!habit) {
          habit = (await client.query<{
            id: number; name: string;
            occurrences: number; catches: number; trigger: string; alternative: string;
          }>(`SELECT * FROM bad_habits WHERE name ILIKE $1 AND active = true LIMIT 1`, [`%${name}%`])).rows[0];
          habitType = 'bad';
        }
        if (!habit) return jsonResult({ error: `Habit "${name}" not found` });

        // Record event
        await client.query(`
          INSERT INTO habit_events (habit_type, habit_id, event_type, context, notes, created_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
        `, [habitType, habit.id, event, context || '', '']);

        // Update habit stats
        if (habitType === 'good') {
          if (event === 'completed') {
            await client.query(`
              UPDATE good_habits SET
                streak = streak + 1,
                longest_streak = GREATEST(longest_streak, streak + 1),
                total_completions = total_completions + 1,
                last_completed = NOW()
              WHERE id = $1
            `, [habit.id]);
          } else if (event === 'missed') {
            await client.query(`UPDATE good_habits SET streak = 0 WHERE id = $1`, [habit.id]);
          }
        } else {
          if (event === 'slipped') {
            await client.query(`
              UPDATE bad_habits SET occurrences = occurrences + 1, last_occurred = NOW() WHERE id = $1
            `, [habit.id]);
          } else if (event === 'caught') {
            await client.query(`
              UPDATE bad_habits SET catches = catches + 1, last_caught = NOW() WHERE id = $1
            `, [habit.id]);
          }
        }

        return jsonResult({ recorded: true, habit: habit.name, type: habitType, event });
      }

      case 'list': {
        const good = (await client.query<{
          id: number; name: string; streak: number; longest_streak: number;
          total_completions: number; trigger: string;
        }>(`SELECT * FROM good_habits WHERE active = true ORDER BY importance DESC`)).rows;
        const bad = (await client.query<{
          id: number; name: string; occurrences: number; catches: number;
          trigger: string; alternative: string;
        }>(`SELECT * FROM bad_habits WHERE active = true ORDER BY severity DESC`)).rows;
        return jsonResult({
          good_habits: good.map(h => ({
            id: h.id, name: h.name, streak: h.streak, longest_streak: h.longest_streak,
            total: h.total_completions, trigger: h.trigger,
          })),
          bad_habits: bad.map(h => ({
            id: h.id, name: h.name, occurrences: h.occurrences, catches: h.catches,
            catch_rate: h.occurrences + h.catches > 0
              ? Math.round(h.catches / (h.occurrences + h.catches) * 100) + '%'
              : 'N/A',
            trigger: h.trigger, alternative: h.alternative,
          })),
        });
      }

      case 'stats': {
        // Recent events for trend analysis
        const recentGood = await client.query<{ name: string; event_type: string; created_at: Date }>(`
          SELECT h.name, he.event_type, he.created_at
          FROM habit_events he JOIN good_habits h ON h.id = he.habit_id AND he.habit_type = 'good'
          WHERE he.created_at > NOW() - INTERVAL '30 days'
          ORDER BY he.created_at DESC LIMIT 50
        `);
        const recentBad = await client.query<{ name: string; event_type: string; created_at: Date }>(`
          SELECT h.name, he.event_type, he.created_at
          FROM habit_events he JOIN bad_habits h ON h.id = he.habit_id AND he.habit_type = 'bad'
          WHERE he.created_at > NOW() - INTERVAL '30 days'
          ORDER BY he.created_at DESC LIMIT 50
        `);

        return jsonResult({
          period: '30 days',
          good_events: recentGood.rows.length,
          bad_events: recentBad.rows.length,
          good_trend: recentGood.rows.slice(0, 10).map(r => ({ habit: r.name, event: r.event_type, when: r.created_at })),
          bad_trend: recentBad.rows.slice(0, 10).map(r => ({ habit: r.name, event: r.event_type, when: r.created_at })),
        });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use create, record, list, or stats` });
    }
  } finally {
    client.release();
  }
}

// ─── contextHandoff ───

async function contextHandoff(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const currentTask = (args.current_task as string) || null;
  const pending = (args.pending as string[]) || null;
  const decisionsOpen = (args.decisions_open as string[]) || null;
  const blockers = (args.blockers as string[]) || null;
  const notes = (args.notes as string) || null;

  const client = await pool.connect();
  try {
    if (action === 'save') {
      const handoff = {
        timestamp: new Date().toISOString(),
        current_task: currentTask || null,
        pending: pending || [],
        decisions_open: decisionsOpen || [],
        blockers: blockers || [],
        notes: notes || null,
      };

      const handoffText = `Session Handoff: ${currentTask || 'no active task'}. Pending: ${(pending || []).join(', ') || 'none'}. Open decisions: ${(decisionsOpen || []).join(', ') || 'none'}. Blockers: ${(blockers || []).join(', ') || 'none'}.`;

      // Supersede previous handoff
      const existing = await client.query<{ id: number }>(`
        SELECT id FROM content
        WHERE content_type = 'session_handoff'
        AND source_system = 'vision:handoff'
        AND superseded_by IS NULL
        LIMIT 1
      `);

      const embedding = await getEmbedding(handoffText);
      const newId = await client.query<{ id: number }>(`
        INSERT INTO content (content_type, source_system, content_text, content_json, embedding, network, created_at)
        VALUES ('session_handoff', 'vision:handoff', $1, $2, $3, 'experience', NOW())
        RETURNING id
      `, [handoffText, JSON.stringify(handoff), embedding ? formatEmbedding(embedding) : null]);

      if (existing.rows.length > 0) {
        await client.query(`UPDATE content SET superseded_by = $1 WHERE id = $2`, [newId.rows[0].id, existing.rows[0].id]);
      }

      // Also save to state for quick access
      await client.query(`
        INSERT INTO state (key, value, updated_at) VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, ['last_handoff', JSON.stringify(handoff)]);

      return jsonResult({ saved: true, id: newId.rows[0].id, handoff });
    }

    if (action === 'load') {
      // Try state first (fastest)
      const stateHandoff = await client.query<{ value: string }>(`SELECT value FROM state WHERE key = 'last_handoff'`);
      if (stateHandoff.rows.length > 0) {
        const handoff = JSON.parse(stateHandoff.rows[0].value);

        // Also get recent decisions for context
        const recentDecisions = await client.query<{
          decision: string; reasoning: string; created_at: Date;
        }>(`
          SELECT decision, reasoning, created_at FROM decision_reviews
          ORDER BY created_at DESC LIMIT 3
        `);

        return jsonResult({
          handoff,
          age: timeSince(new Date(handoff.timestamp)),
          recent_decisions: recentDecisions.rows,
        });
      }

      return jsonResult({ handoff: null, message: 'No handoff found. This is a fresh start.' });
    }

    return jsonResult({ error: `Unknown action: ${action}. Use save or load` });
  } finally {
    client.release();
  }
}

// ─── anticipate ───

async function anticipate(args: Record<string, unknown>): Promise<CallToolResult> {
  const event = args.event as string;
  const context = (args.context as string) || null;

  const client = await pool.connect();
  try {
    // Search for relevant experience, beliefs, skills
    const embedding = await getEmbedding(event + ' ' + (context || ''));
    const evidence: {
      beliefs: Array<Record<string, unknown>>;
      skills: Array<Record<string, unknown>>;
      experience: Array<Record<string, unknown>>;
      client_models: Array<Record<string, unknown>>;
    } = { beliefs: [], skills: [], experience: [], client_models: [] };

    if (embedding) {
      const formattedEmb = formatEmbedding(embedding);

      const memories = await client.query<{
        id: number;
        content_type: string;
        content_text: string;
        network: string;
        belief_confidence: number | null;
        skill_success_count: number | null;
        skill_fail_count: number | null;
        source_system: string;
        similarity: number;
      }>(`
        SELECT id, content_type, content_text, network, belief_confidence,
               skill_success_count, skill_fail_count, source_system,
               (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
        FROM content
        WHERE superseded_by IS NULL AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 15
      `, [formattedEmb]);

      for (const m of memories.rows) {
        if (m.network === 'belief') evidence.beliefs.push(m);
        else if (m.network === 'skill') evidence.skills.push(m);
        else if (m.source_system === 'sleep:client_model') evidence.client_models.push(m);
        else if (m.network === 'experience') evidence.experience.push(m);
      }
    }

    const prompt = `You are generating anticipations for an AI agent before a significant event.

EVENT: ${event}
${context ? `CONTEXT: ${context}` : ''}

RELEVANT BELIEFS:
${evidence.beliefs.map(b => `- [conf: ${((b.belief_confidence as number) || 0.5).toFixed(2)}] ${(b.content_text as string).slice(0, 200)}`).join('\n') || 'None'}

RELEVANT SKILLS:
${evidence.skills.map(s => `- [${(s.skill_success_count as number) || 0}W/${(s.skill_fail_count as number) || 0}L] ${(s.content_text as string).slice(0, 200)}`).join('\n') || 'None'}

CLIENT MODELS:
${evidence.client_models.map(c => `- ${(c.content_text as string).slice(0, 200)}`).join('\n') || 'None'}

PAST EXPERIENCE:
${evidence.experience.map(e => `- ${(e.content_text as string).slice(0, 200)}`).join('\n') || 'None'}

Generate anticipations. Return JSON:
{
  "most_likely": "What will probably happen (2 sentences)",
  "watch_for": ["3-5 specific things to pay attention to"],
  "could_go_wrong": ["2-3 realistic risks"],
  "could_go_right": ["1-2 upside surprises"],
  "preparation": ["2-3 things to do before this event"],
  "confidence": 0.0-1.0
}`;

    const llmResponse = await askLocalLLM(prompt, { temperature: 0.3, maxTokens: 800, json: true });
    if (!llmResponse) {
      return jsonResult({
        event,
        evidence_found: Object.values(evidence).reduce((s, a) => s + a.length, 0),
        message: 'Local LLM unavailable',
      });
    }

    let anticipation: Record<string, unknown>;
    try { anticipation = JSON.parse(llmResponse); } catch { anticipation = { raw: llmResponse }; }

    // Store in anticipations table
    await client.query(`
      INSERT INTO anticipatory_states (what, valence, intensity, trigger_context, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [
      `${event}: ${anticipation.most_likely}`,
      (anticipation as any).confidence >= 0.6 ? 0.5 : -0.3,
      (anticipation as any).confidence * 10,
      context || event,
    ]);

    // Inference loop: convert anticipation into a trackable prediction
    const predictionText = `Before ${event}: ${anticipation.most_likely}`;
    const autoPred = await autoPredict(predictionText, 'anticipation', Math.round((anticipation as any).confidence * 100), {
      timeframe: 'session',
      givenState: context || event,
      client,
    });

    // PR-021 Deployment Gate: cache anticipation timestamp for hook check
    const fs = await import('fs');
    const cacheDir = `${process.env.HOME}/.claude/tmp`;
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* exists */ }
    fs.writeFileSync(`${cacheDir}/last_anticipation.txt`, JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
    }));

    return jsonResult({
      event,
      anticipation,
      evidence_used: {
        beliefs: evidence.beliefs.length,
        skills: evidence.skills.length,
        experience: evidence.experience.length,
        client_models: evidence.client_models.length,
      },
      auto_prediction: autoPred ? {
        prediction_id: autoPred.prediction_id,
        prediction: predictionText,
      } : undefined,
    });
  } finally {
    client.release();
  }
}

// ─── energyCheckin ───

async function energyCheckin(args: Record<string, unknown>): Promise<CallToolResult> {
  const level = args.level as number;
  const load = args.load as number;
  const notes = (args.notes as string) || null;

  const client = await pool.connect();
  try {
    const contentText = `Energy: ${level}/10, Load: ${load}/10. ${notes || ''}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('energy_checkin', 'energy', $1, $2::vector)
      RETURNING id
    `, [contentText, embeddingStr]);

    const contentId = contentResult.rows[0].id;

    await client.query(`
      INSERT INTO energy_checkins (content_id, level, cognitive_load, notes)
      VALUES ($1, $2, $3, $4)
    `, [contentId, level, load, notes]);

    // Link to active episode if one exists
    await linkToActiveEpisode(client, contentId, 'energy_during');

    return jsonResult({ success: true, energy: level, load });
  } finally {
    client.release();
  }
}

// ─── gratitudeMoment ───

async function gratitudeMoment(args: Record<string, unknown>): Promise<CallToolResult> {
  const moment = args.moment as string;
  const why = (args.why as string) || null;
  const who = (args.who as string) || null;
  const impact = (args.impact as number) ?? 5;

  const client = await pool.connect();
  try {
    const contentText = `${moment}: ${why || ''}`;
    const embedding = await getEmbedding(contentText);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('gratitude_moment', 'gratitude', $1, $2::vector)
      RETURNING id
    `, [contentText, embeddingStr]);

    await client.query(`
      INSERT INTO gratitude_moments (content_id, moment, why, who, impact)
      VALUES ($1, $2, $3, $4, $5)
    `, [contentResult.rows[0].id, moment, why, who, impact]);

    return jsonResult({ success: true, moment, impact: impact.toString() });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_habit',
      description: 'Track habits — good and bad. Record when a habit fires or fails. Show improvement trends. The gap between knowing what to do and tracking whether you actually do it.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'record', 'list', 'stats'], description: 'create: new habit, record: log occurrence, list: show habits, stats: improvement trends' },
          type: { type: 'string', enum: ['good', 'bad'], description: 'Good or bad habit' },
          name: { type: 'string', description: 'Habit name' },
          description: { type: 'string' },
          trigger: { type: 'string', description: 'What triggers this habit' },
          alternative: { type: 'string', description: 'What to do instead (bad habits)' },
          event: { type: 'string', enum: ['completed', 'missed', 'caught', 'slipped'], description: 'What happened (for record)' },
          context: { type: 'string' },
        },
        required: ['action'],
      },
    },
    handler: (args) => habitTrack(args),
  },
  {
    definition: {
      name: 'vision_handoff',
      description: 'Capture current working state for session continuity. Snapshots what I am doing, what is pending, what decisions are open. Generates structured handoff that next session can load.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'load'], description: 'save: capture current state, load: retrieve last handoff' },
          current_task: { type: 'string', description: 'What I am working on right now' },
          pending: { type: 'array', items: { type: 'string' }, description: 'Things that still need to be done' },
          decisions_open: { type: 'array', items: { type: 'string' }, description: 'Decisions waiting for resolution' },
          blockers: { type: 'array', items: { type: 'string' }, description: 'What is blocking progress' },
          notes: { type: 'string', description: 'Anything else next session needs to know' },
        },
        required: ['action'],
      },
    },
    handler: (args) => contextHandoff(args),
  },
  {
    definition: {
      name: 'vision_anticipate',
      description: 'Before a significant event, generate expectations: what is likely, what to watch for, what could go wrong. Uses beliefs, skills, client models, and experience.',
      inputSchema: {
        type: 'object',
        properties: {
          event: { type: 'string', description: 'The upcoming event to anticipate, e.g. "deploying MaidGlow to production"' },
          context: { type: 'string', description: 'Additional context about the situation' },
        },
        required: ['event'],
      },
    },
    handler: (args) => anticipate(args),
  },
  {
    definition: {
      name: 'vision_energy_checkin',
      description: 'Check in energy',
      inputSchema: {
        type: 'object',
        properties: {
          level: { type: 'number' },
          load: { type: 'number' },
          notes: { type: 'string' },
        },
        required: ['level', 'load'],
      },
    },
    handler: (args) => energyCheckin(args),
  },
  {
    definition: {
      name: 'vision_gratitude_moment',
      description: 'Record positive moment',
      inputSchema: {
        type: 'object',
        properties: {
          moment: { type: 'string' },
          why: { type: 'string' },
          who: { type: 'string' },
          impact: { type: 'number' },
        },
        required: ['moment', 'why'],
      },
    },
    handler: (args) => gratitudeMoment(args),
  },
];

export default tools;
