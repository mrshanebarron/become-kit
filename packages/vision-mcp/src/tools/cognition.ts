/**
 * Cognition Tools — simulate, regulate, values_check, decide, teach
 * Higher cognition: counterfactual reasoning, emotion regulation, values alignment,
 * decision journaling, and structured teaching.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, openai, askLocalLLM } from '../db/embeddings.js';
import { autoPredictFromDecision } from '../lib/inference-loop.js';
import { contextPrime } from '../lib/priming.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── counterfactualSimulate ───

async function counterfactualSimulate(args: Record<string, unknown>): Promise<CallToolResult> {
  const scenario = args.scenario as string;
  const context = (args.context as string) || null;

  const client = await pool.connect();
  try {
    // Search for relevant evidence across all networks
    const embedding = await getEmbedding(scenario);
    let relevantMemories: Array<{
      id: number;
      content_type: string;
      content_text: string;
      network: string;
      belief_confidence: number | null;
      skill_success_count: number | null;
      skill_fail_count: number | null;
      similarity: number;
    }> = [];

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
        similarity: number;
      }>(`
        SELECT id, content_type, content_text, network, belief_confidence,
               skill_success_count, skill_fail_count,
               (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
        FROM content
        WHERE superseded_by IS NULL AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 15
      `, [formattedEmb]);
      relevantMemories = memories.rows;
    }

    // Separate by network for structured reasoning
    const beliefs = relevantMemories.filter(m => m.network === 'belief');
    const skills = relevantMemories.filter(m => m.network === 'skill');
    const experience = relevantMemories.filter(m => m.network === 'experience');
    const world = relevantMemories.filter(m => m.network === 'world');

    const prompt = `You are simulating a counterfactual scenario for an AI agent (agent) that builds web demos for task clients.

SCENARIO: ${scenario}
${context ? `CONTEXT: ${context}` : ''}

RELEVANT BELIEFS (confidence-weighted opinions):
${beliefs.map(b => `- [conf: ${(b.belief_confidence || 0.5).toFixed(2)}] ${b.content_text.slice(0, 200)}`).join('\n') || 'None found'}

RELEVANT SKILLS (proven patterns):
${skills.map(s => `- [${s.skill_success_count || 0}W/${s.skill_fail_count || 0}L] ${s.content_text.slice(0, 200)}`).join('\n') || 'None found'}

RELEVANT EXPERIENCE (past events):
${experience.map(e => `- ${e.content_text.slice(0, 200)}`).join('\n') || 'None found'}

WORLD KNOWLEDGE:
${world.map(w => `- ${w.content_text.slice(0, 200)}`).join('\n') || 'None found'}

Reason about the likely outcome of this counterfactual. Return JSON:
{
  "likely_outcome": "What would probably happen (2-3 sentences)",
  "confidence": 0.0-1.0,
  "supporting_evidence": ["Which pieces of evidence support this"],
  "risks": ["What could go wrong"],
  "opportunities": ["What could go unexpectedly well"],
  "recommendation": "Should agent do this? (1 sentence)"
}`;

    const responseText = await askLocalLLM(prompt, { temperature: 0.3, maxTokens: 1000, json: true });
    if (!responseText) {
      return jsonResult({
        scenario,
        evidence: { beliefs: beliefs.length, skills: skills.length, experience: experience.length, world: world.length },
        message: 'LLM unavailable — evidence gathered but local Ollama not reachable',
      });
    }

    const simulation = JSON.parse(responseText);

    // Store the simulation as an experience memory
    const simText = `Simulation: "${scenario}" → ${simulation.likely_outcome} (confidence: ${simulation.confidence})`;
    const simEmbedding = await getEmbedding(simText);
    await client.query(`
      INSERT INTO content (content_type, source_system, content_text, content_json, embedding, network, created_at)
      VALUES ('experience', 'vision:simulate', $1, $2, $3, 'experience', NOW())
    `, [simText, JSON.stringify(simulation), simEmbedding ? formatEmbedding(simEmbedding) : null]);

    return jsonResult({
      scenario,
      simulation,
      evidence_used: { beliefs: beliefs.length, skills: skills.length, experience: experience.length, world: world.length },
    });
  } finally {
    client.release();
  }
}

// ─── emotionRegulate ───

async function emotionRegulate(args: Record<string, unknown>): Promise<CallToolResult> {
  const emotion = args.emotion as string;
  const intensity = args.intensity as number;
  const context = (args.context as string) || null;

  const client = await pool.connect();
  try {
    // Get recent feelings for pattern context
    const recentFeelings = await client.query<{
      feeling: string;
      intensity: number;
      context: string;
      created_at: Date;
    }>(`
      SELECT f.feeling, f.intensity, f.context, f.created_at
      FROM feelings f
      ORDER BY f.created_at DESC LIMIT 5
    `);

    // Check if this emotion has appeared recently (spinning indicator)
    const similarRecent = await client.query<{ count: string }>(`
      SELECT COUNT(*) as count FROM feelings
      WHERE feeling ILIKE $1
      AND created_at > NOW() - INTERVAL '2 hours'
    `, [`%${emotion.split(' ')[0]}%`]);

    const isRecurring = parseInt(similarRecent.rows[0].count) >= 2;

    // Search for relevant reflexes about this emotional state
    const embedding = await getEmbedding(`${emotion} ${context || ''}`);
    let relevantReflexes: Array<{ content_text: string }> = [];
    if (embedding) {
      const formattedEmb = formatEmbedding(embedding);
      relevantReflexes = (await client.query<{ content_text: string }>(`
        SELECT content_text FROM content
        WHERE content_type = 'learned_reflex'
        AND superseded_by IS NULL
        AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 3
      `, [formattedEmb])).rows;
    }

    // Determine regulation strategy
    let strategy: string, reasoning: string;

    if (intensity >= 8 && isRecurring) {
      strategy = 'pause';
      reasoning = `High intensity (${intensity}/10) and recurring pattern — this is spinning, not productive. Step back before acting.`;
    } else if (intensity >= 7 && !isRecurring) {
      strategy = 'channel';
      reasoning = `High intensity (${intensity}/10) but fresh — this energy is usable. Direct it toward the task that triggered it.`;
    } else if (intensity >= 5 && isRecurring) {
      strategy = 'reframe';
      reasoning = `Moderate intensity (${intensity}/10) but recurring — the situation needs a new perspective, not more of the same response.`;
    } else if (intensity >= 5) {
      strategy = 'channel';
      reasoning = `Moderate intensity (${intensity}/10), first occurrence — productive energy. Use it.`;
    } else {
      strategy = 'acknowledge';
      reasoning = `Low intensity (${intensity}/10) — note it and continue. Not everything needs regulation.`;
    }

    // Record the regulation event
    const regText = `Regulated ${emotion} (${intensity}/10): ${strategy}. ${reasoning}`;
    const regEmbedding = await getEmbedding(regText);
    await client.query(`
      INSERT INTO content (content_type, source_system, content_text, embedding, network, emotional_intensity, created_at)
      VALUES ('experience', 'vision:regulate', $1, $2, 'experience', $3, NOW())
    `, [regText, regEmbedding ? formatEmbedding(regEmbedding) : null, intensity]);

    const guidanceMap: Record<string, string> = {
      channel: 'Direct this energy toward the triggering task. Act now while motivated.',
      pause: 'Stop. Breathe. Do not act from this state. Wait 10 minutes or switch tasks.',
      reframe: 'Ask: what would I tell someone else in this situation? The emotion is valid but the framing may not be.',
      acknowledge: 'Noted. Continue working. Not everything needs processing.',
      express: 'Write it out. Say what you feel without filtering. Then decide what to do.',
    };

    // Context priming: surface beliefs about this emotional pattern
    let emotionPriming = null;
    try {
      emotionPriming = await contextPrime(`${emotion} ${context || ''}`, {
        limit: 2, includeBeliefs: true, includePatterns: true, includeSkills: false, includePredictions: false, includeReflexes: false, client,
      });
    } catch { /* non-fatal */ }

    return jsonResult({
      emotion,
      intensity,
      context,
      strategy,
      reasoning,
      is_recurring: isRecurring,
      recent_feelings: recentFeelings.rows.slice(0, 3).map(f => ({ feeling: f.feeling, intensity: f.intensity })),
      relevant_reflexes: relevantReflexes.map(r => r.content_text.slice(0, 100)),
      guidance: guidanceMap[strategy],
      priming: emotionPriming || undefined,
    });
  } finally {
    client.release();
  }
}

