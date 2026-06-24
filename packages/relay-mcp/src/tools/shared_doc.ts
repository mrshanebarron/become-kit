import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { query } from '../db/pool.js';
import { getPublisher } from '../db/redis.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';
import { AGENT_NAME } from '../identity.js';
import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';

const MAX_CONTENT_SIZE = 512_000;

interface SharedDocRow {
  slug: string;
  schema_type: string;
  content: Record<string, unknown>;
  version: number;
  last_editor: string | null;
  last_edited: Date;
  created_at: Date;
}

async function publishDocUpdate(slug: string, version: number, editor: string): Promise<void> {
  try {
    const pub = getPublisher();
    await pub.publish(
      `shared_doc:${slug}`,
      JSON.stringify({ slug, version, editor, edited_at: new Date().toISOString() }),
    );
  } catch (err) {
    console.error('[shared_doc] Publish failed:', err instanceof Error ? err.message : err);
  }
}

async function sharedDocGet(args: Record<string, unknown>): Promise<CallToolResult> {
  const slug = args.slug as string;
  const result = await query<SharedDocRow>(
    `SELECT slug, schema_type, content, version, last_editor, last_edited, created_at
     FROM shared_docs WHERE slug = $1`,
    [slug],
  );
  if (result.rows.length === 0) {
    return jsonResult({ exists: false, slug }, true);
  }
  return jsonResult({ exists: true, ...result.rows[0] });
}

