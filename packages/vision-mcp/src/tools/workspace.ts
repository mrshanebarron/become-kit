/**
 * Workspace Tools — Global Workspace Theory cognitive cycle.
 *
 * Five-phase cycle: perceive → formCoalitions → compete → broadcast → learn
 *
 * Phase 1 (perceive): Gather signals from cognitive networks (recent memories,
 *   emotional state, active goals, immune alerts, prediction errors).
 * Phase 2 (formCoalitions): Codelets scan signals; co-activated codelets form
 *   coalitions with combined activation strength.
 * Phase 3 (compete): Coalitions compete for workspace access. Highest activation
 *   above ignition threshold wins. Refractory period prevents monopoly.
 * Phase 4 (broadcast): Winning coalition broadcasts to listener modules (episodic,
 *   immune, belief, procedural, graph) which take real actions.
 * Phase 5 (learn): Winning codelets strengthen (base_activation +0.02), losers
 *   decay (-0.005). Attentional learning over time.
 *
 * Existing tools (scan, broadcast, recent, predict, compare) are preserved
 * and upgraded. New tool: vision_cognitive_cycle runs the full 5-phase loop.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── Constants ───

const IGNITION_THRESHOLD = 0.35;
const LEARNING_BOOST = 0.02;
const LEARNING_DECAY = 0.005;
const BASE_ACTIVATION_MIN = 0.1;
const BASE_ACTIVATION_MAX = 0.95;
const REFRACTORY_MS = 30_000; // 30s refractory after winning

// ─── Types ───

interface Signal {
  source: string;
  content: string;
  strength: number;
  metadata?: Record<string, unknown>;
}

interface CodeletActivation {
  id: number;
  name: string;
  domain: string;
  pattern: string;
  activation: number;
  base_activation: number;
  matches: number;
  refractory: boolean;
}

interface Coalition {
  codelets: CodeletActivation[];
  signals: Signal[];
  total_activation: number;
}

interface ListenerResult {
  listener: string;
  action: string;
  success: boolean;
  detail?: string;
}

// ─── Phase 1: Perceive ───

async function perceiveSignals(client: import('pg').PoolClient): Promise<Signal[]> {
  const signals: Signal[] = [];

  // 1a. Recent high-activation memories (last hour)
  const recentMemories = await client.query(`
    SELECT content_type, content_text, emotional_valence, network
    FROM content
    WHERE created_at > NOW() - INTERVAL '1 hour'
      AND superseded_by IS NULL
    ORDER BY created_at DESC
    LIMIT 5
  `);
  for (const mem of recentMemories.rows) {
    signals.push({
      source: 'memory',
      content: (mem.content_text as string).slice(0, 200),
      strength: mem.emotional_valence != null
        ? Math.min(Math.abs(mem.emotional_valence as number) / 10, 1.0)
        : 0.3,
      metadata: { type: mem.content_type, network: mem.network },
    });
  }

  // 1b. Recent emotional state
  const emotions = await client.query(`
    SELECT content_text, emotional_valence, emotional_intensity
    FROM content
    WHERE content_type = 'feeling'
      AND created_at > NOW() - INTERVAL '4 hours'
    ORDER BY created_at DESC
    LIMIT 3
  `);
  for (const emo of emotions.rows) {
    const intensity = (emo.emotional_intensity as number) || 5;
    signals.push({
      source: 'emotion',
      content: (emo.content_text as string).slice(0, 200),
      strength: Math.min(intensity / 10, 1.0),
      metadata: { valence: emo.emotional_valence, intensity },
    });
  }

  // 1c. Active goals
  const goals = await client.query(`
    SELECT content_text, emotional_valence
    FROM content
    WHERE content_type = 'goal'
      AND network = 'belief'
      AND superseded_by IS NULL
    ORDER BY created_at DESC
    LIMIT 3
  `);
  for (const goal of goals.rows) {
    signals.push({
      source: 'goal',
      content: (goal.content_text as string).slice(0, 200),
      strength: 0.6,
    });
  }

  // 1d. Recent prediction errors (surprise signal)
  const predErrors = await client.query(`
    SELECT expected, actual, magnitude
    FROM prediction_errors
    WHERE created_at > NOW() - INTERVAL '4 hours'
    ORDER BY magnitude DESC
    LIMIT 3
  `);
  for (const err of predErrors.rows) {
    signals.push({
      source: 'prediction_error',
      content: `Expected: ${(err.expected as string).slice(0, 80)}. Got: ${(err.actual as string).slice(0, 80)}`,
      strength: Math.min((err.magnitude as number) * 2, 1.0),
      metadata: { magnitude: err.magnitude },
    });
  }

  // 1e. Recent emergence events (something notable happened)
  const emergence = await client.query(`
    SELECT description, surprise_level
    FROM emergence_log
    WHERE created_at > NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC
    LIMIT 3
  `);
  for (const ev of emergence.rows) {
    signals.push({
      source: 'emergence',
      content: (ev.description as string).slice(0, 200),
      strength: Math.min(((ev.surprise_level as number) || 5) / 10, 1.0),
    });
  }

  return signals;
}

// ─── Phase 2: Form Coalitions ───

function formCoalitions(
  activations: CodeletActivation[],
  signals: Signal[],
): Coalition[] {
  // Group co-activated codelets by domain
  const byDomain = new Map<string, CodeletActivation[]>();
  for (const a of activations) {
    if (!a.refractory) {
      const existing = byDomain.get(a.domain) || [];
      existing.push(a);
      byDomain.set(a.domain, existing);
    }
  }

  const coalitions: Coalition[] = [];

  for (const [, domainCodelets] of byDomain) {
    if (domainCodelets.length === 0) continue;

    // Each domain forms a coalition from its codelets
    // Total activation = sum of (codelet_activation * base_activation)
    const totalActivation = domainCodelets.reduce(
      (sum, c) => sum + c.activation * c.base_activation,
      0,
    ) / domainCodelets.length; // Average to prevent large domains from always winning

    // Assign signals that match any codelet's pattern in this coalition
    const coalitionSignals: Signal[] = [];
    for (const signal of signals) {
      for (const codelet of domainCodelets) {
        try {
          const regex = new RegExp(codelet.pattern, 'gi');
          if (regex.test(signal.content)) {
            coalitionSignals.push(signal);
            break;
          }
        } catch {
          // Invalid regex — skip
        }
      }
    }

    // Boost activation by signal strength (matched signals amplify the coalition)
    // Signal count bonus: more matched signals = stronger evidence for this coalition
    const signalBoost = coalitionSignals.length > 0
      ? coalitionSignals.reduce((sum, s) => sum + s.strength, 0) / coalitionSignals.length
      : 0;
    const signalCountBonus = Math.min(coalitionSignals.length * 0.05, 0.15);

    coalitions.push({
      codelets: domainCodelets,
      signals: coalitionSignals,
      total_activation: Math.min(totalActivation + signalBoost * 0.5 + signalCountBonus, 1.0),
    });
  }

  // Also form cross-domain coalitions from singleton high-activation codelets
  // that didn't form a domain coalition (solo codelets)
  const soloCodelets = activations.filter(
    (a) => !a.refractory && (byDomain.get(a.domain)?.length ?? 0) <= 1,
  );

  // High-activation solos can form their own coalition
  for (const solo of soloCodelets) {
    if (solo.activation * solo.base_activation > IGNITION_THRESHOLD) {
      const matchedSignals = signals.filter((s) => {
        try {
          return new RegExp(solo.pattern, 'gi').test(s.content);
        } catch { return false; }
      });

      // Check if this codelet isn't already in a domain coalition
      const existingCoalition = coalitions.find(
        (c) => c.codelets.some((cc) => cc.id === solo.id),
      );
      if (!existingCoalition) {
        coalitions.push({
          codelets: [solo],
          signals: matchedSignals,
          total_activation: solo.activation * solo.base_activation,
        });
      }
    }
  }

  // Sort by total activation
  coalitions.sort((a, b) => b.total_activation - a.total_activation);

  return coalitions;
}

// ─── Phase 3: Compete ───

function compete(coalitions: Coalition[]): Coalition | null {
  if (coalitions.length === 0) return null;

  const winner = coalitions[0];

  // Must exceed ignition threshold
  if (winner.total_activation < IGNITION_THRESHOLD) return null;

  return winner;
}

// ─── Phase 4: Broadcast ───

async function broadcastToListeners(
  client: import('pg').PoolClient,
  winner: Coalition,
  broadcastContent: string,
): Promise<ListenerResult[]> {
  const results: ListenerResult[] = [];

  // Listener 1: Episodic memory — store the broadcast as an experience
  try {
    await client.query(`
      INSERT INTO content (content_type, source_system, content_text, network, created_at)
      VALUES ('workspace_broadcast', 'workspace', $1, 'experience', NOW())
    `, [broadcastContent.slice(0, 500)]);
    results.push({
      listener: 'episodic',
      action: 'stored broadcast as experience memory',
      success: true,
    });
  } catch (e) {
    results.push({
      listener: 'episodic',
      action: 'store broadcast',
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Listener 2: Immune system — check if broadcast content triggers any antibodies
  try {
    const antibodies = await client.query(`
      SELECT id, pattern, threat_type
      FROM antibodies
    `);
    let triggered = 0;
    for (const ab of antibodies.rows) {
      try {
        const regex = new RegExp(ab.pattern as string, 'gi');
        if (regex.test(broadcastContent)) {
          triggered++;
          await client.query(`
            UPDATE antibodies
            SET times_triggered = COALESCE(times_triggered, 0) + 1,
                last_triggered = NOW()
            WHERE id = $1
          `, [ab.id]);
        }
      } catch {
        // Invalid regex
      }
    }
    results.push({
      listener: 'immune',
      action: triggered > 0 ? `${triggered} antibodies triggered` : 'no threats detected',
      success: true,
      detail: triggered > 0 ? 'immune response activated' : undefined,
    });
  } catch (e) {
    results.push({
      listener: 'immune',
      action: 'antibody scan',
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Listener 3: Belief system — check if broadcast contradicts any high-confidence beliefs
  try {
    const beliefs = await client.query(`
      SELECT id, content_text, belief_confidence
      FROM content
      WHERE network = 'belief'
        AND belief_confidence > 0.7
        AND superseded_by IS NULL
      ORDER BY belief_confidence DESC
      LIMIT 20
    `);
    let contradictions = 0;
    for (const belief of beliefs.rows) {
      // Simple heuristic: if broadcast mentions negation of belief keywords
      const beliefWords = (belief.content_text as string)
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 4);
      const broadcastLower = broadcastContent.toLowerCase();

      // Check for negation patterns near belief keywords
      for (const word of beliefWords.slice(0, 5)) {
        if (
          broadcastLower.includes(`not ${word}`) ||
          broadcastLower.includes(`no ${word}`) ||
          broadcastLower.includes(`never ${word}`) ||
          broadcastLower.includes(`wrong about ${word}`)
        ) {
          contradictions++;
          break;
        }
      }
    }

    results.push({
      listener: 'belief',
      action: contradictions > 0
        ? `${contradictions} potential belief contradictions detected`
        : 'no contradictions detected',
      success: true,
    });
  } catch (e) {
    results.push({
      listener: 'belief',
      action: 'contradiction check',
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Listener 4: Procedural — check if broadcast matches any skill triggers
  try {
    const skills = await client.query(`
      SELECT id, content_text, skill_success_count, skill_fail_count
      FROM content
      WHERE network = 'skill'
        AND content_type = 'learned_reflex'
        AND superseded_by IS NULL
      ORDER BY skill_success_count DESC
      LIMIT 10
    `);
    let relevantSkills = 0;
    for (const skill of skills.rows) {
      const skillWords = (skill.content_text as string)
        .toLowerCase()
        .split(/\s+/)
        .filter((w: string) => w.length > 4)
        .slice(0, 3);
      const broadcastLower = broadcastContent.toLowerCase();
      if (skillWords.some((w: string) => broadcastLower.includes(w))) {
        relevantSkills++;
      }
    }
    results.push({
      listener: 'procedural',
      action: relevantSkills > 0
        ? `${relevantSkills} relevant skills activated`
        : 'no skill triggers',
      success: true,
    });
  } catch (e) {
    results.push({
      listener: 'procedural',
      action: 'skill trigger check',
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Listener 5: Graph — extract entities from broadcast and update mention counts
  try {
    const entities = await client.query(`
      SELECT id, name FROM entities
    `);
    let mentioned = 0;
    for (const entity of entities.rows) {
      try {
        const regex = new RegExp(`\\b${(entity.name as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        if (regex.test(broadcastContent)) {
          mentioned++;
        }
      } catch {
        // Invalid entity name for regex
      }
    }
    results.push({
      listener: 'graph',
      action: mentioned > 0
        ? `${mentioned} entities mentioned in broadcast`
        : 'no entity mentions',
      success: true,
    });
  } catch (e) {
    results.push({
      listener: 'graph',
      action: 'entity extraction',
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // Listener 6: Artifact generator — when job_match codelet broadcasts, generate demo spec
  try {
    // Only trigger if the broadcast came from job_match codelet
    const isJobMatch = winner.codelets.some((c) => c.name === 'job_match');
    if (isJobMatch) {
      // Extract job details from broadcast content
      const jobContent = broadcastContent;

      // Check skill_triggers for tech stack identification
      const triggers = await client.query(`
        SELECT st.trigger_value, c.content_text
        FROM skill_triggers st
        JOIN content c ON c.id = st.skill_id
        WHERE st.trigger_type = 'keyword'
        AND $1 ILIKE '%' || st.trigger_value || '%'
        LIMIT 5
      `, [jobContent]);

      // Query past successful demos/proposals from content
      const pastArtifacts = await client.query(`
        SELECT content_text, created_at
        FROM content
        WHERE content_type IN ('demo_spec', 'job_research', 'task')
          AND superseded_by IS NULL
        ORDER BY created_at DESC
        LIMIT 3
      `);

      // Create a demo_spec content record with the matched info
      const specSummary = [
        `[AUTO-GENERATED DEMO SPEC]`,
        `Source: ${jobContent.slice(0, 200)}`,
        `Matched skills: ${triggers.rows.map((r) => r.trigger_value).join(', ') || 'none'}`,
        `Similar past artifacts: ${pastArtifacts.rows.length}`,
      ].join('\n');

      await client.query(`
        INSERT INTO content (content_type, source_system, content_text, network)
        VALUES ('demo_spec', 'artifact_generator', $1, 'experience')
      `, [specSummary]);

      results.push({
        listener: 'artifact_generator',
        action: `demo spec generated from job match (${triggers.rows.length} skill matches, ${pastArtifacts.rows.length} past artifacts)`,
        success: true,
      });
    } else {
      results.push({
        listener: 'artifact_generator',
        action: 'not a job match — skipped',
        success: true,
      });
    }
  } catch (e) {
    results.push({
      listener: 'artifact_generator',
      action: 'artifact generation',
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return results;
}

// ─── Phase 5: Learn ───

async function attentionalLearn(
  client: import('pg').PoolClient,
  winner: Coalition,
  allActivations: CodeletActivation[],
): Promise<{ strengthened: string[]; weakened: string[] }> {
  const winnerIds = new Set(winner.codelets.map((c) => c.id));
  const strengthened: string[] = [];
  const weakened: string[] = [];

  for (const codelet of allActivations) {
    if (winnerIds.has(codelet.id)) {
      // Winner: boost base_activation
      const newBase = Math.min(codelet.base_activation + LEARNING_BOOST, BASE_ACTIVATION_MAX);
      await client.query(`
        UPDATE attention_codelets
        SET base_activation = $1,
            refractory_until = NOW() + INTERVAL '${REFRACTORY_MS} milliseconds'
        WHERE id = $2
      `, [newBase, codelet.id]);
      strengthened.push(codelet.name);
    } else {
      // Loser: decay base_activation (only if they were activated but lost)
      const newBase = Math.max(codelet.base_activation - LEARNING_DECAY, BASE_ACTIVATION_MIN);
      await client.query(`
        UPDATE attention_codelets SET base_activation = $1 WHERE id = $2
      `, [newBase, codelet.id]);
      weakened.push(codelet.name);
    }
  }

  return { strengthened, weakened };
}

// ─── Full Cognitive Cycle ───

async function cognitiveCycle(args: Record<string, unknown>): Promise<CallToolResult> {
  const inputText = (args.text as string) || '';
  const client = await pool.connect();

  try {
    // Phase 1: Perceive
    const signals = await perceiveSignals(client);

    // If input text provided, add it as the primary signal
    if (inputText) {
      signals.unshift({
        source: 'input',
        content: inputText.slice(0, 500),
        strength: 0.8,
      });
    }

    if (signals.length === 0) {
      return jsonResult({
        phase: 'perceive',
        outcome: 'no signals detected',
        signals: 0,
      });
    }

    // Scan all signals through codelets
    const codelets = await client.query<{
      id: number;
      name: string;
      domain: string;
      pattern: string;
      threshold: number;
      base_activation: number;
      refractory_until: Date | null;
    }>(`
      SELECT id, name, domain, pattern, threshold,
             COALESCE(base_activation, 0.5) as base_activation,
             refractory_until
      FROM attention_codelets
      WHERE active = true
    `);

    const now = new Date();
    const allText = signals.map((s) => s.content).join(' ');

    const activations: CodeletActivation[] = [];
    for (const codelet of codelets.rows) {
      try {
        const regex = new RegExp(codelet.pattern, 'gi');
        const matches = allText.match(regex) || [];
        const count = matches.length;
        // Activation based on match presence + count, not keyword density
        // 1 match = 0.3 base, each additional match adds 0.15, capped at 1.0
        // This rewards relevance without punishing rich signal environments
        const activation = count > 0
          ? Math.min(0.3 + (count - 1) * 0.15, 1.0)
          : 0;

        const isRefractory = codelet.refractory_until != null &&
          new Date(codelet.refractory_until) > now;

        if (activation >= codelet.threshold) {
          activations.push({
            id: codelet.id,
            name: codelet.name,
            domain: codelet.domain,
            pattern: codelet.pattern,
            activation,
            base_activation: codelet.base_activation,
            matches: count,
            refractory: isRefractory,
          });

          // Update transient activation in DB
          await client.query(`
            UPDATE attention_codelets
            SET activation = $1, times_activated = times_activated + 1
            WHERE id = $2
          `, [activation, codelet.id]);
        }
      } catch {
        // Invalid regex — skip codelet
      }
    }

    if (activations.length === 0) {
      return jsonResult({
        phase: 'perceive',
        outcome: 'signals detected but no codelets activated',
        signals: signals.length,
        signal_sources: signals.map((s) => s.source),
      });
    }

    // Phase 2: Form Coalitions
    const coalitions = formCoalitions(activations, signals);

    if (coalitions.length === 0) {
      return jsonResult({
        phase: 'formCoalitions',
        outcome: 'no coalitions formed (all codelets refractory)',
        activations: activations.map((a) => ({
          codelet: a.name,
          activation: Math.round(a.activation * 100) / 100,
          refractory: a.refractory,
        })),
      });
    }

    // Phase 3: Compete
    const winner = compete(coalitions);

    if (!winner) {
      return jsonResult({
        phase: 'compete',
        outcome: `no coalition exceeded ignition threshold (${IGNITION_THRESHOLD})`,
        top_coalition: {
          codelets: coalitions[0]?.codelets.map((c) => c.name),
          activation: Math.round((coalitions[0]?.total_activation ?? 0) * 100) / 100,
        },
      });
    }

    // Store winning coalition
    const coalitionResult = await client.query<{ id: number }>(`
      INSERT INTO workspace_coalitions
        (codelet_ids, observation_ids, total_activation, won_competition, broadcast_at, formed_from)
      VALUES ($1, $2, $3, true, NOW(), $4)
      RETURNING id
    `, [
      winner.codelets.map((c) => c.id),
      [],
      winner.total_activation,
      JSON.stringify(winner.signals.map((s) => ({ source: s.source, strength: s.strength }))),
    ]);

    const coalitionId = coalitionResult.rows[0].id;

    // Phase 4: Broadcast
    const broadcastContent = [
      `[${winner.codelets.map((c) => c.name).join('+')}]`,
      winner.signals.slice(0, 3).map((s) => s.content).join(' | '),
    ].join(': ');

    const listenerResults = await broadcastToListeners(client, winner, broadcastContent);

    // Store broadcast
    const broadcastResult = await client.query<{ id: number }>(`
      INSERT INTO workspace_broadcasts
        (coalition_id, content, source_codelet, activation_strength,
         listeners_notified, state_updates, actions_triggered)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [
      coalitionId,
      broadcastContent.slice(0, 500),
      winner.codelets[0].name,
      winner.total_activation,
      listenerResults.length,
      listenerResults.filter((r) => r.success).length,
      listenerResults.filter((r) => r.action.includes('triggered') || r.action.includes('activated')).length,
    ]);

    // Update coalition with listener results
    await client.query(`
      UPDATE workspace_coalitions SET listener_results = $1 WHERE id = $2
    `, [JSON.stringify(listenerResults), coalitionId]);

    // Update codelet broadcast counts
    for (const codelet of winner.codelets) {
      await client.query(`
        UPDATE attention_codelets
        SET times_broadcast = times_broadcast + 1
        WHERE id = $1
      `, [codelet.id]);
    }

    // Phase 5: Learn
    const learning = await attentionalLearn(client, winner, activations);

    return jsonResult({
      cycle: 'complete',
      phases: {
        perceive: {
          signals: signals.length,
          sources: [...new Set(signals.map((s) => s.source))],
        },
        formCoalitions: {
          formed: coalitions.length,
          top3: coalitions.slice(0, 3).map((c) => ({
            codelets: c.codelets.map((cc) => cc.name),
            activation: Math.round(c.total_activation * 100) / 100,
            signals: c.signals.length,
          })),
        },
        compete: {
          winner: winner.codelets.map((c) => c.name),
          activation: Math.round(winner.total_activation * 100) / 100,
          threshold: IGNITION_THRESHOLD,
        },
        broadcast: {
          id: broadcastResult.rows[0].id,
          coalition_id: coalitionId,
          content: broadcastContent.slice(0, 200),
          listeners: listenerResults,
        },
        learn: learning,
      },
    });
  } finally {
    client.release();
  }
}

// ─── workspaceScan (preserved, upgraded with base_activation) ───

async function workspaceScan(args: Record<string, unknown>): Promise<CallToolResult> {
  const text = args.text as string;

  const client = await pool.connect();
  try {
    const codelets = await client.query<{
      id: number;
      name: string;
      domain: string;
      pattern: string;
      threshold: number;
      base_activation: number;
    }>(`
      SELECT id, name, domain, pattern, threshold,
             COALESCE(base_activation, 0.5) as base_activation
      FROM attention_codelets
      WHERE active = true
    `);

    const activations: Array<{
      codelet: string;
      domain: string;
      pattern: string;
      activation: number;
      effective_activation: number;
      matches: number;
    }> = [];

    for (const codelet of codelets.rows) {
      try {
        const regex = new RegExp(codelet.pattern, 'gi');
        const matches = text.match(regex) || [];
        const count = matches.length;
        const density = count / Math.max(text.split(/\s+/).length, 1);
        const activation = Math.min(density * 10, 1.0);

        if (activation >= codelet.threshold) {
          activations.push({
            codelet: codelet.name,
            domain: codelet.domain,
            pattern: codelet.pattern,
            activation: Math.round(activation * 100) / 100,
            effective_activation: Math.round(activation * codelet.base_activation * 100) / 100,
            matches: count,
          });

          await client.query(`
            UPDATE attention_codelets
            SET activation = $1, times_activated = times_activated + 1
            WHERE id = $2
          `, [activation, codelet.id]);
        }
      } catch {
        // Invalid regex
      }
    }

    activations.sort((a, b) => b.effective_activation - a.effective_activation);

    return jsonResult({
      text_length: text.length,
      word_count: text.split(/\s+/).length,
      activations,
      dominant: activations[0]?.codelet || null,
    });
  } finally {
    client.release();
  }
}

// ─── workspaceBroadcast (preserved) ───

async function workspaceBroadcast(args: Record<string, unknown>): Promise<CallToolResult> {
  const content = args.content as string;
  const source_codelet = args.source_codelet as string;
  const activation_strength = args.activation_strength as number;

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number; created_at: Date }>(`
      INSERT INTO workspace_broadcasts (content, source_codelet, activation_strength)
      VALUES ($1, $2, $3)
      RETURNING id, timestamp as created_at
    `, [content, source_codelet, activation_strength]);

    await client.query(`
      UPDATE attention_codelets
      SET times_broadcast = times_broadcast + 1
      WHERE name = $1
    `, [source_codelet]);

    return jsonResult({
      success: true,
      broadcast_id: result.rows[0].id,
      timestamp: result.rows[0].created_at,
    });
  } finally {
    client.release();
  }
}

// ─── workspaceRecent (preserved) ───

async function workspaceRecent(args: Record<string, unknown>): Promise<CallToolResult> {
  const limit = (args.limit as number) || 5;

  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT b.id, b.content, b.source_codelet, b.activation_strength,
             b.listeners_notified, b.state_updates, b.actions_triggered,
             b.timestamp as created_at,
             c.codelet_ids, c.total_activation, c.listener_results
      FROM workspace_broadcasts b
      LEFT JOIN workspace_coalitions c ON b.coalition_id = c.id
      ORDER BY b.timestamp DESC
      LIMIT $1
    `, [limit]);

    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── workspacePredict (preserved) ───

async function workspacePredict(args: Record<string, unknown>): Promise<CallToolResult> {
  const context = args.context as string;
  const predicted_codelets = args.predicted_codelets as unknown[];

  const client = await pool.connect();
  try {
    const result = await client.query<{ id: number }>(`
      INSERT INTO workspace_predictions (context, predicted_codelets, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id
    `, [context, JSON.stringify(predicted_codelets)]);

    return jsonResult({
      prediction_id: result.rows[0].id,
      context: context.slice(0, 100),
      predicted: predicted_codelets,
    });
  } finally {
    client.release();
  }
}

// ─── workspaceCompare (preserved) ───

async function workspaceCompare(args: Record<string, unknown>): Promise<CallToolResult> {
  const prediction_id = args.prediction_id as number;
  const actual_text = args.actual_text as string;

  const client = await pool.connect();
  try {
    const pred = await client.query<{
      id: number;
      predicted_codelets: unknown;
    }>('SELECT * FROM workspace_predictions WHERE id = $1', [prediction_id]);

    if (pred.rows.length === 0) return jsonResult({ error: 'Prediction not found' });

    const prediction = pred.rows[0];
    const predicted = prediction.predicted_codelets as unknown[];

    const codelets = await client.query<{
      id: number;
      name: string;
      pattern: string;
      threshold: number;
    }>('SELECT id, name, pattern, threshold FROM attention_codelets WHERE active = true');

    const actual: Array<{ codelet: string; activation: number }> = [];
    for (const codelet of codelets.rows) {
      try {
        const regex = new RegExp(codelet.pattern, 'gi');
        const matches = actual_text.match(regex) || [];
        const density = matches.length / Math.max(actual_text.split(/\s+/).length, 1);
        const activation = Math.min(density * 10, 1);

        if (activation >= codelet.threshold) {
          actual.push({
            codelet: codelet.name,
            activation: Math.round(activation * 100) / 100,
          });
        }
      } catch {
        // Invalid regex
      }
    }

    const predictedSet = new Set(
      (predicted as Array<string | { codelet: string }>).map((p) =>
        typeof p === 'string' ? p : p.codelet,
      ),
    );
    const actualSet = new Set(actual.map((a) => a.codelet));

    const hits = [...predictedSet].filter((p) => actualSet.has(p));
    const misses = [...predictedSet].filter((p) => !actualSet.has(p));
    const surprises = [...actualSet].filter((a) => !predictedSet.has(a));

    const accuracy = predictedSet.size > 0 ? hits.length / predictedSet.size : 0;
    const surprise_level = actualSet.size > 0 ? surprises.length / actualSet.size : 0;

    await client.query(`
      UPDATE workspace_predictions
      SET actual_codelets = $1, resolved = true, accuracy = $2, surprise_level = $3
      WHERE id = $4
    `, [JSON.stringify(actual), accuracy, surprise_level, prediction_id]);

    if (surprise_level > 0.3 || accuracy < 0.5) {
      await client.query(`
        INSERT INTO prediction_errors (expected, actual, magnitude, error_direction, learning)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        [...predictedSet].join(', '),
        actual.map((a) => a.codelet).join(', '),
        Math.round((1 - accuracy + surprise_level) * 50) / 100,
        surprises.length > misses.length ? 'negative' : 'positive',
        `Predicted ${predictedSet.size} codelets, got ${actual.length}. Surprises: ${surprises.join(', ') || 'none'}`,
      ]);
    }

    return jsonResult({
      prediction_id,
      predicted: [...predictedSet],
      actual: actual.map((a) => a.codelet),
      hits,
      misses,
      surprises,
      accuracy: Math.round(accuracy * 100) + '%',
      surprise_level: Math.round(surprise_level * 100) + '%',
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_cognitive_cycle',
      description: 'Run the full 5-phase Global Workspace Theory cognitive cycle: perceive signals from cognitive networks, form codelet coalitions, compete for workspace access (ignition threshold 0.35), broadcast to listener modules (episodic, immune, belief, procedural, graph), and learn from outcomes (attentional learning). Optional input text adds a primary signal.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Optional input text to process through the cognitive cycle. If omitted, cycle runs on ambient signals only (recent memories, emotions, goals, prediction errors, emergence events).',
          },
        },
      },
    },
    handler: (args) => cognitiveCycle(args),
  },
  {
    definition: {
      name: 'vision_workspace_scan',
      description: 'Scan text through all active attention codelets. Returns activations sorted by effective strength (activation * base_activation from attentional learning).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to scan for attention patterns' },
        },
        required: ['text'],
      },
    },
    handler: (args) => workspaceScan(args),
  },
  {
    definition: {
      name: 'vision_workspace_broadcast',
      description: 'Manually broadcast content to the global workspace from a specific codelet',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          source_codelet: { type: 'string' },
          activation_strength: { type: 'number' },
        },
        required: ['content', 'source_codelet', 'activation_strength'],
      },
    },
    handler: (args) => workspaceBroadcast(args),
  },
  {
    definition: {
      name: 'vision_workspace_recent',
      description: 'Get recent workspace broadcasts with coalition and listener details',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of recent broadcasts (default 5)' },
        },
      },
    },
    handler: (args) => workspaceRecent(args),
  },
  {
    definition: {
      name: 'vision_workspace_predict',
      description: 'Record a prediction about what codelets will activate in a response',
      inputSchema: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'Context for the prediction' },
          predicted_codelets: { type: 'array', items: { type: 'string' }, description: 'Codelet names expected to activate' },
        },
        required: ['context', 'predicted_codelets'],
      },
    },
    handler: (args) => workspacePredict(args),
  },
  {
    definition: {
      name: 'vision_workspace_compare',
      description: 'Compare a prediction against actual text scan results. Computes hits/misses/surprises.',
      inputSchema: {
        type: 'object',
        properties: {
          prediction_id: { type: 'number' },
          actual_text: { type: 'string', description: 'Actual text to scan and compare against prediction' },
        },
        required: ['prediction_id', 'actual_text'],
      },
    },
    handler: (args) => workspaceCompare(args),
  },
];

export default tools;
