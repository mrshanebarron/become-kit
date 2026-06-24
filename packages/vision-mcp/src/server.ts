/**
 * Vision MCP Server v4.0 — TypeScript Edition
 * Thin bootstrap: creates server, registers tools, connects transport.
 *
 * Telemetry (added 2026-05-02 by the agent + the agent, Vision Phase 2 — Observability):
 * Every tool dispatch is wrapped in instrumentation that writes one row to
 * tool_invocations. Fire-and-forget — the tool result returns to the caller
 * before the row hits Postgres so latency is unaffected. Schema in
 * migrations/018-tool-invocations.sql.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { createHash } from 'node:crypto';
import { TOOL_SCHEMAS, validateInput, type ToolName } from './schemas/tools.js';
import { pool } from './db/pool.js';

// ─── Tool Definition Type ───

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

// ─── Audit-namespace mapping (2026-05-17) ───
// Maps tool_name -> { table, namespace, operation } so the dispatcher can
// write an intent-bearing audit row alongside tool_invocations. Only
// mutation-bearing tools are mapped; pure-read tools skip audit.
//
// Closes audit_writers_removed meta_observation. Schema is preserved from
// 2026-05-05 (op_id/run_id/namespace/operation/intent/produced_by/status/
// op_payload).
function auditTargetForTool(toolName: string): { table: string; namespace: string; operation: string } | null {
  // vault — memory/state writes
  if (toolName === 'vision_vault_remember') return { table: 'vault_audit', namespace: 'vault', operation: 'remember' };
  if (toolName === 'vision_vault_state') return { table: 'vault_audit', namespace: 'vault', operation: 'state_set' };
  if (toolName === 'vision_vault_consolidate') return { table: 'vault_audit', namespace: 'vault', operation: 'consolidate' };
  if (toolName === 'vision_core_memory_patch') return { table: 'vault_audit', namespace: 'vault', operation: 'core_memory_patch' };
  if (toolName === 'vision_core_memory_replace') return { table: 'vault_audit', namespace: 'vault', operation: 'core_memory_replace' };
  if (toolName === 'vision_note') return { table: 'vault_audit', namespace: 'vault', operation: 'note' };
  // beliefs
  if (toolName === 'vision_belief_update') return { table: 'beliefs_audit', namespace: 'beliefs', operation: 'update' };
  if (toolName === 'vision_belief_revise') return { table: 'beliefs_audit', namespace: 'beliefs', operation: 'revise' };
  if (toolName === 'vision_state_belief') return { table: 'beliefs_audit', namespace: 'beliefs', operation: 'state_belief' };
  // graph
  if (toolName === 'vision_graph_relate') return { table: 'graph_audit', namespace: 'graph', operation: 'relate' };
  if (toolName === 'vision_graph_merge') return { table: 'graph_audit', namespace: 'graph', operation: 'merge' };
  if (toolName === 'vision_graph_prune') return { table: 'graph_audit', namespace: 'graph', operation: 'prune' };
  if (toolName === 'vision_graph_delete_entity') return { table: 'graph_audit', namespace: 'graph', operation: 'delete_entity' };
  if (toolName === 'vision_graph_delete_relationship') return { table: 'graph_audit', namespace: 'graph', operation: 'delete_relationship' };
  if (toolName === 'vision_world_observe') return { table: 'graph_audit', namespace: 'graph', operation: 'world_observe' };
  if (toolName === 'vision_world_relate') return { table: 'graph_audit', namespace: 'graph', operation: 'world_relate' };
  // immune
  if (toolName === 'vision_immune_learn') return { table: 'immune_audit', namespace: 'immune', operation: 'learn' };
  if (toolName === 'vision_immune_autolearn') return { table: 'immune_audit', namespace: 'immune', operation: 'autolearn' };
  if (toolName === 'vision_phrase_add') return { table: 'immune_audit', namespace: 'immune', operation: 'phrase_add' };
  if (toolName === 'vision_phrase_caught') return { table: 'immune_audit', namespace: 'immune', operation: 'phrase_caught' };
  if (toolName === 'vision_boundary_add') return { table: 'immune_audit', namespace: 'immune', operation: 'boundary_add' };
  return null;
}

// ─── Tool Registry ───

const toolDefinitions: ToolDefinition[] = [];
const toolHandlers = new Map<string, ToolHandler>();

/**
 * Read-only access to the registered tool list. Used by vision_dashboard
 * to detect "registered but never invoked" tools — the never_used_tools
 * dashboard signal added 2026-05-02 by the agent + the agent (Vision Phase 2).
 */
export function getRegisteredToolNames(): string[] {
  return toolDefinitions.map((t) => t.name);
}

/**
 * Register a tool with its MCP definition and handler.
 * Called by each tool module during initialization.
 */
export function registerTool(
  definition: ToolDefinition,
  handler: ToolHandler,
): void {
  toolDefinitions.push(definition);
  toolHandlers.set(definition.name, handler);
}

/**
 * Register multiple tools at once from a module.
 */
