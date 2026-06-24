/**
 * artifact-emit — TypeScript companion to the runtime state dir
 *
 * Wave 3 of agent-artifact-v1 protocol (sealed 2026-05-05).
 * Vision MCP write-tools call emitOperation() instead of mutating directly.
 * The Python applier daemon (the runtime state dir) polls
 * the runtime state dir every 60s, dispatches by namespace,
 * runs atomic Postgres transactions, halts on any failure.
 *
 * Envelope must match the 13-field spec in PR-010-artifact-protocol.md.
 *
 * The agent-MCP (this code) emits intent. The control plane (Python applier)
 * decides whether to apply. Postgres only ever holds rows that committed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';

const ARTIFACT_DIR = path.join(os.homedir(), '.claude', 'agent', 'state', 'artifacts');

export type Namespace = 'task' | 'vault' | 'graph' | 'beliefs' | 'immune' | 'relay';

export interface OperationEnvelope {
  op_id: string;
  run_id: string;
  produced_at: string;
  produced_by: string;
  intent: string;
  namespace: Namespace;
  operation: string;
  target: Record<string, unknown>;
  fields: Record<string, unknown>;
  preconditions?: Record<string, unknown>;
  dry_run: boolean;
  confirmed: boolean;
  confidence: number;
}

export interface EmitOptions {
  namespace: Namespace;
  runId: string;
  operation: string;
  target?: Record<string, unknown>;
  intent: string;
  fields: Record<string, unknown>;
  confidence: number;
  preconditions?: Record<string, unknown>;
  dryRun?: boolean;
  confirmed?: boolean;
  producedBy?: string;
}

function generateOpId(): string {
  // Time-sortable pseudo-ULID: ms timestamp + 16 hex entropy.
  // Matches the runtime state dir:generate_op_id().
  const timestampMs = Date.now();
  const entropy = randomUUID().replace(/-/g, '').slice(0, 16);
  return `${timestampMs}_${entropy}`;
}

/**
 * Emit an operation to the JSONL artifact log.
 * Validates envelope fields and writes a single newline-terminated JSON line
 * with fsync so the Python applier never reads a torn line.
 *
 * Returns the generated op_id (ulid-prefixed). Caller can use this to query
 * the audit table after the applier processes the file.
 */
export function emitOperation(opts: EmitOptions): string {
  const intent = opts.intent;
  if (!intent || intent.length === 0 || intent.length > 200) {
    throw new Error('intent is required and must be 1..200 characters');
  }
  if (!(opts.confidence >= 0.0 && opts.confidence <= 1.0)) {
    throw new Error(`confidence must be in [0.0, 1.0], got ${opts.confidence}`);
  }
  if (!opts.fields || Object.keys(opts.fields).length === 0) {
    if (!opts.dryRun) {
      throw new Error('fields must be non-empty for non-dry-run operations');
    }
  }
  if (!opts.namespace) {
    throw new Error('namespace is required');
  }
  if (!opts.runId) {
    throw new Error('runId is required');
  }

  const envelope: OperationEnvelope = {
    op_id: generateOpId(),
    run_id: opts.runId,
    produced_at: new Date().toISOString(),
    produced_by: opts.producedBy ?? 'vision-mcp',
    intent,
    namespace: opts.namespace,
    operation: opts.operation,
    target: opts.target ?? {},
    fields: opts.fields,
    dry_run: opts.dryRun ?? false,
    confirmed: opts.confirmed ?? false,
    confidence: opts.confidence,
  };
  if (opts.preconditions) envelope.preconditions = opts.preconditions;

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const artifactPath = path.join(ARTIFACT_DIR, `${opts.namespace}-${opts.runId}.jsonl`);
  const line = JSON.stringify(envelope) + '\n';

  // Open with O_APPEND so concurrent writers can't tear lines, fsync after
  // each write so the applier never reads partial bytes. Matches the Python
  // emit helper's fsync semantics.
  const fd = fs.openSync(artifactPath, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  return envelope.op_id;
}

/**
 * Read an artifact file's emitted operations. Useful for tests and for tools
 * that want to verify their own emit history during a run.
 *
 * Skips trailing partial lines (lines without a newline terminator) — same
 * defense the applier uses against torn writes.
 */
export function readArtifactFile(namespace: Namespace, runId: string): OperationEnvelope[] {
  const artifactPath = path.join(ARTIFACT_DIR, `${namespace}-${runId}.jsonl`);
  if (!fs.existsSync(artifactPath)) return [];

  const raw = fs.readFileSync(artifactPath, 'utf-8');
  const ops: OperationEnvelope[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      ops.push(JSON.parse(line) as OperationEnvelope);
    } catch {
      // Skip malformed lines (likely a torn write being read mid-poll).
    }
  }
  return ops;
}

/**
 * Generate a fresh runId for an emit batch. Call once at the start of a tool
 * invocation; reuse across all emits within that invocation so the applier
 * sees them in the same JSONL file (and can drain them as one logical run).
 */
export function newRunId(prefix = 'mcp'): string {
  const timestampMs = Date.now();
  const entropy = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${timestampMs}_${entropy}`;
}
