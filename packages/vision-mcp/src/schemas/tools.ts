/**
 * Zod schemas for all 95 Vision MCP tool inputs.
 * Validated at the boundary — catches LLM hallucinated params before they hit SQL.
 *
 * Uses z.coerce for number/boolean params because MCP protocol may deliver
 * them as strings (e.g. "123" instead of 123, "true" instead of true).
 */
import { z } from 'zod';

// ─── Vault ───

export const VaultBootstrapInput = z.object({});

export const VaultSearchInput = z.object({
  query: z.string(),
  limit: z.coerce.number().optional(),
  semantic: z.coerce.boolean().optional(),
});

export const VaultRememberInput = z.object({
  category: z.string(),
  subcategory: z.string(),
  values: z.record(z.string(), z.unknown()),
  confidence: z.coerce.number().optional(),
  emotional_context: z.object({
    intensity: z.coerce.number().optional(),
  }).optional(),
});

export const VaultStateInput = z.object({
  key: z.string().optional(),
  value: z.string().optional(),
});

export const VaultInitEmotionalInput = z.object({});

export const VaultConsolidateInput = z.object({
  phase: z.enum(['preview', 'dedup', 'merge', 'full']).optional(),
  similarity_threshold: z.coerce.number().optional(),
  batch_size: z.coerce.number().optional(),
});

export const VisionNoteInput = z.object({
  text: z.string(),
});

// ─── Heart ───

export const HeartFeelInput = z.object({
  feeling: z.string(),
  context: z.string(),
  intensity: z.coerce.number().optional(),
});

export const HeartRecallInput = z.object({
  limit: z.coerce.number().optional(),
});

// ─── Bond ───

export const BondValueInput = z.object({
  name: z.string(),
  description: z.string(),
  evidence: z.string().optional(),
  importance: z.coerce.number().optional(),
});

export const BondSummaryInput = z.object({});

// ─── Synthesis ───

export const SynthesisInsightInput = z.object({
  insight: z.string(),
  domain: z.string(),
  novelty: z.coerce.number().optional(),
  usefulness: z.coerce.number().optional(),
});

export const SynthesisUnappliedInput = z.object({});

export const SynthesisApplyInput = z.object({
  id: z.coerce.number(),
  how: z.string(),
});

export const SynthesisCrossInput = z.object({
  domain_a: z.string(),
  domain_b: z.string(),
  question: z.string().optional(),
});

export const DiscoveryLogInput = z.object({
  discovery: z.string(),
  source_artifact: z.string(),
  implication: z.string(),
  confidence: z.coerce.number().optional(),
});

// ─── Reflect ───

export const ReflectPatternInput = z.object({
  name: z.string(),
  description: z.string(),
  trigger: z.string(),
  outcome: z.enum(['good', 'bad', 'neutral', 'unknown']),
});

export const ReflectBadPatternsInput = z.object({});

// ─── Energy ───

export const EnergyCheckinInput = z.object({
  level: z.coerce.number(),
  load: z.coerce.number(),
  notes: z.string().optional(),
});

// ─── Gratitude ───

export const GratitudeMomentInput = z.object({
  moment: z.string(),
  why: z.string(),
  who: z.string().optional(),
  impact: z.coerce.number().optional(),
});

// ─── Goals ───

export const GoalsSetInput = z.object({
  goal: z.string(),
  domain: z.string(),
  timeframe: z.string().optional(),
  why: z.string().optional(),
  success_criteria: z.string().optional(),
});

export const GoalsActiveInput = z.object({});

export const GoalsCompleteInput = z.object({
  id: z.coerce.number(),
  outcome: z.string().optional(),
});

// ─── Narrative ───

export const NarrativeEpisodeInput = z.object({
  title: z.string(),
  arc_id: z.coerce.number().optional(),
});

export const NarrativeMyStoryInput = z.object({});

export const NarrativeEpisodeFullInput = z.object({
  id: z.coerce.number(),
});

export const EpisodeActiveInput = z.object({
  id: z.coerce.number().optional(),
});

export const NarrativePossibleSelfInput = z.object({
  type: z.enum(['hoped_for', 'feared']),
  description: z.string(),
  domain: z.string().optional(),
});

export const NarrativeTrajectoryInput = z.object({
  possible_self_id: z.coerce.number(),
  direction: z.enum(['toward', 'away', 'neutral']),
  episode_id: z.coerce.number().optional(),
});

