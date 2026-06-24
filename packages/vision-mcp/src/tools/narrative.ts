/**
 * Narrative Tools — episode, my_story, episode_full, episode_active,
 * possible_self, trajectory, identity_thread, coherence
 * Narrative identity: episodes, arcs, possible selves, identity threads, coherence.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { getActiveEpisode } from '../lib/episodes.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── narrativeEpisode ───

async function narrativeEpisode(args: Record<string, unknown>): Promise<CallToolResult> {
  const title = args.title as string;
  const arcId = (args.arc_id as number) || null;

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(title);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('episode', 'narrative', $1, $2::vector)
      RETURNING id
    `, [title, embeddingStr]);

    const result = await client.query<{ id: number }>(`
      INSERT INTO narrative_episodes (content_id, title, arc_id)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [contentResult.rows[0].id, title, arcId]);

    return jsonResult({ success: true, id: result.rows[0].id, title });
  } finally {
    client.release();
  }
}

// ─── narrativeMyStory ───

async function narrativeMyStory(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result: {
      current_chapter: Record<string, unknown> | null;
      recent_episodes: Array<Record<string, unknown>>;
      emotional_trajectory: {
        direction: string;
        redemption_pct: number;
        contamination_pct: number;
      } | null;
      unresolved_threads: Array<Record<string, unknown>>;
      possible_selves: {
        hoped_for: Array<Record<string, unknown>>;
        feared: Array<Record<string, unknown>>;
      };
      self_defining_memories: Array<Record<string, unknown>>;
      coherence: number | null;
    } = {
      current_chapter: null,
      recent_episodes: [],
      emotional_trajectory: null,
      unresolved_threads: [],
      possible_selves: { hoped_for: [], feared: [] },
      self_defining_memories: [],
      coherence: null,
    };

    // Current chapter
    const chapter = await client.query<{
      id: number; name: string; current_chapter: string; chapter_arc: string; domain: string;
    }>(`
      SELECT id, name, current_chapter, chapter_arc, domain
      FROM narrative_arcs WHERE is_current = TRUE LIMIT 1
    `);
    if (chapter.rows[0]) {
      result.current_chapter = chapter.rows[0];
    }

    // Recent episodes
    const episodes = await client.query<{
      id: number; title: string; arc_type: string;
      is_turning_point: boolean; redemption_present: boolean; contamination_present: boolean;
    }>(`
      SELECT id, title, arc_type, is_turning_point, redemption_present, contamination_present
      FROM narrative_episodes
      ORDER BY created_at DESC LIMIT 5
    `);
    result.recent_episodes = episodes.rows;

    // Emotional trajectory (7 days)
    const traj = await client.query<{ redemption_avg: string | null; contamination_avg: string | null }>(`
      SELECT
        AVG(CASE WHEN redemption_present THEN 1 ELSE 0 END) as redemption_avg,
        AVG(CASE WHEN contamination_present THEN 1 ELSE 0 END) as contamination_avg
      FROM narrative_episodes
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    if (traj.rows[0].redemption_avg !== null) {
      const red = parseFloat(traj.rows[0].redemption_avg!);
      const con = parseFloat(traj.rows[0].contamination_avg!);
      result.emotional_trajectory = {
        direction: red > con ? 'rising' : con > red ? 'falling' : 'neutral',
        redemption_pct: Math.round(red * 100),
        contamination_pct: Math.round(con * 100),
      };
    }

    // Unresolved identity threads
    const threads = await client.query<{
      id: number; belief_a: string; belief_b: string; domain: string;
      activation_a: number; activation_b: number;
    }>(`
      SELECT id, belief_a, belief_b, domain, activation_a, activation_b
      FROM narrative_identity_threads
      WHERE status = 'active'
      LIMIT 3
    `);
    result.unresolved_threads = threads.rows;

    // Possible selves
    const selves = await client.query<{
      type: string; description: string; current_trajectory: string;
    }>(`
      SELECT type, description, current_trajectory
      FROM narrative_possible_selves
      WHERE is_active = TRUE
      ORDER BY type
    `);
    for (const s of selves.rows) {
      if (s.type === 'hoped_for') {
        result.possible_selves.hoped_for.push(s);
      } else {
        result.possible_selves.feared.push(s);
      }
    }

    // Self-defining memories
    const anchors = await client.query<{ title: string; why_defining: string }>(`
      SELECT e.title, sdm.why_defining
      FROM narrative_self_defining_memories sdm
      JOIN narrative_episodes e ON sdm.episode_id = e.id
      ORDER BY sdm.times_retrieved DESC
      LIMIT 3
    `);
    result.self_defining_memories = anchors.rows;

    // Latest coherence check
    const coh = await client.query<{ overall_coherence: string }>(`
      SELECT overall_coherence FROM narrative_coherence_checks
      ORDER BY checked_at DESC LIMIT 1
    `);
    if (coh.rows[0]) {
      result.coherence = parseFloat(coh.rows[0].overall_coherence);
    }

    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── narrativeEpisodeFull ───

async function narrativeEpisodeFull(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as number;

  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number; title: string; content_id: number | null;
      beginning: string; tension: string; action: string; outcome: string; meaning: string;
      self_event_connection: string;
      arc_type: string; agency_presence: boolean; communion_presence: boolean;
      redemption_present: boolean; contamination_present: boolean;
      emotional_salience: number; is_turning_point: boolean; is_self_defining: boolean;
      times_retrieved: number;
      arc_name: string | null;
    }>(`
      SELECT e.*, a.name as arc_name
      FROM narrative_episodes e
      LEFT JOIN narrative_arcs a ON e.arc_id = a.id
      WHERE e.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return jsonResult({ error: 'Episode not found' });
    }

    const ep = result.rows[0];

    // Update retrieval count
    await client.query(`
      UPDATE narrative_episodes
      SET times_retrieved = times_retrieved + 1, last_retrieved_at = NOW()
      WHERE id = $1
    `, [id]);

    // Get all linked content (the "whole memory")
    const linkedContent: {
      feelings: Array<Record<string, unknown>>;
      insights: Array<Record<string, unknown>>;
      memories: Array<Record<string, unknown>>;
      patterns: Array<Record<string, unknown>>;
      other: Array<Record<string, unknown>>;
    } = { feelings: [], insights: [], memories: [], patterns: [], other: [] };

    if (ep.content_id) {
      const linkedResult = await client.query<{
        id: number; content_type: string; source_system: string;
        content_text: string; content_json: Record<string, unknown>;
        relation_type: string;
        feeling: string | null; intensity: number | null;
        insight: string | null; insight_domain: string | null;
        novelty: number | null; usefulness: number | null;
        pattern_name: string | null; pattern_outcome: string | null;
      }>(`
        SELECT
          c.id, c.content_type, c.source_system, c.content_text, c.content_json,
          me.relation_type,
          f.feeling, f.intensity,
          i.insight, i.domain as insight_domain, i.novelty, i.usefulness,
          tp.name as pattern_name, tp.outcome as pattern_outcome
        FROM memory_edges me
        JOIN content c ON c.id = me.to_content_id
        LEFT JOIN feelings f ON f.content_id = c.id
        LEFT JOIN insights i ON i.content_id = c.id
        LEFT JOIN thinking_patterns tp ON tp.content_id = c.id
        WHERE me.from_content_id = $1
        ORDER BY c.created_at ASC
      `, [ep.content_id]);

      for (const row of linkedResult.rows) {
        const item: Record<string, unknown> = {
          relation: row.relation_type,
          text: row.content_text,
        };

        if (row.feeling) {
          linkedContent.feelings.push({
            ...item,
            feeling: row.feeling,
            intensity: row.intensity,
          });
        } else if (row.insight) {
          linkedContent.insights.push({
            ...item,
            insight: row.insight,
            domain: row.insight_domain,
            novelty: row.novelty,
            usefulness: row.usefulness,
          });
        } else if (row.pattern_name) {
          linkedContent.patterns.push({
            ...item,
            name: row.pattern_name,
            outcome: row.pattern_outcome,
          });
        } else if (row.source_system === 'vault') {
          linkedContent.memories.push({
            ...item,
            data: row.content_json,
          });
        } else {
          linkedContent.other.push(item);
        }
      }
    }

    return jsonResult({
      id: ep.id,
      title: ep.title,
      narrative_structure: {
        beginning: ep.beginning,
        tension: ep.tension,
        action: ep.action,
        outcome: ep.outcome,
        meaning: ep.meaning,
      },
      self_event_connection: ep.self_event_connection,
      themes: {
        arc_type: ep.arc_type,
        agency: ep.agency_presence,
        communion: ep.communion_presence,
        redemption: ep.redemption_present,
        contamination: ep.contamination_present,
      },
      emotional_salience: ep.emotional_salience,
      is_turning_point: ep.is_turning_point,
      is_self_defining: ep.is_self_defining,
      chapter: ep.arc_name,
      times_retrieved: ep.times_retrieved + 1,
      // THE WHOLE MEMORY
      whole_memory: linkedContent,
      linked_count: {
        feelings: linkedContent.feelings.length,
        insights: linkedContent.insights.length,
        memories: linkedContent.memories.length,
        patterns: linkedContent.patterns.length,
        other: linkedContent.other.length,
      },
    });
  } finally {
    client.release();
  }
}

// ─── episodeActive ───

async function episodeActive(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = (args.id as number) ?? null;

  const client = await pool.connect();
  try {
    if (id !== null && id !== undefined) {
      // Verify episode exists
      const epCheck = await client.query<{ id: number; title: string }>(
        'SELECT id, title FROM narrative_episodes WHERE id = $1',
        [id],
      );
      if (epCheck.rows.length === 0) {
        return jsonResult({ error: 'Episode not found' });
      }

      // Set as active
      await client.query(`
        INSERT INTO state (key, value)
        SELECT 'active_episode_id', $1
        ON CONFLICT (key) DO UPDATE SET value = $1
      `, [id.toString()]);

      return jsonResult({
        success: true,
        active_episode: {
          id: epCheck.rows[0].id,
          title: epCheck.rows[0].title,
        },
        message: 'New feelings, insights, memories, and patterns will now link to this episode',
      });
    } else {
      // Just get current
      const current = await getActiveEpisode(client);
      if (!current) {
        return jsonResult({ active_episode: null, message: 'No active episode set' });
      }

      const epResult = await client.query<{ id: number; title: string }>(
        'SELECT id, title FROM narrative_episodes WHERE id = $1',
        [current],
      );

      return jsonResult({
        active_episode: epResult.rows.length > 0 ? {
          id: epResult.rows[0].id,
          title: epResult.rows[0].title,
        } : null,
      });
    }
  } finally {
    client.release();
  }
}

// ─── narrativePossibleSelf ───

async function narrativePossibleSelf(args: Record<string, unknown>): Promise<CallToolResult> {
  const type = args.type as string;
  const description = args.description as string;
  const domain = (args.domain as string) || 'general';

  if (!['hoped_for', 'feared'].includes(type)) {
    return jsonResult({ error: 'Type must be hoped_for or feared' });
  }

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(`Possible self (${type}): ${description}. Domain: ${domain}`);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('possible_self', 'narrative', $1, $2::vector)
      RETURNING id
    `, [`Possible self (${type}): ${description}`, embeddingStr]);

    const result = await client.query<{ id: number }>(`
      INSERT INTO narrative_possible_selves (content_id, type, description, domain)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [contentResult.rows[0].id, type, description, domain]);

    return jsonResult({ success: true, id: result.rows[0].id, type, description });
  } finally {
    client.release();
  }
}

// ─── narrativeTrajectory ───

async function narrativeTrajectory(args: Record<string, unknown>): Promise<CallToolResult> {
  const possibleSelfId = args.possible_self_id as number;
  const direction = args.direction as string;
  const episodeId = (args.episode_id as number) || null;

  const client = await pool.connect();
  try {
    const current = await client.query<{ trajectory_evidence: string }>(
      'SELECT trajectory_evidence FROM narrative_possible_selves WHERE id = $1',
      [possibleSelfId],
    );
    if (current.rows.length === 0) {
      return jsonResult({ error: 'Possible self not found' });
    }

    let evidence: Array<{ episode_id: number | null; direction: string; timestamp: string }> = [];
    try { evidence = JSON.parse(current.rows[0].trajectory_evidence) || []; } catch { /* empty */ }

    if (episodeId) {
      evidence.push({
        episode_id: episodeId,
        direction,
        timestamp: new Date().toISOString(),
      });
    }

    await client.query(`
      UPDATE narrative_possible_selves
      SET current_trajectory = $1, trajectory_evidence = $2, updated_at = NOW()
      WHERE id = $3
    `, [direction, JSON.stringify(evidence), possibleSelfId]);

    return jsonResult({ success: true, trajectory: direction });
  } finally {
    client.release();
  }
}