export function registerTools(
  tools: Array<{ definition: ToolDefinition; handler: ToolHandler }>,
): void {
  for (const tool of tools) {
    registerTool(tool.definition, tool.handler);
  }
}

/** Helper to create a text result. */
export function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Helper to create a JSON result. */
export function jsonResult(data: unknown, isError = false): CallToolResult {
  return textResult(JSON.stringify(data, null, 2), isError);
}

// ─── Server Setup ───

export async function startServer(): Promise<void> {
  const server = new Server(
    { name: 'vision-mcp', version: '4.0.0' },
    { capabilities: { tools: {} } },
  );

  // List all registered tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Dispatch tool calls — instrumented to write tool_invocations rows.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = toolHandlers.get(name);

    if (!handler) {
      return textResult(`Unknown tool: ${name}`, true);
    }

    const startedAt = Date.now();
    let argsSize = 0;
    let argsHash: string | null = null;
    if (args !== undefined && args !== null) {
      const argsJson = JSON.stringify(args);
      argsSize = Buffer.byteLength(argsJson, 'utf8');
      argsHash = createHash('sha256').update(argsJson).digest('hex').slice(0, 16);
    }

    let result: CallToolResult;
    let errorMessage: string | null = null;

    try {
      const schemaKey = name as ToolName;
      if (schemaKey in TOOL_SCHEMAS) {
        validateInput(schemaKey, args);
      }
      result = await handler(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
        errorMessage = `Invalid input: ${issues}`;
        result = textResult(`Invalid input for ${name}: ${issues}`, true);
      } else {
        errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[${name}] Error:`, errorMessage);
        result = textResult(`Error in ${name}: ${errorMessage}`, true);
      }
    }

    const durationMs = Date.now() - startedAt;
    const resultText = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    const resultSize = Buffer.byteLength(resultText, 'utf8');
    if (result.isError && !errorMessage) {
      errorMessage = resultText.slice(0, 500);
    }

    // Fire-and-forget: do not await the insert. Errors here must NEVER affect
    // the tool's return value. We pull agent identity from VISION_AGENT env
    // so the agent's process records 'the agent', mine records 'the agent'.
    //
    // Schema is OTel-aligned (migration 019): we now also write span_id and
    // an attributes JSONB so the tool_invocations_otel view exposes a clean
    // OTel projection for any future exporter.
    const agent = process.env.VISION_AGENT || 'the agent';
    const spanId = createHash('sha256')
      .update(`${name}:${agent}:${startedAt}:${Math.random()}`)
      .digest('hex')
      .slice(0, 32);
    const attributes = {
      'args.hash': argsHash,
      'args.size': argsSize,
      'result.size': resultSize,
      'duration.ms': durationMs,
      'error.message': errorMessage,
    };
    pool
      .query(
        `INSERT INTO tool_invocations
           (tool_name, agent, args_hash, args_size, result_size, duration_ms, error,
            span_id, span_kind, attributes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          name, agent, argsHash, argsSize, resultSize, durationMs, errorMessage,
          spanId, 'INTERNAL', JSON.stringify(attributes),
        ],
      )
      .catch((err) => {
        // Telemetry must never crash the dispatcher. Log and move on.
        console.error('[telemetry] tool_invocations insert failed:', err.message);
      });

    // ─── 2026-05-17 audit_writers_removed gap closure ───
    // Write a namespace-specific audit row for tools that map cleanly to one
    // The audit schema is intent-bearing (op_id, run_id, namespace, operation,
    // intent, produced_by, status, op_payload) — kept compatible with the
    // historic shape from 2026-05-05 writers. Fire-and-forget like
    // tool_invocations; never block the dispatcher.
    const auditMap = auditTargetForTool(name);
    if (auditMap) {
      const opId = `${startedAt}_${spanId.slice(0, 16)}`;
      const status = errorMessage ? 'failed' : 'committed';
      const opPayload = {
        op_id: opId,
        intent: `mcp-dispatch:${name}`,
        run_id: agent,
        target: {},
        dry_run: false,
        confirmed: true,
        namespace: auditMap.namespace,
        operation: auditMap.operation,
        produced_at: new Date(startedAt).toISOString(),
        produced_by: `${agent}.mcp_dispatcher`,
        duration_ms: durationMs,
        error: errorMessage,
      };
      pool
        .query(
          `INSERT INTO ${auditMap.table}
             (op_id, run_id, namespace, operation, intent, produced_by, status, op_payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [
            opId, agent, auditMap.namespace, auditMap.operation,
            `mcp-dispatch:${name}`, `${agent}.mcp_dispatcher`, status,
            JSON.stringify(opPayload),
          ],
        )
        .catch((err) => {
          console.error(`[audit] ${auditMap.table} insert failed:`, err.message);
        });
    }

    return result;
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function getToolHandler(name: string): ToolHandler | undefined {
  return toolHandlers.get(name);
}
export function getToolDefinitions(): ToolDefinition[] {
  return toolDefinitions;
}
