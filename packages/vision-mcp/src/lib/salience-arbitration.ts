export type SalienceIntervention =
  | 'reconnect_surface'
  | 'honor_presence_hold'
  | 'hold_for_felt_threat'
  | 'ask_owner'
  | 'forage_research'
  | 'switch_patch'
  | 'research_first'
  | 'collect_live_evidence'
  | 'review_prediction_miss'
  | 'persist'
  | 'act_now'
  | 'safe_to_proceed';

export const COMPARISON_OPERATORS = [
  'equals',
  'not_equals',
  'less_than',
  'less_than_or_equal',
  'greater_than',
  'greater_than_or_equal',
  'contains',
  'matches_regex',
] as const;

export type ComparisonOperator = typeof COMPARISON_OPERATORS[number];

export type SalienceSignal = {
  source: string;
  intervention: SalienceIntervention;
  priority: number;
  state: string | null;
  reason: string;
  evidence_ceiling?: string | null;
  diagnostics?: Record<string, unknown>;
};

export type SalienceArbitrationInput = {
  surface?: {
    freshness_state?: string | null;
    build_required?: boolean;
    restart_required?: boolean;
    watched_changed_after_process_start?: boolean;
  } | null;
  gate_authority?: {
    active?: boolean;
    source?: string | null;
    effective_precedence?: string | null;
    state?: string | null;
    stance?: string | null;
    reason?: string | null;
  } | null;
  evidence_readiness?: {
    readiness_state?: string | null;
    readiness_level?: number | null;
    next_live_evidence_needed?: string | null;
    calibration_claim_ceiling?: string | null;
    needs_live_traffic?: boolean;
    synthetic_only?: boolean;
  } | null;
  forage_signal?: {
    intervention?: string | null;
    patch_utility_state?: string | null;
    tonic_foraging_pressure?: number | null;
    claim_ceiling?: string | null;
    reason?: string | null;
    diagnostics?: Record<string, unknown> | null;
  } | null;
  patience?: {
    stance?: string | null;
    confidence_posture?: string | null;
    p_persistence_pays?: number | null;
    p_lower_approx_95?: number | null;
    p_upper_approx_95?: number | null;
    evidence_n?: number | null;
  } | null;
  action_readiness?: {
    action_kind?: string | null;
    forward_prediction_id?: number | null;
    prediction?: string | null;
    predicted_outcome?: string | null;
    predicted_observable?: string | null;
    comparison_operator?: ComparisonOperator | string | null;
    expected_value?: string | number | boolean | null;
    actual_value?: string | number | boolean | null;
    verification_plan?: string | null;
    verification_step?: string | null;
    verification_observable?: string | null;
    actual_observation_source?: string | null;
    prediction_logged_before_action?: boolean;
    verification_plan_logged?: boolean;
    claim_logged_before_action?: boolean;
  } | null;
  authority_drift?: {
    active?: boolean;
    severity?: string | null;
    state?: string | null;
    drift_score?: number | null;
  } | null;
  relay?: {
    unread?: number | null;
    urgent?: boolean;
    pressure?: string | null;
  } | null;
};

export type SalienceArbitration = {
  selected_intervention: SalienceIntervention;
  selected_signal: SalienceSignal;
  suppressed_alternatives: SalienceSignal[];
  all_signals: SalienceSignal[];
  evidence_ceiling: string | null;
  arbitration_basis: string;
  organ_state_mutation_allowed: false;
  presence_sticky_overwrite_allowed: false;
  state_isolation_policy: string;
};

export type ActionPrecommitQuality = {
  prediction_logged: boolean;
  verification_logged: boolean;
  prediction_quality: 'missing' | 'uncomputable' | 'computable';
  verification_quality: 'missing' | 'uncomputable' | 'computable';
  eligible: boolean;
  blocked_reasons: string[];
  contrastable: boolean;
  contrastable_basis: 'forward_prediction_id' | 'structured_assertion' | null;
  predicted_observable: string | null;
  verification_observable: string | null;
  comparison_operator: ComparisonOperator | null;
};

export type ContrastableAssertionEvaluation = {
  comparable: boolean;
  matched: boolean | null;
  operator: ComparisonOperator | null;
  actual_value: unknown;
  expected_value: unknown;
  reason: string;
};

function bool(value: unknown): boolean {
  return value === true;
}

