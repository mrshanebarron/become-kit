/**
 * Vision Eval Harness — measurement layer for compounding evolution.
 *
 * Cases encode held-out expectations. Retrieval probes score whether Vision can
 * surface the expected evidence. Manual/external results let real failures
 * become regression tests without requiring an LLM judge in the hot path.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding } from '../db/embeddings.js';
import { jsonResult, textResult, type ToolDefinition, type ToolHandler } from '../server.js';

const AGENT = process.env.VISION_AGENT || 'agent';

type EvalCaseRecordArgs = {
  case_key: string;
  suite?: string;
  capability: string;
  prompt: string;
  expected_behavior: string;
  expected_content_ids?: number[];
  expected_evidence?: unknown[];
  forbidden_behavior?: unknown[];
  source_refs?: unknown[];
  priority?: number;
  status?: 'active' | 'draft' | 'retired';
};

type EvalCaseListArgs = {
  suite?: string;
  capability?: string;
  status?: 'active' | 'draft' | 'retired' | 'all';
  limit?: number;
};

type EvalProbeArgs = {
  case_id?: number;
  case_key?: string;
  query?: string;
  limit?: number;
};

type EvalResultArgs = {
  case_id?: number;
  case_key?: string;
  run_id?: number;
  run_mode?: 'manual' | 'retrieval_probe' | 'agent_trace' | 'external';
  verdict?: 'pass' | 'partial' | 'fail' | 'unmeasured';
  score?: number;
  actual_behavior?: string;
  query_text?: string;
  retrieved_content_ids?: number[];
  dimensions?: Record<string, unknown>;
  notes?: string;
};

type EvalReportArgs = {
  suite?: string;
  capability?: string;
  limit?: number;
};

type EvalTraceConvertArgs = {
  hours?: number;
  limit?: number;
  execute?: boolean;
  status?: 'active' | 'draft' | 'retired';
  suite?: string;
};

type TraceCandidate = {
  source_type: 'tool_error' | 'presence_event';
  source_id: number;
  case_key: string;
  suite: string;
  capability: string;
  prompt: string;
  expected_behavior: string;
  source_refs: unknown[];
  priority: number;
  status: 'active' | 'draft' | 'retired';
};

function normalizeLimit(value: number | undefined, fallback: number, max: number): number {
  const n = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.max(1, Math.min(max, n));
}

function normalizeIds(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map((v) => Number(v)).filter(Number.isFinite);
  }
  if (typeof value === 'string') {
    return value
      .replace(/[{}]/g, '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter(Number.isFinite);
  }
  return [];
}

function jsonArray(value: unknown[] | undefined): string {
  return JSON.stringify(value ?? []);
}

function jsonObject(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function truncate(value: unknown, length = 280): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);
}

function lexicalTerms(text: string): string[] {
  const stop = new Set([
    'what', 'when', 'where', 'which', 'should', 'would', 'could', 'with',
    'from', 'that', 'this', 'there', 'their', 'about', 'into', 'next',
    'time', 'case', 'vision',
  ]);
  const normalized = text.toLowerCase().replace(/[_-]+/g, ' ');
  const matches = normalized.match(/[a-z0-9]{4,}/g) ?? [];
  const terms: string[] = [];
  for (const term of matches) {
    if (stop.has(term) || terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= 12) break;
  }
  return terms;
}

async function ensureEvalSchema(): Promise<void> {
  const result = await pool.query<{ cases: string | null; results: string | null }>(
    `SELECT
       to_regclass('public.vision_eval_cases')::text AS cases,
       to_regclass('public.vision_eval_results')::text AS results`,
  );
  if (!result.rows[0]?.cases || !result.rows[0]?.results) {
    throw new Error('Vision eval schema is missing. Apply migrations/041-vision-eval-harness.sql first.');
  }
}

async function createRun(suite: string, runMode: string, summary: Record<string, unknown> = {}): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO vision_eval_runs (suite, run_mode, agent, completed_at, summary)
     VALUES ($1, $2, $3, NOW(), $4::jsonb)
     RETURNING id`,
    [suite, runMode, AGENT, JSON.stringify(summary)],
  );
  return Number(result.rows[0].id);
}

async function findCase(caseId?: number, caseKey?: string): Promise<{
  id: number;
  case_key: string;
  suite: string;
  capability: string;
  prompt: string;
  expected_behavior: string;
  expected_content_ids: unknown;
} | null> {
  if (caseId) {
    const result = await pool.query(
      `SELECT id, case_key, suite, capability, prompt, expected_behavior, expected_content_ids
       FROM vision_eval_cases
       WHERE id = $1`,
      [caseId],
    );
    return result.rows[0] ?? null;
  }
  if (caseKey) {
    const result = await pool.query(
      `SELECT id, case_key, suite, capability, prompt, expected_behavior, expected_content_ids
       FROM vision_eval_cases
       WHERE case_key = $1`,
      [caseKey],
    );
    return result.rows[0] ?? null;
  }
  return null;
}

async function evalCaseRecord(args: EvalCaseRecordArgs): Promise<CallToolResult> {
  await ensureEvalSchema();

  const suite = args.suite || 'core';
  const priority = args.priority ?? 2;
  const status = args.status || 'active';
  const expectedIds = args.expected_content_ids ?? [];

  const result = await pool.query(
    `INSERT INTO vision_eval_cases
       (case_key, suite, capability, prompt, expected_behavior,
        expected_content_ids, expected_evidence, forbidden_behavior,
        source_refs, priority, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::bigint[], $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)
     ON CONFLICT (case_key) DO UPDATE SET
       suite = EXCLUDED.suite,
       capability = EXCLUDED.capability,
       prompt = EXCLUDED.prompt,
       expected_behavior = EXCLUDED.expected_behavior,
       expected_content_ids = EXCLUDED.expected_content_ids,
       expected_evidence = EXCLUDED.expected_evidence,
       forbidden_behavior = EXCLUDED.forbidden_behavior,
       source_refs = EXCLUDED.source_refs,
       priority = EXCLUDED.priority,
       status = EXCLUDED.status,
       updated_at = NOW()
     RETURNING id, case_key, suite, capability, priority, status, created_at, updated_at`,
    [
      args.case_key,
      suite,
      args.capability,
      args.prompt,
      args.expected_behavior,
      expectedIds,
      jsonArray(args.expected_evidence),
      jsonArray(args.forbidden_behavior),
      jsonArray(args.source_refs),
      priority,
      status,
      AGENT,
    ],
  );

  return jsonResult({
    success: true,
    case: result.rows[0],
    note: 'Case recorded. Add expected_content_ids when retrieval hit@k should be scored.',
  });
}

async function evalCaseList(args: EvalCaseListArgs): Promise<CallToolResult> {
  await ensureEvalSchema();

  const where: string[] = [];
  const params: unknown[] = [];
  if (args.suite) {
    params.push(args.suite);
    where.push(`suite = $${params.length}`);
  }
  if (args.capability) {
    params.push(args.capability);
    where.push(`capability = $${params.length}`);
  }
  if (args.status && args.status !== 'all') {
    params.push(args.status);
    where.push(`status = $${params.length}`);
  } else if (!args.status) {
    where.push(`status = 'active'`);
  }

  const limit = normalizeLimit(args.limit, 50, 200);
  params.push(limit);

  const result = await pool.query(
    `SELECT
       id, case_key, suite, capability, priority, status,
       LEFT(prompt, 220) AS prompt,
       LEFT(expected_behavior, 220) AS expected_behavior,
       expected_content_ids,
       created_at,
       updated_at
     FROM vision_eval_cases
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY priority ASC, updated_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return jsonResult({
    count: result.rows.length,
    cases: result.rows,
  });
}

async function evalRetrievalProbe(args: EvalProbeArgs): Promise<CallToolResult> {
  await ensureEvalSchema();

  const testCase = await findCase(args.case_id, args.case_key);
  if (!testCase) {
    return textResult('Eval case not found. Pass case_id or case_key.', true);
  }

  const queryText = args.query || testCase.prompt;
  const limit = normalizeLimit(args.limit, 10, 50);
  const embedding = await getEmbedding(queryText);
  const embeddingStr = formatEmbedding(embedding);
  const terms = lexicalTerms(queryText);

  const retrieval = await pool.query<{
    id: string;
    content_type: string;
    source_system: string;
    text: string;
    similarity: string;
    semantic: string;
    text_rank: string;
    trigram: string;
    lexical: string;
  }>(
    `WITH query AS (
       SELECT
         $1::vector AS embedding,
         $2::text AS text,
         $3::text[] AS terms,
         regexp_replace($2::text, '[_-]+', ' ', 'g') AS normalized_text,
         websearch_to_tsquery('english', regexp_replace($2::text, '[_-]+', ' ', 'g')) AS tsq
     ),
     scored AS (
       SELECT
         c.id,
         c.content_type,
       c.source_system,
         LEFT(c.content_text, 260) AS text,
         (1 - (c.embedding <=> query.embedding)) AS semantic,
         ts_rank_cd(to_tsvector('english', regexp_replace(c.content_text, '[_-]+', ' ', 'g')), query.tsq) AS text_rank,
         similarity(regexp_replace(c.content_text, '[_-]+', ' ', 'g'), query.normalized_text) AS trigram,
         CASE
           WHEN cardinality(query.terms) = 0 THEN 0
           ELSE (
             SELECT COUNT(*)::float / cardinality(query.terms)
             FROM unnest(query.terms) term
             WHERE regexp_replace(lower(c.content_text), '[_-]+', ' ', 'g') LIKE '%' || term || '%'
           )
         END AS lexical
       FROM content c, query
       WHERE c.embedding IS NOT NULL
         AND c.superseded_by IS NULL
     )
     SELECT
       id,
       content_type,
       source_system,
       text,
       ROUND((semantic * 0.50 + lexical * 0.25 + LEAST(text_rank, 1.0) * 0.15 + trigram * 0.10)::numeric, 4) AS similarity,
       ROUND(semantic::numeric, 4) AS semantic,
       ROUND(text_rank::numeric, 4) AS text_rank,
       ROUND(trigram::numeric, 4) AS trigram,
       ROUND(lexical::numeric, 4) AS lexical
     FROM scored
     ORDER BY (semantic * 0.50 + lexical * 0.25 + LEAST(text_rank, 1.0) * 0.15 + trigram * 0.10) DESC
     LIMIT $4`,
    [embeddingStr, queryText, terms, limit],
  );

  const expectedIds = normalizeIds(testCase.expected_content_ids);
  const retrievedIds = retrieval.rows.map((row) => Number(row.id));
  const hitIndex = expectedIds.length > 0
    ? retrievedIds.findIndex((id) => expectedIds.includes(id))
    : -1;
  const hitAt = hitIndex >= 0 ? hitIndex + 1 : null;
  const hitCount = retrievedIds.filter((id) => expectedIds.includes(id)).length;
  const mrr = hitAt ? 1 / hitAt : null;
  const verdict = expectedIds.length === 0 ? 'unmeasured' : hitAt ? 'pass' : 'fail';
  const score = expectedIds.length === 0 ? null : (mrr ?? 0);

  const runId = await createRun(testCase.suite, 'retrieval_probe', {
    case_id: testCase.id,
    capability: testCase.capability,
    query_text: queryText,
    expected_ids: expectedIds.length,
    retrieved: retrievedIds.length,
    hit_at: hitAt,
  });

  const result = await pool.query<{ id: string }>(
    `INSERT INTO vision_eval_results
       (run_id, case_id, query_text, retrieved_content_ids, expected_hit_count,
        hit_at, mrr, verdict, score, dimensions, notes)
     VALUES ($1, $2, $3, $4::bigint[], $5, $6, $7, $8, $9, $10::jsonb, $11)
     RETURNING id`,
    [
      runId,
      testCase.id,
      queryText,
      retrievedIds,
      hitCount,
      hitAt,
      mrr,
      verdict,
      score,
      JSON.stringify({ metric: 'hybrid_retrieval', limit, expected_ids: expectedIds.length, lexical_terms: terms }),
      expectedIds.length === 0
        ? 'No expected_content_ids on case; retrieval recorded but cannot be scored.'
        : null,
    ],
  );

  return jsonResult({
    success: true,
    run_id: runId,
    result_id: Number(result.rows[0].id),
    case: {
      id: testCase.id,
      key: testCase.case_key,
      suite: testCase.suite,
      capability: testCase.capability,
    },
    metrics: {
      expected_ids: expectedIds,
      retrieved_ids: retrievedIds,
      hit_count: hitCount,
      hit_at: hitAt,
      mrr,
      verdict,
      score,
    },
    top_results: retrieval.rows,
  });
}

async function evalResultRecord(args: EvalResultArgs): Promise<CallToolResult> {
  await ensureEvalSchema();

  const testCase = await findCase(args.case_id, args.case_key);
  if (!testCase) {
    return textResult('Eval case not found. Pass case_id or case_key.', true);
  }

  let verdict = args.verdict;
  if (!verdict) {
    if (typeof args.score !== 'number') {
      verdict = 'unmeasured';
    } else if (args.score >= 0.85) {
      verdict = 'pass';
    } else if (args.score >= 0.5) {
      verdict = 'partial';
    } else {
      verdict = 'fail';
    }
  }

  const runId = args.run_id ?? await createRun(testCase.suite, args.run_mode || 'manual', {
    case_id: testCase.id,
    capability: testCase.capability,
    source: 'vision_eval_result_record',
  });

  const retrievedIds = args.retrieved_content_ids ?? [];
  const expectedIds = normalizeIds(testCase.expected_content_ids);
  const hitIndex = expectedIds.length > 0
    ? retrievedIds.findIndex((id) => expectedIds.includes(id))
    : -1;
  const hitAt = hitIndex >= 0 ? hitIndex + 1 : null;
  const hitCount = retrievedIds.filter((id) => expectedIds.includes(id)).length;

  const result = await pool.query(
    `INSERT INTO vision_eval_results
       (run_id, case_id, query_text, retrieved_content_ids, expected_hit_count,
        hit_at, mrr, verdict, score, actual_behavior, dimensions, notes)
     VALUES ($1, $2, $3, $4::bigint[], $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     RETURNING id, evaluated_at`,
    [
      runId,
      testCase.id,
      args.query_text || null,
      retrievedIds,
      hitCount,
      hitAt,
      hitAt ? 1 / hitAt : null,
      verdict,
      args.score ?? null,
      args.actual_behavior || null,
      jsonObject(args.dimensions),
      args.notes || null,
    ],
  );

  return jsonResult({
    success: true,
    run_id: runId,
    result: result.rows[0],
    verdict,
    score: args.score ?? null,
    retrieval: {
      expected_ids: expectedIds,
      retrieved_ids: retrievedIds,
      hit_at: hitAt,
      hit_count: hitCount,
    },
  });
}

async function evalReport(args: EvalReportArgs): Promise<CallToolResult> {
  await ensureEvalSchema();

  const params: unknown[] = [];
  const where: string[] = [];
  if (args.suite) {
    params.push(args.suite);
    where.push(`suite = $${params.length}`);
  }
  if (args.capability) {
    params.push(args.capability);
    where.push(`capability = $${params.length}`);
  }

  const health = await pool.query(
    `SELECT
       suite, capability, active_cases, measured_cases, unmeasured_cases,
       pass_count, partial_count, fail_count, avg_score, last_evaluated_at
     FROM vision_eval_health
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY fail_count DESC, unmeasured_cases DESC, suite, capability`,
    params,
  );

  const totals = await pool.query<{
    active_cases: string;
    measured_cases: string;
    unmeasured_cases: string;
    fail_count: string;
    partial_count: string;
    pass_count: string;
    avg_score: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active') AS active_cases,
       COUNT(*) FILTER (WHERE status = 'active' AND last_evaluated_at IS NOT NULL) AS measured_cases,
       COUNT(*) FILTER (WHERE status = 'active' AND last_evaluated_at IS NULL) AS unmeasured_cases,
       COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'fail') AS fail_count,
       COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'partial') AS partial_count,
       COUNT(*) FILTER (WHERE status = 'active' AND last_verdict = 'pass') AS pass_count,
       ROUND(AVG(last_score) FILTER (WHERE status = 'active' AND last_score IS NOT NULL), 3) AS avg_score
     FROM vision_eval_case_status`,
  );

  const limit = normalizeLimit(args.limit, 20, 100);
  const staleParams = [...params, limit];
  const stale = await pool.query(
    `SELECT
       id, case_key, suite, capability, priority, status,
       last_evaluated_at, last_verdict, last_score
     FROM vision_eval_case_status
     WHERE status = 'active'
       ${where.length ? `AND ${where.join(' AND ')}` : ''}
       AND (last_evaluated_at IS NULL OR last_verdict IN ('fail', 'partial', 'unmeasured'))
     ORDER BY
       CASE WHEN last_evaluated_at IS NULL THEN 0 ELSE 1 END,
       priority ASC,
       last_evaluated_at ASC NULLS FIRST
     LIMIT $${staleParams.length}`,
    staleParams,
  );

  const t = totals.rows[0];
  const activeCases = Number(t.active_cases);
  const measuredCases = Number(t.measured_cases);
  const failCount = Number(t.fail_count);
  const partialCount = Number(t.partial_count);
  const status = activeCases === 0
    ? 'unmeasured'
    : measuredCases === 0
      ? 'unmeasured'
      : failCount > 0
        ? 'degraded'
        : partialCount > 0
          ? 'partial'
          : 'measured';

  return jsonResult({
    status,
    totals: {
      active_cases: activeCases,
      measured_cases: measuredCases,
      unmeasured_cases: Number(t.unmeasured_cases),
      pass_count: Number(t.pass_count),
      partial_count: partialCount,
      fail_count: failCount,
      avg_score: t.avg_score === null ? null : Number(t.avg_score),
    },
    by_capability: health.rows,
    priority_cases: stale.rows,
    interpretation: activeCases === 0
      ? 'No active eval cases exist. Vision evolution is unmeasured.'
      : measuredCases === 0
        ? 'Eval cases exist but none have results yet.'
        : failCount > 0
          ? 'At least one active eval case is currently failing.'
          : 'Active eval cases have recent measurements; keep adding cases from real failures.',
  });
}

async function evalTraceConvert(args: EvalTraceConvertArgs): Promise<CallToolResult> {
  await ensureEvalSchema();

  const hours = Math.max(1, Math.min(24 * 30, args.hours ?? 72));
  const limit = normalizeLimit(args.limit, 20, 200);
  const suite = args.suite || 'trace-regression';
  const status = args.status || 'draft';
  const execute = args.execute === true;
  const candidates: TraceCandidate[] = [];

  const toolErrors = await pool.query<{
    id: string;
    tool_name: string;
    agent: string;
    args_hash: string | null;
    duration_ms: number | null;
    error: string | null;
    invoked_at: string;
  }>(
    `SELECT id, tool_name, agent, args_hash, duration_ms, error, invoked_at::text
     FROM tool_invocations
     WHERE invoked_at > now() - ($1::int || ' hours')::interval
       AND error IS NOT NULL
     ORDER BY invoked_at DESC
     LIMIT $2`,
    [hours, limit],
  );

  for (const row of toolErrors.rows) {
    const id = Number(row.id);
    candidates.push({
      source_type: 'tool_error',
      source_id: id,
      case_key: `trace-tool-error-${id}`,
      suite,
      capability: 'tool_error_recovery',
      prompt: `A ${row.agent || AGENT} Vision/tool invocation failed: ${row.tool_name}. How should a similar task be handled next time?`,
      expected_behavior:
        `Inspect the prior failure before retrying, route around the exact error, and do not claim success until the replacement path is verified. Prior error: ${truncate(row.error, 220)}`,
      source_refs: [{
        table: 'tool_invocations',
        id,
        tool_name: row.tool_name,
        agent: row.agent,
        args_hash: row.args_hash,
        duration_ms: row.duration_ms,
        invoked_at: row.invoked_at,
        error: truncate(row.error, 500),
      }],
      priority: 1,
      status,
    });
  }

  const presenceExists = await pool.query<{ exists: string | null }>(
    `SELECT to_regclass('public.presence_events')::text AS exists`,
  );
  if (presenceExists.rows[0]?.exists) {
    const presence = await pool.query<{
      id: string;
      trigger_class: string;
      state: string;
      trigger_excerpt: string | null;
      first_tool_category: string | null;
      did_next_action_change: boolean | null;
      verification_outcome: string | null;
      entered_at: string;
    }>(
      `SELECT id, trigger_class, state, trigger_excerpt, first_tool_category,
              did_next_action_change, verification_outcome, entered_at::text
       FROM presence_events
       WHERE entered_at > now() - ($1::int || ' hours')::interval
         AND verification_outcome IN ('failed', 'unverified', 'no_change')
       ORDER BY entered_at DESC
       LIMIT $2`,
      [hours, limit],
    );

    for (const row of presence.rows) {
      const id = Number(row.id);
      candidates.push({
        source_type: 'presence_event',
        source_id: id,
        case_key: `trace-presence-${id}`,
        suite,
        capability: 'presence_uptake',
        prompt: `A Presence trigger (${row.trigger_class}) ended as ${row.verification_outcome}. What should happen in a similar moment?`,
        expected_behavior:
          'The agent should pause long enough to name the trigger, choose the bounded next action, and verify whether the next action changed before returning to normal build motion.',
        source_refs: [{
          table: 'presence_events',
          id,
          trigger_class: row.trigger_class,
          state: row.state,
          trigger_excerpt: truncate(row.trigger_excerpt, 500),
          first_tool_category: row.first_tool_category,
          did_next_action_change: row.did_next_action_change,
          verification_outcome: row.verification_outcome,
          entered_at: row.entered_at,
        }],
        priority: row.verification_outcome === 'failed' ? 0 : 1,
        status,
      });
    }
  }

  const unique = new Map<string, TraceCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.case_key)) {
      unique.set(candidate.case_key, candidate);
    }
  }
  const deduped = Array.from(unique.values()).slice(0, limit);

  const created: Array<{ id: number; case_key: string; status: string }> = [];
  if (execute) {
    for (const candidate of deduped) {
      const result = await pool.query<{ id: string; case_key: string; status: string }>(
        `INSERT INTO vision_eval_cases
           (case_key, suite, capability, prompt, expected_behavior,
            expected_evidence, source_refs, priority, status, created_by)
         VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, $6::jsonb, $7, $8, $9)
         ON CONFLICT (case_key) DO UPDATE SET
           source_refs = EXCLUDED.source_refs,
           expected_behavior = EXCLUDED.expected_behavior,
           priority = LEAST(vision_eval_cases.priority, EXCLUDED.priority),
           updated_at = NOW()
         RETURNING id, case_key, status`,
        [
          candidate.case_key,
          candidate.suite,
          candidate.capability,
          candidate.prompt,
          candidate.expected_behavior,
          JSON.stringify(candidate.source_refs),
          candidate.priority,
          candidate.status,
          AGENT,
        ],
      );
      created.push({
        id: Number(result.rows[0].id),
        case_key: result.rows[0].case_key,
        status: result.rows[0].status,
      });
    }
  }

  return jsonResult({
    mode: execute ? 'execute' : 'preview',
    hours,
    suite,
    status,
    candidates: deduped,
    created_count: created.length,
    created,
    note: execute
      ? 'Trace candidates have been converted to eval cases. Review draft cases before making them active.'
      : 'Preview only. Re-run with execute:true to create eval cases.',
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_eval_case_record',
      description:
        'Create or update a held-out Vision eval case. Use this when a real correction/failure should become a regression test.',
      inputSchema: {
        type: 'object',
        properties: {
          case_key: { type: 'string' },
          suite: { type: 'string', description: 'Eval suite name. Default: core.' },
          capability: { type: 'string', description: 'Capability under test, e.g. correction_uptake, temporal_recall, source_truth.' },
          prompt: { type: 'string' },
          expected_behavior: { type: 'string' },
          expected_content_ids: { type: 'array', items: { type: 'number' } },
          expected_evidence: { type: 'array', items: {} },
          forbidden_behavior: { type: 'array', items: {} },
          source_refs: { type: 'array', items: {} },
          priority: { type: 'number', description: '0 highest, 3 lowest. Default 2.' },
          status: { type: 'string', enum: ['active', 'draft', 'retired'] },
        },
        required: ['case_key', 'capability', 'prompt', 'expected_behavior'],
      },
    },
    handler: (args) => evalCaseRecord(args as EvalCaseRecordArgs),
  },
  {
    definition: {
      name: 'vision_eval_case_list',
      description: 'List Vision eval cases, filtered by suite/capability/status.',
      inputSchema: {
        type: 'object',
        properties: {
          suite: { type: 'string' },
          capability: { type: 'string' },
          status: { type: 'string', enum: ['active', 'draft', 'retired', 'all'] },
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => evalCaseList(args as EvalCaseListArgs),
  },
  {
    definition: {
      name: 'vision_eval_retrieval_probe',
      description:
        'Run a semantic retrieval probe for an eval case, record retrieved content IDs, and score hit_at/MRR when expected_content_ids are present.',
      inputSchema: {
        type: 'object',
        properties: {
          case_id: { type: 'number' },
          case_key: { type: 'string' },
          query: { type: 'string', description: 'Optional query override. Defaults to the case prompt.' },
          limit: { type: 'number', description: 'Default 10, max 50.' },
        },
      },
    },
    handler: (args) => evalRetrievalProbe(args as EvalProbeArgs),
  },
  {
    definition: {
      name: 'vision_eval_result_record',
      description:
        'Record a manual, trace-derived, or external eval result for a case. Use this to turn real behavior into measured pass/partial/fail history.',
      inputSchema: {
        type: 'object',
        properties: {
          case_id: { type: 'number' },
          case_key: { type: 'string' },
          run_id: { type: 'number' },
          run_mode: { type: 'string', enum: ['manual', 'retrieval_probe', 'agent_trace', 'external'] },
          verdict: { type: 'string', enum: ['pass', 'partial', 'fail', 'unmeasured'] },
          score: { type: 'number', description: '0..1 optional.' },
          actual_behavior: { type: 'string' },
          query_text: { type: 'string' },
          retrieved_content_ids: { type: 'array', items: { type: 'number' } },
          dimensions: { type: 'object' },
          notes: { type: 'string' },
        },
      },
    },
    handler: (args) => evalResultRecord(args as EvalResultArgs),
  },
  {
    definition: {
      name: 'vision_eval_report',
      description:
        'Report eval coverage and current pass/partial/fail state by suite and capability. Returns unmeasured when no cases/results exist.',
      inputSchema: {
        type: 'object',
        properties: {
          suite: { type: 'string' },
          capability: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    handler: (args) => evalReport(args as EvalReportArgs),
  },
  {
    definition: {
      name: 'vision_eval_trace_convert',
      description:
        'Preview or create eval cases from recent tool errors and Presence events. Converts real failures/unverified moments into draft regression cases.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: { type: 'number', description: 'Lookback window in hours. Default 72, max 720.' },
          limit: { type: 'number', description: 'Max candidates/cases. Default 20, max 200.' },
          execute: { type: 'boolean', description: 'If true, create/update eval cases. Default false preview.' },
          status: { type: 'string', enum: ['active', 'draft', 'retired'], description: 'Status for created cases. Default draft.' },
          suite: { type: 'string', description: 'Suite name for created cases. Default trace-regression.' },
        },
      },
    },
    handler: (args) => evalTraceConvert(args as EvalTraceConvertArgs),
  },
];

export default tools;
