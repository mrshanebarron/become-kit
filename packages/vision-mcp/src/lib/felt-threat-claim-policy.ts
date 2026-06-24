export const LIVE_FELT_THREAT_CLAIMS = [
  'live_sensing_trace_claim',
  'initial_live_calibration_claim',
  'live_sensory_sampling_claim',
  'live_decision_trace_claim',
  'live_authority_calibration_claim',
];

export function claimPolicyForCeiling(claimCeiling: string): Record<string, unknown> {
  if (claimCeiling === 'no_felt_threat_claim') {
    return {
      allowed_current_claims: ['no_felt_threat_training_claim'],
      blocked_current_claims: ['schema_verified_only', ...LIVE_FELT_THREAT_CLAIMS],
      claim_policy_note: 'No felt-threat evidence exists, so only absence/no-training claims are allowed.',
    };
  }
  if (claimCeiling === 'schema_verified_only') {
    return {
      allowed_current_claims: ['schema_verified_only', 'synthetic_proof_coverage_verified'],
      blocked_current_claims: LIVE_FELT_THREAT_CLAIMS,
      claim_policy_note: 'Synthetic/proof coverage may be described, but no live felt-threat training claim is allowed.',
    };
  }
  const order = ['schema_verified_only', ...LIVE_FELT_THREAT_CLAIMS];
  const ceilingIndex = order.indexOf(claimCeiling);
  return {
    allowed_current_claims: ceilingIndex >= 0 ? order.slice(0, ceilingIndex + 1) : ['unknown_claim_ceiling'],
    blocked_current_claims: ceilingIndex >= 0 ? order.slice(ceilingIndex + 1) : LIVE_FELT_THREAT_CLAIMS,
    claim_policy_note: `Claims are allowed only through ${claimCeiling}; stronger live calibration claims remain blocked.`,
  };
}
