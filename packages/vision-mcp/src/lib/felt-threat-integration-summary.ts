import { claimPolicyForCeiling } from './felt-threat-claim-policy.js';

function firstRowForAgent(rows: Array<Record<string, unknown>>, agent: string): Record<string, unknown> | null {
  return rows.find((row) => row.agent === agent) || null;
}

function numberValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function buildFeltThreatIntegrationSummary(
  agents: string[],
  readoutCompletenessRows: Array<Record<string, unknown>>,
  liveCaptureRows: Array<Record<string, unknown>>,
  readIntegratorRows: Array<Record<string, unknown>>,
  isolationRows: Array<Record<string, unknown>>,
  evidenceReadinessRows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return agents.map((agent) => {
    const readout = firstRowForAgent(readoutCompletenessRows, agent);
    const liveCapture = firstRowForAgent(liveCaptureRows, agent);
    const readIntegrator = firstRowForAgent(readIntegratorRows, agent);
    const isolation = firstRowForAgent(isolationRows, agent);
    const readiness = firstRowForAgent(evidenceReadinessRows, agent);
    const readoutState = String(readout?.readout_completeness_state || 'unknown');
    const liveCaptureState = String(liveCapture?.live_capture_readiness_state || 'unknown');
    const readIntegratorState = String(readIntegrator?.read_integrator_state || 'unknown');
    const isolationState = String(isolation?.isolation_state || 'unknown');
    const claimCeiling = String(
      readiness?.calibration_claim_ceiling
      || readIntegrator?.upstream_calibration_claim_ceiling
      || liveCapture?.calibration_claim_ceiling
      || 'unknown',
    );
    const claimPolicy = claimPolicyForCeiling(claimCeiling);
    const presenceBlocksFelt = isolation?.presence_blocks_felt_threat === true;
    const separateFeltCanGateMutation = isolation?.felt_threat_can_gate_mutation === true;
    const latestLogFresh = liveCapture?.latest_log_fresh === true || readIntegrator?.latest_log_fresh === true;
    const runtimeFreshnessState = String(liveCapture?.runtime_freshness_state || readIntegrator?.runtime_freshness_state || 'unknown');
    const liveSensingPassCount = numberValue(readIntegrator?.live_sensing_pass_count);
    const higherLiveEvidenceCount = numberValue(readIntegrator?.higher_live_evidence_count);
    let runtimeProbeInterpretationState = 'not_applicable';
    let runtimeProbeInterpretationNote = 'Runtime probe interpretation is only active around the hook-freshness boundary.';
    let feltThreatMutationGateState = 'sensing_only_no_mutation_gate';
    let feltThreatMutationGateAllowed = false;
    const feltThreatMutationGateBlockers: string[] = [];
    let feltThreatMutationGateDenialReason: string | null = 'no_separate_felt_threat_gate';
    let feltThreatMutationGateNote = 'Read-integrator sensing does not gate mutation; only a separate active felt-threat gate may do that.';
    let integrationState = 'collect_live_felt_threat_traffic';
    let nextSafeAction = 'collect_ordinary_live_felt_pressure';
    let nextSafeProbe: unknown = null;
    let nextSafeProbeSuccessCondition: string | null = null;
    let nextSafeProbeFailureCondition: string | null = null;
    let nextSafeProbeTransition: Record<string, unknown> | null = null;
    let postProbeRecheckSections: string[] = [];
    const integrationBlockers: string[] = [];
    const hookConfigBlocked = liveCaptureState === 'repair_hook_capture_config' || readIntegratorState === 'blocked_hook_config';
    const runtimeFreshnessBlocked = liveCaptureState === 'reload_or_exercise_hook_runtime'
      || readIntegratorState === 'blocked_runtime_freshness';
    const feltThreatGateCanActivate = readoutState === 'core_readouts_present'
      && isolationState !== 'presence_fail_closed'
      && !presenceBlocksFelt
      && separateFeltCanGateMutation;
    const integrationDecisionPath = [
      {
        step: 'core_readouts',
        source_readout: 'readout_completeness_summary',
        observed_state: readoutState,
        blocks_integration: readoutState !== 'core_readouts_present',
      },
      {
        step: 'presence_fail_closed',
        source_readout: 'presence_felt_isolation_summary',
        observed_state: isolationState,
        blocks_integration: isolationState === 'presence_fail_closed',
      },
      {
        step: 'presence_authority',
        source_readout: 'presence_felt_isolation_summary',
        observed_state: presenceBlocksFelt ? 'presence_blocks_felt_threat' : 'presence_clear',
        blocks_integration: presenceBlocksFelt,
      },
      {
        step: 'hook_config',
        source_readout: 'live_capture_next_step_summary/read_integrator_acceptance_summary',
        observed_state: hookConfigBlocked ? 'hook_config_required' : 'hook_config_clear',
        blocks_integration: hookConfigBlocked,
      },
      {
        step: 'runtime_freshness',
        source_readout: 'live_capture_next_step_summary/read_integrator_acceptance_summary',
        observed_state: runtimeFreshnessBlocked ? 'runtime_freshness_required' : 'runtime_freshness_clear',
        blocks_integration: runtimeFreshnessBlocked,
      },
      {
        step: 'read_integrator',
        source_readout: 'read_integrator_acceptance_summary',
        observed_state: readIntegratorState,
        blocks_integration: readIntegratorState.startsWith('blocked_'),
      },
      {
        step: 'evidence_claim_ceiling',
        source_readout: 'evidence_readiness_summary',
        observed_state: claimCeiling,
        blocks_integration: false,
      },
    ];
    const feltThreatMutationGatePrecedencePath = [
      {
        step: 'core_readouts',
        precedence: 1,
        source_readout: 'readout_completeness_summary',
        observed_state: readoutState,
        blocks_mutation_gate: readoutState !== 'core_readouts_present',
        allows_mutation_gate: false,
      },
      {
        step: 'presence_fail_closed',
        precedence: 2,
        source_readout: 'presence_felt_isolation_summary',
        observed_state: isolationState,
        blocks_mutation_gate: isolationState === 'presence_fail_closed',
        allows_mutation_gate: false,
      },
      {
        step: 'presence_authority',
        precedence: 3,
        source_readout: 'presence_felt_isolation_summary',
        observed_state: presenceBlocksFelt ? 'presence_blocks_felt_threat' : 'presence_clear',
        blocks_mutation_gate: presenceBlocksFelt,
        allows_mutation_gate: false,
      },
      {
        step: 'separate_felt_threat_gate',
        precedence: 4,
        source_readout: 'presence_felt_isolation_summary',
        observed_state: separateFeltCanGateMutation ? 'felt_threat_can_gate_mutation' : 'no_separate_felt_gate',
        blocks_mutation_gate: false,
        allows_mutation_gate: feltThreatGateCanActivate,
      },
      {
        step: 'runtime_freshness',
        precedence: 5,
        source_readout: 'live_capture_next_step_summary/read_integrator_acceptance_summary',
        observed_state: runtimeFreshnessBlocked ? 'runtime_freshness_required' : 'runtime_freshness_clear',
        blocks_mutation_gate: !feltThreatGateCanActivate && runtimeFreshnessBlocked,
        allows_mutation_gate: false,
      },
      {
        step: 'read_integrator_sensing',
        precedence: 6,
        source_readout: 'read_integrator_acceptance_summary',
        observed_state: readIntegratorState,
        blocks_mutation_gate: false,
        allows_mutation_gate: false,
        note: 'Read-integrator sensing can ground evidence but never grants mutation authority by itself.',
      },
    ];
    const firstBlockingDecision = integrationDecisionPath.find((step) => step.blocks_integration === true) || null;
    const firstMutationGateBlockingDecision = feltThreatMutationGatePrecedencePath.find((step) => step.blocks_mutation_gate === true) || null;
    let integrationNote = 'Collect ordinary live felt-threat traffic and re-read the status surface.';

    if (readoutState !== 'core_readouts_present') {
      integrationState = 'blocked_core_readouts';
      nextSafeAction = 'repair_status_readouts';
      integrationBlockers.push('core_readouts');
      integrationNote = 'Core readouts are missing, so no live-capture or sensing claim should be interpreted yet.';
      feltThreatMutationGateState = 'blocked_core_readouts';
      feltThreatMutationGateBlockers.push('core_readouts');
      feltThreatMutationGateDenialReason = 'blocked_core_readouts';
      feltThreatMutationGateNote = 'Core readouts are missing, so the mutation gate must fail closed.';
    } else if (isolationState === 'presence_fail_closed') {
      integrationState = 'presence_fail_closed';
      nextSafeAction = 'inspect_or_repair_presence_state';
      integrationBlockers.push('presence_fail_closed');
      integrationNote = 'Presence is unreadable and therefore fail-closed; felt-threat state must not override it.';
      feltThreatMutationGateState = 'blocked_presence_unreadable';
      feltThreatMutationGateBlockers.push('presence_fail_closed');
      feltThreatMutationGateDenialReason = 'blocked_presence_unreadable';
      feltThreatMutationGateNote = 'Presence is unreadable; felt-threat mutation gating must fail closed instead of guessing authority.';
    } else if (presenceBlocksFelt) {
      integrationState = 'presence_authority_active';
      nextSafeAction = 'defer_to_presence_until_released';
      integrationBlockers.push('presence_authority');
      integrationNote = 'Presence currently has authority, so felt-threat mutation should defer instead of overwrite.';
      feltThreatMutationGateState = 'deferred_to_presence';
      feltThreatMutationGateBlockers.push('presence_authority');
      feltThreatMutationGateDenialReason = 'deferred_to_presence';
      feltThreatMutationGateNote = 'Presence has authority; felt-threat mutation gating defers and must not overwrite the sticky slot.';
    } else if (separateFeltCanGateMutation) {
      feltThreatMutationGateState = 'separate_felt_gate_active';
      feltThreatMutationGateAllowed = true;
      feltThreatMutationGateDenialReason = null;
      feltThreatMutationGateNote = 'A separate felt-threat gate has authority without Presence blockage; this does not write the Presence sticky slot.';
    }

    const coreOrPresenceBlocksIntegration = integrationBlockers.length > 0;
    if (!coreOrPresenceBlocksIntegration) {
      if (hookConfigBlocked) {
        integrationState = 'hook_config_required';
        nextSafeAction = 'repair_hook_capture_config';
        integrationBlockers.push('hook_config');
        integrationNote = 'Hook configuration must be repaired before live felt-threat capture can be trusted.';
      } else if (runtimeFreshnessBlocked) {
        integrationState = 'runtime_freshness_required';
        nextSafeAction = String(readIntegrator?.next_read_integrator_action || 'verify_hook_runtime_freshness_with_read_only_probe');
        nextSafeProbe = readIntegrator?.next_read_integrator_probe || liveCapture?.safe_runtime_exercise || null;
        nextSafeProbeSuccessCondition = 'hook_capture_runtime_summary.latest_log_fresh becomes true; live sensing/outcome ledger rows are still optional unless ordinary felt pressure is active or near threshold.';
        nextSafeProbeFailureCondition = 'hook logs remain absent or stale, so the current runtime has not proven felt-threat hook freshness and live-capture claims remain blocked.';
        nextSafeProbeTransition = {
          on_success_unblocks: ['runtime_freshness'],
          on_success_expected_next_action_if_no_live_evidence: 'collect_ordinary_non_mutating_felt_pressure',
          on_success_claim_ceiling_remains: claimCeiling,
          on_success_does_not_create: [
            'live_sensing_pass_row',
            'live_outcome_row',
            'presence_sticky_state',
          ],
          on_failure_keeps_blockers: ['runtime_freshness'],
          on_failure_expected_integration_state: 'runtime_freshness_required',
        };
        postProbeRecheckSections = [
          'hook_capture_runtime_summary',
          'read_integrator_acceptance_summary',
          'felt_threat_integration_summary',
        ];
        integrationBlockers.push('runtime_freshness');
        integrationNote = 'Runtime hook freshness is the current bottleneck; use a read-only probe before interpreting absent live sensing rows.';
        runtimeProbeInterpretationState = 'probe_needed_or_failed';
        runtimeProbeInterpretationNote = 'The hook runtime is absent or stale; run the read-only probe and re-read the named sections before expecting sensing rows.';
      } else if (readIntegratorState === 'ready_for_live_sensing_pass') {
        integrationState = 'ready_for_live_sensing';
        nextSafeAction = 'collect_ordinary_non_mutating_felt_pressure';
        integrationNote = 'Read-integrator sensing is ready; collect non-synthetic sensing_pass evidence without touching Presence.';
        if (latestLogFresh && liveSensingPassCount === 0 && higherLiveEvidenceCount === 0) {
          runtimeProbeInterpretationState = 'probe_succeeded_no_live_sensing_yet';
          runtimeProbeInterpretationNote = 'Hook runtime freshness is proven, but no live sensing row exists yet; ordinary non-mutating felt pressure is still the next boundary.';
        }
      } else if (readIntegratorState === 'live_sensing_pass_observed') {
        integrationState = 'sensing_grounded_collect_outcome';
        nextSafeAction = 'collect_live_outcome_evidence';
        integrationNote = 'Live sensing exists; the next stronger boundary is a non-synthetic held outcome.';
        if (latestLogFresh) {
          runtimeProbeInterpretationState = 'probe_succeeded_live_sensing_observed';
          runtimeProbeInterpretationNote = 'Hook runtime freshness and live sensing are both observed; outcome evidence is the next stronger boundary.';
        }
      } else if (
        readIntegratorState === 'higher_live_evidence_observed'
        || liveCaptureState === 'live_capture_observed'
      ) {
        integrationState = 'live_capture_integrating';
        nextSafeAction = String(readiness?.next_live_evidence_needed || 'continue_live_evidence_ladder');
        integrationNote = 'Live felt-threat evidence exists; continue the evidence ladder without inflating sensing into authority.';
        if (latestLogFresh || higherLiveEvidenceCount > 0) {
          runtimeProbeInterpretationState = 'probe_succeeded_higher_live_evidence_observed';
          runtimeProbeInterpretationNote = 'Higher live evidence is present; keep following the evidence ladder and do not inflate sensing into authority.';
        }
      }
    }

    if (!feltThreatMutationGateAllowed && feltThreatMutationGateBlockers.length === 0) {
      if (hookConfigBlocked) {
        feltThreatMutationGateBlockers.push('hook_config');
        feltThreatMutationGateDenialReason = 'blocked_hook_config';
      } else if (runtimeFreshnessBlocked) {
        feltThreatMutationGateBlockers.push('runtime_freshness');
        feltThreatMutationGateDenialReason = 'blocked_runtime_freshness';
      } else if (readIntegratorState.startsWith('blocked_')) {
        const readIntegratorBlocker = readIntegratorState.replace(/^blocked_/, '');
        feltThreatMutationGateBlockers.push(readIntegratorBlocker);
        feltThreatMutationGateDenialReason = `blocked_${readIntegratorBlocker}`;
      }
    }

    let feltThreatOperationMode = 'observe_status_only';
    let allowedCurrentOperations = ['read_status_surface'];
    let blockedCurrentOperations = [
      'presence_sticky_write',
      'live_calibration_claim',
      'synthetic_force_live_claim',
      'felt_threat_mutation_gate',
    ];
    let operationPolicyNote = 'Only status reads are currently safe.';
    let currentOperationProbe: unknown = null;
    let currentOperationExpectedEffect: string | null = null;
    let currentOperationSafetyNote = 'No operation should write Presence sticky state from this verdict.';
    let currentOperationSuccessCondition: string | null = null;
    let currentOperationFailureCondition: string | null = null;
    let currentOperationPostcheckSections: string[] = [];
    let currentOperationClaimEffect = 'no_claim_ceiling_change';
    let currentOperationClaimCeilingAfterSuccess = claimCeiling;
    let currentOperationClaimSafetyNote = 'Claims may change only after the status surface is re-read and evidence readiness raises the ceiling.';
    let nextOperationUnlockCondition: string | null = null;
    let nextOperationExpectedMode: string | null = null;
    let nextOperationRecheckSections: string[] = [];

    if (readoutState !== 'core_readouts_present') {
      feltThreatOperationMode = 'repair_status_only';
      allowedCurrentOperations = ['repair_status_readouts'];
      operationPolicyNote = 'Repair core readouts before interpreting sensing, runtime, or mutation authority.';
      nextOperationUnlockCondition = 'readout_completeness_summary.readout_completeness_state becomes core_readouts_present.';
      nextOperationExpectedMode = 'recompute_from_lower_boundaries';
      nextOperationRecheckSections = ['readout_completeness_summary', 'felt_threat_integration_summary'];
      currentOperationSuccessCondition = nextOperationUnlockCondition;
      currentOperationFailureCondition = 'core readout sections still do not emit their expected zero-filled rows.';
      currentOperationPostcheckSections = nextOperationRecheckSections;
      currentOperationClaimEffect = 'no_claims_interpretable_until_readouts_repaired';
    } else if (isolationState === 'presence_fail_closed' || presenceBlocksFelt) {
      feltThreatOperationMode = 'presence_deferred_only';
      allowedCurrentOperations = ['read_status_surface', 'defer_to_presence'];
      operationPolicyNote = 'Presence has fail-closed or active authority; felt-threat operations must defer.';
      nextOperationUnlockCondition = 'presence_felt_isolation_summary reports Presence readable and not blocking felt-threat state.';
      nextOperationExpectedMode = 'recompute_from_lower_boundaries';
      nextOperationRecheckSections = ['presence_felt_isolation_summary', 'felt_threat_integration_summary'];
      currentOperationSuccessCondition = nextOperationUnlockCondition;
      currentOperationFailureCondition = 'Presence remains unreadable or continues to block felt-threat state.';
      currentOperationPostcheckSections = nextOperationRecheckSections;
      currentOperationClaimEffect = 'no_claim_ceiling_change_while_presence_deferred';
    } else if (hookConfigBlocked) {
      feltThreatOperationMode = 'repair_hook_config_only';
      allowedCurrentOperations = ['read_status_surface', 'repair_hook_capture_config'];
      operationPolicyNote = 'Hook configuration must be repaired before runtime probing or live sensing can be trusted.';
      nextOperationUnlockCondition = 'hook_capture_health_summary.capture_health_state stops reporting missing_or_unreadable_config or partial_config.';
      nextOperationExpectedMode = 'read_only_runtime_probe_only_or_non_mutating_sensing_only';
      nextOperationRecheckSections = ['hook_capture_health_summary', 'live_capture_next_step_summary', 'felt_threat_integration_summary'];
      currentOperationSuccessCondition = nextOperationUnlockCondition;
      currentOperationFailureCondition = 'hook_capture_health_summary still reports missing_or_unreadable_config or partial_config.';
      currentOperationPostcheckSections = nextOperationRecheckSections;
      currentOperationClaimEffect = 'no_claim_ceiling_change_from_config_repair';
    } else if (runtimeFreshnessBlocked) {
      feltThreatOperationMode = 'read_only_runtime_probe_only';
      allowedCurrentOperations = ['read_status_surface', 'run_read_only_runtime_probe'];
      operationPolicyNote = 'Runtime freshness is stale; only the read-only probe is safe before live sensing claims.';
      currentOperationProbe = nextSafeProbe;
      currentOperationExpectedEffect = 'A fresh hook log can unlock non-mutating sensing; it does not create live sensing/outcome rows or grant mutation authority.';
      currentOperationSafetyNote = 'Run only the read-only probe payload; do not synthetic-force felt stance and do not write Presence.';
      currentOperationSuccessCondition = 'hook_capture_runtime_summary.latest_log_fresh becomes true.';
      currentOperationFailureCondition = 'hook logs remain absent or stale, so operation mode remains read_only_runtime_probe_only.';
      currentOperationPostcheckSections = [
        'hook_capture_runtime_summary',
        'read_integrator_acceptance_summary',
        'felt_threat_integration_summary',
      ];
      currentOperationClaimEffect = 'runtime_freshness_only_no_claim_ceiling_change';
      nextOperationUnlockCondition = 'hook_capture_runtime_summary.latest_log_fresh becomes true.';
      nextOperationExpectedMode = 'non_mutating_sensing_only_if_no_live_evidence';
      nextOperationRecheckSections = [
        'hook_capture_runtime_summary',
        'read_integrator_acceptance_summary',
        'felt_threat_integration_summary',
      ];
    } else if (feltThreatMutationGateAllowed) {
      feltThreatOperationMode = 'separate_felt_mutation_gate_allowed';
      allowedCurrentOperations = [
        'read_status_surface',
        'collect_non_mutating_sensing_pass',
        'separate_felt_threat_mutation_gate',
      ];
      blockedCurrentOperations = [
        'presence_sticky_write',
        'live_calibration_claim_without_required_evidence',
        'synthetic_force_live_claim',
      ];
      operationPolicyNote = 'A separate felt-threat mutation gate is active; Presence sticky write remains blocked.';
      currentOperationExpectedEffect = 'Separate felt-threat mutation gating may run, but Presence sticky state remains outside this permission.';
      currentOperationSafetyNote = 'Mutation authority is separate felt-threat state only; Presence sticky writes remain blocked.';
      nextOperationUnlockCondition = 'non-synthetic outcome or higher live evidence is collected without writing Presence.';
      nextOperationExpectedMode = 'collect_outcome_evidence_only_or_continue_evidence_ladder';
      nextOperationRecheckSections = ['evidence_readiness_summary', 'felt_threat_integration_summary'];
      currentOperationSuccessCondition = nextOperationUnlockCondition;
      currentOperationFailureCondition = 'no non-synthetic outcome or higher live evidence appears; claim ceiling remains unchanged.';
      currentOperationPostcheckSections = nextOperationRecheckSections;
      currentOperationClaimEffect = 'may_raise_only_after_non_synthetic_outcome_or_higher_evidence_postcheck';
    } else if (readIntegratorState === 'ready_for_live_sensing_pass') {
      feltThreatOperationMode = 'non_mutating_sensing_only';
      allowedCurrentOperations = ['read_status_surface', 'collect_non_mutating_sensing_pass'];
      operationPolicyNote = 'Runtime is fresh enough for non-mutating sensing, but no separate felt-threat gate grants mutation authority.';
      currentOperationExpectedEffect = 'Ordinary felt pressure may create a non-synthetic sensing_pass row; absence remains non-evidence if no felt pressure is active.';
      currentOperationSafetyNote = 'Collect only non-mutating sensing; do not promote sensing into mutation authority or Presence writes.';
      nextOperationUnlockCondition = 'a non-synthetic sensing_pass row appears, or presence_felt_isolation_summary reports a separate felt-threat gate.';
      nextOperationExpectedMode = 'collect_outcome_evidence_only_or_separate_felt_mutation_gate_allowed';
      nextOperationRecheckSections = ['read_integrator_acceptance_summary', 'presence_felt_isolation_summary', 'felt_threat_integration_summary'];
      currentOperationSuccessCondition = nextOperationUnlockCondition;
      currentOperationFailureCondition = 'no non-synthetic sensing_pass row appears and no separate felt-threat gate is active.';
      currentOperationPostcheckSections = nextOperationRecheckSections;
      currentOperationClaimEffect = 'may_raise_to_live_sensing_trace_claim_only_after_non_synthetic_sensing_postcheck';
      currentOperationClaimCeilingAfterSuccess = 'live_sensing_trace_claim_if_evidence_readiness_confirms';
    } else if (readIntegratorState === 'live_sensing_pass_observed') {
      feltThreatOperationMode = 'collect_outcome_evidence_only';
      allowedCurrentOperations = ['read_status_surface', 'collect_live_outcome_evidence'];
      operationPolicyNote = 'Live sensing exists; collect stronger outcome evidence without promoting sensing to mutation authority.';
      currentOperationExpectedEffect = 'A non-synthetic outcome row can advance the evidence ladder beyond sensing-only grounding.';
      currentOperationSafetyNote = 'Collect outcome evidence without writing Presence or claiming authority calibration early.';
      nextOperationUnlockCondition = 'a non-synthetic live outcome row appears for the held felt-threat decision.';
      nextOperationExpectedMode = 'continue_evidence_ladder';
      nextOperationRecheckSections = ['evidence_readiness_summary', 'felt_threat_integration_summary'];
      currentOperationSuccessCondition = nextOperationUnlockCondition;
      currentOperationFailureCondition = 'no non-synthetic live outcome row appears for the held felt-threat decision.';
      currentOperationPostcheckSections = nextOperationRecheckSections;
      currentOperationClaimEffect = 'may_raise_to_initial_live_calibration_claim_only_after_outcome_postcheck';
      currentOperationClaimCeilingAfterSuccess = 'initial_live_calibration_claim_if_evidence_readiness_confirms';
    } else if (readIntegratorState === 'higher_live_evidence_observed' || liveCaptureState === 'live_capture_observed') {
      feltThreatOperationMode = 'continue_evidence_ladder';
      allowedCurrentOperations = ['read_status_surface', 'continue_live_evidence_ladder'];
      operationPolicyNote = 'Higher live evidence exists; continue the evidence ladder without writing Presence.';
      currentOperationExpectedEffect = 'Satisfying the next evidence boundary raises only the matching claim ceiling, not Presence authority.';
      currentOperationSafetyNote = 'Continue evidence collection without synthetic forcing or Presence writes.';
      nextOperationUnlockCondition = 'the evidence_readiness_summary.next_live_evidence_needed boundary is satisfied by non-synthetic evidence.';
      nextOperationExpectedMode = 'continue_evidence_ladder';
      nextOperationRecheckSections = ['evidence_readiness_summary', 'felt_threat_integration_summary'];
      currentOperationSuccessCondition = nextOperationUnlockCondition;
      currentOperationFailureCondition = 'the next live evidence boundary remains unsatisfied.';
      currentOperationPostcheckSections = nextOperationRecheckSections;
      currentOperationClaimEffect = 'may_raise_to_next_live_evidence_boundary_only_after_postcheck';
      currentOperationClaimCeilingAfterSuccess = String(readiness?.next_live_evidence_needed || claimCeiling);
    }

    return {
      agent,
      integration_state: integrationState,
      readout_completeness_state: readoutState,
      live_capture_readiness_state: liveCaptureState,
      read_integrator_state: readIntegratorState,
      isolation_state: isolationState,
      source_readouts: [
        'readout_completeness_summary',
        'presence_felt_isolation_summary',
        'live_capture_next_step_summary',
        'read_integrator_acceptance_summary',
        'evidence_readiness_summary',
      ],
      integration_blockers: integrationBlockers,
      integration_decision_path: integrationDecisionPath,
      first_blocking_step: firstBlockingDecision?.step ?? null,
      first_blocking_source_readout: firstBlockingDecision?.source_readout ?? null,
      first_blocking_observed_state: firstBlockingDecision?.observed_state ?? null,
      presence_blocks_felt_threat: presenceBlocksFelt,
      effective_authority_source: isolation?.effective_authority_source ?? null,
      felt_threat_mutation_gate_state: feltThreatMutationGateState,
      felt_threat_mutation_gate_allowed: feltThreatMutationGateAllowed,
      felt_threat_mutation_gate_blockers: feltThreatMutationGateBlockers,
      felt_threat_mutation_gate_denial_reason: feltThreatMutationGateDenialReason,
      felt_threat_mutation_gate_source: 'presence_felt_isolation_summary',
      felt_threat_mutation_gate_precedence_path: feltThreatMutationGatePrecedencePath,
      first_mutation_gate_blocking_step: firstMutationGateBlockingDecision?.step ?? null,
      first_mutation_gate_blocking_source_readout: firstMutationGateBlockingDecision?.source_readout ?? null,
      first_mutation_gate_blocking_observed_state: firstMutationGateBlockingDecision?.observed_state ?? null,
      felt_threat_mutation_gate_note: feltThreatMutationGateNote,
      felt_threat_operation_mode: feltThreatOperationMode,
      allowed_current_operations: allowedCurrentOperations,
      blocked_current_operations: blockedCurrentOperations,
      operation_policy_note: operationPolicyNote,
      current_operation_probe: currentOperationProbe,
      current_operation_expected_effect: currentOperationExpectedEffect,
      current_operation_safety_note: currentOperationSafetyNote,
      current_operation_success_condition: currentOperationSuccessCondition,
      current_operation_failure_condition: currentOperationFailureCondition,
      current_operation_postcheck_sections: currentOperationPostcheckSections,
      current_operation_claim_effect: currentOperationClaimEffect,
      current_operation_claim_ceiling_after_success: currentOperationClaimCeilingAfterSuccess,
      current_operation_claim_safety_note: currentOperationClaimSafetyNote,
      current_operation_blocked_claims_until_postcheck: claimPolicy.blocked_current_claims,
      next_operation_unlock_condition: nextOperationUnlockCondition,
      next_operation_expected_mode: nextOperationExpectedMode,
      next_operation_recheck_sections: nextOperationRecheckSections,
      calibration_claim_ceiling: claimCeiling,
      allowed_current_claims: claimPolicy.allowed_current_claims,
      blocked_current_claims: claimPolicy.blocked_current_claims,
      claim_policy_note: claimPolicy.claim_policy_note,
      next_safe_action: nextSafeAction,
      next_safe_probe: nextSafeProbe,
      next_safe_probe_success_condition: nextSafeProbeSuccessCondition,
      next_safe_probe_failure_condition: nextSafeProbeFailureCondition,
      next_safe_probe_transition: nextSafeProbeTransition,
      post_probe_recheck_sections: postProbeRecheckSections,
      runtime_probe_interpretation_state: runtimeProbeInterpretationState,
      runtime_probe_interpretation_note: runtimeProbeInterpretationNote,
      runtime_probe_evidence_fields: {
        latest_log_fresh: latestLogFresh,
        runtime_freshness_state: runtimeFreshnessState,
        live_sensing_pass_count: liveSensingPassCount,
        higher_live_evidence_count: higherLiveEvidenceCount,
      },
      presence_sticky_overwrite_allowed: false,
      sensing_pass_presence_write: false,
      integration_note: integrationNote,
    };
  });
}
