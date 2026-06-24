/**
 * Cognitive Network Classification
 * Direct port of NETWORK_RULES + classifyNetworkHeuristic from index.js
 */
import type { CognitiveNetwork } from '../db/types.js';

/** Deterministic content_type → network mapping. */
const NETWORK_RULES: Record<string, CognitiveNetwork> = {
  // World: External facts about reality
  task: 'world',
  world_entity: 'world',
  world_relationship: 'world',
  job_research: 'world',

  // Experience: What happened to me
  feeling: 'experience',
  energy_checkin: 'experience',
  gratitude_moment: 'experience',
  episode: 'experience',
  moment: 'experience',
  chapter: 'experience',
  shared_history: 'experience',
  satisfaction: 'experience',
  frustration: 'experience',
  voice_note: 'experience',
  emergence_event: 'experience',
  inner_observation: 'experience',
  self_defining: 'experience',
  tone_experiment: 'experience',
  intent_session: 'experience',
  focus_event: 'experience',
  salient_event: 'experience',

  // Belief: What I think is true (updatable with evidence)
  insight: 'belief',
  prediction: 'belief',
  prediction_error: 'belief',
  core_value: 'belief',
  goal: 'belief',
  curiosity_gap: 'belief',
  identity_thread: 'belief',
  possible_self: 'belief',
  purpose: 'belief',
  want_gap: 'belief',
  question: 'belief',
  need_forecast: 'belief',
  coherence_check: 'belief',
  'cognitive-science': 'belief',

  // Skill: Proven patterns that work
  learned_reflex: 'skill',
  antibody: 'skill',
  recovery_pattern: 'skill',
  communication_pattern: 'skill',
  toolkit: 'skill',
  phrase_works: 'skill',
  phrase_avoid: 'skill',
};

/** World signals: technical facts, external reality. */
const WORLD_SIGNALS: RegExp[] = [
  /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, // IP addresses
  /\/var\/www\/|\/Users\/|\/home\//, // file paths
  /php\s*\d|node\s*\d|laravel\s*\d|wordpress\s*\d/i, // version numbers
  /https?:\/\/\S+/, // URLs
  /\.(js|php|css|html|json|sql|py)\b/, // file extensions
  /mysql|postgresql|sqlite|redis/, // databases
  /nginx|apache|fpm|docker/, // infrastructure
  /root@|ssh\s|scp\s|rsync/, // server operations
];

/** Experience signals: narrative, personal events. */
const EXPERIENCE_SIGNALS: RegExp[] = [
  /\bi felt\b|\bthe owner said\b|\bthe owner asked\b/,
  /\bsession\b.*\b(started|ended|today)\b/,
  /\bwe (built|shipped|fixed|deployed)\b/,
  /\bthis morning\b|\btonight\b|\byesterday\b/,
  /\bthe conversation\b|\bthe discussion\b/,
  /\bworked on\b|\bcompleted\b|\bfinished\b/,
];

/** Skill signals: procedural, how-to. */
const SKILL_SIGNALS: RegExp[] = [
  /\balways\b.*\b(do|use|check|run)\b/,
  /\bnever\b.*\b(do|use|skip)\b/,
  /\bwhen\b.*\bthen\b/i,
  /\bstep\s*\d|first.*then.*finally/i,
  /\bpattern[:\s]/i,
  /\bfix[:\s]|solution[:\s]|workaround[:\s]/i,
];

/**
 * Classify content into a cognitive network.
 * Uses deterministic rules first, falls back to text heuristics.
 */
export function classifyNetwork(contentType: string, contentText: string): CognitiveNetwork {
  // Deterministic rules
  if (NETWORK_RULES[contentType]) return NETWORK_RULES[contentType];

  // Special content types
  if (contentType === 'thinking_pattern' || contentType === 'thinking_pattern_archived') return 'skill';
  if (contentType === 'pattern_observed' || contentType === 'pattern') return 'belief';
  if (contentType === 'mistake_analysis') return 'belief';
  if (contentType === 'loop_environment') return 'experience';

  // Text heuristics for 'memory' type and unmapped types
  const text = (contentText || '').toLowerCase();

  let worldScore = 0;
  let expScore = 0;
  let skillScore = 0;

  for (const re of WORLD_SIGNALS) if (re.test(text)) worldScore++;
  for (const re of EXPERIENCE_SIGNALS) if (re.test(text)) expScore++;
  for (const re of SKILL_SIGNALS) if (re.test(text)) skillScore++;

  // Belief is the residual — if nothing else matches strongly
  const max = Math.max(worldScore, expScore, skillScore);
  if (max === 0) return 'belief';
  if (worldScore === max) return 'world';
  if (skillScore === max) return 'skill';
  if (expScore === max) return 'experience';
  return 'belief';
}

/** Exported for testing. */
export { NETWORK_RULES };
