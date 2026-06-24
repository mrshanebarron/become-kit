export type EvidenceReadinessState =
  | 'no_evidence'
  | 'synthetic_only'
  | 'live_sensing_grounded'
  | 'live_outcome_grounded'
  | 'live_observation_grounded'
  | 'live_decision_grounded'
  | 'live_authority_grounded';

export type NextLiveEvidenceNeeded =
  | 'establish_any_felt_threat_evidence'
  | 'capture_live_sensing_pass'
  | 'capture_live_outcome'
  | 'capture_live_observation'
  | 'capture_live_decision_trace'
  | 'capture_live_authority_trace'
  | 'maintain_live_authority_coverage';

export type CalibrationClaimCeiling =
  | 'no_felt_threat_claim'
  | 'schema_verified_only'
  | 'live_sensing_trace_claim'
  | 'initial_live_calibration_claim'
  | 'live_sensory_sampling_claim'
  | 'live_decision_trace_claim'
  | 'live_authority_calibration_claim';

export type EvidenceCollectionState =
  | 'no_evidence_observed'
  | 'proof_only_no_live_capture'
  | 'live_sensing_trace_active'
  | 'live_capture_started'
  | 'live_sampler_active'
  | 'live_decision_trace_active'
  | 'live_authority_trace_active';

export type EvidenceScopeRow = Record<string, unknown>;

export const EVIDENCE_LEDGER_ORDER = ['sensing_passes', 'outcomes', 'observations', 'decisions', 'authority_traces'];

const NEXT_LIVE_EVIDENCE_BY_STATE: Record<EvidenceReadinessState, NextLiveEvidenceNeeded> = {
  no_evidence: 'establish_any_felt_threat_evidence',
  synthetic_only: 'capture_live_sensing_pass',
  live_sensing_grounded: 'capture_live_outcome',
  live_outcome_grounded: 'capture_live_observation',
  live_observation_grounded: 'capture_live_decision_trace',
  live_decision_grounded: 'capture_live_authority_trace',
  live_authority_grounded: 'maintain_live_authority_coverage',
};

const CLAIM_CEILING_BY_STATE: Record<EvidenceReadinessState, CalibrationClaimCeiling> = {
  no_evidence: 'no_felt_threat_claim',
  synthetic_only: 'schema_verified_only',
  live_sensing_grounded: 'live_sensing_trace_claim',
  live_outcome_grounded: 'initial_live_calibration_claim',
  live_observation_grounded: 'live_sensory_sampling_claim',
  live_decision_grounded: 'live_decision_trace_claim',
  live_authority_grounded: 'live_authority_calibration_claim',
};

const COLLECTION_STATE_BY_STATE: Record<EvidenceReadinessState, EvidenceCollectionState> = {
  no_evidence: 'no_evidence_observed',
  synthetic_only: 'proof_only_no_live_capture',
  live_sensing_grounded: 'live_sensing_trace_active',
  live_outcome_grounded: 'live_capture_started',
  live_observation_grounded: 'live_sampler_active',
  live_decision_grounded: 'live_decision_trace_active',
  live_authority_grounded: 'live_authority_trace_active',
};

function countValue(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function latestEvidenceAt(values: unknown[]): unknown {
  let latest: unknown = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const ms = new Date(String(value)).getTime();
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = value;
    }
  }
  return latest;
}

function readinessNote(
  readinessState: EvidenceReadinessState,
  liveEvidenceCount: number,
  syntheticEvidenceCount: number,
  strongestLiveLedger: string | null,
): string {
  if (readinessState === 'no_evidence') {
    return 'No felt-threat evidence exists for this agent yet.';
  }
  if (readinessState === 'synthetic_only') {
    return `Only synthetic/proof felt-threat evidence exists (${syntheticEvidenceCount} rows); collect ordinary live hook traffic before treating calibration as trained.`;
  }
  if (readinessState === 'live_authority_grounded') {
    return `Live felt-threat evidence reaches authority-trace level (${liveEvidenceCount} live rows); continue monitoring drift and freshness.`;
  }
  if (readinessState === 'live_sensing_grounded') {
    return `Live felt-threat sensing traces exist (${liveEvidenceCount} live rows); collect held outcomes before making calibration claims.`;
  }
  return `Live felt-threat evidence is present through ${strongestLiveLedger || 'an early ledger'} (${liveEvidenceCount} live rows); collect the next higher evidence channel before making stronger calibration claims.`;
}