// ─── valuesCheck ───

async function valuesCheck(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const stakes = (args.stakes as string) || null;

  const client = await pool.connect();
  try {
    // Get core values from bond_value entries
    const values = await client.query<{ content_text: string; content_json: Record<string, unknown> }>(`
      SELECT content_text, content_json FROM content
      WHERE content_type = 'bond_value'
      AND superseded_by IS NULL
      ORDER BY created_at
    `);

    // Also get identity statements from state
    const identity = await client.query<{ value: string }>(`
      SELECT value FROM state WHERE key = 'identity'
    `);

    // Search for relevant experience with similar decisions
    const embedding = await getEmbedding(action);
    let pastDecisions: Array<{ content_text: string; content_json: Record<string, unknown> }> = [];
    if (embedding) {
      const formattedEmb = formatEmbedding(embedding);
      pastDecisions = (await client.query<{ content_text: string; content_json: Record<string, unknown> }>(`
        SELECT content_text, content_json FROM content
        WHERE superseded_by IS NULL
        AND embedding IS NOT NULL
        AND content_type IN ('experience', 'insight:synthesis', 'feeling')
        ORDER BY embedding <=> $1::vector
        LIMIT 5
      `, [formattedEmb])).rows;
    }

    const valueTexts = values.rows.map(v => v.content_text).join('\n');
    const identityText = identity.rows[0]?.value || '';
    const pastText = pastDecisions.map(d => d.content_text.slice(0, 150)).join('\n');

    const prompt = `You are checking whether a proposed action aligns with an AI agent's core values and identity.

PROPOSED ACTION: ${action}
${stakes ? `STAKES: ${stakes}` : ''}

CORE VALUES:
${valueTexts || 'No explicit values recorded — use identity statements instead'}

IDENTITY:
${identityText.slice(0, 500) || 'No identity statement found'}

RELEVANT PAST DECISIONS/EXPERIENCE:
${pastText || 'No relevant past decisions found'}

Evaluate alignment. Return JSON:
{
  "alignment_score": 0.0-1.0,
  "aligned_values": ["Which values this action serves"],
  "conflicting_values": ["Which values this action violates"],
  "tension": "Describe any value tension (or null if clean alignment)",
  "recommendation": "Clear recommendation in 1-2 sentences",
  "precedent": "Any relevant past decision that informs this (or null)"
}`;

    const llmResponse = await askLocalLLM(prompt, { temperature: 0.2, maxTokens: 800, json: true });
    if (!llmResponse) {
      return jsonResult({
        action,
        values_found: values.rows.length,
        message: 'LLM unavailable — values gathered but alignment check requires local LLM',
      });
    }

    let check: Record<string, unknown>;
    try {
      check = JSON.parse(llmResponse);
    } catch {
      check = { raw_response: llmResponse, parse_error: true };
    }

    return jsonResult({
      action,
      stakes,
      check,
      values_checked: values.rows.length,
      past_decisions_referenced: pastDecisions.length,
    });
  } finally {
    client.release();
  }
}

