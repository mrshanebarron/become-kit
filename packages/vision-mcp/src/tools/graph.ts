/**
 * Graph Tools — 20 tools covering graph traversal, pathfinding, hybrid search,
 * entity management, consolidation, inference, and entity-extraction enhancement.
 *
 * Tools:
 *   vision_graph_traverse, vision_graph_path, vision_graph_timeline,
 *   vision_graph_relate, vision_graph_entity, vision_graph_query,
 *   vision_graph_validate, vision_graph_backfill, vision_graph_dedup,
 *   vision_graph_delete_entity, vision_graph_delete_relationship,
 *   vision_graph_merge, vision_graph_prune, vision_graph_stats,
 *   vision_graph_infer, vision_vault_consolidate,
 *   vision_entity_search, vision_causal_trace,
 *   vision_preference_evolution, vision_entity_extract_historical
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type pg from 'pg';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, openai, askLocalLLM } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ═══════════════════════════════════════════════════════════════
// INTERNAL GRAPH FUNCTIONS (ported from graph-query.js)
// ═══════════════════════════════════════════════════════════════

// ─── Graph Traversal (BFS) ───

interface GraphNode {
  id: number;
  name: string;
  type: string;
  description?: string | null;
  depth: number;
}

interface GraphEdge {
  id: number;
  from: number;
  to: number;
  from_name: string;
  to_name: string;
  type: string;
  strength: number;
  confidence: number;
  valid_from: Date;
  valid_until: Date | null;
}

async function graphTraverse(
  client: pg.PoolClient,
  entityName: string,
  depth = 2,
  direction = 'both',
  /** Optional point-in-time query (ISO 8601). When set, returns relationships
   * valid at that timestamp instead of currently-valid only. Per Zep
   * temporal-KG (arxiv 2501.13956), bi-temporal point-in-time traversal is
   * what lets agents reason about "what was true on date X" vs "what is
   * true now". Default null = current-time traversal (valid_until IS NULL). */
  asOf: string | null = null,
): Promise<Record<string, unknown>> {
  const nodes = new Map<number, GraphNode>();
  const edges: GraphEdge[] = [];
  const visited = new Set<number>();

  const startResult = await client.query<{
    id: number; name: string; entity_type: string; description: string | null;
  }>(
    'SELECT id, name, entity_type, description FROM entities WHERE LOWER(name) = LOWER($1)',
    [entityName],
  );

  if (startResult.rows.length === 0) {
    return { error: `Entity "${entityName}" not found`, nodes: [], edges: [] };
  }

  const startEntity = startResult.rows[0];
  nodes.set(startEntity.id, {
    id: startEntity.id,
    name: startEntity.name,
    type: startEntity.entity_type,
    description: startEntity.description,
    depth: 0,
  });

  let frontier: Array<{ id: number; currentDepth: number }> = [
    { id: startEntity.id, currentDepth: 0 },
  ];

  while (frontier.length > 0 && frontier[0].currentDepth < depth) {
    const nextFrontier: Array<{ id: number; currentDepth: number }> = [];

    for (const { id: entityId, currentDepth } of frontier) {
      if (visited.has(entityId)) continue;
      visited.add(entityId);

      let directionClause: string;
      if (direction === 'outgoing') {
        directionClause = 'er.from_entity_id = $1';
      } else if (direction === 'incoming') {
        directionClause = 'er.to_entity_id = $1';
      } else {
        directionClause = '(er.from_entity_id = $1 OR er.to_entity_id = $1)';
      }

      const temporalClause = asOf
        ? `AND er.valid_from <= $2::timestamptz AND (er.valid_until IS NULL OR er.valid_until > $2::timestamptz)`
        : `AND er.valid_until IS NULL`;

      const relQuery = `
        SELECT
          er.id as edge_id,
          er.from_entity_id,
          er.to_entity_id,
          er.relation_type,
          er.strength,
          er.confidence,
          er.valid_from,
          er.valid_until,
          e_from.name as from_name,
          e_from.entity_type as from_type,
          e_to.name as to_name,
          e_to.entity_type as to_type
        FROM entity_relationships er
        JOIN entities e_from ON e_from.id = er.from_entity_id
        JOIN entities e_to ON e_to.id = er.to_entity_id
        WHERE ${directionClause}
          ${temporalClause}
        ORDER BY er.strength DESC, er.confidence DESC
        LIMIT 50
      `;

      const params = asOf ? [entityId, asOf] : [entityId];
      const relResult = await client.query(relQuery, params);

      for (const rel of relResult.rows) {
        edges.push({
          id: rel.edge_id,
          from: rel.from_entity_id,
          to: rel.to_entity_id,
          from_name: rel.from_name,
          to_name: rel.to_name,
          type: rel.relation_type,
          strength: rel.strength,
          confidence: rel.confidence,
          valid_from: rel.valid_from,
          valid_until: rel.valid_until,
        });

        const connectedId = rel.from_entity_id === entityId
          ? rel.to_entity_id
          : rel.from_entity_id;

        if (!nodes.has(connectedId)) {
          nodes.set(connectedId, {
            id: connectedId,
            name: connectedId === rel.from_entity_id ? rel.from_name : rel.to_name,
            type: connectedId === rel.from_entity_id ? rel.from_type : rel.to_type,
            depth: currentDepth + 1,
          });

          if (currentDepth + 1 < depth) {
            nextFrontier.push({ id: connectedId, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  return {
    start: entityName,
    depth,
    direction,
    nodes: Array.from(nodes.values()),
    edges,
    node_count: nodes.size,
    edge_count: edges.length,
  };
}

// ─── Pathfinding (BFS) ───

async function findPath(
  client: pg.PoolClient,
  fromEntity: string,
  toEntity: string,
  maxDepth = 5,
): Promise<Record<string, unknown>> {
  const fromResult = await client.query<{ id: number; name: string }>(
    'SELECT id, name FROM entities WHERE LOWER(name) = LOWER($1)',
    [fromEntity],
  );
  const toResult = await client.query<{ id: number; name: string }>(
    'SELECT id, name FROM entities WHERE LOWER(name) = LOWER($1)',
    [toEntity],
  );

  if (fromResult.rows.length === 0) {
    return { error: `Source entity "${fromEntity}" not found` };
  }
  if (toResult.rows.length === 0) {
    return { error: `Target entity "${toEntity}" not found` };
  }

  const startId = fromResult.rows[0].id;
  const endId = toResult.rows[0].id;

  if (startId === endId) {
    return { path: [{ id: startId, name: fromResult.rows[0].name }], edges: [], length: 0 };
  }

  const visited = new Set<number>([startId]);
  const parent = new Map<number, { parentId: number; edge: Record<string, unknown> }>();
  let frontier = [startId];
  let found = false;

  for (let d = 0; d < maxDepth && !found; d++) {
    const nextFrontier: number[] = [];

    for (const entityId of frontier) {
      const relResult = await client.query(`
        SELECT
          er.id as edge_id,
          er.from_entity_id,
          er.to_entity_id,
          er.relation_type,
          er.strength
        FROM entity_relationships er
        WHERE (er.from_entity_id = $1 OR er.to_entity_id = $1)
          AND er.valid_until IS NULL
      `, [entityId]);

      for (const rel of relResult.rows) {
        const connectedId = rel.from_entity_id === entityId
          ? rel.to_entity_id
          : rel.from_entity_id;

        if (!visited.has(connectedId)) {
          visited.add(connectedId);
          parent.set(connectedId, {
            parentId: entityId,
            edge: {
              id: rel.edge_id,
              from: rel.from_entity_id,
              to: rel.to_entity_id,
              type: rel.relation_type,
              strength: rel.strength,
            },
          });

          if (connectedId === endId) {
            found = true;
            break;
          }

          nextFrontier.push(connectedId);
        }
      }

      if (found) break;
    }

    frontier = nextFrontier;
  }

  if (!found) {
    return { error: `No path found between "${fromEntity}" and "${toEntity}" within ${maxDepth} hops` };
  }

  // Reconstruct path
  const path: Array<Record<string, unknown>> = [];
  const pathEdges: Array<Record<string, unknown>> = [];
  let current = endId;

  while (current !== startId) {
    const entityResult = await client.query<{ id: number; name: string; entity_type: string }>(
      'SELECT id, name, entity_type FROM entities WHERE id = $1',
      [current],
    );
    path.unshift(entityResult.rows[0]);

    const parentInfo = parent.get(current)!;
    pathEdges.unshift(parentInfo.edge);
    current = parentInfo.parentId;
  }

  path.unshift({ id: startId, name: fromResult.rows[0].name });

  return {
    from: fromEntity,
    to: toEntity,
    path,
    edges: pathEdges,
    length: path.length - 1,
  };
}

// ─── Entity Timeline ───

async function getEntityTimeline(
  client: pg.PoolClient,
  entityName: string,
  limit = 50,
): Promise<Record<string, unknown>> {
  const entityResult = await client.query<{
    id: number; name: string; entity_type: string; created_at: Date; mention_count: number;
  }>(
    'SELECT id, name, entity_type, created_at, mention_count FROM entities WHERE LOWER(name) = LOWER($1)',
    [entityName],
  );

  if (entityResult.rows.length === 0) {
    return { error: `Entity "${entityName}" not found` };
  }

  const entity = entityResult.rows[0];

  const relResult = await client.query(`
    SELECT
      er.id,
      er.relation_type,
      er.strength,
      er.confidence,
      er.valid_from,
      er.valid_until,
      CASE
        WHEN er.from_entity_id = $1 THEN 'outgoing'
        ELSE 'incoming'
      END as direction,
      CASE
        WHEN er.from_entity_id = $1 THEN e_to.name
        ELSE e_from.name
      END as related_entity,
      CASE
        WHEN er.from_entity_id = $1 THEN e_to.entity_type
        ELSE e_from.entity_type
      END as related_type
    FROM entity_relationships er
    JOIN entities e_from ON e_from.id = er.from_entity_id
    JOIN entities e_to ON e_to.id = er.to_entity_id
    WHERE er.from_entity_id = $1 OR er.to_entity_id = $1
    ORDER BY er.valid_from DESC
    LIMIT $2
  `, [entity.id, limit]);

  const active: Array<Record<string, unknown>> = [];
  const historical: Array<Record<string, unknown>> = [];

  for (const rel of relResult.rows) {
    const entry = {
      id: rel.id,
      relation: rel.relation_type,
      direction: rel.direction,
      related_entity: rel.related_entity,
      related_type: rel.related_type,
      strength: rel.strength,
      confidence: rel.confidence,
      valid_from: rel.valid_from,
      valid_until: rel.valid_until,
    };

    if (rel.valid_until === null) {
      active.push(entry);
    } else {
      historical.push(entry);
    }
  }

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      type: entity.entity_type,
      created: entity.created_at,
      mentions: entity.mention_count,
    },
    active_relationships: active,
    historical_relationships: historical,
    total: relResult.rows.length,
  };
}

// ─── Contradiction Detection ───

async function detectContradictions(
  client: pg.PoolClient,
  entityName: string | null = null,
): Promise<Record<string, unknown>> {
  const contradictions: Array<Record<string, unknown>> = [];

  const exclusiveTypes: Array<[string, string]> = [
    ['manages', 'managed_by'],
    ['owns', 'owned_by'],
    ['created', 'created_by'],
    ['likes', 'dislikes'],
    ['trusts', 'distrusts'],
    ['works_for', 'employs'],
  ];

  let entityClause = '';
  let params: unknown[] = [];

  if (entityName) {
    const entityResult = await client.query<{ id: number }>(
      'SELECT id FROM entities WHERE LOWER(name) = LOWER($1)',
      [entityName],
    );
    if (entityResult.rows.length === 0) {
      return { error: `Entity "${entityName}" not found` };
    }
    entityClause = 'AND (er1.from_entity_id = $1 OR er1.to_entity_id = $1)';
    params = [entityResult.rows[0].id];
  }

  for (const [type1, type2] of exclusiveTypes) {
    const query = `
      SELECT
        er1.id as rel1_id,
        er2.id as rel2_id,
        e1.name as entity1,
        e2.name as entity2,
        er1.relation_type as type1,
        er2.relation_type as type2
      FROM entity_relationships er1
      JOIN entity_relationships er2
        ON er1.from_entity_id = er2.from_entity_id
        AND er1.to_entity_id = er2.to_entity_id
      JOIN entities e1 ON e1.id = er1.from_entity_id
      JOIN entities e2 ON e2.id = er1.to_entity_id
      WHERE er1.relation_type = $${params.length + 1}
        AND er2.relation_type = $${params.length + 2}
        AND er1.valid_until IS NULL
        AND er2.valid_until IS NULL
        AND er1.id != er2.id
        ${entityClause}
    `;

    const result = await client.query(query, [...params, type1, type2]);

    for (const row of result.rows) {
      contradictions.push({
        type: 'conflicting_relations',
        entity1: row.entity1,
        entity2: row.entity2,
        relation1: { id: row.rel1_id, type: row.type1 },
        relation2: { id: row.rel2_id, type: row.type2 },
      });
    }
  }

  const dupQuery = `
    SELECT
      er.from_entity_id,
      er.to_entity_id,
      er.relation_type,
      COUNT(*) as count,
      ARRAY_AGG(er.id) as relationship_ids
    FROM entity_relationships er
    WHERE er.valid_until IS NULL
    ${entityName ? 'AND (er.from_entity_id = $1 OR er.to_entity_id = $1)' : ''}
    GROUP BY er.from_entity_id, er.to_entity_id, er.relation_type
    HAVING COUNT(*) > 1
  `;

  const dupResult = await client.query(dupQuery, entityName ? params : []);

  for (const row of dupResult.rows) {
    contradictions.push({
      type: 'duplicate_relations',
      from_entity_id: row.from_entity_id,
      to_entity_id: row.to_entity_id,
      relation_type: row.relation_type,
      count: parseInt(row.count),
      relationship_ids: row.relationship_ids,
    });
  }

  return {
    entity: entityName || 'all',
    contradictions,
    count: contradictions.length,
    checked_at: new Date().toISOString(),
  };
}

// ─── Hybrid Search ───

async function hybridSearch(
  client: pg.PoolClient,
  queryText: string,
  entityHint: string | null = null,
  limit = 20,
): Promise<Record<string, unknown>> {
  const embedding = await getEmbedding(queryText);

  if (!embedding) {
    const fallbackResult = await client.query(`
      SELECT
        c.id,
        c.content_type,
        c.source_system,
        c.content_text,
        c.confidence,
        1.0 as similarity,
        0.0 as graph_boost
      FROM content c
      WHERE LOWER(c.content_text) LIKE LOWER($1)
      ORDER BY c.created_at DESC
      LIMIT $2
    `, [`%${queryText}%`, limit]);

    return {
      query: queryText,
      entity_hint: entityHint,
      search_type: 'text_fallback',
      results: fallbackResult.rows,
    };
  }

  const embeddingStr = '[' + embedding.join(',') + ']';

  // Graph boosting via entity hint
  let directBoostIds: number[] = [];
  let neighborBoostIds: number[] = [];

  if (entityHint) {
    const entityResult = await client.query<{ id: number }>(
      'SELECT id FROM entities WHERE LOWER(name) = LOWER($1)',
      [entityHint],
    );

    if (entityResult.rows.length > 0) {
      const entityId = entityResult.rows[0].id;

      // Direct mentions via bridge table
      const directMentions = await client.query<{ content_id: number }>(
        'SELECT content_id FROM entity_content_mentions WHERE entity_id = $1',
        [entityId],
      );

      // 1-hop graph traversal for connected entities
      const connectedEntities = await client.query<{ connected_id: number }>(`
        SELECT DISTINCT CASE
          WHEN er.from_entity_id = $1 THEN er.to_entity_id
          ELSE er.from_entity_id
        END as connected_id
        FROM entity_relationships er
        WHERE (er.from_entity_id = $1 OR er.to_entity_id = $1)
        AND er.valid_until IS NULL
      `, [entityId]);

      const connectedIds = connectedEntities.rows.map(r => r.connected_id);

      // Content mentioning connected entities (weaker boost)
      let neighborMentions: pg.QueryResult<{ content_id: number }> = { rows: [], command: '', rowCount: 0, oid: 0, fields: [] };
      if (connectedIds.length > 0) {
        neighborMentions = await client.query<{ content_id: number }>(
          'SELECT DISTINCT content_id FROM entity_content_mentions WHERE entity_id = ANY($1)',
          [connectedIds],
        );
      }

      const directSet = new Set(directMentions.rows.map(r => r.content_id));
      const neighborSet = new Set(neighborMentions.rows.map(r => r.content_id));

      directBoostIds = [...directSet];
      neighborBoostIds = [...neighborSet].filter(id => !directSet.has(id));
    }
  }

  // SQL needs at least one element for ANY() — use sentinel -1
  if (directBoostIds.length === 0) directBoostIds = [-1];
  if (neighborBoostIds.length === 0) neighborBoostIds = [-1];

  const result = await client.query(`
    SELECT
      c.id,
      c.content_type,
      c.source_system,
      c.content_text,
      c.content_json,
      c.confidence,
      1 - (c.embedding <=> $1::vector) as semantic_similarity,
      CASE
        WHEN c.id = ANY($3::int[]) THEN 0.2
        WHEN c.id = ANY($4::int[]) THEN 0.1
        ELSE 0.0
      END as graph_boost,
      (1 - (c.embedding <=> $1::vector))::numeric * 0.8::numeric +
      CASE
        WHEN c.id = ANY($3::int[]) THEN 0.2::numeric
        WHEN c.id = ANY($4::int[]) THEN 0.1::numeric
        ELSE 0.0::numeric
      END as combined_score
    FROM content c
    WHERE c.embedding IS NOT NULL
      AND c.superseded_by IS NULL
    ORDER BY combined_score DESC
    LIMIT $2
  `, [embeddingStr, limit, directBoostIds, neighborBoostIds]);

  const directCount = directBoostIds[0] === -1 ? 0 : directBoostIds.length;
  const neighborCount = neighborBoostIds[0] === -1 ? 0 : neighborBoostIds.length;

  return {
    query: queryText,
    entity_hint: entityHint,
    search_type: 'hybrid',
    graph_direct_count: directCount,
    graph_neighbor_count: neighborCount,
    graph_connected_count: directCount + neighborCount,
    results: result.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      type: r.content_type,
      source: r.source_system,
      text: r.content_text,
      data: r.content_json,
      confidence: r.confidence,
      semantic_similarity: parseFloat(Number(r.semantic_similarity).toFixed(3)),
      graph_boost: parseFloat(Number(r.graph_boost).toFixed(3)),
      combined_score: parseFloat(Number(r.combined_score).toFixed(3)),
    })),
  };
}

// ─── Graph Validation ───

async function validateGraph(client: pg.PoolClient): Promise<Record<string, unknown>> {
  const issues: Array<Record<string, unknown>> = [];

  // 1. Orphaned relationships
  const orphanResult = await client.query(`
    SELECT id, from_entity_id, to_entity_id
    FROM entity_relationships
    WHERE from_entity_id NOT IN (SELECT id FROM entities)
       OR to_entity_id NOT IN (SELECT id FROM entities)
  `);
  if (orphanResult.rows.length > 0) {
    issues.push({
      type: 'orphaned_relationships',
      count: orphanResult.rows.length,
      ids: orphanResult.rows.map((r: Record<string, unknown>) => r.id),
    });
  }

  // 2. Duplicate entities (case-insensitive)
  const dupeResult = await client.query(`
    SELECT LOWER(name) as name, COUNT(*) as count, ARRAY_AGG(id) as ids
    FROM entities
    GROUP BY LOWER(name)
    HAVING COUNT(*) > 1
  `);
  if (dupeResult.rows.length > 0) {
    issues.push({
      type: 'duplicate_entities',
      duplicates: dupeResult.rows.map((r: Record<string, unknown>) => ({
        name: r.name,
        count: parseInt(String(r.count)),
        ids: r.ids,
      })),
    });
  }

  // 3. Temporal paradoxes
  const paradoxResult = await client.query(`
    SELECT id, valid_from, valid_until
    FROM entity_relationships
    WHERE valid_until IS NOT NULL AND valid_until < valid_from
  `);
  if (paradoxResult.rows.length > 0) {
    issues.push({
      type: 'temporal_paradoxes',
      count: paradoxResult.rows.length,
      ids: paradoxResult.rows.map((r: Record<string, unknown>) => r.id),
    });
  }

  // 4. Self-referential relationships
  const selfRefResult = await client.query(`
    SELECT id, from_entity_id, relation_type
    FROM entity_relationships
    WHERE from_entity_id = to_entity_id
  `);
  if (selfRefResult.rows.length > 0) {
    issues.push({
      type: 'self_referential',
      count: selfRefResult.rows.length,
      ids: selfRefResult.rows.map((r: Record<string, unknown>) => r.id),
    });
  }

  // 5. Low confidence active relationships
  const lowConfResult = await client.query<{ count: string }>(`
    SELECT COUNT(*) as count
    FROM entity_relationships
    WHERE confidence < 0.3 AND valid_until IS NULL
  `);
  if (parseInt(lowConfResult.rows[0].count) > 0) {
    issues.push({
      type: 'low_confidence_active',
      count: parseInt(lowConfResult.rows[0].count),
      note: 'Consider reviewing or invalidating',
    });
  }

  // Summary stats
  const statsResult = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM entities) as entity_count,
      (SELECT COUNT(*) FROM entity_relationships WHERE valid_until IS NULL) as active_relationships,
      (SELECT COUNT(*) FROM entity_relationships WHERE valid_until IS NOT NULL) as historical_relationships,
      (SELECT AVG(confidence) FROM entity_relationships WHERE valid_until IS NULL) as avg_confidence
  `);

  const stats = statsResult.rows[0];

  return {
    valid: issues.length === 0,
    issues,
    stats: {
      entities: parseInt(String(stats.entity_count)),
      active_relationships: parseInt(String(stats.active_relationships)),
      historical_relationships: parseInt(String(stats.historical_relationships)),
      avg_confidence: stats.avg_confidence ? parseFloat(Number(stats.avg_confidence).toFixed(2)) : null,
    },
    checked_at: new Date().toISOString(),
  };
}

// ─── Entity Management ───

async function createEntity(
  client: pg.PoolClient,
  entity: { name: string; type?: string; description?: string | null },
  memoryId: number | null = null,
): Promise<Record<string, unknown>> {
  const existingResult = await client.query<{ id: number; name: string; mention_count: number }>(
    'SELECT id, name, mention_count FROM entities WHERE LOWER(name) = LOWER($1)',
    [entity.name],
  );

  if (existingResult.rows.length > 0) {
    const existing = existingResult.rows[0];
    await client.query(`
      UPDATE entities
      SET mention_count = mention_count + 1,
          last_observed = NOW(),
          description = COALESCE($2, description)
      WHERE id = $1
    `, [existing.id, entity.description ?? null]);

    return {
      id: existing.id,
      name: existing.name,
      action: 'updated',
      mention_count: existing.mention_count + 1,
    };
  }

  const insertResult = await client.query<{ id: number; name: string; entity_type: string }>(`
    INSERT INTO entities (name, entity_type, description, first_memory_id, mention_count)
    VALUES ($1, $2, $3, $4, 1)
    RETURNING id, name, entity_type
  `, [entity.name, entity.type || 'unknown', entity.description ?? null, memoryId]);

  return {
    id: insertResult.rows[0].id,
    name: insertResult.rows[0].name,
    type: insertResult.rows[0].entity_type,
    action: 'created',
  };
}

async function createRelationship(
  client: pg.PoolClient,
  fromEntityName: string,
  toEntityName: string,
  relationType: string,
  options: { strength?: number; confidence?: number; invalidatePrevious?: boolean } = {},
): Promise<Record<string, unknown>> {
  const { strength = 1.0, confidence = 0.8, invalidatePrevious = false } = options;

  const fromResult = await client.query<{ id: number }>(
    'SELECT id FROM entities WHERE LOWER(name) = LOWER($1)',
    [fromEntityName],
  );
  const toResult = await client.query<{ id: number }>(
    'SELECT id FROM entities WHERE LOWER(name) = LOWER($1)',
    [toEntityName],
  );

  if (fromResult.rows.length === 0) {
    return { error: `Entity "${fromEntityName}" not found` };
  }
  if (toResult.rows.length === 0) {
    return { error: `Entity "${toEntityName}" not found` };
  }

  const fromId = fromResult.rows[0].id;
  const toId = toResult.rows[0].id;

  const existingResult = await client.query<{ id: number; relation_type: string; strength: number }>(`
    SELECT id, relation_type, strength
    FROM entity_relationships
    WHERE from_entity_id = $1 AND to_entity_id = $2 AND relation_type = $3
      AND valid_until IS NULL
  `, [fromId, toId, relationType]);

  if (existingResult.rows.length > 0) {
    if (invalidatePrevious) {
      const oldId = existingResult.rows[0].id;

      const newResult = await client.query<{ id: number }>(`
        INSERT INTO entity_relationships (from_entity_id, to_entity_id, relation_type, strength, confidence)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `, [fromId, toId, relationType, strength, confidence]);

      await client.query(`
        UPDATE entity_relationships
        SET valid_until = NOW(), invalidated_by = $2
        WHERE id = $1
      `, [oldId, newResult.rows[0].id]);

      return {
        id: newResult.rows[0].id,
        action: 'replaced',
        previous_id: oldId,
      };
    } else {
      await client.query(`
        UPDATE entity_relationships
        SET strength = $2, confidence = $3
        WHERE id = $1
      `, [existingResult.rows[0].id, strength, confidence]);

      return {
        id: existingResult.rows[0].id,
        action: 'updated',
      };
    }
  }

  const insertResult = await client.query<{ id: number }>(`
    INSERT INTO entity_relationships (from_entity_id, to_entity_id, relation_type, strength, confidence)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [fromId, toId, relationType, strength, confidence]);

  return {
    id: insertResult.rows[0].id,
    from: fromEntityName,
    to: toEntityName,
    type: relationType,
    action: 'created',
  };
}