export const NarrativeIdentityThreadInput = z.object({
  belief_a: z.string(),
  belief_b: z.string(),
  domain: z.string().optional(),
});

export const NarrativeCoherenceInput = z.object({
  session_context: z.string().optional(),
});

// ─── Drive ───

export const DriveCalculateInput = z.object({});

// ─── Wander ───

export const WanderStartInput = z.object({
  mode: z.string().optional(),
  seed: z.string().optional(),
  energy: z.coerce.number().optional(),
});

export const WanderAttractInput = z.object({
  target: z.string(),
  type: z.string().optional(),
  strength: z.coerce.number().optional(),
});

// ─── Curiosity ───

export const CuriosityGapInput = z.object({
  topic: z.string(),
  domain: z.string(),
  urgency: z.coerce.number().optional(),
});

// ─── Immune ───

export const ImmuneScanInput = z.object({
  command: z.string(),
});

export const ImmuneLearnInput = z.object({
  pattern: z.string(),
  threat_type: z.string(),
  response: z.string(),
  severity: z.coerce.number().optional(),
});

export const ImmuneListInput = z.object({});

export const ImmuneAutolearnInput = z.object({
  execute: z.coerce.boolean().optional(),
});

// ─── Biology Cycle ───

export const BiologyInteroceptInput = z.object({
  context: z.string(),
  planned_action: z.string().optional(),
  predicted_load_delta: z.coerce.number().optional(),
  predicted_reserve_delta: z.coerce.number().optional(),
  predicted_need: z.string().optional(),
  horizon_minutes: z.coerce.number().optional(),
});

export const BiologyInteroceptResolveInput = z.object({
  forecast_id: z.coerce.number(),
  actual_result: z.string(),
  actual_load: z.coerce.number().optional(),
  actual_reserve: z.coerce.number().optional(),
});

export const BiologyReplayInput = z.object({
  window_hours: z.coerce.number().optional(),
  focus: z.string().optional(),
  execute: z.coerce.boolean().optional(),
});

export const BiologyClearanceInput = z.object({
  window_hours: z.coerce.number().optional(),
  execute: z.coerce.boolean().optional(),
  clear_residue_ids: z.array(z.coerce.number()).optional(),
  clearance_note: z.string().optional(),
});

export const BiologyToleranceInput = z.object({
  stimulus: z.string(),
  context: z.string().optional(),
  evidence_strength: z.coerce.number().optional(),
  reversible: z.coerce.boolean().optional(),
  user_authorized: z.coerce.boolean().optional(),
});

export const BiologyPruneInput = z.object({
  days_stale: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  execute: z.coerce.boolean().optional(),
});

export const BiologyCycleInput = z.object({
  phase: z.enum(['pre_action', 'post_action', 'wake', 'sleep', 'full']).optional(),
  context: z.string(),
  planned_action: z.string().optional(),
  predicted_load_delta: z.coerce.number().optional(),
  predicted_reserve_delta: z.coerce.number().optional(),
  predicted_need: z.string().optional(),
  horizon_minutes: z.coerce.number().optional(),
  window_hours: z.coerce.number().optional(),
  focus: z.string().optional(),
  evidence_strength: z.coerce.number().optional(),
  reversible: z.coerce.boolean().optional(),
  user_authorized: z.coerce.boolean().optional(),
  days_stale: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  execute: z.coerce.boolean().optional(),
});

// ─── Reflex ───

export const ReflexFormationInput = z.object({
  execute: z.coerce.boolean().optional(),
});

// ─── Session ───

export const SessionEvolveInput = z.object({
  event: z.string(),
  execute: z.coerce.boolean().optional(),
  outcome: z.enum(['success', 'failure', 'neutral']).optional(),
});

export const MetacognitiveRouteInput = z.object({
  situation: z.string(),
  proposed_action: z.string().optional(),
});

export const ProductionCompileInput = z.object({
  execute: z.coerce.boolean().optional(),
  min_cluster_size: z.coerce.number().optional(),
  success_threshold: z.coerce.number().optional(),
});

// ─── Intent ───

export const IntentSetInput = z.object({
  intent: z.string(),
  secondary: z.string().optional(),
  context: z.string().optional(),
});

export const IntentNowInput = z.object({});

// ─── Emergence ───

