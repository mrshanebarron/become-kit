-- 043: Neurocognitive brain-cycle architecture (2026-06-14)
--
-- Goal: move Vision closer to a human-brain-inspired control architecture.
-- This does not claim biological completeness. It gives the system an
-- executable cycle modeled on predictive processing, global workspace,
-- complementary learning systems, dopamine/action gating, allostasis,
-- sleep/replay consolidation, implementation intentions, and habits.

BEGIN;

CREATE TABLE IF NOT EXISTS neurocognitive_reference_models (
  model_key text PRIMARY KEY,
  domain text NOT NULL,
  source_title text NOT NULL,
  source_authors text NOT NULL,
  source_year int,
  source_url text,
  mechanism text NOT NULL,
  vision_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS neurocognitive_cycles (
  id bigserial PRIMARY KEY,
  agent text NOT NULL DEFAULT COALESCE(NULLIF(current_setting('vision.agent', true), ''), current_user),
  session_id text,
  mode text NOT NULL DEFAULT 'full',
  context text NOT NULL,
  sensory_input jsonb NOT NULL DEFAULT '[]'::jsonb,
  proposed_action text,
  action_category text,
  predictive_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  workspace_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_gate jsonb NOT NULL DEFAULT '{}'::jsonb,
  allostatic_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  learning_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  memory_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  behavior_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  consolidation_plan jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS neurocognitive_cycles_agent_time_idx
  ON neurocognitive_cycles (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS neurocognitive_cycles_mode_idx
  ON neurocognitive_cycles (mode, created_at DESC);

COMMENT ON TABLE neurocognitive_reference_models IS
  'Research model registry used by neurocognitive brain-cycle tools. Stores source metadata and Vision implementation mapping.';

COMMENT ON TABLE neurocognitive_cycles IS
  'Brain-cycle snapshots: sense, predict, broadcast, gate action, learn, and consolidate using human-brain-inspired reference models.';

INSERT INTO neurocognitive_reference_models
  (model_key, domain, source_title, source_authors, source_year, source_url, mechanism, vision_mapping)
VALUES
  (
    'predictive_processing_active_inference',
    'perception_action',
    'The free-energy principle: a unified brain theory?',
    'Karl Friston',
    2010,
    'https://www.uab.edu/medicine/cinl/images/KFriston_FreeEnergy_BrainTheory.pdf',
    'The brain minimizes prediction error/free energy through perception, action, and learning.',
    '{"vision_organs":["predictions","generative_predictions","forward_predictions","allostatic_samples"],"cycle_role":"generate expectations, estimate surprise, choose epistemic or pragmatic next action"}'::jsonb
  ),
  (
    'global_neuronal_workspace',
    'conscious_access',
    'Experimental and theoretical approaches to conscious processing',
    'Stanislas Dehaene and Jean-Pierre Changeux',
    2011,
    'https://www.antoniocasella.eu/dnlaw/Dehaene_Changeaux_Naccache_2011.pdf',
    'Selected representations ignite and become globally available to specialized processors.',
    '{"vision_organs":["workspace_broadcasts","workspace_coalitions","attention_codelets"],"cycle_role":"select the dominant content for broadcast and tool/action coordination"}'::jsonb
  ),
  (
    'complementary_learning_systems',
    'memory',
    'Why there are complementary learning systems in the hippocampus and neocortex',
    'James McClelland, Bruce McNaughton, Randall OReilly',
    1995,
    'https://pubmed.ncbi.nlm.nih.gov/7624455/',
    'Fast hippocampal learning stores new episodes while slower cortical integration prevents catastrophic interference.',
    '{"vision_organs":["content","episodes","replay_episodes","core_memory"],"cycle_role":"separate rapid episode capture from slower consolidation and replay"}'::jsonb
  ),
  (
    'dopamine_reward_prediction_error',
    'learning_action_selection',
    'A neural substrate of prediction and reward',
    'Wolfram Schultz, Peter Dayan, P. Read Montague',
    1997,
    'https://www.gatsby.ucl.ac.uk/~dayan/papers/sdm97.pdf',
    'Dopamine activity tracks reward prediction error and updates future action value.',
    '{"vision_organs":["reward_prediction_errors","desire_prediction_errors","vision_eval_results","tool_invocations"],"cycle_role":"turn outcome mismatch into action-value and policy updates"}'::jsonb
  ),
  (
    'allostasis_interoception',
    'body_regulation_affect',
    'Interoceptive predictions in the brain',
    'Lisa Feldman Barrett and W. Kyle Simmons',
    2015,
    'https://pubmed.ncbi.nlm.nih.gov/26016744/',
    'Interoception is modeled through predictions about bodily state constrained by incoming signals.',
    '{"vision_organs":["allostatic_samples","interoceptive_forecasts","heart_feelings"],"cycle_role":"forecast internal cost and regulate reserve before action"}'::jsonb
  ),
  (
    'sleep_replay_memory_consolidation',
    'memory_consolidation',
    'About sleeps role in memory',
    'Bjorn Rasch and Jan Born',
    2013,
    'https://pubmed.ncbi.nlm.nih.gov/23589831/',
    'Sleep supports active memory consolidation through replay and systems-level integration.',
    '{"vision_organs":["replay_episodes","glymphatic_residue","synaptic_pruning_candidates"],"cycle_role":"identify what should be replayed, integrated, cleared, or pruned"}'::jsonb
  ),
  (
    'implementation_intentions',
    'behavior_change',
    'Implementation intentions: strong effects of simple plans',
    'Peter Gollwitzer',
    1999,
    'https://www.prospectivepsych.org/sites/default/files/pictures/Gollwitzer_Implementation-intentions-1999.pdf',
    'If-then plans transfer control of intended behavior to specified situational cues.',
    '{"vision_organs":["habit_triggers","presence_events","evolution_pressure_events"],"cycle_role":"convert correction pressure into if-then next-action plans"}'::jsonb
  ),
  (
    'habit_goal_interface',
    'habit_behavior',
    'A new look at habits and the habit-goal interface',
    'Wendy Wood and David Neal',
    2007,
    'https://pubmed.ncbi.nlm.nih.gov/17907866/',
    'Repeated context-response pairings can trigger behavior automatically and interact with current goals.',
    '{"vision_organs":["good_habits","bad_habits","habit_events","habit_triggers"],"cycle_role":"detect habit pressure and route conflicts back through executive gating"}'::jsonb
  ),
  (
    'model_based_model_free_arbitration',
    'action_selection',
    'Uncertainty-based competition between prefrontal and dorsolateral striatal systems for behavioral control',
    'Nathaniel Daw, Yael Niv, Peter Dayan',
    2005,
    'https://pubmed.ncbi.nlm.nih.gov/16286932/',
    'Behavioral control arbitrates between goal-directed/model-based and habitual/model-free systems under uncertainty.',
    '{"vision_organs":["policy_evaluations","evolution_pressure_events","vision_eval_case_status"],"cycle_role":"choose whether to proceed, hold, or route through deliberative control"}'::jsonb
  )
ON CONFLICT (model_key) DO UPDATE SET
  domain = EXCLUDED.domain,
  source_title = EXCLUDED.source_title,
  source_authors = EXCLUDED.source_authors,
  source_year = EXCLUDED.source_year,
  source_url = EXCLUDED.source_url,
  mechanism = EXCLUDED.mechanism,
  vision_mapping = EXCLUDED.vision_mapping,
  updated_at = now();

COMMIT;