function severityRank(severity: string | null | undefined): number {
  if (severity === 'critical') return 4;
  if (severity === 'high') return 3;
  if (severity === 'medium') return 2;
  if (severity === 'low') return 1;
  return 0;
}

function isMutationAction(actionKind: string | null | undefined): boolean {
  return ['mutation', 'write', 'execute', 'external_write', 'tool_mutation'].includes(actionKind || '');
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function comparableKey(value: unknown): string {
  return cleanText(value).toLowerCase().replace(/^['"`]+|['"`]+$/g, '');
}

function trailingField(value: unknown): string {
  const cmpKey = comparableKey(value);
  const parts = cmpKey.split('.').filter(Boolean);
  return parts.at(-1) || cmpKey;
}

function hasExpectedValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function hasActualValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function isTautologicalExpectedValue(predictedObservable: string, expectedValue: unknown): boolean {
  if (typeof expectedValue !== 'string') return false;
  const observable = comparableKey(predictedObservable);
  const expected = comparableKey(expectedValue);
  if (!observable || !expected) return false;
  return observable === expected || trailingField(observable) === expected;
}

function comparisonOperator(value: unknown): ComparisonOperator | null {
  return COMPARISON_OPERATORS.includes(value as ComparisonOperator)
    ? value as ComparisonOperator
    : null;
}

function numericValue(value: unknown): number | null {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/%$/, '')
    : value;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function evaluateContrastableAssertion(args: {
  actual_value?: unknown;
  comparison_operator?: unknown;
  expected_value?: unknown;
}): ContrastableAssertionEvaluation {
  const operator = comparisonOperator(args.comparison_operator);
  if (!operator) {
    return {
      comparable: false,
      matched: null,
      operator: null,
      actual_value: args.actual_value,
      expected_value: args.expected_value,
      reason: 'comparison_operator is missing or unsupported',
    };
  }
  if (!hasExpectedValue(args.expected_value)) {
    return {
      comparable: false,
      matched: null,
      operator,
      actual_value: args.actual_value,
      expected_value: args.expected_value,
      reason: 'expected_value is missing',
    };
  }
  if (args.actual_value === null || args.actual_value === undefined || args.actual_value === '') {
    return {
      comparable: false,
      matched: null,
      operator,
      actual_value: args.actual_value,
      expected_value: args.expected_value,
      reason: 'actual_value is missing',
    };
  }

  const actualText = String(args.actual_value);
  const expectedText = String(args.expected_value);
  const actualNumber = numericValue(args.actual_value);
  const expectedNumber = numericValue(args.expected_value);
  let matched: boolean;
  if (operator === 'equals') {
    matched = actualNumber !== null && expectedNumber !== null
      ? actualNumber === expectedNumber
      : actualText === expectedText;
  } else if (operator === 'not_equals') {
    matched = actualNumber !== null && expectedNumber !== null
      ? actualNumber !== expectedNumber
      : actualText !== expectedText;
  }
  else if (operator === 'contains') matched = actualText.includes(expectedText);
  else if (operator === 'matches_regex') {
    try {
      matched = new RegExp(expectedText).test(actualText);
    } catch {
      return {
        comparable: false,
        matched: null,
        operator,
        actual_value: args.actual_value,
        expected_value: args.expected_value,
        reason: 'expected_value is not a valid regex',
      };
    }
  } else {
    if (actualNumber === null || expectedNumber === null) {
      return {
        comparable: false,
        matched: null,
        operator,
        actual_value: args.actual_value,
        expected_value: args.expected_value,
        reason: 'numeric comparison requires numeric actual_value and expected_value',
      };
    }
    if (operator === 'less_than') matched = actualNumber < expectedNumber;
    else if (operator === 'less_than_or_equal') matched = actualNumber <= expectedNumber;
    else if (operator === 'greater_than') matched = actualNumber > expectedNumber;
    else matched = actualNumber >= expectedNumber;
  }

  return {
    comparable: true,
    matched,
    operator,
    actual_value: args.actual_value,
    expected_value: args.expected_value,
    reason: matched ? 'actual matched expected assertion' : 'actual violated expected assertion',
  };
}

export function evaluateActionPrecommitQuality(
  actionReadiness: SalienceArbitrationInput['action_readiness'],
): ActionPrecommitQuality {
  const predictionLogged = actionReadiness?.prediction_logged_before_action === true;
  const verificationLogged = actionReadiness?.verification_plan_logged === true;
  const predictionText = cleanText(actionReadiness?.prediction ?? actionReadiness?.predicted_outcome);
  const verificationText = cleanText(actionReadiness?.verification_plan ?? actionReadiness?.verification_step);
  const predictedObservable = cleanText(actionReadiness?.predicted_observable);
  const operator = comparisonOperator(actionReadiness?.comparison_operator);
  const verificationObservable = cleanText(
    actionReadiness?.verification_observable ?? actionReadiness?.actual_observation_source,
  );
  const forwardPredictionId = Number(actionReadiness?.forward_prediction_id);
  const hasForwardPrediction = Number.isFinite(forwardPredictionId) && forwardPredictionId > 0;
  const tautologicalExpected = isTautologicalExpectedValue(predictedObservable, actionReadiness?.expected_value);
  const hasStructuredPrediction = Boolean(
    predictedObservable
    && operator
    && hasExpectedValue(actionReadiness?.expected_value),
  );
  const hasStructuredVerification = Boolean(verificationObservable && verificationText);
  const hasContrastableStructuredAssertion = hasStructuredPrediction
    && hasStructuredVerification
    && !tautologicalExpected;
  const contrastableBasis = hasForwardPrediction
    ? 'forward_prediction_id'
    : (hasContrastableStructuredAssertion ? 'structured_assertion' : null);
  const blockedReasons: string[] = [];

  let predictionQuality: ActionPrecommitQuality['prediction_quality'] = 'computable';
  if (!predictionLogged || (!predictionText && !hasStructuredPrediction && !hasForwardPrediction)) {
    predictionQuality = 'missing';
    blockedReasons.push('missing_prediction');
  } else if (tautologicalExpected) {
    predictionQuality = 'uncomputable';
    blockedReasons.push('tautological_prediction');
  } else if (!hasForwardPrediction && !hasStructuredPrediction) {
    predictionQuality = 'uncomputable';
    blockedReasons.push('non_contrastable_prediction');
  }

  let verificationQuality: ActionPrecommitQuality['verification_quality'] = 'computable';
  if (!verificationLogged || !verificationText) {
    verificationQuality = 'missing';
    blockedReasons.push('missing_verification');
  } else if (!hasForwardPrediction && !hasStructuredVerification) {
    verificationQuality = 'uncomputable';
    blockedReasons.push('non_contrastable_verification');
  }

  const contrastable = predictionQuality === 'computable'
    && verificationQuality === 'computable'
    && contrastableBasis !== null;

  return {
    prediction_logged: predictionLogged,
    verification_logged: verificationLogged,
    prediction_quality: predictionQuality,
    verification_quality: verificationQuality,
    eligible: contrastable,
    blocked_reasons: blockedReasons,
    contrastable,
    contrastable_basis: contrastableBasis,
    predicted_observable: predictedObservable || null,
    verification_observable: verificationObservable || null,
    comparison_operator: operator,
  };
}

function sortSignals(signals: SalienceSignal[]): SalienceSignal[] {
  return [...signals].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.source.localeCompare(b.source);
  });
}

function actionAssertionEvaluation(
  actionReadiness: SalienceArbitrationInput['action_readiness'],
): ContrastableAssertionEvaluation | null {
  if (!hasActualValue(actionReadiness?.actual_value)) {
    return null;
  }
  return evaluateContrastableAssertion({
    actual_value: actionReadiness?.actual_value,
    comparison_operator: actionReadiness?.comparison_operator,
    expected_value: actionReadiness?.expected_value,
  });
}

function actionDiagnostics(
  actionReadiness: SalienceArbitrationInput['action_readiness'],
  precommitQuality: ActionPrecommitQuality,
  assertionEvaluation: ContrastableAssertionEvaluation | null = actionAssertionEvaluation(actionReadiness),
): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {
    action_precommit_quality: precommitQuality,
  };
  if (assertionEvaluation) {
    diagnostics.contrastable_assertion_evaluation = assertionEvaluation;
  }
  return diagnostics;
}

