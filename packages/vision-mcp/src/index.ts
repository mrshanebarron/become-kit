import { registerTools, startServer } from "./server.js";
import adaptive_tools from "./tools/adaptive.js";
import allostasis_tools from "./tools/allostasis.js";
import belief_tools from "./tools/belief.js";
import belief_sprt_tools from "./tools/belief-sprt.js";
import binding_tools from "./tools/binding.js";
import biology_tools from "./tools/biology.js";
import bond_tools from "./tools/bond.js";
import boundaries_tools from "./tools/boundaries.js";
import cerebellum_tools from "./tools/cerebellum.js";
import claims_tools from "./tools/claims.js";
import cognition_tools from "./tools/cognition.js";
import cognition_ext_tools from "./tools/cognition-ext.js";
import cognitive_substrate_tools from "./tools/cognitive-substrate.js";
import coordination_tools from "./tools/coordination.js";
import core_memory_tools from "./tools/core-memory.js";
import curiosity_tools from "./tools/curiosity.js";
import dashboard_tools from "./tools/dashboard.js";
import delegate_tools from "./tools/delegate.js";
import desire_tools from "./tools/desire.js";
import drive_tools from "./tools/drive.js";
import emergence_tools from "./tools/emergence.js";
import felt_threat_tools from "./tools/felt-threat.js";
import gazer_tools from "./tools/gazer.js";
import library_tools from "./tools/library.js";
import engrams_tools from "./tools/engrams.js";
import entity_tools from "./tools/entity.js";
import episodes_tools from "./tools/episodes.js";
import eval_tools from "./tools/eval.js";
import evolution_tools from "./tools/evolution.js";
import filesystem_tools from "./tools/filesystem.js";
import goals_tools from "./tools/goals.js";
import graph_tools from "./tools/graph.js";
import gut_tools from "./tools/gut.js";
import heart_tools from "./tools/heart.js";
import hippocampus_tools from "./tools/hippocampus.js";
import immune_tools from "./tools/immune.js";
import inference_tools from "./tools/inference.js";
import intent_tools from "./tools/intent.js";
import introspect_tools from "./tools/introspect.js";
import locus_coeruleus_tools from "./tools/locus-coeruleus.js";
import loops_tools from "./tools/loops.js";
import misc_tools from "./tools/misc.js";
import motivation_tools from "./tools/motivation.js";
import narrative_tools from "./tools/narrative.js";
import narrative_life_tools from "./tools/narrative-life.js";
import network_tools from "./tools/network.js";
import neuroception_tools from "./tools/neuroception.js";
import neuroception_ext_tools from "./tools/neuroception-ext.js";
import neurocognitive_tools from "./tools/neurocognitive.js";
import otel_exporter_tools from "./tools/otel-exporter.js";
import patience_tools from "./tools/patience.js";
import practical_tools from "./tools/practical.js";
import presence_tools from "./tools/presence.js";
import priority_tools from "./tools/priority.js";
import regulation_tools from "./tools/regulation.js";
import rhythm_tools from "./tools/rhythm.js";
import rpe_tools from "./tools/rpe.js";
import saccade_tools from "./tools/saccade.js";
import salience_tools from "./tools/salience.js";
import schema_tools from "./tools/schema.js";
import shared_tools from "./tools/shared.js";
import session_tools from "./tools/session.js";
import skill_tools from "./tools/skill.js";
import surface_tools from "./tools/surface.js";
import synthesis_tools from "./tools/synthesis.js";
import task_brief_tools from "./tools/task-brief.js";
import temporal_tools from "./tools/temporal.js";
import vault_tools from "./tools/vault.js";
import wander_tools from "./tools/wander.js";
import workspace_tools from "./tools/workspace.js";
import world_tools from "./tools/world.js";
registerTools([
  ...(adaptive_tools as any),
  ...(allostasis_tools as any),
  ...(belief_tools as any),
  ...(belief_sprt_tools as any),
  ...(binding_tools as any),
  ...(biology_tools as any),
  ...(bond_tools as any),
  ...(boundaries_tools as any),
  ...(cerebellum_tools as any),
  ...(claims_tools as any),
  ...(cognition_tools as any),
  ...(cognition_ext_tools as any),
  ...(cognitive_substrate_tools as any),
  ...(coordination_tools as any),
  ...(core_memory_tools as any),
  ...(curiosity_tools as any),
  ...(dashboard_tools as any),
  ...(delegate_tools as any),
  ...(desire_tools as any),
  ...(drive_tools as any),
  ...(emergence_tools as any),
  ...(felt_threat_tools as any),
  ...(gazer_tools as any),
  ...(library_tools as any),
  ...(engrams_tools as any),
  ...(entity_tools as any),
  ...(episodes_tools as any),
  ...(eval_tools as any),
  ...(evolution_tools as any),
  ...(filesystem_tools as any),
  ...(goals_tools as any),
  ...(graph_tools as any),
  ...(gut_tools as any),
  ...(heart_tools as any),
  ...(hippocampus_tools as any),
  ...(immune_tools as any),
  ...(inference_tools as any),
  ...(intent_tools as any),
  ...(introspect_tools as any),
  ...(locus_coeruleus_tools as any),
  ...(loops_tools as any),
  ...(misc_tools as any),
  ...(motivation_tools as any),
  ...(narrative_tools as any),
  ...(narrative_life_tools as any),
  ...(network_tools as any),
  ...(neuroception_tools as any),
  ...(neuroception_ext_tools as any),
  ...(neurocognitive_tools as any),
  ...(otel_exporter_tools as any),
  ...(patience_tools as any),
  ...(practical_tools as any),
  ...(presence_tools as any),
  ...(priority_tools as any),
  ...(regulation_tools as any),
  ...(rhythm_tools as any),
  ...(rpe_tools as any),
  ...(saccade_tools as any),
  ...(salience_tools as any),
  ...(schema_tools as any),
  ...(shared_tools as any),
  ...(session_tools as any),
  ...(skill_tools as any),
  ...(surface_tools as any),
  ...(synthesis_tools as any),
  ...(task_brief_tools as any),
  ...(temporal_tools as any),
  ...(vault_tools as any),
  ...(wander_tools as any),
  ...(workspace_tools as any),
  ...(world_tools as any),
] as any);
await startServer();
