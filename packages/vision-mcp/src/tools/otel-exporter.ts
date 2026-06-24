/**
 * OTel Exporter — vision_otel_export
 *
 * Stub built 2026-05-02 by agent + agent as the deferred half of the OTel
 * compromise: keep tool_invocations as primary storage (PG backend, joinable
 * to cognitive tables), expose an OTel-shaped projection (tool_invocations_otel
 * view), and provide this tool as the on-ramp for emitting OTLP spans WHEN —
 * and only when — a second consumer of the telemetry actually appears.
 *
 * Until that day:
 *   - vision_otel_export(dry_run: true) returns the SpanData payload that
 *     WOULD be sent, so we can verify the projection without depending on
 *     an OTel Collector being deployed.
 *   - vision_otel_export(dry_run: false) is a no-op that returns an error
 *     telling the caller to set OTLP_ENDPOINT env var first.
 *
 * When the second consumer ships:
 *   - Add @opentelemetry/sdk-node + @opentelemetry/exporter-trace-otlp-http
 *   - Implement the actual emit path inside emitSpans()
 *   - Set OTLP_ENDPOINT in the env
 *   - Tool flips from stub to live with no schema or middleware changes
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

interface OtelSpan {
  trace_id: string | null;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  status_code: string;
  status_message: string | null;
  service_name: string;
  attributes: Record<string, unknown> | null;
}

async function fetchPendingSpans(sinceIso: string, limit: number): Promise<OtelSpan[]> {
  const result = await pool.query<OtelSpan>(
    `SELECT
        trace_id::text,
        span_id,
        parent_invocation_id::text AS parent_span_id,
        name,
        kind,
        start_time::text,
        end_time::text,
        duration_ms,
        status_code,
        status_message,
        service_name,
        attributes
       FROM tool_invocations_otel
      WHERE start_time > $1::timestamptz
      ORDER BY start_time ASC
      LIMIT $2`,
    [sinceIso, limit],
  );
  return result.rows;
}

function emitSpans(_spans: OtelSpan[]): { sent: number; error: string | null } {
  // STUB: real implementation will use @opentelemetry/sdk-node and ship
  // OTLP/HTTP to OTLP_ENDPOINT. Today we no-op and report.
  if (!process.env.OTLP_ENDPOINT) {
    return {
      sent: 0,
      error: 'OTLP_ENDPOINT env var not set — exporter is stubbed. Wire OTel SDK when ready.',
    };
  }
  return {
    sent: 0,
    error: 'Exporter SDK not yet wired in — see otel-exporter.ts header for activation steps.',
  };
}

async function visionOtelExport(args: {
  since?: string;
  limit?: number;
  dry_run?: boolean;
}): Promise<CallToolResult> {
  const since = args.since || new Date(Date.now() - 3600 * 1000).toISOString(); // last hour default
  const limit = Math.min(args.limit ?? 100, 1000);
  const dryRun = args.dry_run !== false; // default true while stub

  const spans = await fetchPendingSpans(since, limit);

  if (dryRun) {
    return jsonResult({
      mode: 'dry_run',
      since,
      limit,
      span_count: spans.length,
      spans_preview: spans.slice(0, 3),
      note: 'Dry-run only. Real OTLP emission is stubbed until a second consumer needs the data. See otel-exporter.ts header.',
    });
  }

  const emitResult = emitSpans(spans);
  return jsonResult({
    mode: 'live',
    since,
    limit,
    span_count: spans.length,
    sent: emitResult.sent,
    error: emitResult.error,
  });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_otel_export',
      description:
        'Export tool_invocations as OTel SpanData. Stub today (returns dry-run by default). When a second consumer of telemetry appears, wire the OTel SDK and flip dry_run:false.',
      inputSchema: {
        type: 'object',
        properties: {
          since: {
            type: 'string',
            description: 'ISO 8601 timestamp; only spans started after this will be emitted. Default: 1h ago.',
          },
          limit: {
            type: 'number',
            description: 'Max spans per call. Default 100, max 1000.',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true (default), returns the spans that WOULD be emitted without sending. If false, attempts real OTLP send (currently stubbed).',
          },
        },
      },
    },
    handler: (args) => visionOtelExport(args as { since?: string; limit?: number; dry_run?: boolean }),
  },
];

export default tools;