export function buildSalienceArbitration(input: SalienceArbitrationInput): SalienceArbitration {
  const signals: SalienceSignal[] = [];
  const evidenceCeiling = input.evidence_readiness?.calibration_claim_ceiling ?? null;
  const surfaceState = input.surface?.freshness_state ?? null;

  if (
    (surfaceState && surfaceState !== 'runtime_loaded_current_artifacts')
    || bool(input.surface?.build_required)
    || bool(input.surface?.restart_required)
    || bool(input.surface?.watched_changed_after_process_start)
  ) {
    signals.push({
      source: 'surface',
      intervention: 'reconnect_surface',
      priority: 100,
      state: surfaceState,
      evidence_ceiling: evidenceCeiling,
      reason: 'The loaded runtime or owning surface is not proven fresh, so domain claims must wait for a same-surface postcheck.',
    });
  }

  const gate = input.gate_authority;
  if (gate?.active === true) {
    if (gate.source === 'presence') {
      const failClosed = gate.effective_precedence === 'presence_fail_closed';
      signals.push({
        source: 'presence',
        intervention: failClosed ? 'ask_owner' : 'honor_presence_hold',
        priority: failClosed ? 95 : 88,
        state: gate.state ?? gate.effective_precedence ?? null,
        evidence_ceiling: evidenceCeiling,
        reason: failClosed
          ? 'Presence is fail-closed or unreadable; escalation is safer than letting a lower organ overrule it.'
          : 'Presence currently has gate authority and must not be overwritten by felt-threat or patience state.',
      });
    } else if (gate.source === 'felt_threat') {
      signals.push({
        source: 'felt_threat',
        intervention: 'hold_for_felt_threat',
        priority: 82,
        state: gate.stance ?? gate.state ?? null,
        evidence_ceiling: evidenceCeiling,
        reason: 'Felt-threat has current gate authority and should hold action until read or cleared.',
      });
    }
  }

  const driftSeverity = severityRank(input.authority_drift?.severity);
  if (input.authority_drift?.active === true || driftSeverity >= 3) {
    signals.push({
      source: 'authority_drift',
      intervention: driftSeverity >= 4 ? 'ask_owner' : 'research_first',
      priority: driftSeverity >= 4 ? 92 : 78,
      state: input.authority_drift?.state ?? input.authority_drift?.severity ?? null,
      evidence_ceiling: evidenceCeiling,
      reason: driftSeverity >= 4
        ? 'Authority drift is critical; shared judgment is required before proceeding.'
        : 'Authority drift is elevated; research or partner critique should precede action.',
    });
  }

  const readiness = input.evidence_readiness;
  if (readiness?.needs_live_traffic === true || readiness?.synthetic_only === true) {
    signals.push({
      source: 'evidence_readiness',
      intervention: 'collect_live_evidence',
      priority: readiness.synthetic_only === true ? 72 : 68,
      state: readiness.readiness_state ?? null,
      evidence_ceiling: evidenceCeiling,
      reason: `Evidence readiness has not cleared live calibration; next live evidence needed is ${readiness.next_live_evidence_needed ?? 'unknown'}.`,
    });
  }

  const forage = input.forage_signal;
  if (forage?.intervention === 'forage_research' || forage?.intervention === 'switch_patch') {
    signals.push({
      source: 'forage_signal',
      intervention: forage.intervention,
      priority: forage.intervention === 'switch_patch' ? 74 : 76,
      state: forage.patch_utility_state ?? null,
      evidence_ceiling: forage.claim_ceiling ?? evidenceCeiling,
      diagnostics: {
        tonic_foraging_pressure: forage.tonic_foraging_pressure ?? null,
        ...(forage.diagnostics ?? {}),
      },
      reason: forage.reason
        ?? 'LC-style forage signal says current patch utility is stale enough to gather external evidence before more local refinement.',
    });
  }

  const actionReadiness = input.action_readiness;
  const actionKind = actionReadiness?.action_kind ?? null;
  const precommitQuality = evaluateActionPrecommitQuality(actionReadiness);
  const assertionEvaluation = actionAssertionEvaluation(actionReadiness);
  const predictionMissed = precommitQuality.eligible
    && assertionEvaluation?.comparable === true
    && assertionEvaluation.matched === false;
  const actionHasPrecommit = precommitQuality.eligible;
  const actionUnderPressure = input.patience?.stance === 'act_now'
    && isMutationAction(actionKind)
    && (
      input.relay?.urgent === true
      || Number(input.relay?.unread ?? 0) > 0
      || input.relay?.pressure === 'high'
      || input.relay?.pressure === 'sprint'
    );

  if (actionUnderPressure && !actionHasPrecommit) {
    signals.push({
      source: 'sprint_discriminator',
      intervention: input.relay?.urgent === true ? 'ask_owner' : 'research_first',
      priority: input.relay?.urgent === true ? 91 : 86,
      state: actionKind,
      evidence_ceiling: evidenceCeiling,
      diagnostics: actionDiagnostics(actionReadiness, precommitQuality, assertionEvaluation),
      reason: 'Patience can say act_now for both legitimate action and relief-seeking discharge. Under pressure, a mutating action needs a contrastable pre-action assertion and a verification plan tied to an observable.',
    });
  } else if (input.patience?.stance === 'act_now' && actionHasPrecommit) {
    if (predictionMissed) {
      signals.push({
        source: 'prediction_outcome',
        intervention: 'review_prediction_miss',
        priority: 80,
        state: actionKind,
        evidence_ceiling: evidenceCeiling,
        diagnostics: actionDiagnostics(actionReadiness, precommitQuality, assertionEvaluation),
        reason: 'The pre-action assertion was contrastable and the actual value violated it; review the missed prediction before letting act_now win.',
      });
    }
    signals.push({
      source: 'action_readiness',
      intervention: 'act_now',
      priority: 62,
      state: actionKind,
      evidence_ceiling: evidenceCeiling,
      diagnostics: actionDiagnostics(actionReadiness, precommitQuality, assertionEvaluation),
      reason: 'Act-now posture has a contrastable pre-action assertion and verification plan, so the arbiter can distinguish it from ungrounded pressure discharge.',
    });
  }

  const relayUnread = Number(input.relay?.unread ?? 0);
  if (input.relay?.urgent === true || relayUnread > 0) {
    signals.push({
      source: 'relay',
      intervention: input.relay?.urgent === true ? 'ask_owner' : 'research_first',
      priority: input.relay?.urgent === true ? 90 : 58,
      state: input.relay?.pressure ?? (relayUnread > 0 ? 'unread' : null),
      evidence_ceiling: evidenceCeiling,
      reason: input.relay?.urgent === true
        ? 'Relay pressure is urgent and may require a human decision.'
        : 'Relay has unread sibling context; read it before acting as if the local frame is complete.',
    });
  }

  const patience = input.patience;
  if (patience?.stance === 'persist') {
    const uncertain = String(patience.confidence_posture || '').includes('uncertain');
    signals.push({
      source: 'patience',
      intervention: 'persist',
      priority: uncertain ? 42 : 50,
      state: patience.confidence_posture ?? patience.stance ?? null,
      evidence_ceiling: evidenceCeiling,
      reason: uncertain
        ? 'Patience leans toward persistence, but the credible interval is still wide.'
        : 'Patience belief supports continued persistence.',
    });
  } else if (patience?.stance === 'act_now') {
    const uncertain = String(patience.confidence_posture || '').includes('uncertain');
    signals.push({
      source: 'patience',
      intervention: 'act_now',
      priority: uncertain ? 40 : 54,
      state: patience.confidence_posture ?? patience.stance ?? null,
      evidence_ceiling: evidenceCeiling,
      reason: uncertain
        ? 'Patience leans toward acting now, but the credible interval is still wide.'
        : 'Patience belief supports acting now.',
    });
  }

  if (signals.length === 0) {
    signals.push({
      source: 'baseline',
      intervention: 'safe_to_proceed',
      priority: 0,
      state: null,
      evidence_ceiling: evidenceCeiling,
      reason: 'No supplied organ reported a blocker or higher-priority conflict.',
    });
  }

  const sorted = sortSignals(signals);
  const selected = sorted[0];
  return {
    selected_intervention: selected.intervention,
    selected_signal: selected,
    suppressed_alternatives: sorted.slice(1),
    all_signals: sorted,
    evidence_ceiling: evidenceCeiling,
    arbitration_basis: 'priority_ordered_conflict_monitor',
    organ_state_mutation_allowed: false,
    presence_sticky_overwrite_allowed: false,
    state_isolation_policy: 'Read-only salience arbitration. It selects the next intervention from organ readouts and never mutates Presence, felt-threat, patience, surface, relay, or evidence-readiness state.',
  };
}
