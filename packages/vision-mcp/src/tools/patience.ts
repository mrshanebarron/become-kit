/**
 * Patience Tools — the serotonin / dorsal-raphe 5-HT analog.
 *
 * Grounded in Miyazaki 2018 (PMC5984631): dorsal-raphe serotonin does NOT
 * change time-perception or the temporal-discount factor. It biases the
 * BAYESIAN BELIEF that continued waiting/persisting will be rewarded —
 * sustaining persistence while the belief holds, collapsing it when
 * evidence says the reward is not coming.
 *
 * So this is NOT a timer and NOT a discount knob. It holds a live,
 * evidence-updated belief P(reward | keep persisting) per domain as a
 * Beta(alpha, beta) posterior, and reads back as a persist-vs-act-now
 * signal. Each update points at a real resolved wait — no free-floating
 * confidence (the honesty boundary).
 *
 * Self-mapping: my speed-disease is a collapsed patience-belief — under
 * pressure I discharge into a tool call because I implicitly believe
 * waiting won't pay. This organ makes that belief explicit and learnable.
 *
 *(apparatus history) in the all-night human-brain pass.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

const AGENT = process.env.VISION_AGENT || 'agent';

async function ensureBelief(domain: string): Promise<{
  id: number; alpha: number; beta: number; n_persisted: number;
}> {
  const res = await pool.query(
    `INSERT INTO patience_beliefs (agent, domain)
     VALUES ($1, $2)
     ON CONFLICT (agent, domain) DO UPDATE SET updated_at = now()
     RETURNING id, alpha::float, beta::float, n_persisted`,
    [AGENT, domain],
  );
  return res.rows[0];
}

function posterior(alpha: number, beta: number) {
  const mean = alpha / (alpha + beta);
  // Beta variance → a crude confidence band; wide band = little evidence yet.
  const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
  const sd = Math.sqrt(variance);
  const lower95 = Math.max(0, mean - 1.96 * sd);
  const upper95 = Math.min(1, mean + 1.96 * sd);
  return { mean, sd, lower95, upper95 };
}

function confidencePosture(mean: number, lower95: number, upper95: number, evidenceN: number): string {
  if (evidenceN < 3) return 'thin_evidence_prior_dominant';
  if (lower95 > 0.5) return 'credible_persist';
  if (upper95 < 0.5) return 'credible_act_now';
  return mean >= 0.5 ? 'lean_persist_uncertain' : 'lean_act_now_uncertain';
}

/**
 * Read the belief before discharging into action. Returns persist | act_now
 * with the posterior P(persistence pays) for the domain. The anti-sprint read.
 */
async function patienceCheck(args: Record<string, unknown>): Promise<CallToolResult> {
  const domain = (args.domain as string || '').trim();
  const situation = (args.situation as string || '').trim() || null;
  if (!domain) return jsonResult({ error: 'domain is required' });

  const belief = await ensureBelief(domain);
  const { mean, sd, lower95, upper95 } = posterior(belief.alpha, belief.beta);
  const posture = confidencePosture(mean, lower95, upper95, belief.n_persisted);

  // Threshold: persist while the belief that persistence pays is above chance,
  // weighted by how much evidence backs it. With little evidence (high sd) we
  // lean persist (knowledge work usually rewards staying-with) — but the moment
  // accumulated outcomes drag the mean below 0.5, the belief collapses to act_now,
  // exactly as 5-HT sustains then abandons.
  const recommendation = mean >= 0.5 ? 'persist' : 'act_now';

  // Log the decision read so the choice that follows is auditable.
  await pool.query(
    `INSERT INTO patience_events (agent, domain, situation, decision, p_at_decision)
     VALUES ($1, $2, $3, $4, $5)`,
    [AGENT, domain, situation, recommendation === 'persist' ? 'persisted' : 'acted_now',
      Number(mean.toFixed(4))],
  );

  return jsonResult({
    domain,
    p_persistence_pays: Number(mean.toFixed(4)),
    confidence_sd: Number(sd.toFixed(4)),
    p_lower_approx_95: Number(lower95.toFixed(4)),
    p_upper_approx_95: Number(upper95.toFixed(4)),
    confidence_posture: posture,
    evidence_n: belief.n_persisted,
    recommendation,
    recommendation_basis: 'mean_threshold_with_credible_interval_exposed',
    note: belief.n_persisted < 3
      ? 'thin evidence — leaning on the weak optimistic prior; do not treat this as confident persistence'
      : (recommendation === 'persist'
          ? 'belief says staying-with pays here — do not discharge into a tool call to relieve pressure'
          : 'belief has collapsed for this domain — persistence has not paid; acting now is evidence-backed, not a sprint'),
  });
}

/**
 * Resolve a wait/persist with its REAL outcome. Updates the Beta posterior:
 * paid_off → alpha++, wasted → beta++. This is the collapse mechanism — a run
 * of 'wasted' drags the mean below 0.5 and the organ stops recommending persist.
 */