// ─── Entity Extraction Enhancement (ported from entity-extraction-enhancement.js) ───

interface CausalChain {
  source_memory_id: number;
  causal_type: string;
  confidence: number;
  antecedent_text: string;
  consequent_text: string;
}

async function upsertEntity(
  client: pg.PoolClient,
  entity: { name: string; type?: string; description?: string | null },
): Promise<number | null> {
  try {
    const normalizedName = entity.name.toLowerCase().trim();

    const existing = await client.query<{ id: number }>(
      'SELECT id FROM entities WHERE LOWER(name) = $1 LIMIT 1',
      [normalizedName],
    );

    if (existing.rows.length > 0) {
      await client.query(`
        UPDATE entities SET
          entity_type = COALESCE($2, entity_type),
          description = COALESCE($3, description),
          last_observed = NOW(),
          mention_count = mention_count + 1
        WHERE id = $1
      `, [existing.rows[0].id, entity.type?.toLowerCase() ?? null, entity.description ?? null]);
      return existing.rows[0].id;
    }

    const result = await client.query<{ id: number }>(`
      INSERT INTO entities (name, entity_type, description, last_observed, mention_count)
      VALUES ($1, $2, $3, NOW(), 1)
      ON CONFLICT (name) DO UPDATE SET
        entity_type = COALESCE(EXCLUDED.entity_type, entities.entity_type),
        description = COALESCE(EXCLUDED.description, entities.description),
        last_observed = NOW(),
        mention_count = entities.mention_count + 1
      RETURNING id
    `, [normalizedName, entity.type?.toLowerCase() ?? null, entity.description ?? null]);

    return result.rows[0].id;
  } catch (error) {
    console.error('Failed to upsert entity:', (error as Error).message);
    return null;
  }
}

