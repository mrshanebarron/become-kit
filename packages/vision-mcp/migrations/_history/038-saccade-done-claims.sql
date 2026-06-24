-- 038: saccade — done-claim verification substrate (meta-observe proposal #6)
-- 2026-05-17
--
-- Per proposal #6 (saccade): "Maintains a rolling runtime-verification
-- checkpoint between action execution and done-claim emission, blocking
-- any completion assertion until at least one live observable
-- (process output, HTTP response, DOM state) has been sampled and
-- recorded."
--
-- Minimum viable shape: done_claims table records each claim of
-- completion (shipped/built/done/works/landed) emitted by agent in
-- assistant text. Each row tracks whether a verification observable
-- exists for it (matched to a tool_response, a db row, a hook log line,
-- or explicit human confirmation).
--
-- Companion: verification_observables table records the observed evidence
-- linked to each claim.
--
-- Stop hook (to be wired) scans the last assistant response for
-- done-claim phrases, records each, and looks back N seconds for a
-- matching observable in tool_response logs.

CREATE TABLE IF NOT EXISTS done_claims (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  claim_text TEXT NOT NULL,
  claim_phrase TEXT NOT NULL,
  claim_target TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  verification_method TEXT,
  verification_evidence TEXT,
  verified_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_done_claims_unverified
  ON done_claims(claimed_at)
  WHERE NOT verified;

CREATE TABLE IF NOT EXISTS verification_observables (
  id SERIAL PRIMARY KEY,
  claim_id INTEGER REFERENCES done_claims(id),
  observable_type TEXT NOT NULL,
  observable_source TEXT,
  observable_content TEXT,
  matched BOOLEAN,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observables_claim ON verification_observables(claim_id);