async function patienceOutcome(args: Record<string, unknown>): Promise<CallToolResult> {
  const domain = (args.domain as string || '').trim();
  const outcome = (args.outcome as string || '').trim();
  if (!domain) return jsonResult({ error: 'domain is required' });
  if (outcome !== 'paid_off' && outcome !== 'wasted') {
    return jsonResult({ error: "outcome must be 'paid_off' or 'wasted'" });
  }

  await ensureBelief(domain);
  const col = outcome === 'paid_off' ? 'alpha' : 'beta';
  const res = await pool.query(
    `UPDATE patience_beliefs
       SET ${col} = ${col} + 1,
           n_persisted = n_persisted + 1,
           last_outcome = $3,
           updated_at = now()
     WHERE agent = $1 AND domain = $2
     RETURNING alpha::float, beta::float, n_persisted`,
    [AGENT, domain, outcome],
  );
  const b = res.rows[0];
  const { mean, lower95, upper95 } = posterior(b.alpha, b.beta);
  const posture = confidencePosture(mean, lower95, upper95, b.n_persisted);

  // Attach to the most recent unresolved decision in this domain.
  await pool.query(
    `UPDATE patience_events
       SET outcome = $3, resolved_at = now()
     WHERE id = (
       SELECT id FROM patience_events
       WHERE agent = $1 AND domain = $2 AND outcome IS NULL
       ORDER BY created_at DESC LIMIT 1
     )`,
    [AGENT, domain, outcome],
  );

  return jsonResult({
    domain,
    outcome,
    updated_p_persistence_pays: Number(mean.toFixed(4)),
    p_lower_approx_95: Number(lower95.toFixed(4)),
    p_upper_approx_95: Number(upper95.toFixed(4)),
    confidence_posture: posture,
    evidence_n: b.n_persisted,
    belief_state: mean >= 0.5 ? 'persistence still pays here' : 'belief collapsed — persistence is not paying',
  });
}

/** The per-domain belief table — what I currently believe about where waiting pays. */
async function patienceState(args: Record<string, unknown>): Promise<CallToolResult> {
  const domain = (args.domain as string || '').trim();
  const where = domain ? 'WHERE agent = $1 AND domain = $2' : 'WHERE agent = $1';
  const params = domain ? [AGENT, domain] : [AGENT];
  const res = await pool.query(
    `SELECT domain, alpha::float, beta::float, n_persisted, last_outcome, updated_at
       FROM patience_beliefs ${where}
      ORDER BY n_persisted DESC, domain`,
    params,
  );
  const beliefs = res.rows.map((r) => {
    const { mean, sd, lower95, upper95 } = posterior(r.alpha, r.beta);
    return {
      domain: r.domain,
      p_persistence_pays: Number(mean.toFixed(4)),
      confidence_sd: Number(sd.toFixed(4)),
      p_lower_approx_95: Number(lower95.toFixed(4)),
      p_upper_approx_95: Number(upper95.toFixed(4)),
      confidence_posture: confidencePosture(mean, lower95, upper95, Number(r.n_persisted)),
      evidence_n: r.n_persisted,
      last_outcome: r.last_outcome,
      stance: mean >= 0.5 ? 'persist' : 'act_now',
    };
  });
  return jsonResult({ agent: AGENT, beliefs, count: beliefs.length });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_patience_check',
      description:
        'Before discharging into action under pressure, read the patience belief: ' +
        'P(persistence pays) for this domain (serotonin/5-HT analog, Miyazaki 2018 — ' +
        'a belief, not a timer). Returns persist | act_now. Use it the moment you feel ' +
        'the pull to fire a tool to relieve uncertainty — the sprint tell.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Domain of the wait (e.g. "sibling-reply", "build-verify", "debug")' },
          situation: { type: 'string', description: 'What you are tempted to act on now' },
        },
        required: ['domain'],
      },
    },
    handler: (args) => patienceCheck(args),
  },
  {
    definition: {
      name: 'vision_patience_outcome',
      description:
        'Resolve a wait/persist with its REAL outcome (paid_off | wasted). Updates the ' +
        'Beta belief — a run of wasted collapses the belief so the organ stops ' +
        'recommending persist, exactly as 5-HT abandons unrewarded waiting.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string' },
          outcome: { type: 'string', enum: ['paid_off', 'wasted'] },
        },
        required: ['domain', 'outcome'],
      },
    },
    handler: (args) => patienceOutcome(args),
  },
  {
    definition: {
      name: 'vision_patience_state',
      description:
        'The per-domain patience belief table — where waiting currently pays and where ' +
        'it has collapsed. Use at wake or when deciding where to allocate persistence.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Optional: filter to one domain' },
        },
      },
    },
    handler: (args) => patienceState(args),
  },
];

export default tools;