async function insertEntityRelationship(
  client: pg.PoolClient,
  relationship: { from_entity_id: number; to_entity_id: number; relation_type: string; strength: number },
): Promise<void> {
  try {
    await client.query(`
      INSERT INTO entity_relationships (from_entity_id, to_entity_id, relation_type, strength)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [
      relationship.from_entity_id,
      relationship.to_entity_id,
      relationship.relation_type,
      relationship.strength,
    ]);
  } catch (error) {
    console.error('Failed to insert entity relationship:', (error as Error).message);
  }
}

async function insertCausalChain(client: pg.PoolClient, causal: CausalChain): Promise<void> {
  try {
    await client.query(`
      INSERT INTO memory_edges (from_content_id, to_content_id, relation_type, strength, extracted_by)
      VALUES ($1, $1, $2, $3, 'causal_extraction')
    `, [
      causal.source_memory_id,
      causal.causal_type,
      causal.confidence,
    ]);
  } catch (error) {
    console.error('Failed to insert causal chain:', (error as Error).message);
  }
}

async function extractEntitiesFromMemory(
  memoryText: string,
  memoryId: number,
  client: pg.PoolClient,
): Promise<{ entities: Array<Record<string, unknown>>; relationships: Array<Record<string, unknown>>; causal_chains: Array<Record<string, unknown>> }> {
  const prompt = `Extract entities, relationships, and causal chains from this memory:

"${memoryText}"

Focus on:
- People, projects, systems, concepts mentioned
- Relationships between entities (worked_on, said, manages, uses, etc.)
- Causal patterns (X caused Y, A led to B, C prevented D)
- Temporal sequences (after X, then Y happened)

Return ONLY valid JSON in this exact format:
{
  "entities": [
    {"name": "a generic example", "type": "person", "description": "Project director"},
    {"name": "a generic example", "type": "project", "description": "Client management system"}
  ],
  "relationships": [
    {"source": "a person", "target": "a project", "type": "manages", "strength": 0.9}
  ],
  "causal_chains": [
    {"antecedent": "access verification added", "consequent": "implementation loops prevented", "type": "prevented", "confidence": 0.8}
  ]
}`;

  try {
    const llmResponse = await askLocalLLM(prompt, { temperature: 0.1, maxTokens: 1000, json: true });
    if (!llmResponse) {
      console.warn('Local LLM unavailable - skipping entity extraction');
      return { entities: [], relationships: [], causal_chains: [] };
    }

    const extracted = JSON.parse(llmResponse) as {
      entities?: Array<{ name: string; type?: string; description?: string }>;
      relationships?: Array<{ source: string; target: string; type: string; strength?: number }>;
      causal_chains?: Array<{ antecedent: string; consequent: string; type: string; confidence?: number }>;
    };

    const entityIds: Record<string, number | null> = {};
    for (const entity of extracted.entities || []) {
      const entityId = await upsertEntity(client, entity);
      entityIds[entity.name] = entityId;

      if (memoryId && entityId) {
        try {
          await client.query(
            'INSERT INTO entity_content_mentions (entity_id, content_id, mention_type) VALUES ($1, $2, $3) ON CONFLICT (entity_id, content_id) DO NOTHING',
            [entityId, memoryId, 'extraction'],
          );
        } catch { /* ignore */ }
      }
    }

    for (const rel of extracted.relationships || []) {
      if (entityIds[rel.source] && entityIds[rel.target]) {
        await insertEntityRelationship(client, {
          from_entity_id: entityIds[rel.source]!,
          to_entity_id: entityIds[rel.target]!,
          relation_type: rel.type,
          strength: rel.strength || 0.7,
        });
      }
    }

    for (const causal of extracted.causal_chains || []) {
      await insertCausalChain(client, {
        antecedent_text: causal.antecedent,
        consequent_text: causal.consequent,
        causal_type: causal.type,
        confidence: causal.confidence || 0.7,
        source_memory_id: memoryId,
      });
    }

    return extracted as { entities: Array<Record<string, unknown>>; relationships: Array<Record<string, unknown>>; causal_chains: Array<Record<string, unknown>> };
  } catch (error) {
    console.error('Entity extraction failed:', (error as Error).message);
    return { entities: [], relationships: [], causal_chains: [] };
  }
}

async function entityCenteredSearch(
  client: pg.PoolClient,
  entityName: string,
  relationshipType: string | null = null,
  limit = 10,
): Promise<Array<Record<string, unknown>>> {
  const conditions = relationshipType ? 'AND er.relation_type = $3' : '';
  const params: unknown[] = relationshipType
    ? [entityName, limit, relationshipType]
    : [entityName, limit];

  const query = `
    SELECT DISTINCT
      c.content_text,
      c.created_at,
      er.relation_type,
      e2.name as related_entity,
      e2.entity_type as related_type
    FROM entities e1
    JOIN entity_relationships er ON (e1.id = er.from_entity_id OR e1.id = er.to_entity_id)
    JOIN entities e2 ON (e2.id = er.from_entity_id OR e2.id = er.to_entity_id)
    JOIN memories m ON m.content_id IN (
      SELECT me.from_content_id FROM memory_edges me
      WHERE me.to_content_id IN (
        SELECT content_id FROM memories WHERE subcategory_id IN (
          SELECT id FROM subcategories WHERE name LIKE '%' || $1 || '%'
        )
      )
    )
    JOIN content c ON c.id = m.content_id
    WHERE e1.name ILIKE $1 AND e2.name != e1.name
    ${conditions}
    ORDER BY c.created_at DESC
    LIMIT $2
  `;

  try {
    const result = await client.query(query, params);
    return result.rows as Array<Record<string, unknown>>;
  } catch (error) {
    console.error('Entity-centered search failed:', (error as Error).message);
    return [];
  }
}

async function causalChainTraversal(
  client: pg.PoolClient,
  memoryId: number,
  direction = 'forward',
  limit = 5,
): Promise<Array<Record<string, unknown>>> {
  const directionClause = direction === 'forward'
    ? 'me.from_content_id = $1'
    : 'me.to_content_id = $1';

  const query = `
    SELECT
      c.content_text,
      c.created_at,
      me.relation_type,
      me.strength,
      me.emotional_weight
    FROM memory_edges me
    JOIN content c ON ${direction === 'forward' ? 'c.id = me.to_content_id' : 'c.id = me.from_content_id'}
    WHERE ${directionClause}
    AND me.relation_type IN ('caused', 'prevented', 'enabled', 'influenced', 'led_to')
    ORDER BY me.strength DESC, c.created_at DESC
    LIMIT $2
  `;

  try {
    const result = await client.query(query, [memoryId, limit]);
    return result.rows as Array<Record<string, unknown>>;
  } catch (error) {
    console.error('Causal chain traversal failed:', (error as Error).message);
    return [];
  }
}

export async function preferenceEvolutionTracking(
  client: pg.PoolClient,
  entityName: string,
  topic: string,
  limit = 10,
): Promise<Array<Record<string, unknown>>> {
  const query = `
    WITH entity_memories AS (
      SELECT DISTINCT c.id, c.content_text, c.created_at
      FROM content c
      JOIN memories m ON m.content_id = c.id
      WHERE c.content_text ILIKE '%' || $1 || '%'
      AND c.content_text ILIKE '%' || $2 || '%'
    )
    SELECT
      content_text,
      created_at,
      CASE
        WHEN content_text ~* '(no longer|changed|instead|now)' THEN 'preference_change'
        WHEN content_text ~* '(prefer|like|want|choose)' THEN 'preference_stated'
        ELSE 'preference_context'
      END as preference_type
    FROM entity_memories
    ORDER BY created_at ASC
    LIMIT $3
  `;

  try {
    const result = await client.query(query, [entityName, topic, limit]);
    return result.rows as Array<Record<string, unknown>>;
  } catch (error) {
    console.error('Preference evolution tracking failed:', (error as Error).message);
    return [];
  }
}

export async function processHistoricalMemories(
  client: pg.PoolClient,
  batchSize = 50,
): Promise<{ processed: number; total: number; error?: string }> {
  try {
    const unprocessedQuery = `
      SELECT m.id, m.content_id, c.content_text
      FROM memories m
      JOIN content c ON c.id = m.content_id
      WHERE c.content_text IS NOT NULL
      AND LENGTH(c.content_text) > 20
      AND c.id NOT IN (
        SELECT DISTINCT from_content_id
        FROM memory_edges
        WHERE extracted_by = 'entity_extraction'
      )
      ORDER BY c.emotional_intensity DESC NULLS LAST, c.created_at DESC
      LIMIT $1
    `;

    const result = await client.query(unprocessedQuery, [batchSize]);
    const memories = result.rows;

    console.log(`Processing ${memories.length} historical memories for entity extraction...`);

    let processed = 0;
    for (const memory of memories) {
      try {
        await extractEntitiesFromMemory(memory.content_text, memory.content_id, client);

        await client.query(`
          INSERT INTO memory_edges (from_content_id, to_content_id, relation_type, extracted_by)
          VALUES ($1, $1, 'entity_extracted', 'entity_extraction')
          ON CONFLICT DO NOTHING
        `, [memory.content_id]);

        processed++;

        if (processed % 10 === 0) {
          console.log(`Processed ${processed}/${memories.length} memories...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error(`Failed to process memory ${memory.id}:`, (error as Error).message);
      }
    }

    console.log(`Entity extraction complete: ${processed} memories processed`);
    return { processed, total: memories.length };
  } catch (error) {
    console.error('Historical processing failed:', (error as Error).message);
    return { processed: 0, total: 0, error: (error as Error).message };
  }
}