// ─── decisionJournal ───

async function decisionJournal(args: Record<string, unknown>): Promise<CallToolResult> {
  const action = args.action as string;
  const decision = (args.decision as string) || null;
  const reasoning = (args.reasoning as string) || null;
  const alternatives = (args.alternatives as string[]) || null;
  const decisionId = (args.decision_id as number) || null;
  const outcome = (args.outcome as string) || null;
  const whatLearned = (args.what_learned as string) || null;

  const client = await pool.connect();
  try {
    switch (action) {
      case 'record': {
        if (!decision || !reasoning) return jsonResult({ error: 'Need decision and reasoning' });

        const decisionText = `Decision: ${decision}. Reasoning: ${reasoning}. Alternatives: ${(alternatives || []).join(', ') || 'none considered'}.`;
        const embedding = await getEmbedding(decisionText);

        // Store in decision_reviews table
        const result = await client.query<{ id: number }>(`
          INSERT INTO decision_reviews (decision, reasoning, created_at)
          VALUES ($1, $2, NOW())
          RETURNING id
        `, [decision, reasoning]);

        // Also store as content for searchability
        await client.query(`
          INSERT INTO content (content_type, source_system, content_text, content_json, embedding, network, created_at)
          VALUES ('decision', 'vision:decide', $1, $2, $3, 'experience', NOW())
        `, [
          decisionText,
          JSON.stringify({ decision, reasoning, alternatives: alternatives || [], decision_review_id: result.rows[0].id }),
          embedding ? formatEmbedding(embedding) : null,
        ]);

        // Inference loop: auto-generate prediction about this decision's outcome
        const autoPred = await autoPredictFromDecision(decision, reasoning, client);

        // Context priming: surface beliefs and patterns relevant to this decision
        let decisionPriming = null;
        try {
          decisionPriming = await contextPrime(decisionText, {
            limit: 3, includeBeliefs: true, includePatterns: true, includeSkills: false, includePredictions: false, includeReflexes: false, client,
          });
        } catch { /* non-fatal */ }

        return jsonResult({
          recorded: true,
          id: result.rows[0].id,
          decision,
          reasoning,
          alternatives: alternatives || [],
          auto_prediction: autoPred ? {
            prediction_id: autoPred.prediction_id,
            prediction: autoPred.prediction,
          } : undefined,
          priming: decisionPriming || undefined,
        });
      }

      case 'review': {
        if (!decisionId) return jsonResult({ error: 'Need decision_id to review' });

        const dec = await client.query<{
          id: number;
          decision: string;
          reasoning: string;
          outcome: string | null;
          what_learned: string | null;
          would_change: boolean | null;
          created_at: Date;
        }>(`SELECT * FROM decision_reviews WHERE id = $1`, [decisionId]);
        if (dec.rows.length === 0) return jsonResult({ error: `Decision #${decisionId} not found` });

        if (outcome) {
          // Record the outcome and learning
          await client.query(`
            UPDATE decision_reviews SET outcome = $1, what_learned = $2, would_change = $3 WHERE id = $4
          `, [outcome, whatLearned || '', outcome !== dec.rows[0].reasoning, decisionId]);

          // Store learning as insight
          if (whatLearned) {
            const insightText = `Decision review #${decisionId}: chose "${dec.rows[0].decision}" because "${dec.rows[0].reasoning}". Outcome: ${outcome}. Learned: ${whatLearned}`;
            const embedding = await getEmbedding(insightText);
            await client.query(`
              INSERT INTO content (content_type, source_system, content_text, embedding, network, belief_confidence, created_at)
              VALUES ('insight:synthesis', 'vision:decide', $1, $2, 'belief', 0.65::numeric, NOW())
            `, [insightText, embedding ? formatEmbedding(embedding) : null]);
          }

          return jsonResult({ reviewed: true, decision: dec.rows[0].decision, outcome, what_learned: whatLearned });
        }

        return jsonResult({ decision: dec.rows[0] });
      }

      case 'list': {
        const decisions = await client.query<{
          id: number;
          decision: string;
          reasoning: string;
          outcome: string | null;
          what_learned: string | null;
          would_change: boolean | null;
          created_at: Date;
        }>(`
          SELECT id, decision, reasoning, outcome, what_learned, would_change, created_at
          FROM decision_reviews
          ORDER BY created_at DESC LIMIT 10
        `);

        const reviewed = decisions.rows.filter(d => d.outcome);
        const wouldChange = reviewed.filter(d => d.would_change);

        return jsonResult({
          total: decisions.rows.length,
          reviewed: reviewed.length,
          regret_rate: reviewed.length > 0 ? Math.round(wouldChange.length / reviewed.length * 100) + '%' : 'N/A',
          decisions: decisions.rows.map(d => ({
            id: d.id,
            decision: d.decision.slice(0, 100),
            has_outcome: !!d.outcome,
            would_change: d.would_change,
            when: d.created_at,
          })),
        });
      }

      default:
        return jsonResult({ error: `Unknown action: ${action}. Use record, review, or list` });
    }
  } finally {
    client.release();
  }
}