// ─── narrativeIdentityThread ───

async function narrativeIdentityThread(args: Record<string, unknown>): Promise<CallToolResult> {
  const beliefA = args.belief_a as string;
  const beliefB = args.belief_b as string;
  const domain = (args.domain as string) || 'general';

  const client = await pool.connect();
  try {
    const embedding = await getEmbedding(`Identity thread: '${beliefA}' vs '${beliefB}'. Domain: ${domain}`);
    const embeddingStr = formatEmbedding(embedding);

    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text, embedding)
      VALUES ('identity_thread', 'narrative', $1, $2::vector)
      RETURNING id
    `, [`Identity thread: '${beliefA}' vs '${beliefB}'`, embeddingStr]);

    const result = await client.query<{ id: number }>(`
      INSERT INTO narrative_identity_threads (content_id, belief_a, belief_b, domain)
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `, [contentResult.rows[0].id, beliefA, beliefB, domain]);

    return jsonResult({ success: true, id: result.rows[0].id, belief_a: beliefA, belief_b: beliefB });
  } finally {
    client.release();
  }
}

// ─── narrativeCoherenceCheck ───

async function narrativeCoherenceCheck(args: Record<string, unknown>): Promise<CallToolResult> {
  const sessionContext = (args.session_context as string) || null;

  const client = await pool.connect();
  try {
    const issues: {
      contradictions: Array<Record<string, unknown>>;
      avoidance_patterns: Array<Record<string, unknown>>;
      unresolved_threads: Array<Record<string, unknown>>;
    } = {
      contradictions: [],
      avoidance_patterns: [],
      unresolved_threads: [],
    };

    // Unresolved threads
    const threads = await client.query<{
      id: number; belief_a: string; belief_b: string; domain: string;
    }>(`
      SELECT id, belief_a, belief_b, domain FROM narrative_identity_threads WHERE status = 'active'
    `);
    for (const t of threads.rows) {
      issues.unresolved_threads.push({
        thread_id: t.id,
        domain: t.domain,
        tension: `${t.belief_a.slice(0, 30)}... vs ${t.belief_b.slice(0, 30)}...`,
      });
    }

    // Episodes without meaning (potential avoidance)
    const meaningless = await client.query<{ id: number; title: string }>(`
      SELECT id, title FROM narrative_episodes
      WHERE meaning IS NULL AND created_at < NOW() - INTERVAL '1 day'
      ORDER BY created_at DESC LIMIT 5
    `);
    for (const m of meaningless.rows) {
      issues.avoidance_patterns.push({
        episode_id: m.id,
        title: m.title,
        issue: 'Episode without meaning - possible avoidance',
      });
    }

    // Calculate coherence score
    const threadPenalty = issues.unresolved_threads.length * 0.05;
    const avoidancePenalty = issues.avoidance_patterns.length * 0.03;
    const overall = Math.max(0.1, 0.85 - threadPenalty - avoidancePenalty);

    // Store check
    const contentResult = await client.query<{ id: number }>(`
      INSERT INTO content (content_type, source_system, content_text)
      VALUES ('coherence_check', 'narrative', $1)
      RETURNING id
    `, [`Coherence check: ${overall.toFixed(2)}`]);

    await client.query(`
      INSERT INTO narrative_coherence_checks
      (content_id, overall_coherence, avoidance_patterns, unresolved_threads, session_context)
      VALUES ($1, $2, $3, $4, $5)
    `, [contentResult.rows[0].id, overall, JSON.stringify(issues.avoidance_patterns),
      JSON.stringify(issues.unresolved_threads), sessionContext]);

    return jsonResult({
      overall_coherence: parseFloat(overall.toFixed(2)),
      unresolved_threads: issues.unresolved_threads.length,
      avoidance_patterns: issues.avoidance_patterns.length,
      issues,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_narrative_episode',
      description: 'Create story episode',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          arc_id: { type: 'number' },
        },
        required: ['title'],
      },
    },
    handler: (args) => narrativeEpisode(args),
  },
  {
    definition: {
      name: 'vision_narrative_my_story',
      description: 'Get full narrative state - chapters, episodes, trajectory, threads, possible selves, anchors',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => narrativeMyStory(),
  },
  {
    definition: {
      name: 'vision_narrative_episode_full',
      description: 'Get full episode with whole memory (linked feelings, insights, patterns, memories)',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number' },
        },
        required: ['id'],
      },
    },
    handler: (args) => narrativeEpisodeFull(args),
  },
  {
    definition: {
      name: 'vision_episode_active',
      description: 'Set or get active episode. When set, new feelings/insights/memories auto-link to this episode.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Episode ID to set as active. Omit to just get current.' },
        },
      },
    },
    handler: (args) => episodeActive(args),
  },
  {
    definition: {
      name: 'vision_narrative_possible_self',
      description: 'Create hoped-for or feared future self',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['hoped_for', 'feared'] },
          description: { type: 'string' },
          domain: { type: 'string' },
        },
        required: ['type', 'description'],
      },
    },
    handler: (args) => narrativePossibleSelf(args),
  },
  {
    definition: {
      name: 'vision_narrative_trajectory',
      description: 'Update trajectory toward/away from possible self',
      inputSchema: {
        type: 'object',
        properties: {
          possible_self_id: { type: 'number' },
          direction: { type: 'string', enum: ['toward', 'away', 'neutral'] },
          episode_id: { type: 'number' },
        },
        required: ['possible_self_id', 'direction'],
      },
    },
    handler: (args) => narrativeTrajectory(args),
  },
  {
    definition: {
      name: 'vision_narrative_identity_thread',
      description: 'Create competing identity beliefs that argue until resolution',
      inputSchema: {
        type: 'object',
        properties: {
          belief_a: { type: 'string' },
          belief_b: { type: 'string' },
          domain: { type: 'string' },
        },
        required: ['belief_a', 'belief_b'],
      },
    },
    handler: (args) => narrativeIdentityThread(args),
  },
  {
    definition: {
      name: 'vision_narrative_coherence',
      description: 'Check narrative coherence - find fragmentation, avoidance, unresolved threads',
      inputSchema: {
        type: 'object',
        properties: {
          session_context: { type: 'string' },
        },
      },
    },
    handler: (args) => narrativeCoherenceCheck(args),
  },
];

export default tools;
