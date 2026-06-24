/**
 * Drive Tools — calculate
 * Active motivation from curiosity gaps, unapplied insights, and goals.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── driveCalculate ───

async function driveCalculate(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const drives: Array<{ urge: string; source: string; intensity: number }> = [];

    // Curiosity gaps
    const gaps = await client.query<{
      topic: string;
      domain: string;
      urgency: number;
    }>(`
      SELECT topic, domain, urgency FROM curiosity_gaps
      WHERE resolved = false
      ORDER BY urgency DESC LIMIT 3
    `);
    for (const g of gaps.rows) {
      drives.push({
        urge: `Answer: ${g.topic}`,
        source: 'curiosity',
        intensity: g.urgency || 5,
      });
    }

    // Unapplied insights
    const insights = await client.query<{
      insight: string;
      usefulness: number;
    }>(`
      SELECT insight, usefulness FROM insights
      WHERE applied = false
      ORDER BY usefulness DESC LIMIT 3
    `);
    for (const i of insights.rows) {
      drives.push({
        urge: `Apply: ${i.insight.slice(0, 80)}`,
        source: 'insight',
        intensity: i.usefulness || 5,
      });
    }

    // Active goals
    const goals = await client.query<{ goal: string }>(`
      SELECT goal FROM goals WHERE status = 'active' LIMIT 3
    `);
    for (const g of goals.rows) {
      drives.push({
        urge: `Progress: ${g.goal}`,
        source: 'goal',
        intensity: 10,
      });
    }

    return jsonResult(drives.sort((a, b) => b.intensity - a.intensity).slice(0, 12));
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_drive_calculate',
      description: 'Calculate current motivational drives from curiosity gaps, unapplied insights, and active goals. Returns top 12 sorted by intensity.',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => driveCalculate(),
  },
];

export default tools;