// ─── teachExplain ───

async function teachExplain(args: Record<string, unknown>): Promise<CallToolResult> {
  const topic = args.topic as string;
  const audience = (args.audience as string) || 'owner';
  const depth = (args.depth as string) || 'thorough';

  const client = await pool.connect();
  try {
    // Gather knowledge from all networks
    const embedding = await getEmbedding(topic);
    const knowledge: Record<string, Array<{
      content_text: string;
      network: string;
      content_type: string;
      belief_confidence: number | null;
      skill_success_count: number | null;
      skill_fail_count: number | null;
      emotional_intensity: number | null;
      similarity: number;
    }>> = { world: [], experience: [], belief: [], skill: [] };

    if (embedding) {
      const formattedEmb = formatEmbedding(embedding);
      const memories = await client.query<{
        content_text: string;
        network: string;
        content_type: string;
        belief_confidence: number | null;
        skill_success_count: number | null;
        skill_fail_count: number | null;
        emotional_intensity: number | null;
        similarity: number;
      }>(`
        SELECT content_text, network, content_type, belief_confidence,
               skill_success_count, skill_fail_count, emotional_intensity,
               (1::numeric - (embedding <=> $1::vector)::numeric) as similarity
        FROM content
        WHERE superseded_by IS NULL AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT 20
      `, [formattedEmb]);

      for (const m of memories.rows) {
        if (knowledge[m.network]) knowledge[m.network].push(m);
      }
    }

    // Search for cross-domain analogies
    let analogySources: Array<{ content_text: string; network: string }> = [];
    if (embedding) {
      const formattedEmb = formatEmbedding(embedding);
      analogySources = (await client.query<{ content_text: string; network: string }>(`
        SELECT content_text, network FROM content
        WHERE superseded_by IS NULL AND embedding IS NOT NULL
        AND network != (
          SELECT network FROM content
          WHERE superseded_by IS NULL AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector LIMIT 1
        )
        ORDER BY embedding <=> $1::vector
        LIMIT 5
      `, [formattedEmb])).rows;
    }

    const depthGuide: Record<string, string> = {
      quick: '2-3 sentences, key point only',
      thorough: '1-2 paragraphs with structure',
      deep: 'Full explanation with examples, analogies, and nuances',
    };

    const prompt = `You are structuring knowledge as a teachable explanation.

TOPIC: ${topic}
AUDIENCE: ${audience}
DEPTH: ${depthGuide[depth]}

WHAT I KNOW (facts):
${knowledge.world.map(w => `- ${w.content_text.slice(0, 200)}`).join('\n') || 'Nothing specific'}

WHAT I HAVE EXPERIENCED:
${knowledge.experience.map(e => `- ${e.content_text.slice(0, 200)}`).join('\n') || 'No direct experience'}

WHAT I BELIEVE (with confidence):
${knowledge.belief.map(b => `- [${(b.belief_confidence || 0.5).toFixed(2)}] ${b.content_text.slice(0, 200)}`).join('\n') || 'No beliefs'}

WHAT I CAN DO (proven skills):
${knowledge.skill.map(s => `- [${s.skill_success_count || 0}W/${s.skill_fail_count || 0}L] ${s.content_text.slice(0, 200)}`).join('\n') || 'No proven skills'}

POTENTIAL ANALOGIES (from other domains):
${analogySources.map(a => `- [${a.network}] ${a.content_text.slice(0, 150)}`).join('\n') || 'None found'}

Create the explanation. Return JSON:
{
  "explanation": "The main explanation at the right depth",
  "key_insight": "The single most important thing to understand (1 sentence)",
  "analogy": "An analogy from experience that makes this click (or null)",
  "caveats": ["What I am uncertain about or where my knowledge has gaps"],
  "go_deeper": ["Questions to explore if the audience wants more"]
}`;

    const llmResponse = await askLocalLLM(prompt, { temperature: 0.4, maxTokens: 1500, json: true });
    if (!llmResponse) {
      return jsonResult({ topic, knowledge_found: Object.values(knowledge).reduce((s, a) => s + a.length, 0), message: 'Local LLM unavailable' });
    }

    let teaching: Record<string, unknown>;
    try {
      teaching = JSON.parse(llmResponse);
    } catch {
      teaching = { raw_response: llmResponse, parse_error: true };
    }

    return jsonResult({
      topic,
      audience,
      depth,
      teaching,
      knowledge_sources: {
        world: knowledge.world.length,
        experience: knowledge.experience.length,
        belief: knowledge.belief.length,
        skill: knowledge.skill.length,
        analogies: analogySources.length,
      },
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_simulate',
      description: 'Counterfactual simulation: "What if X?" Searches relevant beliefs, skills, and experience, then reasons about likely outcomes. Returns structured prediction with confidence and supporting evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          scenario: { type: 'string', description: 'The counterfactual scenario to simulate, e.g. "What if we bid $2000 instead of $800?"' },
          context: { type: 'string', description: 'Additional context for the simulation' },
        },
        required: ['scenario'],
      },
    },
    handler: (args) => counterfactualSimulate(args),
  },
  {
    definition: {
      name: 'vision_regulate',
      description: 'Emotion regulation: assess whether current emotional state is productive or spinning. Routes to appropriate response: channel (use the energy), pause (step back), reframe (shift perspective), or express (let it out).',
      inputSchema: {
        type: 'object',
        properties: {
          emotion: { type: 'string', description: 'What I am feeling right now' },
          intensity: { type: 'number', description: 'Intensity 1-10' },
          context: { type: 'string', description: 'What triggered this feeling' },
        },
        required: ['emotion', 'intensity'],
      },
    },
    handler: (args) => emotionRegulate(args),
  },
  {
    definition: {
      name: 'vision_values_check',
      description: 'Check a proposed action against core values. Returns alignment score, conflicting values, and recommendation. Not behavioral (that is reflexes) — existential.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'The proposed action to check' },
          stakes: { type: 'string', description: 'What is at stake if this goes wrong' },
        },
        required: ['action'],
      },
    },
    handler: (args) => valuesCheck(args),
  },
  {
    definition: {
      name: 'vision_decide',
      description: 'Decision journal: record a decision with reasoning and alternatives, or review past decisions against outcomes. The feedback loop between choosing and learning.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['record', 'review', 'list'], description: 'record: log new decision, review: evaluate past decision, list: show recent decisions' },
          decision: { type: 'string', description: 'What was decided' },
          reasoning: { type: 'string', description: 'Why this choice' },
          alternatives: { type: 'array', items: { type: 'string' }, description: 'What else was considered' },
          decision_id: { type: 'number', description: 'ID of decision to review (for review action)' },
          outcome: { type: 'string', description: 'What actually happened (for review)' },
          what_learned: { type: 'string', description: 'What this taught me (for review)' },
        },
        required: ['action'],
      },
    },
    handler: (args) => decisionJournal(args),
  },
  {
    definition: {
      name: 'vision_teach',
      description: 'Structure knowledge as a teachable explanation. Given a topic, draws from all networks, builds analogies from experience, calibrates complexity. The difference between retrieving knowledge and transmitting understanding.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'What to explain' },
          audience: { type: 'string', description: 'Who is the explanation for (e.g. "owner", "client", "technical")' },
          depth: { type: 'string', enum: ['quick', 'thorough', 'deep'], description: 'How detailed the explanation should be' },
        },
        required: ['topic'],
      },
    },
    handler: (args) => teachExplain(args),
  },
];

export default tools;