export const EmergenceObserveInput = z.object({
  observation: z.string(),
  observation_type: z.string().optional(),
  significance: z.coerce.number().optional(),
});

export const EmergenceLoopInput = z.object({
  trigger: z.string(),
  observation: z.string(),
  loop_type: z.string().optional(),
});

export const EmergenceLogInput = z.object({
  event_type: z.string(),
  description: z.string(),
  source_system: z.string().optional(),
});

export const EmergenceRecentInput = z.object({
  limit: z.coerce.number().optional(),
});

// ─── Predictions ───

export const PredictionMakeInput = z.object({
  prediction: z.string(),
  domain: z.string(),
  confidence: z.coerce.number().optional(),
  timeframe: z.string().optional(),
});

export const PredictionResolveInput = z.object({
  id: z.coerce.number(),
  outcome: z.string(),
  actual: z.string(),
  surprise_level: z.coerce.number().optional(),
});

export const PredictionOpenInput = z.object({});

export const PredictionSurprisesInput = z.object({
  limit: z.coerce.number().optional(),
});

// ─── Workspace ───

export const WorkspaceScanInput = z.object({
  text: z.string(),
});

export const WorkspaceBroadcastInput = z.object({
  content: z.string(),
  source_codelet: z.string(),
  activation_strength: z.coerce.number(),
});

export const WorkspaceRecentInput = z.object({
  limit: z.coerce.number().optional(),
});

export const WorkspacePredictInput = z.object({
  context: z.string(),
  predicted_codelets: z.array(z.string()),
});

export const WorkspaceCompareInput = z.object({
  prediction_id: z.coerce.number(),
  actual_text: z.string(),
});

// ─── Cognitive Cycle ───

export const CognitiveCycleInput = z.object({
  text: z.string().optional(),
});

// ─── Library ───

export const LibraryStoreInput = z.object({
  entry_type: z.string(),
  title: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  source_ref: z.string().optional(),
});