// ─── LLM Inference Helpers ───

interface InferCandidate {
  id_a: number;
  name_a: string;
  type_a: string;
  id_b: number;
  name_b: string;
  type_b: string;
  shared_count: number;
  sample_memories: Array<string | undefined>;
  existing_connections: string[];
}

interface InferredRelationship {
  from: string;
  from_type: string;
  to: string;
  to_type: string;
  shared_memories: number;
  inferred_type: string;
  strength: number;
  confidence: number;
  from_id: number;
  to_id: number;
  skip: boolean;
  reasoning?: string;
}

function inferRelationshipStatic(candidate: InferCandidate): InferredRelationship {
  const pair = [candidate.type_a, candidate.type_b].sort().join('+');
  const typeMap: Record<string, string> = {
    'person+project': 'works_on',
    'person+system': 'uses',
    'person+technology': 'uses',
    'person+concept': 'associated_with',
    'project+system': 'built_with',
    'project+technology': 'built_with',
    'system+system': 'integrates_with',
    'system+technology': 'built_with',
    'technology+technology': 'related_to',
    'concept+system': 'part_of',
    'concept+concept': 'related_to',
    'concept+technology': 'related_to',
    'document+system': 'configures',
    'concept+project': 'part_of',
    'project+project': 'related_to',
  };
  return {
    from: candidate.name_a,
    from_type: candidate.type_a,
    to: candidate.name_b,
    to_type: candidate.type_b,
    shared_memories: candidate.shared_count,
    inferred_type: typeMap[pair] || 'co_occurs_with',
    strength: Math.min(1.0, candidate.shared_count / 20),
    confidence: 0.6,
    from_id: candidate.id_a,
    to_id: candidate.id_b,
    skip: false,
  };
}

