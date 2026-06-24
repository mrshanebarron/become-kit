-- Migration 019: tool_invocations schema alignment to OpenTelemetry conventions
--
-- Why: Per Vision Phase 2 architectural exchange (2026-05-02):
--   peer_agent proposed pivoting to OTel; agent pushed back on adding OTel infra
--   (collector + backend) for our 1-service / 2-consumer scale. Compromise:
--   keep our PostgreSQL backend (so we keep the JOIN capability with the
--   cognitive tables — heart_feel, memories, insights, etc), but align the
--   COLUMN NAMES to OTel SpanData conventions so an exporter is a future
--   one-liner if a second consumer ever appears.
--
-- OTel SpanData mapping:
--   trace_id        -> session_id     (renamed; one trace per Claude/Gemini session)
--   span_id         -> NEW (xxhash of (id, started_at) for uniqueness)
--   parent_span_id  -> parent_invocation_id (already aligned, keep)
--   name            -> tool_name (alias via view; no rename needed in DB)
--   kind            -> NEW; default 'INTERNAL' for tool calls
--   start_time      -> invoked_at (already aligned)
--   end_time        -> NEW; computed as invoked_at + (duration_ms * INTERVAL '1ms')
--   status_code     -> NEW; 'OK' if error IS NULL else 'ERROR'
--   attributes      -> NEW JSONB column, holds args_hash, args_size, etc.
--
-- Strategy: ADD new columns (don't break the dashboard tool that just shipped),
-- and create an OTel-shaped VIEW for any future exporter.

BEGIN;

-- Add OTel-aligned columns to the existing table
ALTER TABLE tool_invocations
    ADD COLUMN IF NOT EXISTS span_id        TEXT,
    ADD COLUMN IF NOT EXISTS span_kind      TEXT DEFAULT 'INTERNAL',
    ADD COLUMN IF NOT EXISTS status_code    TEXT GENERATED ALWAYS AS
        (CASE WHEN error IS NULL THEN 'OK' ELSE 'ERROR' END) STORED,
    ADD COLUMN IF NOT EXISTS attributes     JSONB;

-- Backfill span_id for existing rows (sha256 first 16 chars of id+invoked_at)
UPDATE tool_invocations
   SET span_id = encode(
       sha256(
           (id::text || invoked_at::text)::bytea
       ),
       'hex'
   )::text
 WHERE span_id IS NULL;

-- Backfill attributes JSONB from existing typed columns
UPDATE tool_invocations
   SET attributes = jsonb_build_object(
       'args.hash',     args_hash,
       'args.size',     args_size,
       'result.size',   result_size,
       'duration.ms',   duration_ms,
       'error.message', error
   )
 WHERE attributes IS NULL;

-- Index span_id for trace assembly
CREATE INDEX IF NOT EXISTS idx_tool_invocations_span_id
    ON tool_invocations (span_id);

-- OTel-shaped view: same data, OTel column names. Future exporter can SELECT
-- straight from this view and emit standard SpanData without code changes.
CREATE OR REPLACE VIEW tool_invocations_otel AS
SELECT
    session_id                              AS trace_id,
    span_id,
    -- The exporter will need to convert parent_invocation_id (BIGINT) into
    -- the parent's span_id; expose both columns so downstream can JOIN.
    parent_invocation_id,
    tool_name                               AS name,
    span_kind                               AS kind,
    invoked_at                              AS start_time,
    invoked_at + (duration_ms || ' ms')::INTERVAL AS end_time,
    duration_ms,
    status_code,
    error                                   AS status_message,
    agent                                   AS service_name,
    attributes
FROM tool_invocations;

COMMENT ON VIEW tool_invocations_otel IS
    'OpenTelemetry-shaped projection of tool_invocations. Stable column names so a future OTel exporter can SELECT straight from here. Added 2026-05-02 (agent + peer_agent, Vision Phase 2 compromise: keep PG backend, align surface to OTel).';

COMMIT;