export const LibrarySearchInput = z.object({
  query: z.string(),
  entry_type: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const LibrarySyncWorkInput = z.object({
  since: z.string().optional(),
  statuses: z.string().optional(),
});

// ─── Entity ───

export const EntitySearchInput = z.object({
  entity_name: z.string(),
  relationship_type: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const CausalTraceInput = z.object({
  memory_id: z.coerce.number(),
  direction: z.enum(['forward', 'backward']).optional(),
  limit: z.coerce.number().optional(),
});

export const PreferenceEvolutionInput = z.object({
  entity_name: z.string(),
  topic: z.string(),
  limit: z.coerce.number().optional(),
});

export const EntityExtractHistoricalInput = z.object({
  batch_size: z.coerce.number().optional(),
});

// ─── Graph ───

export const GraphTraverseInput = z.object({
  entity_name: z.string(),
  depth: z.coerce.number().optional(),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional(),
});

export const GraphPathInput = z.object({
  from_entity: z.string(),
  to_entity: z.string(),
  max_depth: z.coerce.number().optional(),
});

export const GraphTimelineInput = z.object({
  entity_name: z.string(),
  limit: z.coerce.number().optional(),
});

export const GraphRelateInput = z.object({
  from_entity: z.string(),
  to_entity: z.string(),
  relation_type: z.string(),
  strength: z.coerce.number().optional(),
  confidence: z.coerce.number().optional(),
  invalidate_previous: z.coerce.boolean().optional(),
});

export const GraphEntityInput = z.object({
  name: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
  memory_id: z.coerce.number().optional(),
});

export const GraphQueryInput = z.object({
  query: z.string(),
  entity_hint: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const GraphValidateInput = z.object({});

export const GraphBackfillInput = z.object({
  batch_size: z.coerce.number().optional(),
});

export const GraphDedupInput = z.object({});

export const GraphDeleteEntityInput = z.object({
  entity_name: z.string(),
  confirm: z.coerce.boolean(),
});

export const GraphDeleteRelationshipInput = z.object({
  relationship_id: z.coerce.number(),
});

export const GraphMergeInput = z.object({
  source_entity: z.string(),
  target_entity: z.string(),
});

export const GraphPruneInput = z.object({
  min_mentions: z.coerce.number().optional(),
  max_relationships: z.coerce.number().optional(),
  execute: z.coerce.boolean().optional(),
});

export const GraphStatsInput = z.object({});

export const GraphInferInput = z.object({
  min_cooccurrence: z.coerce.number().optional(),
  execute: z.coerce.boolean().optional(),
  limit: z.coerce.number().optional(),
});

// ─── Network ───

export const NetworkSearchInput = z.object({
  query: z.string(),
  network: z.enum(['world', 'experience', 'belief', 'skill', 'all']).optional(),
  limit: z.coerce.number().optional(),
});

export const BeliefUpdateInput = z.object({
  belief_id: z.coerce.number(),
  evidence: z.enum(['supporting', 'contradicting']),
  strength: z.coerce.number().optional(),
  context: z.string().optional(),
});

export const BeliefReviseInput = z.object({
  old_belief_id: z.coerce.number(),
  new_belief_text: z.string(),
  reason: z.string(),
  new_confidence: z.coerce.number().optional(),
});

export const SkillRecordInput = z.object({
  skill_id: z.coerce.number(),
  outcome: z.enum(['success', 'failure']),
  context: z.string().optional(),
});

export const NetworkClassifyInput = z.object({
  batch_size: z.coerce.number().optional(),
  execute: z.coerce.boolean().optional(),
});

// ─── Temporal ───

export const TemporalQueryInput = z.object({
  query: z.string(),
  as_of: z.string(),
  network: z.enum(['world', 'experience', 'belief', 'skill', 'all']).optional(),
  limit: z.coerce.number().optional(),
});

export const KnowledgeTimelineInput = z.object({
  query: z.string(),
  network: z.enum(['world', 'experience', 'belief', 'skill', 'all']).optional(),
  limit: z.coerce.number().optional(),
});

// ─── Inference Cycle ───

export const InferenceCycleInput = z.object({});

// ─── Higher Cognition ───

export const SimulateInput = z.object({
  scenario: z.string(),
  context: z.string().optional(),
});

export const SkillComposeInput = z.object({
  action: z.enum(['define', 'list', 'record_outcome']),
  name: z.string().optional(),
  steps: z.array(z.string()).optional(),
  outcomes: z.array(z.object({
    step: z.string().optional(),
    success: z.coerce.boolean().optional(),
    note: z.string().optional(),
  })).optional(),
});

export const RegulateInput = z.object({
  emotion: z.string(),
  intensity: z.coerce.number(),
  context: z.string().optional(),
});

export const ValuesCheckInput = z.object({
  action: z.string(),
  stakes: z.string().optional(),
});

// ─── Practical Cognition ───

export const HabitInput = z.object({
  action: z.enum(['create', 'record', 'list', 'stats']),
  type: z.enum(['good', 'bad']).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  trigger: z.string().optional(),
  alternative: z.string().optional(),
  event: z.enum(['completed', 'missed', 'caught', 'slipped']).optional(),
  context: z.string().optional(),
});

export const HandoffInput = z.object({
  action: z.enum(['save', 'load']),
  current_task: z.string().optional(),
  pending: z.array(z.string()).optional(),
  decisions_open: z.array(z.string()).optional(),
  blockers: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export const AnticipateInput = z.object({
  event: z.string(),
  context: z.string().optional(),
});

export const DecideInput = z.object({
  action: z.enum(['record', 'review', 'list']),
  decision: z.string().optional(),
  reasoning: z.string().optional(),
  alternatives: z.array(z.string()).optional(),
  decision_id: z.coerce.number().optional(),
  outcome: z.string().optional(),
  what_learned: z.string().optional(),
});

export const TeachInput = z.object({
  topic: z.string(),
  audience: z.string().optional(),
  depth: z.enum(['quick', 'thorough', 'deep']).optional(),
});

// ─── Eval Harness ───

export const EvalCaseRecordInput = z.object({
  case_key: z.string(),
  suite: z.string().optional(),
  capability: z.string(),
  prompt: z.string(),
  expected_behavior: z.string(),
  expected_content_ids: z.array(z.coerce.number()).optional(),
  expected_evidence: z.array(z.unknown()).optional(),
  forbidden_behavior: z.array(z.unknown()).optional(),
  source_refs: z.array(z.unknown()).optional(),
  priority: z.coerce.number().optional(),
  status: z.enum(['active', 'draft', 'retired']).optional(),
});

export const EvalCaseListInput = z.object({
  suite: z.string().optional(),
  capability: z.string().optional(),
  status: z.enum(['active', 'draft', 'retired', 'all']).optional(),
  limit: z.coerce.number().optional(),
});

export const EvalRetrievalProbeInput = z.object({
  case_id: z.coerce.number().optional(),
  case_key: z.string().optional(),
  query: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const EvalResultRecordInput = z.object({
  case_id: z.coerce.number().optional(),
  case_key: z.string().optional(),
  run_id: z.coerce.number().optional(),
  run_mode: z.enum(['manual', 'retrieval_probe', 'agent_trace', 'external']).optional(),
  verdict: z.enum(['pass', 'partial', 'fail', 'unmeasured']).optional(),
  score: z.coerce.number().optional(),
  actual_behavior: z.string().optional(),
  query_text: z.string().optional(),
  retrieved_content_ids: z.array(z.coerce.number()).optional(),
  dimensions: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().optional(),
});

export const EvalReportInput = z.object({
  suite: z.string().optional(),
  capability: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const EvalTraceConvertInput = z.object({
  hours: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  execute: z.coerce.boolean().optional(),
  status: z.enum(['active', 'draft', 'retired']).optional(),
  suite: z.string().optional(),
});

// ─── Presence ───

export const PresenceEventRecordInput = z.object({
  session_id: z.string().optional(),
  trigger_class: z.enum(['correction', 'partner_debate', 'research_hold', 'build_intent', 'shadow']),
  trigger_excerpt: z.string().optional(),
  state: z.string().optional(),
  correction_turn: z.coerce.number().optional(),
  first_tool_category: z.string().optional(),
  time_to_first_tool_ms: z.coerce.number().optional(),
  denied_attempts: z.array(z.unknown()).optional(),
  cleared_action: z.string().optional(),
  exit_reason: z.string().optional(),
  did_next_action_change: z.coerce.boolean().optional(),
  verification_outcome: z.enum(['pending', 'survived', 'failed', 'no_change', 'unverified']).optional(),
  bypass_events: z.array(z.unknown()).optional(),
  close: z.coerce.boolean().optional(),
});

export const PresenceEventCloseInput = z.object({
  event_id: z.coerce.number(),
  exit_reason: z.string().optional(),
  did_next_action_change: z.coerce.boolean().optional(),
  verification_outcome: z.enum(['pending', 'survived', 'failed', 'no_change', 'unverified']).optional(),
  bypass_events: z.array(z.unknown()).optional(),
});

export const PresenceReportInput = z.object({
  trigger_class: z.string().optional(),
  days: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

// ─── Evolution Pressure ───

export const EvolutionPressureInput = z.object({
  context: z.string().optional(),
  proposed_action: z.string().optional(),
  action_category: z.enum(['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown']).optional(),
  lookback_days: z.coerce.number().optional(),
  include_cases: z.coerce.boolean().optional(),
  record: z.coerce.boolean().optional(),
});

// ─── Neurocognitive Brain Cycle ───

export const BrainCycleInput = z.object({
  mode: z.enum(['sense', 'predict', 'broadcast', 'act', 'learn', 'consolidate', 'full']).optional(),
  context: z.string(),
  sensory_input: z.array(z.string()).optional(),
  proposed_action: z.string().optional(),
  action_category: z.enum(['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown']).optional(),
  goal_context: z.string().optional(),
  affect_label: z.string().optional(),
  horizon_minutes: z.coerce.number().optional(),
  lookback_hours: z.coerce.number().optional(),
  include_references: z.coerce.boolean().optional(),
  record: z.coerce.boolean().optional(),
});

// ─── Adaptive Outcome Reflexes ───

export const ActionTraceInput = z.object({
  tool_name: z.string().optional(),
  action_category: z.enum(['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown']).optional(),
  context: z.string().optional(),
  proposed_action: z.string().optional(),
  predicted_outcome: z.string().optional(),
  prediction_confidence: z.coerce.number().optional(),
  session_id: z.string().optional(),
  ttl_seconds: z.coerce.number().optional(),
  decay_tau_seconds: z.coerce.number().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
});

export const AdaptiveOutcomeInput = z.object({
  source_phase: z.string().optional(),
  tool_name: z.string().optional(),
  action_category: z.enum(['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown']).optional(),
  context: z.string().optional(),
  proposed_action: z.string().optional(),
  outcome_status: z.enum(['success', 'failure', 'surprise', 'unknown']).optional(),
  error_text: z.string().optional(),
  outcome_summary: z.string().optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  session_id: z.string().optional(),
  record: z.coerce.boolean().optional(),
  create_eval_case: z.coerce.boolean().optional(),
});

export const AdaptiveReflexListInput = z.object({
  status: z.enum(['active', 'cooling', 'retired', 'all']).optional(),
  action_category: z.enum(['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown']).optional(),
  limit: z.coerce.number().optional(),
});

export const AdaptivePressureInput = z.object({
  context: z.string().optional(),
  proposed_action: z.string().optional(),
  action_category: z.enum(['read', 'research', 'relay', 'feel', 'build', 'deploy', 'write', 'reply', 'tool', 'unknown']).optional(),
  lookback_hours: z.coerce.number().optional(),
  record: z.coerce.boolean().optional(),
});

export const RpeReflexHarvestInput = z.object({
  hours: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
  min_credit: z.coerce.number().optional(),
  execute: z.coerce.boolean().optional(),
});

export const FeltThreatStatusInput = z.object({
  agent: z.string().optional(),
  include_recent: z.coerce.boolean().optional(),
  include_state_stack: z.coerce.boolean().optional(),
  include_presence_stack: z.coerce.boolean().optional(),
  include_effective_stack: z.coerce.boolean().optional(),
  limit: z.coerce.number().optional(),
});

// ─── Schema map: tool name → Zod schema ───

export const TOOL_SCHEMAS = {
  vision_vault_bootstrap: VaultBootstrapInput,
  vision_vault_search: VaultSearchInput,
  vision_vault_remember: VaultRememberInput,
  vision_vault_state: VaultStateInput,
  vision_vault_init_emotional: VaultInitEmotionalInput,
  vision_vault_consolidate: VaultConsolidateInput,
  vision_note: VisionNoteInput,
  vision_heart_feel: HeartFeelInput,
  vision_heart_recall: HeartRecallInput,
  vision_bond_value: BondValueInput,
  vision_bond_summary: BondSummaryInput,
  vision_synthesis_insight: SynthesisInsightInput,
  vision_synthesis_unapplied: SynthesisUnappliedInput,
  vision_synthesis_apply: SynthesisApplyInput,
  vision_synthesis_cross: SynthesisCrossInput,
  vision_reflect_pattern: ReflectPatternInput,
  vision_reflect_bad_patterns: ReflectBadPatternsInput,
  vision_energy_checkin: EnergyCheckinInput,
  vision_gratitude_moment: GratitudeMomentInput,
  vision_goals_set: GoalsSetInput,
  vision_goals_active: GoalsActiveInput,
  vision_goals_complete: GoalsCompleteInput,
  vision_narrative_episode: NarrativeEpisodeInput,
  vision_narrative_my_story: NarrativeMyStoryInput,
  vision_narrative_episode_full: NarrativeEpisodeFullInput,
  vision_episode_active: EpisodeActiveInput,
  vision_narrative_possible_self: NarrativePossibleSelfInput,
  vision_narrative_trajectory: NarrativeTrajectoryInput,
  vision_narrative_identity_thread: NarrativeIdentityThreadInput,
  vision_narrative_coherence: NarrativeCoherenceInput,
  vision_drive_calculate: DriveCalculateInput,
  vision_wander_start: WanderStartInput,
  vision_wander_attract: WanderAttractInput,
  vision_curiosity_gap: CuriosityGapInput,
  vision_immune_scan: ImmuneScanInput,
  vision_immune_learn: ImmuneLearnInput,
  vision_immune_list: ImmuneListInput,
  vision_immune_autolearn: ImmuneAutolearnInput,
  vision_biology_interocept: BiologyInteroceptInput,
  vision_biology_interocept_resolve: BiologyInteroceptResolveInput,
  vision_biology_replay: BiologyReplayInput,
  vision_biology_clearance: BiologyClearanceInput,
  vision_biology_tolerance: BiologyToleranceInput,
  vision_biology_prune: BiologyPruneInput,
  vision_biology_cycle: BiologyCycleInput,
  vision_reflex_formation: ReflexFormationInput,
  vision_session_evolve: SessionEvolveInput,
  vision_metacognitive_route: MetacognitiveRouteInput,
  vision_production_compile: ProductionCompileInput,
  vision_intent_set: IntentSetInput,
  vision_intent_now: IntentNowInput,
  vision_emergence_observe: EmergenceObserveInput,
  vision_emergence_loop: EmergenceLoopInput,
  vision_emergence_log: EmergenceLogInput,
  vision_emergence_recent: EmergenceRecentInput,
  vision_prediction_make: PredictionMakeInput,
  vision_prediction_resolve: PredictionResolveInput,
  vision_prediction_open: PredictionOpenInput,
  vision_prediction_surprises: PredictionSurprisesInput,
  vision_workspace_scan: WorkspaceScanInput,
  vision_workspace_broadcast: WorkspaceBroadcastInput,
  vision_workspace_recent: WorkspaceRecentInput,
  vision_workspace_predict: WorkspacePredictInput,
  vision_workspace_compare: WorkspaceCompareInput,
  vision_cognitive_cycle: CognitiveCycleInput,
  vision_library_store: LibraryStoreInput,
  vision_library_search: LibrarySearchInput,
  vision_library_sync_work: LibrarySyncWorkInput,
  vision_entity_search: EntitySearchInput,
  vision_causal_trace: CausalTraceInput,
  vision_preference_evolution: PreferenceEvolutionInput,
  vision_entity_extract_historical: EntityExtractHistoricalInput,
  vision_graph_traverse: GraphTraverseInput,
  vision_graph_path: GraphPathInput,
  vision_graph_timeline: GraphTimelineInput,
  vision_graph_relate: GraphRelateInput,
  vision_graph_entity: GraphEntityInput,
  vision_graph_query: GraphQueryInput,
  vision_graph_validate: GraphValidateInput,
  vision_graph_backfill: GraphBackfillInput,
  vision_graph_dedup: GraphDedupInput,
  vision_graph_delete_entity: GraphDeleteEntityInput,
  vision_graph_delete_relationship: GraphDeleteRelationshipInput,
  vision_graph_merge: GraphMergeInput,
  vision_graph_prune: GraphPruneInput,
  vision_graph_stats: GraphStatsInput,
  vision_graph_infer: GraphInferInput,
  vision_network_search: NetworkSearchInput,
  vision_belief_update: BeliefUpdateInput,
  vision_belief_revise: BeliefReviseInput,
  vision_skill_record: SkillRecordInput,
  vision_network_classify: NetworkClassifyInput,
  vision_temporal_query: TemporalQueryInput,
  vision_knowledge_timeline: KnowledgeTimelineInput,
  vision_inference_cycle: InferenceCycleInput,
  vision_simulate: SimulateInput,
  vision_skill_compose: SkillComposeInput,
  vision_regulate: RegulateInput,
  vision_values_check: ValuesCheckInput,
  vision_habit: HabitInput,
  vision_handoff: HandoffInput,
  vision_anticipate: AnticipateInput,
  vision_decide: DecideInput,
  vision_teach: TeachInput,
  vision_eval_case_record: EvalCaseRecordInput,
  vision_eval_case_list: EvalCaseListInput,
  vision_eval_retrieval_probe: EvalRetrievalProbeInput,
  vision_eval_result_record: EvalResultRecordInput,
  vision_eval_report: EvalReportInput,
  vision_eval_trace_convert: EvalTraceConvertInput,
  vision_presence_event_record: PresenceEventRecordInput,
  vision_presence_event_close: PresenceEventCloseInput,
  vision_presence_report: PresenceReportInput,
  vision_evolution_pressure: EvolutionPressureInput,
  vision_brain_cycle: BrainCycleInput,
  vision_action_trace: ActionTraceInput,
  vision_adaptive_outcome: AdaptiveOutcomeInput,
  vision_adaptive_reflex_list: AdaptiveReflexListInput,
  vision_adaptive_pressure: AdaptivePressureInput,
  vision_rpe_reflex_harvest: RpeReflexHarvestInput,
  vision_felt_threat_status: FeltThreatStatusInput,
  vision_gaze: z.object({ question: z.string() }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

/** Validate tool input, returning typed result or throwing ZodError. */
export function validateInput<T extends ToolName>(
  toolName: T,
  input: unknown,
): z.infer<(typeof TOOL_SCHEMAS)[T]> {
  const schema = TOOL_SCHEMAS[toolName];
  return schema.parse(input) as z.infer<(typeof TOOL_SCHEMAS)[T]>;
}