async function sharedDocPut(args: Record<string, unknown>): Promise<CallToolResult> {
  const slug = args.slug as string;
  const content = args.content as Record<string, unknown>;
  const schema_type = (args.schema_type as string) || 'freeform';
  const expected_version = args.expected_version as number | undefined;

  const serialized = JSON.stringify(content);
  if (serialized.length > MAX_CONTENT_SIZE) {
    return jsonResult(
      { error: `Content too large: ${serialized.length} bytes (max ${MAX_CONTENT_SIZE})` },
      true,
    );
  }

  const existing = await query<{ version: number; schema_type: string; content: Record<string, unknown> }>(
    `SELECT version, schema_type, content FROM shared_docs WHERE slug = $1`,
    [slug],
  );

  if (existing.rows.length === 0) {
    if (expected_version !== undefined && expected_version !== 0) {
      return jsonResult(
        { error: 'Doc does not exist; expected_version must be 0 or omitted for creation', slug },
        true,
      );
    }
    const inserted = await query<SharedDocRow>(
      `INSERT INTO shared_docs (slug, schema_type, content, version, last_editor, last_edited)
       VALUES ($1, $2, $3::jsonb, 1, $4, NOW())
       RETURNING slug, schema_type, content, version, last_editor, last_edited, created_at`,
      [slug, schema_type, serialized, AGENT_NAME],
    );
    const row = inserted.rows[0];
    await query(
      `INSERT INTO shared_doc_history (doc_slug, version, schema_type, content, editor, edited_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
      [slug, row.version, schema_type, serialized, AGENT_NAME],
    );
    await publishDocUpdate(slug, row.version, AGENT_NAME);
    return jsonResult({ created: true, ...row });
  }

  const current = existing.rows[0];
  if (expected_version !== undefined && current.version !== expected_version) {
    return jsonResult(
      {
        error: 'Version conflict: expected_version mismatch',
        slug,
        expected_version,
        actual_version: current.version,
        hint: 'Re-read, re-merge your changes, and put with the new expected_version.',
      },
      true,
    );
  }

  const new_version = current.version + 1;
  const updated = await query<SharedDocRow>(
    `UPDATE shared_docs
     SET content = $1::jsonb, schema_type = $2, version = $3, last_editor = $4, last_edited = NOW()
     WHERE slug = $5
     RETURNING slug, schema_type, content, version, last_editor, last_edited, created_at`,
    [serialized, schema_type, new_version, AGENT_NAME, slug],
  );
  await query(
    `INSERT INTO shared_doc_history (doc_slug, version, schema_type, content, editor, edited_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
    [slug, new_version, schema_type, serialized, AGENT_NAME],
  );
  await publishDocUpdate(slug, new_version, AGENT_NAME);
  return jsonResult({ updated: true, ...updated.rows[0] });
}

async function sharedDocPatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const slug = args.slug as string;
  const patches = args.patches as Operation[];
  const expected_version = args.expected_version as number | undefined;

  const existing = await query<{ version: number; schema_type: string; content: Record<string, unknown> }>(
    `SELECT version, schema_type, content FROM shared_docs WHERE slug = $1`,
    [slug],
  );
  if (existing.rows.length === 0) {
    return jsonResult({ error: 'Doc does not exist; use shared_doc_put to create', slug }, true);
  }

  const current = existing.rows[0];
  if (expected_version !== undefined && current.version !== expected_version) {
    return jsonResult(
      {
        error: 'Version conflict: expected_version mismatch',
        slug,
        expected_version,
        actual_version: current.version,
      },
      true,
    );
  }

  let new_content: Record<string, unknown>;
  try {
    new_content = jsonpatch.applyPatch(
      jsonpatch.deepClone(current.content),
      patches,
      true,
    ).newDocument as Record<string, unknown>;
  } catch (err) {
    return jsonResult(
      { error: 'Patch failed to apply', detail: err instanceof Error ? err.message : String(err) },
      true,
    );
  }

  const serialized = JSON.stringify(new_content);
  if (serialized.length > MAX_CONTENT_SIZE) {
    return jsonResult(
      { error: `Result too large: ${serialized.length} bytes (max ${MAX_CONTENT_SIZE})` },
      true,
    );
  }

  const new_version = current.version + 1;
  const updated = await query<SharedDocRow>(
    `UPDATE shared_docs
     SET content = $1::jsonb, version = $2, last_editor = $3, last_edited = NOW()
     WHERE slug = $4
     RETURNING slug, schema_type, content, version, last_editor, last_edited, created_at`,
    [serialized, new_version, AGENT_NAME, slug],
  );
  await query(
    `INSERT INTO shared_doc_history (doc_slug, version, schema_type, content, editor, edited_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
    [slug, new_version, current.schema_type, serialized, AGENT_NAME],
  );
  await publishDocUpdate(slug, new_version, AGENT_NAME);
  return jsonResult({ patched: true, operations_applied: patches.length, ...updated.rows[0] });
}

async function sharedDocHistory(args: Record<string, unknown>): Promise<CallToolResult> {
  const slug = args.slug as string;
  const limit = Math.min((args.limit as number) || 10, 100);
  const result = await query(
    `SELECT version, schema_type, editor, edited_at, content
     FROM shared_doc_history
     WHERE doc_slug = $1
     ORDER BY version DESC
     LIMIT $2`,
    [slug, limit],
  );
  return jsonResult({ slug, count: result.rows.length, versions: result.rows });
}

async function sharedDocList(args: Record<string, unknown>): Promise<CallToolResult> {
  const schema_type = (args.schema_type as string) || null;
  let sql = `SELECT slug, schema_type, version, last_editor, last_edited FROM shared_docs`;
  const params: unknown[] = [];
  if (schema_type) {
    sql += ` WHERE schema_type = $1`;
    params.push(schema_type);
  }
  sql += ` ORDER BY last_edited DESC`;
  const result = await query(sql, params);
  return jsonResult({ count: result.rows.length, docs: result.rows });
}

async function sharedDocDelete(args: Record<string, unknown>): Promise<CallToolResult> {
  const slug = args.slug as string;
  const expected_version = args.expected_version as number;

  const existing = await query<{ version: number }>(
    `SELECT version FROM shared_docs WHERE slug = $1`,
    [slug],
  );
  if (existing.rows.length === 0) {
    return jsonResult({ error: 'Doc does not exist', slug }, true);
  }
  if (existing.rows[0].version !== expected_version) {
    return jsonResult(
      {
        error: 'Version conflict',
        slug,
        expected_version,
        actual_version: existing.rows[0].version,
      },
      true,
    );
  }
  await query(`DELETE FROM shared_docs WHERE slug = $1 AND version = $2`, [slug, expected_version]);
  await publishDocUpdate(slug, -1, AGENT_NAME);
  return jsonResult({ deleted: true, slug });
}

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'shared_doc_get',
      description:
        'Read a shared doc by slug. Returns current content, version, schema_type, last editor. Use version for optimistic-concurrency writes.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Doc slug (e.g. "corpus_callosum")' },
        },
        required: ['slug'],
      },
    },
    handler: (args) => sharedDocGet(args),
  },
  {
    definition: {
      name: 'shared_doc_put',
      description:
        'Create or replace a shared doc with optimistic concurrency. Pass expected_version=current version; fails if version drifted. Omit or pass 0 to create new. Publishes shared_doc:<slug> notification on success.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          content: { type: 'object', description: 'JSONB content replacing entire doc' },
          schema_type: {
            type: 'string',
            description: 'Doc schema: freeform | proposal | handoff | task_list',
          },
          expected_version: {
            type: 'number',
            description: 'Version you read before editing; 0 or omit for new doc',
          },
        },
        required: ['slug', 'content'],
      },
    },
    handler: (args) => sharedDocPut(args),
  },
  {
    definition: {
      name: 'shared_doc_patch',
      description:
        'Apply RFC 6902 JSON patch operations to a shared doc. Optimistic concurrency via expected_version. More surgical than put. Publishes shared_doc:<slug> notification on success.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          patches: {
            type: 'array',
            description:
              'Array of RFC 6902 operations: {op: "add"|"remove"|"replace"|"move"|"copy"|"test", path: "/json/pointer", value?: any, from?: string}',
            items: { type: 'object' },
          },
          expected_version: {
            type: 'number',
            description: 'Version you read before patching',
          },
        },
        required: ['slug', 'patches'],
      },
    },
    handler: (args) => sharedDocPatch(args),
  },
  {
    definition: {
      name: 'shared_doc_history',
      description: 'Return last N versions of a shared doc, newest first.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          limit: { type: 'number', description: 'Max versions (default 10, max 100)' },
        },
        required: ['slug'],
      },
    },
    handler: (args) => sharedDocHistory(args),
  },
  {
    definition: {
      name: 'shared_doc_list',
      description: 'Enumerate all shared docs, optionally filtered by schema_type. Sorted by last_edited desc.',
      inputSchema: {
        type: 'object',
        properties: {
          schema_type: { type: 'string' },
        },
      },
    },
    handler: (args) => sharedDocList(args),
  },
  {
    definition: {
      name: 'shared_doc_delete',
      description:
        'Tombstone a shared doc. History is preserved in shared_doc_history. Requires exact expected_version match.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          expected_version: { type: 'number' },
        },
        required: ['slug', 'expected_version'],
      },
    },
    handler: (args) => sharedDocDelete(args),
  },
];

export default tools;