export function buildEvidenceReadinessSummary(rows: EvidenceScopeRow[]): EvidenceScopeRow[] {
  const agents = Array.from(new Set(rows.map((row) => String(row.agent || '')).filter(Boolean))).sort();
  return agents.map((agent) => {
    const agentRows = rows.filter((row) => row.agent === agent);
    const liveLedgerCounts: Record<string, number> = {};
    const syntheticLedgerCounts: Record<string, number> = {};
    for (const ledger of EVIDENCE_LEDGER_ORDER) {
      liveLedgerCounts[ledger] = countValue(
        agentRows.find((row) => row.ledger === ledger && row.evidence_scope === 'live')?.evidence_count,
      );
      syntheticLedgerCounts[ledger] = countValue(
        agentRows.find((row) => row.ledger === ledger && row.evidence_scope === 'synthetic')?.evidence_count,
      );
    }

    const liveEvidenceCount = Object.values(liveLedgerCounts).reduce((sum, count) => sum + count, 0);
    const syntheticEvidenceCount = Object.values(syntheticLedgerCounts).reduce((sum, count) => sum + count, 0);
    const liveLedgersPresent = EVIDENCE_LEDGER_ORDER.filter((ledger) => liveLedgerCounts[ledger] > 0);
    const syntheticLedgersPresent = EVIDENCE_LEDGER_ORDER.filter((ledger) => syntheticLedgerCounts[ledger] > 0);
    const liveStrengthOrder = [...EVIDENCE_LEDGER_ORDER].reverse();
    const strongestLiveLedger = liveStrengthOrder.find((ledger) => liveLedgerCounts[ledger] > 0) || null;

    let readinessState: EvidenceReadinessState = 'no_evidence';
    let readinessLevel = 0;
    if (liveLedgerCounts.authority_traces > 0) {
      readinessState = 'live_authority_grounded';
      readinessLevel = 5;
    } else if (liveLedgerCounts.decisions > 0) {
      readinessState = 'live_decision_grounded';
      readinessLevel = 4;
    } else if (liveLedgerCounts.observations > 0) {
      readinessState = 'live_observation_grounded';
      readinessLevel = 3;
    } else if (liveLedgerCounts.outcomes > 0) {
      readinessState = 'live_outcome_grounded';
      readinessLevel = 2;
    } else if (liveLedgerCounts.sensing_passes > 0) {
      readinessState = 'live_sensing_grounded';
      readinessLevel = 1;
    } else if (syntheticEvidenceCount > 0) {
      readinessState = 'synthetic_only';
    }

    return {
      agent,
      readiness_state: readinessState,
      readiness_level: readinessLevel,
      strongest_live_ledger: strongestLiveLedger,
      next_live_evidence_needed: NEXT_LIVE_EVIDENCE_BY_STATE[readinessState],
      calibration_claim_ceiling: CLAIM_CEILING_BY_STATE[readinessState],
      evidence_collection_state: COLLECTION_STATE_BY_STATE[readinessState],
      readiness_note: readinessNote(readinessState, liveEvidenceCount, syntheticEvidenceCount, strongestLiveLedger),
      live_evidence_count: liveEvidenceCount,
      synthetic_evidence_count: syntheticEvidenceCount,
      live_ledger_counts: liveLedgerCounts,
      synthetic_ledger_counts: syntheticLedgerCounts,
      live_ledgers_present: liveLedgersPresent,
      missing_live_ledgers: EVIDENCE_LEDGER_ORDER.filter((ledger) => liveLedgerCounts[ledger] === 0),
      synthetic_ledgers_present: syntheticLedgersPresent,
      needs_live_traffic: liveEvidenceCount === 0,
      synthetic_only: liveEvidenceCount === 0 && syntheticEvidenceCount > 0,
      last_live_evidence_at: latestEvidenceAt(
        agentRows
          .filter((row) => row.evidence_scope === 'live')
          .map((row) => row.last_evidence_at),
      ),
      last_synthetic_evidence_at: latestEvidenceAt(
        agentRows
          .filter((row) => row.evidence_scope === 'synthetic')
          .map((row) => row.last_evidence_at),
      ),
    };
  });
}