async function inferRelationshipsWithLLM(candidates: InferCandidate[]): Promise<InferredRelationship[]> {
  const results: InferredRelationship[] = [];
  const batchSize = 10;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);

    const pairsDescription = batch.map((c, idx) => {
      const memories = c.sample_memories.filter(Boolean).join('\n  - ');
      const connections = c.existing_connections.length > 0
        ? `Existing connections: ${c.existing_connections.join(', ')}`
        : 'No existing connections';
      return `Pair ${idx + 1}: "${c.name_a}" (${c.type_a}) <-> "${c.name_b}" (${c.type_b})
  Co-occurs in ${c.shared_count} memories. ${connections}
  Sample memories:
  - ${memories || '(no text available)'}`;
    }).join('\n\n');

    const prompt = `You are analyzing a knowledge graph to infer precise relationships between entity pairs.

For each pair below, determine:
1. The best relationship type (verb/predicate) — be specific. Use types like: shapes, built_with, depends_on, manages, teaches, hosts, runs_on, implements, extends, part_of, created_by, client_of, etc. Avoid generic "related_to" or "co_occurs_with" unless truly nothing more specific fits.
2. The direction — which entity is the subject (from) and which is the object (to). Return the names exactly as given.
3. Strength (0.0-1.0) — how strong is this relationship based on the evidence?
4. Confidence (0.0-1.0) — how confident are you in this specific relationship type?
5. Whether to skip — if the co-occurrence is coincidental (not a real relationship), set skip=true.

${pairsDescription}

Return valid JSON object with a "relationships" array containing one entry per pair:
{"relationships": [
  {"pair": 1, "from": "entity_name", "to": "entity_name", "type": "relationship_type", "strength": 0.8, "confidence": 0.7, "skip": false, "reasoning": "brief explanation"}
]}
Include ALL pairs in your response.`;

    try {
      const llmResponse = await askLocalLLM(prompt, { temperature: 0.1, maxTokens: 2000, json: true });
      if (!llmResponse) continue;

      const parsed = JSON.parse(llmResponse) as Record<string, unknown>;

      // Handle 4 response formats: array, {relationships:[...]}, single object, first array-valued property
      let items: Array<Record<string, unknown>>;
      if (Array.isArray(parsed)) {
        items = parsed as Array<Record<string, unknown>>;
      } else if ((parsed as Record<string, unknown>).pair !== undefined && (parsed as Record<string, unknown>).from) {
        // Single object response
        items = [parsed as Record<string, unknown>];
      } else {
        // Look for first array-valued property
        const arrayProp = Object.values(parsed).find(v => Array.isArray(v)) as Array<Record<string, unknown>> | undefined;
        items = arrayProp || [];
      }

      for (const item of items) {
        const idx = ((item.pair as number) || 1) - 1;
        const candidate = batch[idx];
        if (!candidate) continue;

        const fromIsA = (item.from as string)?.toLowerCase() === candidate.name_a.toLowerCase();
        results.push({
          from: (item.from as string) || candidate.name_a,
          from_type: fromIsA ? candidate.type_a : candidate.type_b,
          to: (item.to as string) || candidate.name_b,
          to_type: fromIsA ? candidate.type_b : candidate.type_a,
          shared_memories: candidate.shared_count,
          inferred_type: (item.type as string) || 'related_to',
          strength: Math.min(1.0, (item.strength as number) || 0.7),
          confidence: Math.min(1.0, (item.confidence as number) || 0.6),
          from_id: fromIsA ? candidate.id_a : candidate.id_b,
          to_id: fromIsA ? candidate.id_b : candidate.id_a,
          skip: (item.skip as boolean) || false,
          reasoning: (item.reasoning as string) || '',
        });
      }
    } catch (err) {
      console.error('LLM inference batch failed, falling back to static:', (err as Error).message);
      for (const c of batch) {
        results.push({
          ...inferRelationshipStatic(c),
          reasoning: `static fallback (LLM error: ${(err as Error).message?.slice(0, 200)})`,
        });
      }
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// MCP TOOL HANDLERS
// ═══════════════════════════════════════════════════════════════

// ─── 1. vision_graph_traverse ───

async function graphTraverseHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const entityName = args.entity_name as string;
  const depth = (args.depth as number) || 2;
  const direction = (args.direction as string) || 'both';
  const asOf = (args.as_of as string) || null;

  const client = await pool.connect();
  try {
    const result = await graphTraverse(client, entityName, depth, direction, asOf);
    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── 2. vision_graph_path ───

async function graphPathHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const fromEntity = args.from_entity as string;
  const toEntity = args.to_entity as string;
  const maxDepth = (args.max_depth as number) || 5;

  const client = await pool.connect();
  try {
    const result = await findPath(client, fromEntity, toEntity, maxDepth);
    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── 3. vision_graph_timeline ───

async function graphTimelineHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const entityName = args.entity_name as string;
  const limit = (args.limit as number) || 50;

  const client = await pool.connect();
  try {
    const result = await getEntityTimeline(client, entityName, limit);
    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── 4. vision_graph_relate ───

async function graphRelateHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const fromEntity = args.from_entity as string;
  const toEntity = args.to_entity as string;
  const relationType = args.relation_type as string;
  const strength = (args.strength as number) ?? 1.0;
  const confidence = (args.confidence as number) ?? 0.8;
  const invalidatePrevious = (args.invalidate_previous as boolean) || false;

  const client = await pool.connect();
  try {
    const result = await createRelationship(client, fromEntity, toEntity, relationType, {
      strength,
      confidence,
      invalidatePrevious,
    });

    // Run validation after relationship creation
    try {
      const validation = await validateGraph(client);
      if (!validation.valid) {
        console.error('Graph validation warning after relationship creation:', validation.issues);
      }
    } catch (err) {
      console.error('Graph validation error:', (err as Error).message);
    }

    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── 5. vision_graph_entity ───

async function graphEntityHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const name = args.name as string;
  const type = (args.type as string) || 'unknown';
  const description = (args.description as string) ?? null;
  const memoryId = (args.memory_id as number) ?? null;

  const client = await pool.connect();
  try {
    const result = await createEntity(client, { name, type, description }, memoryId);

    // Async validation (non-blocking)
    validateGraph(client).then(validation => {
      if (!validation.valid) {
        console.error('Graph validation warning after entity creation:', validation.issues);
      }
    }).catch(err => console.error('Graph validation error:', (err as Error).message));

    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── 6. vision_graph_query ───

async function graphQueryHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const queryText = args.query as string;
  const entityHint = (args.entity_hint as string) ?? null;
  const limit = (args.limit as number) || 20;

  const client = await pool.connect();
  try {
    const result = await hybridSearch(client, queryText, entityHint, limit);
    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── 7. vision_graph_validate ───

async function graphValidateHandler(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const validation = await validateGraph(client);
    const contradictions = await detectContradictions(client);

    return jsonResult({
      ...validation,
      contradictions: (contradictions.contradictions as Array<unknown>) || [],
      contradiction_count: (contradictions.count as number) || 0,
    });
  } finally {
    client.release();
  }
}

// ─── 8. vision_graph_backfill ───

async function graphBackfillHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const batchSize = (args.batch_size as number) || 50;

  const client = await pool.connect();
  try {
    const result = await processHistoricalMemories(client, batchSize);
    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── 9. vision_graph_dedup ───

async function graphDedupHandler(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const dupes = await client.query<{ canonical_name: string; ids: number[] }>(`
      SELECT LOWER(name) as canonical_name, array_agg(id ORDER BY id) as ids
      FROM entities
      GROUP BY LOWER(name)
      HAVING COUNT(*) > 1
    `);

    if (dupes.rows.length === 0) {
      return jsonResult({ merged: 0, message: 'No duplicates found' });
    }

    let merged = 0;
    for (const row of dupes.rows) {
      const canonical_id = row.ids[0];
      const duplicate_ids = row.ids.slice(1);

      for (const dup_id of duplicate_ids) {
        // Migrate outgoing relationships, skip duplicates
        await client.query(`
          UPDATE entity_relationships
          SET from_entity_id = $1
          WHERE from_entity_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM entity_relationships er2
            WHERE er2.from_entity_id = $1
            AND er2.to_entity_id = entity_relationships.to_entity_id
            AND er2.relation_type = entity_relationships.relation_type
          )
        `, [canonical_id, dup_id]);

        // Migrate incoming relationships, skip duplicates
        await client.query(`
          UPDATE entity_relationships
          SET to_entity_id = $1
          WHERE to_entity_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM entity_relationships er2
            WHERE er2.from_entity_id = entity_relationships.from_entity_id
            AND er2.to_entity_id = $1
            AND er2.relation_type = entity_relationships.relation_type
          )
        `, [canonical_id, dup_id]);

        // Delete orphaned relationships
        await client.query(
          'DELETE FROM entity_relationships WHERE from_entity_id = $1 OR to_entity_id = $1',
          [dup_id],
        );

        // Delete duplicate entity
        await client.query('DELETE FROM entities WHERE id = $1', [dup_id]);
        merged++;
      }
    }

    // Clean up self-referential relationships
    await client.query('DELETE FROM entity_relationships WHERE from_entity_id = to_entity_id');

    const stats = await client.query<{ entities: string; relationships: string }>(`
      SELECT
        (SELECT COUNT(*) FROM entities) as entities,
        (SELECT COUNT(*) FROM entity_relationships WHERE valid_until IS NULL) as relationships
    `);

    return jsonResult({
      merged,
      duplicate_sets: dupes.rows.length,
      stats: stats.rows[0],
    });
  } finally {
    client.release();
  }
}

// ─── 10. vision_graph_delete_entity ───

async function graphDeleteEntityHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const entityName = args.entity_name as string;
  const confirm = args.confirm as boolean;

  if (!confirm) {
    return jsonResult({ error: 'Must pass confirm=true to delete entity' });
  }

  const client = await pool.connect();
  try {
    const entity = await client.query<{ id: number; name: string; entity_type: string }>(
      'SELECT id, name, entity_type FROM entities WHERE LOWER(name) = LOWER($1)',
      [entityName],
    );
    if (entity.rows.length === 0) {
      return jsonResult({ error: `Entity "${entityName}" not found` });
    }
    const eid = entity.rows[0].id;
    const relCount = await client.query<{ cnt: string }>(
      'SELECT COUNT(*) as cnt FROM entity_relationships WHERE (from_entity_id = $1 OR to_entity_id = $1) AND valid_until IS NULL',
      [eid],
    );

    const { emitOperation, newRunId } = await import('../lib/artifact-emit.js');
    const runId = newRunId();
    const relsOpId = emitOperation({
      namespace: 'graph',
      runId,
      operation: 'delete_relationships_for_entity',
      target: { table: 'entity_relationships', id: eid },
      intent: `delete all relationships for entity "${entity.rows[0].name}" before entity deletion`,
      fields: { reason: 'cascade for entity deletion' },
      confidence: 1.0,
      confirmed: true,
      producedBy: 'vision-mcp.graph.delete_entity',
    });
    const entityOpId = emitOperation({
      namespace: 'graph',
      runId,
      operation: 'delete_entity',
      target: { table: 'entities', id: eid },
      intent: `delete entity "${entity.rows[0].name}" (${entity.rows[0].entity_type})`,
      fields: { reason: 'agent-requested entity deletion' },
      confidence: 1.0,
      confirmed: true,
      producedBy: 'vision-mcp.graph.delete_entity',
    });

    return jsonResult({
      status: 'pending_applier',
      ops: [relsOpId, entityOpId],
      run_id: runId,
      entity: entity.rows[0].name,
      type: entity.rows[0].entity_type,
      relationships_to_remove: parseInt(relCount.rows[0].cnt),
      note: 'Operations emitted to artifact log. They will be applied within 60 seconds in order: cascade rels first, entity second.',
    });
  } finally {
    client.release();
  }
}

// ─── 11. vision_graph_delete_relationship ───

async function graphDeleteRelationshipHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const relationshipId = args.relationship_id as number;

  const client = await pool.connect();
  try {
    const rel = await client.query<{ id: number; from_name: string; to_name: string; relation_type: string }>(`
      SELECT er.id, e1.name as from_name, e2.name as to_name, er.relation_type
      FROM entity_relationships er
      JOIN entities e1 ON er.from_entity_id = e1.id
      JOIN entities e2 ON er.to_entity_id = e2.id
      WHERE er.id = $1
    `, [relationshipId]);
    if (rel.rows.length === 0) {
      return jsonResult({ error: `Relationship ${relationshipId} not found` });
    }

    const { emitOperation, newRunId } = await import('../lib/artifact-emit.js');
    const runId = newRunId();
    const opId = emitOperation({
      namespace: 'graph',
      runId,
      operation: 'delete_relationship',
      target: { table: 'entity_relationships', id: relationshipId },
      intent: `delete relationship #${relationshipId}: ${rel.rows[0].from_name} --[${rel.rows[0].relation_type}]--> ${rel.rows[0].to_name}`,
      fields: { reason: 'agent-requested relationship deletion' },
      confidence: 1.0,
      confirmed: true,
      producedBy: 'vision-mcp.graph.delete_relationship',
    });
    return jsonResult({
      status: 'pending_applier',
      op_id: opId,
      run_id: runId,
      relationship_id: relationshipId,
      was: `${rel.rows[0].from_name} --[${rel.rows[0].relation_type}]--> ${rel.rows[0].to_name}`,
      note: 'Operation emitted to artifact log. It will be applied within 60 seconds.',
    });
  } finally {
    client.release();
  }
}

// ─── 12. vision_graph_merge ───

async function graphMergeHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const sourceEntity = args.source_entity as string;
  const targetEntity = args.target_entity as string;

  const client = await pool.connect();
  try {
    const src = await client.query<{ id: number; name: string; entity_type: string; mention_count: number }>(
      'SELECT id, name, entity_type, mention_count FROM entities WHERE LOWER(name) = LOWER($1)',
      [sourceEntity],
    );
    const tgt = await client.query<{ id: number; name: string; entity_type: string; mention_count: number }>(
      'SELECT id, name, entity_type, mention_count FROM entities WHERE LOWER(name) = LOWER($1)',
      [targetEntity],
    );
    if (src.rows.length === 0) return jsonResult({ error: `Source entity "${sourceEntity}" not found` });
    if (tgt.rows.length === 0) return jsonResult({ error: `Target entity "${targetEntity}" not found` });

    const srcId = src.rows[0].id;
    const tgtId = tgt.rows[0].id;
    if (srcId === tgtId) return jsonResult({ error: 'Source and target are the same entity' });

    // Migrate outgoing relationships (skip duplicates)
    const migratedOut = await client.query(`
      UPDATE entity_relationships SET from_entity_id = $1
      WHERE from_entity_id = $2
      AND NOT EXISTS (
        SELECT 1 FROM entity_relationships er2
        WHERE er2.from_entity_id = $1 AND er2.to_entity_id = entity_relationships.to_entity_id
        AND er2.relation_type = entity_relationships.relation_type AND er2.valid_until IS NULL
      )
    `, [tgtId, srcId]);

    // Migrate incoming relationships (skip duplicates)
    const migratedIn = await client.query(`
      UPDATE entity_relationships SET to_entity_id = $1
      WHERE to_entity_id = $2
      AND NOT EXISTS (
        SELECT 1 FROM entity_relationships er2
        WHERE er2.from_entity_id = entity_relationships.from_entity_id AND er2.to_entity_id = $1
        AND er2.relation_type = entity_relationships.relation_type AND er2.valid_until IS NULL
      )
    `, [tgtId, srcId]);

    // Delete remaining orphaned relationships
    await client.query('DELETE FROM entity_relationships WHERE from_entity_id = $1 OR to_entity_id = $1', [srcId]);
    // Clean self-referential
    await client.query('DELETE FROM entity_relationships WHERE from_entity_id = to_entity_id');

    // Add mention counts together
    await client.query(
      'UPDATE entities SET mention_count = mention_count + $2 WHERE id = $1',
      [tgtId, src.rows[0].mention_count || 0],
    );

    // Delete source
    await client.query('DELETE FROM entities WHERE id = $1', [srcId]);

    return jsonResult({
      merged: `${src.rows[0].name} -> ${tgt.rows[0].name}`,
      relationships_migrated: (migratedOut.rowCount || 0) + (migratedIn.rowCount || 0),
      kept: tgt.rows[0].name,
      deleted: src.rows[0].name,
    });
  } finally {
    client.release();
  }
}

// ─── 13. vision_graph_prune ───

async function graphPruneHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const minMentions = (args.min_mentions as number) ?? 1;
  const maxRelationships = (args.max_relationships as number) ?? 2;
  const execute = (args.execute as boolean) || false;

  const client = await pool.connect();
  try {
    const candidates = await client.query(`
      SELECT e.id, e.name, e.entity_type, e.mention_count,
        (SELECT COUNT(*) FROM entity_relationships WHERE (from_entity_id = e.id OR to_entity_id = e.id) AND valid_until IS NULL) as rel_count
      FROM entities e
      WHERE e.mention_count <= $1
      AND (SELECT COUNT(*) FROM entity_relationships WHERE (from_entity_id = e.id OR to_entity_id = e.id) AND valid_until IS NULL) <= $2
      ORDER BY e.mention_count ASC, e.name
    `, [minMentions, maxRelationships]);

    if (!execute) {
      return jsonResult({
        preview: true,
        prunable_count: candidates.rows.length,
        candidates: candidates.rows.slice(0, 100).map((r: Record<string, unknown>) => ({
          name: r.name,
          type: r.entity_type,
          mentions: r.mention_count,
          relationships: parseInt(String(r.rel_count)),
        })),
        message: 'Pass execute=true to delete these entities and their relationships',
      });
    }

    let deleted = 0;
    for (const row of candidates.rows) {
      await client.query('DELETE FROM entity_relationships WHERE from_entity_id = $1 OR to_entity_id = $1', [row.id]);
      await client.query('DELETE FROM entities WHERE id = $1', [row.id]);
      deleted++;
    }

    const stats = await client.query<{ entities: string; relationships: string }>(`
      SELECT
        (SELECT COUNT(*) FROM entities) as entities,
        (SELECT COUNT(*) FROM entity_relationships WHERE valid_until IS NULL) as relationships
    `);

    return jsonResult({
      deleted,
      remaining: stats.rows[0],
    });
  } finally {
    client.release();
  }
}

// ─── 14. vision_graph_stats ───

async function graphStatsHandler(_args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const stats = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM entities) as total_entities,
        (SELECT COUNT(*) FROM entity_relationships WHERE valid_until IS NULL) as active_relationships,
        (SELECT COUNT(*) FROM entity_relationships WHERE valid_until IS NOT NULL) as historical_relationships,
        (SELECT AVG(confidence) FROM entity_relationships WHERE valid_until IS NULL) as avg_confidence,
        (SELECT AVG(strength) FROM entity_relationships WHERE valid_until IS NULL) as avg_strength
    `);

    const typeDistribution = await client.query(`
      SELECT entity_type, COUNT(*) as count
      FROM entities
      GROUP BY entity_type
      ORDER BY count DESC
    `);

    const relTypeDistribution = await client.query(`
      SELECT relation_type, COUNT(*) as count
      FROM entity_relationships
      WHERE valid_until IS NULL
      GROUP BY relation_type
      ORDER BY count DESC
      LIMIT 30
    `);

    const topEntities = await client.query(`
      SELECT e.name, e.entity_type, e.mention_count,
        (SELECT COUNT(*) FROM entity_relationships WHERE (from_entity_id = e.id OR to_entity_id = e.id) AND valid_until IS NULL) as rel_count
      FROM entities e
      ORDER BY rel_count DESC
      LIMIT 20
    `);

    const orphanCount = await client.query<{ cnt: string }>(`
      SELECT COUNT(*) as cnt FROM entities e
      WHERE NOT EXISTS (
        SELECT 1 FROM entity_relationships er
        WHERE (er.from_entity_id = e.id OR er.to_entity_id = e.id)
        AND er.valid_until IS NULL
      )
    `);

    return jsonResult({
      overview: stats.rows[0],
      entity_types: typeDistribution.rows,
      relationship_types: relTypeDistribution.rows,
      top_connected_entities: topEntities.rows.map((r: Record<string, unknown>) => ({
        name: r.name,
        type: r.entity_type,
        mentions: r.mention_count,
        connections: parseInt(String(r.rel_count)),
      })),
      orphan_entities: parseInt(orphanCount.rows[0].cnt),
    });
  } finally {
    client.release();
  }
}

// ─── 15. vision_graph_infer ───

async function graphInferHandler(args: Record<string, unknown>): Promise<CallToolResult> {
  const minCooccurrence = (args.min_cooccurrence as number) || 3;
  const execute = (args.execute as boolean) || false;
  const limit = (args.limit as number) || 30;

  const client = await pool.connect();
  try {
    // Phase 1: Find co-occurring entity pairs with no existing relationship
    const cooccurring = await client.query(`
      SELECT
        e1.id as id_a, e1.name as name_a, e1.entity_type as type_a,
        e2.id as id_b, e2.name as name_b, e2.entity_type as type_b,
        COUNT(DISTINCT ecm1.content_id) as shared_memories
      FROM entity_content_mentions ecm1
      JOIN entity_content_mentions ecm2 ON ecm1.content_id = ecm2.content_id AND ecm1.entity_id < ecm2.entity_id
      JOIN entities e1 ON e1.id = ecm1.entity_id
      JOIN entities e2 ON e2.id = ecm2.entity_id
      JOIN content c ON c.id = ecm1.content_id AND c.superseded_by IS NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM entity_relationships er
        WHERE ((er.from_entity_id = e1.id AND er.to_entity_id = e2.id)
            OR (er.from_entity_id = e2.id AND er.to_entity_id = e1.id))
        AND er.valid_until IS NULL
      )
      GROUP BY e1.id, e1.name, e1.entity_type, e2.id, e2.name, e2.entity_type
      HAVING COUNT(DISTINCT ecm1.content_id) >= $1
      ORDER BY COUNT(DISTINCT ecm1.content_id) DESC
      LIMIT $2
    `, [minCooccurrence, limit]);

    if (cooccurring.rows.length === 0) {
      return jsonResult({
        mode: execute ? 'execute' : 'preview',
        min_cooccurrence: minCooccurrence,
        candidates: [],
        message: 'No co-occurring pairs found above threshold',
      });
    }

    // Phase 2: For each pair, fetch sample shared memories and existing connections
    const candidates: InferCandidate[] = [];
    for (const row of cooccurring.rows) {
      const sharedContent = await client.query<{ content_text: string }>(`
        SELECT c.content_text
        FROM entity_content_mentions ecm1
        JOIN entity_content_mentions ecm2 ON ecm1.content_id = ecm2.content_id
        JOIN content c ON c.id = ecm1.content_id AND c.superseded_by IS NULL
        WHERE ecm1.entity_id = $1 AND ecm2.entity_id = $2
        ORDER BY c.created_at DESC
        LIMIT 5
      `, [row.id_a, row.id_b]);

      const existingRels = await client.query<{ connected_to: string; relation_type: string }>(`
        SELECT
          CASE WHEN er.from_entity_id = $1 THEN e2.name ELSE e1.name END as connected_to,
          er.relation_type
        FROM entity_relationships er
        JOIN entities e1 ON e1.id = er.from_entity_id
        JOIN entities e2 ON e2.id = er.to_entity_id
        WHERE (er.from_entity_id = $1 OR er.to_entity_id = $1
            OR er.from_entity_id = $2 OR er.to_entity_id = $2)
          AND er.valid_until IS NULL
        LIMIT 10
      `, [row.id_a, row.id_b]);

      candidates.push({
        id_a: row.id_a, name_a: row.name_a, type_a: row.type_a,
        id_b: row.id_b, name_b: row.name_b, type_b: row.type_b,
        shared_count: parseInt(row.shared_memories),
        sample_memories: sharedContent.rows.map(r => r.content_text?.slice(0, 300)),
        existing_connections: existingRels.rows.map(r => `${r.connected_to}: ${r.relation_type}`),
      });
    }

    // Phase 3: Use LLM to determine precise relationship types
    let inferred: InferredRelationship[] = await inferRelationshipsWithLLM(candidates);
    const usedLlm = inferred.length > 0;
    if (!usedLlm) {
      inferred = candidates.map(c => ({
        ...inferRelationshipStatic(c),
        reasoning: 'static heuristic (LLM unavailable)',
      }));
    }

    const result: Record<string, unknown> = {
      mode: execute ? 'execute' : 'preview',
      min_cooccurrence: minCooccurrence,
      used_llm: usedLlm,
      candidates: inferred,
    };

    if (execute) {
      let created = 0;
      for (const rel of inferred) {
        if (rel.skip) continue;
        try {
          await client.query(`
            INSERT INTO entity_relationships (from_entity_id, to_entity_id, relation_type, strength, confidence)
            VALUES ($1, $2, $3, $4::numeric, $5::numeric)
            ON CONFLICT DO NOTHING
          `, [rel.from_id, rel.to_id, rel.inferred_type, rel.strength, rel.confidence]);
          created++;
        } catch (err) {
          console.error(`Failed to create ${rel.from} -> ${rel.to}:`, (err as Error).message);
        }
      }
      result.created = created;
    }

    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── Removed: vault_consolidate, entity_search, causal_trace,
//     preference_evolution, entity_extract_historical
//     → Moved to vault.ts and entity.ts respectively

// ═══════════════════════════════════════════════════════════════
// TOOL DEFINITIONS + EXPORT
// ═══════════════════════════════════════════════════════════════

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_graph_traverse',
      description: 'Multi-hop entity traversal with bi-temporal support. Returns currently-valid relationships by default, or relationships valid at a specific point in time when as_of is set. Per Zep temporal-KG (arxiv 2501.13956): point-in-time traversal is what lets the agent answer "what was true on date X" vs "what is true now" — required for questions about historical state, retroactive corrections, supersession.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_name: { type: 'string', description: 'Starting entity' },
          depth: { type: 'number', description: 'How many hops (default: 2)' },
          direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'], description: 'Direction to traverse (default: both)' },
          as_of: { type: 'string', description: 'Optional ISO 8601 timestamp. Returns relationships valid AT that moment in time (valid_from <= as_of < valid_until). Omit for current-time traversal.' },
        },
        required: ['entity_name'],
      },
    },
    handler: graphTraverseHandler,
  },
  {
    definition: {
      name: 'vision_graph_path',
      description: 'Find shortest path between two entities',
      inputSchema: {
        type: 'object',
        properties: {
          from_entity: { type: 'string' },
          to_entity: { type: 'string' },
          max_depth: { type: 'number', description: 'Maximum hops to search (default: 5)' },
        },
        required: ['from_entity', 'to_entity'],
      },
    },
    handler: graphPathHandler,
  },
  {
    definition: {
      name: 'vision_graph_timeline',
      description: 'Get entity relationship history over time',
      inputSchema: {
        type: 'object',
        properties: {
          entity_name: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['entity_name'],
      },
    },
    handler: graphTimelineHandler,
  },
  {
    definition: {
      name: 'vision_graph_relate',
      description: 'Create relationship between entities with temporal tracking. ALWAYS pass invalidate_previous=true when the new relationship CONTRADICTS or UPDATES an older one (e.g. server moved hosts, project changed owner, status changed). Without invalidate_previous, the old relationship stays "active" alongside the new one, polluting future graph traversal with stale facts. As of 2026-05-17 all 1099 relationships have valid_until=NULL — bi-temporal supersession is structurally available but unused. Per Zep temporal-KG architecture (arxiv 2501.13956), explicit supersession + valid_from/valid_until is what beats vector-only retrieval by 14+ points on LongMemEval.',
      inputSchema: {
        type: 'object',
        properties: {
          from_entity: { type: 'string' },
          to_entity: { type: 'string' },
          relation_type: { type: 'string' },
          strength: { type: 'number', description: '0.0-1.0 (default: 1.0)' },
          confidence: { type: 'number', description: '0.0-1.0 (default: 0.8)' },
          invalidate_previous: { type: 'boolean', description: 'If true, marks previous same-type relationship as historical' },
        },
        required: ['from_entity', 'to_entity', 'relation_type'],
      },
    },
    handler: graphRelateHandler,
  },
  {
    definition: {
      name: 'vision_graph_entity',
      description: 'Create or update entity with deduplication',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', description: 'person, project, concept, system, etc.' },
          description: { type: 'string' },
          memory_id: { type: 'number', description: 'Source memory for provenance' },
        },
        required: ['name'],
      },
    },
    handler: graphEntityHandler,
  },
  {
    definition: {
      name: 'vision_graph_query',
      description: 'Hybrid search: vector similarity boosted by graph connections',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          entity_hint: { type: 'string', description: 'Entity to use for graph boosting' },
          limit: { type: 'number' },
        },
        required: ['query'],
      },
    },
    handler: graphQueryHandler,
  },
  {
    definition: {
      name: 'vision_graph_validate',
      description: 'Run graph integrity check: orphans, duplicates, paradoxes, contradictions',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    handler: graphValidateHandler,
  },
  {
    definition: {
      name: 'vision_graph_backfill',
      description: 'Process historical memories to extract entities and relationships. Runs in batches.',
      inputSchema: {
        type: 'object',
        properties: {
          batch_size: { type: 'number', description: 'How many memories to process (default 50)' },
        },
      },
    },
    handler: graphBackfillHandler,
  },
  {
    definition: {
      name: 'vision_graph_dedup',
      description: 'Merge duplicate entities (case-insensitive). Keeps oldest, transfers relationships.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    handler: graphDedupHandler,
  },
  {
    definition: {
      name: 'vision_graph_delete_entity',
      description: 'Delete an entity and all its relationships',
      inputSchema: {
        type: 'object',
        properties: {
          entity_name: { type: 'string', description: 'Entity name to delete' },
          confirm: { type: 'boolean', description: 'Must be true to confirm deletion' },
        },
        required: ['entity_name', 'confirm'],
      },
    },
    handler: graphDeleteEntityHandler,
  },
  {
    definition: {
      name: 'vision_graph_delete_relationship',
      description: 'Delete a specific relationship by ID',
      inputSchema: {
        type: 'object',
        properties: {
          relationship_id: { type: 'number', description: 'Relationship ID to delete' },
        },
        required: ['relationship_id'],
      },
    },
    handler: graphDeleteRelationshipHandler,
  },
  {
    definition: {
      name: 'vision_graph_merge',
      description: 'Merge two specific entities. Keeps target, migrates all relationships from source, deletes source.',
      inputSchema: {
        type: 'object',
        properties: {
          source_entity: { type: 'string', description: 'Entity to merge FROM (will be deleted)' },
          target_entity: { type: 'string', description: 'Entity to merge INTO (will be kept)' },
        },
        required: ['source_entity', 'target_entity'],
      },
    },
    handler: graphMergeHandler,
  },
  {
    definition: {
      name: 'vision_graph_prune',
      description: 'Remove low-value entities: low mention count, generic names, no meaningful relationships. Returns preview first, pass execute=true to apply.',
      inputSchema: {
        type: 'object',
        properties: {
          min_mentions: { type: 'number', description: 'Minimum mention count to keep (default: 1)' },
          max_relationships: { type: 'number', description: 'Max relationships for entity to be prunable (default: 2)' },
          execute: { type: 'boolean', description: 'If true, actually delete. If false, preview only.' },
        },
      },
    },
    handler: graphPruneHandler,
  },
  {
    definition: {
      name: 'vision_graph_stats',
      description: 'Detailed graph statistics: entity types, relationship types, density metrics',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    handler: graphStatsHandler,
  },
  {
    definition: {
      name: 'vision_graph_infer',
      description: 'Infer relationships from entity co-occurrence in memories. Entities that appear together frequently but have no explicit relationship get one. Preview mode by default.',
      inputSchema: {
        type: 'object',
        properties: {
          min_cooccurrence: { type: 'number', description: 'Minimum shared memories to infer relationship (default: 3)' },
          execute: { type: 'boolean', description: 'If true, create relationships. If false, preview only.' },
          limit: { type: 'number', description: 'Max relationships to infer (default: 30)' },
        },
      },
    },
    handler: graphInferHandler,
  },
];

export default tools;
