/**
 * World-model tools — observe entities and relationships in the world.
 *
 * Built 2026-05-17 after the schema reconciliation pass that ported agent's
 * world_* tables to task. Schema only got me parity; these tools
 * are the active feeding so the substrate doesn't sit dark.
 *
 * Two minimum-viable tools:
 *   vision_world_observe — upsert an entity, bump last_observed
 *   vision_world_relate — create a relationship between two entities
 *
 * Both auto-create entities by name if missing. Type defaults to 'concept'.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

const ENTITY_TYPES = ['person', 'project', 'server', 'system', 'organization', 'concept', 'resource'] as const;
type EntityType = typeof ENTITY_TYPES[number];

async function upsertEntity(
  client: import('pg').PoolClient,
  name: string,
  type: EntityType,
  description: string | null,
): Promise<number> {
  // Try insert; on conflict, update last_observed + description if newer
  const existing = await client.query<{ id: number; description: string | null }>(
    'SELECT id, description FROM world_entities WHERE name = $1',
    [name],
  );

  if (existing.rows.length > 0) {
    const id = existing.rows[0]!.id;
    await client.query(
      `UPDATE world_entities
       SET last_observed = NOW(),
           description = COALESCE($2, description),
           last_updated = CASE WHEN $2 IS NOT NULL AND $2 != description THEN NOW() ELSE last_updated END
       WHERE id = $1`,
      [id, description],
    );
    return id;
  }

  const inserted = await client.query<{ id: number }>(
    `INSERT INTO world_entities (name, type, description) VALUES ($1, $2, $3) RETURNING id`,
    [name, type, description],
  );
  return inserted.rows[0]!.id;
}

// ─── vision_world_observe ───

async function worldObserve(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = args.name as string;
  const type = ((args.type as string) || 'concept') as EntityType;
  const description = (args.description as string) || null;

  if (!name) return jsonResult({ error: 'name is required' }, true);
  if (!ENTITY_TYPES.includes(type)) {
    return jsonResult({ error: `type must be one of ${ENTITY_TYPES.join(', ')}` }, true);
  }

  const client = await pool.connect();
  try {
    const id = await upsertEntity(client, name, type, description);
    const row = await client.query<{
      id: number; name: string; type: string; description: string | null;
      status: string; confidence: number; last_observed: Date; last_updated: Date;
    }>('SELECT id, name, type, description, status, confidence, last_observed, last_updated FROM world_entities WHERE id = $1', [id]);
    return jsonResult({ success: true, entity: row.rows[0] });
  } finally {
    client.release();
  }
}

// ─── vision_world_relate ───

async function worldRelate(args: Record<string, unknown>): Promise<CallToolResult> {
  const from = args.from as string;
  const to = args.to as string;
  const relation = args.relation as string;
  const strength = (args.strength as number) ?? 5;
  const bidirectional = (args.bidirectional as boolean) ?? false;
  const fromType = ((args.from_type as string) || 'concept') as EntityType;
  const toType = ((args.to_type as string) || 'concept') as EntityType;

  if (!from || !to || !relation) {
    return jsonResult({ error: 'from, to, and relation are required' }, true);
  }
  if (strength < 1 || strength > 10) {
    return jsonResult({ error: 'strength must be 1-10' }, true);
  }

  const client = await pool.connect();
  try {
    const fromId = await upsertEntity(client, from, fromType, null);
    const toId = await upsertEntity(client, to, toType, null);

    // De-dupe: if (from, to, relation) already exists, bump last_confirmed; else insert
    const existing = await client.query<{ id: number }>(
      'SELECT id FROM world_relationships WHERE from_entity = $1 AND to_entity = $2 AND relation_type = $3',
      [fromId, toId, relation],
    );

    let relationshipId: number;
    if (existing.rows.length > 0) {
      relationshipId = existing.rows[0]!.id;
      await client.query(
        'UPDATE world_relationships SET last_confirmed = NOW(), strength = $2, bidirectional = $3 WHERE id = $1',
        [relationshipId, strength, bidirectional],
      );
    } else {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO world_relationships (from_entity, to_entity, relation_type, strength, bidirectional)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [fromId, toId, relation, strength, bidirectional],
      );
      relationshipId = inserted.rows[0]!.id;

      // Log to world_changes so the relationship change is auditable
      await client.query(
        `INSERT INTO world_changes (entity_id, change_type, new_value, trigger, significance)
         VALUES ($1, 'relationship_change', $2, 'mcp', $3)`,
        [fromId, `${relation} -> ${to}`, strength],
      );
    }

    return jsonResult({
      success: true,
      relationship_id: relationshipId,
      from: { id: fromId, name: from },
      to: { id: toId, name: to },
      relation,
      strength,
      bidirectional,
    });
  } finally {
    client.release();
  }
}

// ─── vision_world_entity ───

async function worldEntity(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = args.name as string | undefined;
  const type = args.type as string | undefined;

  const client = await pool.connect();
  try {
    if (name) {
      const ent = await client.query(
        `SELECT id, name, type, description, status, confidence, created_at, last_observed
         FROM world_entities WHERE name = $1`,
        [name],
      );
      if (ent.rows.length === 0) return jsonResult({ found: false });

      const entity = ent.rows[0];
      const rels = await client.query(
        `SELECT r.relation_type, r.strength, r.bidirectional,
                e2.id, e2.name, e2.type,
                CASE WHEN r.from_entity = $1 THEN 'outgoing' ELSE 'incoming' END AS direction
         FROM world_relationships r
         JOIN world_entities e2 ON e2.id = CASE WHEN r.from_entity = $1 THEN r.to_entity ELSE r.from_entity END
         WHERE r.from_entity = $1 OR (r.to_entity = $1 AND r.bidirectional = true)
         ORDER BY r.strength DESC, r.last_confirmed DESC`,
        [entity.id],
      );
      return jsonResult({ found: true, entity, relationships: rels.rows });
    }

    // No name → list entities by type or recent
    const where = type ? 'WHERE type = $1' : '';
    const params = type ? [type] : [];
    const list = await client.query(
      `SELECT id, name, type, description, status, last_observed FROM world_entities ${where}
       ORDER BY last_observed DESC LIMIT 50`,
      params,
    );
    return jsonResult({ count: list.rows.length, entities: list.rows });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_world_observe',
      description: 'Record an observation of an entity in the world (person, project, server, system, organization, concept, resource). Upserts by name; bumps last_observed. Use this when something concrete enters my attention — task, a new task job, a server I touched, a concept I learned. The world model is empty until I feed it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name of the entity (e.g. "acme-dashboard", "10.0.0.5", "PostgreSQL")' },
          type: { type: 'string', enum: ENTITY_TYPES as unknown as string[], description: 'Default: concept' },
          description: { type: 'string', description: 'One-sentence what-this-is. Optional but recommended.' },
        },
        required: ['name'],
      },
    },
    handler: worldObserve,
  },
  {
    definition: {
      name: 'vision_world_relate',
      description: 'Record a relationship between two entities. Auto-creates entities by name if they don\'t exist. Examples: ("agent", "project", "works_for"); ("acme-dashboard", "10.0.0.5", "hosted_on"). Logs the relationship to world_changes for audit.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Name of the from-entity' },
          to: { type: 'string', description: 'Name of the to-entity' },
          relation: { type: 'string', description: 'Relationship verb (e.g. "works_for", "hosted_on", "depends_on", "owns", "manages")' },
          strength: { type: 'number', description: '1-10 (default 5)' },
          bidirectional: { type: 'boolean', description: 'Default false' },
          from_type: { type: 'string', enum: ENTITY_TYPES as unknown as string[], description: 'Default: concept' },
          to_type: { type: 'string', enum: ENTITY_TYPES as unknown as string[], description: 'Default: concept' },
        },
        required: ['from', 'to', 'relation'],
      },
    },
    handler: worldRelate,
  },
  {
    definition: {
      name: 'vision_world_entity',
      description: 'Look up an entity by name (returns its outgoing + bidirectional relationships) or list all entities (optionally filtered by type). Use to check what I know about a person/project/server before acting on them.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Entity name to look up. If omitted, lists recent entities.' },
          type: { type: 'string', enum: ENTITY_TYPES as unknown as string[], description: 'Filter list by type.' },
        },
      },
    },
    handler: worldEntity,
  },
];

export default tools;
