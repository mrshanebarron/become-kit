export type GateStackRecord = Record<string, unknown>;

type RankedGateStackRecord = GateStackRecord & { authority_rank: number };

export function effectiveGateStack(
  presenceStack: GateStackRecord[],
  feltStack: GateStackRecord[],
): GateStackRecord[] {
  const entries: RankedGateStackRecord[] = [];

  for (const state of presenceStack) {
    if (state.active !== true) {
      continue;
    }
    const failClosed = state.precedence === 'presence_fail_closed';
    entries.push({
      ...state,
      source: 'presence',
      authority_rank: failClosed ? 0 : 1,
      effective_precedence: failClosed ? 'presence_fail_closed' : 'presence_before_felt_threat',
      reason: failClosed
        ? 'Presence state was unreadable, so the gate treats it as active and defers felt-threat evaluation.'
        : 'Presence sticky/session state is active and has precedence over felt-threat state.',
    });
  }

  for (const state of feltStack) {
    if (state.expired === true) {
      continue;
    }
    const sessionScoped = state.precedence === 'session_scoped';
    entries.push({
      ...state,
      source: 'felt_threat',
      authority_rank: sessionScoped ? 2 : 3,
      active: true,
      effective_precedence: sessionScoped ? 'session_scoped_felt_threat' : 'legacy_sessionless_felt_threat',
      reason: sessionScoped
        ? 'Session-scoped felt-threat state applies only to its own session and must not read the legacy single slot.'
        : 'Legacy felt-threat state applies only to sessionless payloads and has lowest precedence.',
    });
  }

  return entries
    .sort((a, b) => {
      if (a.authority_rank !== b.authority_rank) return a.authority_rank - b.authority_rank;
      return Number(b.entered_epoch || 0) - Number(a.entered_epoch || 0);
    })
    .map((entry, index) => ({
      ...entry,
      effective_rank: index + 1,
      current_authority: index === 0,
    }));
}

export function effectiveGateAuthority(effectiveStack: GateStackRecord[]): GateStackRecord {
  const authority = effectiveStack.find((entry) => entry.current_authority === true);
  if (authority) {
    return {
      active: true,
      source: authority.source ?? null,
      effective_precedence: authority.effective_precedence ?? null,
      state: authority.state ?? null,
      stance: authority.stance ?? null,
      event_id: authority.event_id ?? null,
      session_id: authority.session_id ?? null,
      path: authority.path ?? null,
      reason: authority.reason ?? null,
    };
  }
  return {
    active: false,
    source: null,
    effective_precedence: 'none',
    reason: 'No active Presence or felt-threat state currently has gate authority.',
  };
}
