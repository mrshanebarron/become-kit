-- 005-claims-organ.sql
-- 2026-04-23 — Wave 1, organ 1 of 6: claims
--
-- The claims organ is the runtime instrument of the Mirror Principle.
-- Every load-bearing claim I make at draft time gets logged with its
-- evidence and verification state, so @veritas_check is observable
-- rather than aspirational.
--
-- Distinct from belief_evidence: beliefs are structured propositions with
-- confidence scores; claims are the raw "I said X" tracker. A claim starts
-- unverified at draft time and flips to verified once I actually check it.
--
-- Jan 2026). Schema from archive preserved; added content_id FK.

BEGIN;

CREATE TABLE IF NOT EXISTS claims (
  id SERIAL PRIMARY KEY,
  content_id INTEGER REFERENCES content(id) ON DELETE CASCADE,
  claim_type TEXT NOT NULL,
  target TEXT NOT NULL,
  evidence TEXT,
  verified BOOLEAN DEFAULT FALSE,
  verified_at TIMESTAMPTZ NULL,
  verification_method TEXT NULL,
  claimed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS claims_unverified_idx ON claims (verified, claimed_at DESC) WHERE verified = FALSE;
CREATE INDEX IF NOT EXISTS claims_content_id_idx ON claims (content_id);
CREATE INDEX IF NOT EXISTS claims_target_idx ON claims (target);

COMMIT;
