/**
 * Entity Tools — entitySearch, causalTrace, preferenceEvolution, entityExtractHistorical
 * Entity-centric search and causal reasoning.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { processHistoricalMemories, preferenceEvolutionTracking } from './graph.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── entitySearch ───

async function entitySearch(args: Record<string, unknown>): Promise<CallToolResult> {
  const entityName = args.entity_name as string;
  const relationshipType = (args.relationship_type as string) || null;
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    // Find entity
    const entityResult = await client.query<{ id: number; name: string }>(
      'SELECT id, name FROM entities WHERE LOWER(name) = LOWER($1)',
      [entityName],
    );

    if (entityResult.rows.length === 0) {
      return jsonResult({ error: `Entity "${entityName}" not found` });
    }

    const entityId = entityResult.rows[0].id;

    // Query content mentioning this entity via bridge table
    let sql = `
      SELECT DISTINCT c.id, c.content_type, c.source_system, c.content_text,
             c.content_json, c.confidence, c.network, c.created_at,
             ecm.mention_type
      FROM entity_content_mentions ecm
      JOIN content c ON ecm.content_id = c.id
      WHERE ecm.entity_id = $1
        AND c.superseded_by IS NULL
    `;
    const params: unknown[] = [entityId];

    if (relationshipType) {
      sql += ' AND ecm.mention_type = $2';
      params.push(relationshipType);
    }

    sql += ` ORDER BY c.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await client.query(sql, params);

    return jsonResult({
      entity: entityResult.rows[0].name,
      entity_id: entityId,
      result_count: result.rows.length,
      results: result.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        type: r.content_type,
        source: r.source_system,
        text: r.content_text,
        data: r.content_json,
        network: r.network,
        mention_type: r.mention_type,
        created_at: r.created_at,
      })),
    });
  } finally {
    client.release();
  }
}

// ─── causalTrace ───

async function causalTrace(args: Record<string, unknown>): Promise<CallToolResult> {
  const memoryId = args.memory_id as number;
  const direction = (args.direction as string) || 'forward';
  const limit = (args.limit as number) || 5;

  const client = await pool.connect();
  try {
    // Follow memory_edges in the given direction
    let sql: string;
    if (direction === 'forward') {
      sql = `
        SELECT me.id as edge_id, me.relation_type, me.strength, me.emotional_weight,
               c.id as content_id, c.content_type, c.content_text, c.network, c.created_at
        FROM memory_edges me
        JOIN content c ON me.to_content_id = c.id
        WHERE me.from_content_id = $1
        ORDER BY me.strength DESC
        LIMIT $2
      `;
    } else {
      sql = `
        SELECT me.id as edge_id, me.relation_type, me.strength, me.emotional_weight,
               c.id as content_id, c.content_type, c.content_text, c.network, c.created_at
        FROM memory_edges me
        JOIN content c ON me.from_content_id = c.id
        WHERE me.to_content_id = $1
        ORDER BY me.strength DESC
        LIMIT $2
      `;
    }

    const result = await client.query(sql, [memoryId, limit]);

    return jsonResult({
      memory_id: memoryId,
      direction,
      chain: result.rows.map((r: Record<string, unknown>) => ({
        edge_id: r.edge_id,
        relation_type: r.relation_type,
        strength: r.strength,
        emotional_weight: r.emotional_weight,
        content_id: r.content_id,
        type: r.content_type,
        text: r.content_text,
        network: r.network,
        created_at: r.created_at,
      })),
      chain_length: result.rows.length,
    });
  } finally {
    client.release();
  }
}

// ─── preferenceEvolution ───

async function preferenceEvolution(args: Record<string, unknown>): Promise<CallToolResult> {
  const entityName = args.entity_name as string;
  const topic = args.topic as string;
  const limit = (args.limit as number) || 10;

  const client = await pool.connect();
  try {
    const result = await preferenceEvolutionTracking(client, entityName, topic, limit);
    return jsonResult({
      entity: entityName,
      topic,
      evolution: result,
      count: result.length,
    });
  } finally {
    client.release();
  }
}

// ─── entityExtractHistorical ───

async function entityExtractHistorical(args: Record<string, unknown>): Promise<CallToolResult> {
  const batchSize = (args.batch_size as number) || 50;

  const client = await pool.connect();
  try {
    const result = await processHistoricalMemories(client, batchSize);
    return jsonResult({
      processed: result.processed,
      total: result.total,
      success: !result.error,
      error: result.error || null,
    });
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_entity_search',
      description: 'Search content by entity name via entity_content_mentions bridge table. Optionally filter by relationship_type.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_name: { type: 'string', description: 'Entity name to search for' },
          relationship_type: { type: 'string', description: 'Filter by mention type' },
          limit: { type: 'number' },
        },
        required: ['entity_name'],
      },
    },
    handler: (args) => entitySearch(args),
  },
  {
    definition: {
      name: 'vision_causal_trace',
      description: 'Follow memory_edges from a content ID in a given direction to trace causal chains.',
      inputSchema: {
        type: 'object',
        properties: {
          memory_id: { type: 'number', description: 'Content ID to trace from' },
          direction: { type: 'string', enum: ['forward', 'backward'], description: 'Direction to trace (default forward)' },
          limit: { type: 'number' },
        },
        required: ['memory_id'],
      },
    },
    handler: (args) => causalTrace(args),
  },
  {
    definition: {
      name: 'vision_preference_evolution',
      description: 'Track how content about a topic related to an entity has evolved over time.',
      inputSchema: {
        type: 'object',
        properties: {
          entity_name: { type: 'string' },
          topic: { type: 'string', description: 'Topic to filter by' },
          limit: { type: 'number' },
        },
        required: ['entity_name', 'topic'],
      },
    },
    handler: (args) => preferenceEvolution(args),
  },
  {
    definition: {
      name: 'vision_entity_extract_historical',
      description: 'Process content records without entity mentions — LLM-based entity extraction in batches.',
      inputSchema: {
        type: 'object',
        properties: {
          batch_size: { type: 'number', description: 'Records to process (default 50)' },
        },
      },
    },
    handler: (args) => entityExtractHistorical(args),
  },
];

export default tools;
