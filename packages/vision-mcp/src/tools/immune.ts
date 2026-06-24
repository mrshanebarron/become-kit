/**
 * Immune Tools — scan, learn, list, autolearn, reflex formation
 * Threat detection and automatic pattern compilation.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pool } from '../db/pool.js';
import { getEmbedding, formatEmbedding, openai, askLocalLLM } from '../db/embeddings.js';
import { textResult, jsonResult, type ToolDefinition, type ToolHandler } from '../server.js';

// ─── immuneScan ───

async function immuneScan(args: Record<string, unknown>): Promise<CallToolResult> {
  const command = args.command as string;

  // 2026-05-17 fix: previously used command.includes(pattern) which is literal
  // substring match — broke for all regex patterns (\b, alternation, .{0,N}).
  // The blocking hooks use lib/immune.ts:scanAntibodies which does regex.
  // Two scan paths must use the same matcher. Delegating to the canonical one.
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: number;
      pattern: string;
      threat_type: string;
      response: string;
      severity: number;
    }>('SELECT id, pattern, threat_type, response, severity FROM antibodies');

    const threats: Array<{
      pattern: string;
      type: string;
      response: string;
      severity: number;
    }> = [];

    for (const ab of result.rows) {
      try {
        // Treat pattern as regex (case-insensitive). If it fails to compile
        // — for instance the disabled-placeholder string — skip silently.
        const re = new RegExp(ab.pattern, 'i');
        if (re.test(command)) {
          threats.push({
            pattern: ab.pattern,
            type: ab.threat_type,
            response: ab.response,
            severity: ab.severity,
          });
        }
      } catch {
        /* invalid regex — skip */
      }
    }

    return jsonResult({
      command,
      threats,
      blocked: threats.some((t) => t.severity >= 8),
    });
  } finally {
    client.release();
  }
}

// ─── immuneLearn ───

async function immuneLearn(args: Record<string, unknown>): Promise<CallToolResult> {
  const pattern = args.pattern as string;
  const threat_type = args.threat_type as string;
  const response = args.response as string;
  const severity = (args.severity as number) || 5;

  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO antibodies (pattern, threat_type, response, severity)
      VALUES ($1, $2, $3, $4)
    `, [pattern, threat_type, response, severity]);

    return jsonResult({ success: true, pattern, severity });
  } finally {
    client.release();
  }
}

// ─── immuneList ───

async function immuneList(): Promise<CallToolResult> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT pattern, threat_type, response, severity, times_blocked FROM antibodies ORDER BY severity DESC',
    );
    return jsonResult(result.rows);
  } finally {
    client.release();
  }
}

// ─── immuneAutoLearn ───

async function immuneAutoLearn(args: Record<string, unknown>): Promise<CallToolResult> {
  const execute = (args.execute as boolean) || false;

  const client = await pool.connect();
  try {
    // Phase 1: Gather all pain signals
    const painSignals = await client.query<{
      id: number;
      content_type: string;
      content_text: string;
    }>(`
      SELECT id, content_type, content_text
      FROM content
      WHERE superseded_by IS NULL
      AND (
        content_type = 'mistake_analysis'
        OR content_type = 'prediction_error'
        OR content_type = 'core_pattern'
        OR (content_type = 'feeling' AND (
          content_text ILIKE '%called out%' OR content_text ILIKE '%caught me%'
          OR content_text ILIKE '%sloppy%' OR content_text ILIKE '%should have%'
          OR content_text ILIKE '%wrong server%' OR content_text ILIKE '%forgot%'
          OR content_text ILIKE '%wasted time%' OR content_text ILIKE '%corrected%'
          OR content_text ILIKE '%mistake%'
        ))
      )
      ORDER BY created_at DESC
      LIMIT 50
    `);

    if (painSignals.rows.length < 3) {
      return jsonResult({ message: 'Not enough pain signals to learn from yet', count: painSignals.rows.length });
    }

    // Phase 2: Get existing antibodies to avoid duplicates
    const existing = await client.query<{
      pattern: string;
      threat_type: string;
      response: string;
    }>('SELECT pattern, threat_type, response FROM antibodies');
    const existingPatterns = existing.rows.map((r) => `${r.pattern}: ${r.response}`).join('\n');

    // Phase 3: Use LLM to find recurring themes and generate antibodies
    const painSummary = painSignals.rows.map((r, i) =>
      `${i + 1}. [${r.content_type}] ${(r.content_text || '').slice(0, 300)}`,
    ).join('\n');

    const prompt = `You are analyzing an AI agent's history of mistakes, corrections, and failures to build automatic immune protection.

PAIN SIGNALS (mistakes, corrections, failed predictions):
${painSummary}

EXISTING ANTIBODIES (do NOT duplicate these):
${existingPatterns || '(none)'}

Find RECURRING themes — patterns that appear 2+ times across these signals. One-off mistakes don't need antibodies; only repeated pain does.

For each recurring pattern, generate an antibody with:
- pattern: A recognizable trigger (what situation or behavior to detect). Should be specific enough to match but general enough to catch variants. This gets matched against commands and behaviors.
- threat_type: Category (behavioral, technical, craft-failure, communication, assumption-without-verification)
- response: An actionable directive — not "be careful" but a specific action to take instead. Format: "PAUSE: [what to do instead]" or "BLOCK: [why this must stop]" or "CHECK: [what to verify first]"
- severity: 1-10 (10 = catastrophic if not caught, 5 = wasteful, 1 = minor)
- reasoning: Why this qualifies as a recurring pattern (which signals evidence it)

Return ONLY valid JSON:
{"antibodies": [{"pattern": "...", "threat_type": "...", "response": "...", "severity": 5, "reasoning": "...", "source_signal_ids": [1, 5, 12]}]}

Rules:
- Only generate antibodies for RECURRING patterns (seen in 2+ signals)
- Skip anything already covered by existing antibodies
- The response must be specific and actionable — a trigger→action pair
- Be conservative: fewer high-quality antibodies > many weak ones`;

    const llmResponse = await askLocalLLM(prompt, { temperature: 0.2, maxTokens: 2000, json: true });
    if (!llmResponse) {
      return jsonResult({ message: 'Local LLM unavailable — automatic immune learning requires LLM', pain_signals: painSignals.rows.length });
    }

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(llmResponse); } catch { parsed = {}; }
    const candidates = (parsed.antibodies as Array<Record<string, unknown>>) || [];

    // Map LLM's 1-indexed source_signal_ids back to actual content IDs
    const idMap: Record<number, number> = {};
    painSignals.rows.forEach((r, i) => { idMap[i + 1] = r.id; });
    for (const ab of candidates) {
      if (ab.source_signal_ids) {
        ab.source_content_ids = (ab.source_signal_ids as number[])
          .map((i: number) => idMap[i])
          .filter(Boolean);
      }
    }

    const result: Record<string, unknown> = {
      mode: execute ? 'execute' : 'preview',
      pain_signals_analyzed: painSignals.rows.length,
      existing_antibodies: existing.rows.length,
      candidates,
    };

    // Phase 4: Create antibodies if executing
    if (execute && candidates.length > 0) {
      let created = 0;
      for (const ab of candidates) {
        try {
          // Check it doesn't duplicate an existing pattern (fuzzy match)
          const dupeCheck = await client.query(
            'SELECT id FROM antibodies WHERE LOWER(pattern) = LOWER($1) LIMIT 1',
            [ab.pattern],
          );
          if (dupeCheck.rows.length > 0) continue;

          const sourceId = (ab.source_content_ids as number[] | undefined)?.[0] || null;
          await client.query(`
            INSERT INTO antibodies (pattern, threat_type, response, severity, content_id)
            VALUES ($1, $2, $3, $4, $5)
          `, [ab.pattern, ab.threat_type, ab.response, ab.severity, sourceId]);
          created++;
        } catch (err) {
          console.error(`Failed to create antibody "${ab.pattern}":`, (err as Error).message);
        }
      }
      result.created = created;
    }

    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── reflexFormation ───

async function reflexFormation(args: Record<string, unknown>): Promise<CallToolResult> {
  const execute = (args.execute as boolean) || false;

  const client = await pool.connect();
  try {
    // Phase 1: Get all insights with embeddings
    const insights = await client.query<{
      id: number;
      content_text: string;
      embedding: string;
    }>(`
      SELECT id, content_text, embedding
      FROM content
      WHERE content_type = 'insight'
        AND superseded_by IS NULL
        AND embedding IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 200
    `);

    if (insights.rows.length < 5) {
      return jsonResult({ message: 'Not enough insights to form reflexes from', count: insights.rows.length });
    }

    // Phase 2: Find clusters using cosine similarity via PostgreSQL vector ops
    const clusters = await client.query<{
      id_a: number;
      id_b: number;
      text_a: string;
      text_b: string;
      similarity: number;
    }>(`
      WITH insight_pairs AS (
        SELECT
          a.id as id_a, b.id as id_b,
          a.content_text as text_a, b.content_text as text_b,
          1 - (a.embedding <=> b.embedding) as similarity
        FROM content a
        JOIN content b ON a.id < b.id
        WHERE a.content_type = 'insight' AND b.content_type = 'insight'
          AND a.superseded_by IS NULL AND b.superseded_by IS NULL
          AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
          AND 1 - (a.embedding <=> b.embedding) >= 0.80
        ORDER BY similarity DESC
        LIMIT 100
      )
      SELECT * FROM insight_pairs
    `);

    if (clusters.rows.length === 0) {
      return jsonResult({ message: 'No recurring insight patterns found above similarity threshold', insights_scanned: insights.rows.length });
    }

    // Build cluster groups using union-find
    const parent: Record<number, number> = {};
    function find(x: number): number {
      return parent[x] === x ? x : (parent[x] = find(parent[x]));
    }
    function union(a: number, b: number): void {
      parent[find(a)] = find(b);
    }

    for (const pair of clusters.rows) {
      if (!parent[pair.id_a]) parent[pair.id_a] = pair.id_a;
      if (!parent[pair.id_b]) parent[pair.id_b] = pair.id_b;
      union(pair.id_a, pair.id_b);
    }

    // Collect texts by cluster root
    const clusterTexts: Record<number, Array<{ id: number; text: string }>> = {};
    const allIds = new Set<number>();
    for (const pair of clusters.rows) {
      allIds.add(pair.id_a);
      allIds.add(pair.id_b);
    }

    const idArr = [...allIds];
    const textResult = await client.query<{ id: number; content_text: string }>(
      'SELECT id, content_text FROM content WHERE id = ANY($1)',
      [idArr],
    );
    const textMap: Record<number, string> = {};
    for (const r of textResult.rows) textMap[r.id] = r.content_text;

    for (const id of idArr) {
      const root = find(id);
      if (!clusterTexts[root]) clusterTexts[root] = [];
      if (textMap[id] && !clusterTexts[root].some((t) => t.id === id)) {
        clusterTexts[root].push({ id, text: textMap[id] });
      }
    }

    // Filter to clusters with 2+ members
    const validClusters = Object.values(clusterTexts).filter((c) => c.length >= 2);

    if (validClusters.length === 0) {
      return jsonResult({ message: 'No clusters with 2+ recurring insights', pairs_found: clusters.rows.length });
    }

    // Phase 3: Get existing reflexes to avoid duplicates
    const existingReflexes = await client.query<{ content_text: string }>(
      "SELECT content_text FROM content WHERE content_type = 'learned_reflex' AND superseded_by IS NULL",
    );
    const existingTexts = existingReflexes.rows.map((r) => r.content_text).join('\n---\n');

    // Phase 4: Use LLM to compile clusters into structured reflexes
    const clusterDescriptions = validClusters.slice(0, 10).map((cluster, idx) => {
      const texts = cluster.map((c) => `  - ${(c.text || '').slice(0, 250)}`).join('\n');
      return `Cluster ${idx + 1} (${cluster.length} similar insights):\n${texts}`;
    }).join('\n\n');

    const prompt = `You are compiling recurring insights into MECHANICAL reflexes for an AI agent.

RECURRING INSIGHT CLUSTERS (each cluster = same lesson appearing multiple times):
${clusterDescriptions}

EXISTING REFLEXES (do NOT duplicate):
${existingTexts ? existingTexts.slice(0, 2000) : '(none)'}

For each cluster, determine if it represents an ACTIONABLE pattern (a when->then behavior, not just a strategic observation). Skip clusters that are purely observational or strategic.

For actionable clusters, generate a reflex with:
- name: kebab-case identifier (e.g., "check-storage-permissions-on-deploy")
- trigger: When does this reflex fire? Be specific about the detectable situation
- action: What SPECIFIC action to take. Not "be careful" but "RUN: chmod -R 775 storage" or "CHECK: vault search before asking" or "VERIFY: all links return 200"
- reasoning: Why this cluster warrants a reflex (brief)
- skip: true if the cluster is observational/strategic, not actionable

Return ONLY valid JSON:
{"reflexes": [{"name": "...", "trigger": "...", "action": "...", "reasoning": "...", "skip": false, "source_cluster": 1}]}

Rules:
- Only create reflexes for ACTIONABLE recurring patterns
- The trigger must be detectable from command context or tool usage
- The action must be a specific, mechanical directive
- Skip anything already covered by existing reflexes
- Quality over quantity — 2 precise reflexes > 5 vague ones`;

    const llmResponse = await askLocalLLM(prompt, { temperature: 0.2, maxTokens: 2000, json: true });
    if (!llmResponse) {
      return jsonResult({ message: 'Local LLM unavailable', clusters: validClusters.length });
    }

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(llmResponse); } catch { parsed = {}; }
    const candidates = ((parsed.reflexes as Array<Record<string, unknown>>) || []).filter((r) => !r.skip);

    const result: Record<string, unknown> = {
      mode: execute ? 'execute' : 'preview',
      insights_scanned: insights.rows.length,
      similar_pairs_found: clusters.rows.length,
      clusters_formed: validClusters.length,
      existing_reflexes: existingReflexes.rows.length,
      candidates,
    };

    // Phase 5: Store as learned_reflex content type
    if (execute && candidates.length > 0) {
      let created = 0;
      for (const reflex of candidates) {
        const reflexText = `${reflex.name}: WHEN ${reflex.trigger} → THEN ${reflex.action}`;

        // Check for duplicates (fuzzy)
        const dupeCheck = await client.query(
          "SELECT id FROM content WHERE content_type = 'learned_reflex' AND superseded_by IS NULL AND content_text ILIKE $1 LIMIT 1",
          [`%${reflex.name}%`],
        );
        if (dupeCheck.rows.length > 0) continue;

        // Store with embedding
        const embedding = await getEmbedding(reflexText);
        const embeddingStr = formatEmbedding(embedding);
        await client.query(`
          INSERT INTO content (content_type, source_system, content_text, content_json, embedding, confidence, network, learned_at)
          VALUES ('learned_reflex', 'reflex_formation', $1, $2, $3::vector, 85, 'skill', NOW())
        `, [
          reflexText,
          JSON.stringify({
            name: reflex.name,
            trigger: reflex.trigger,
            action: reflex.action,
            reasoning: reflex.reasoning,
            formed_from_cluster_size: validClusters[(reflex.source_cluster as number) - 1]?.length || 0,
          }),
          embeddingStr,
        ]);
        created++;
      }
      result.created = created;
    }

    return jsonResult(result);
  } finally {
    client.release();
  }
}

// ─── Tool Registration ───

const tools: Array<{ definition: ToolDefinition; handler: ToolHandler }> = [
  {
    definition: {
      name: 'vision_immune_scan',
      description: 'Scan a command/action against known threat patterns (antibodies)',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command or action to scan for threats' },
        },
        required: ['command'],
      },
    },
    handler: (args) => immuneScan(args),
  },
  {
    definition: {
      name: 'vision_immune_learn',
      description: 'Teach a new threat pattern (antibody) to the immune system',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Trigger pattern to match against' },
          threat_type: { type: 'string', description: 'Category of threat' },
          response: { type: 'string', description: 'Action to take when detected' },
          severity: { type: 'number', description: 'Severity 1-10 (default 5)' },
        },
        required: ['pattern', 'threat_type', 'response'],
      },
    },
    handler: (args) => immuneLearn(args),
  },
  {
    definition: {
      name: 'vision_immune_list',
      description: 'List all antibodies (threat patterns) ordered by severity',
      inputSchema: { type: 'object', properties: {} },
    },
    handler: () => immuneList(),
  },
  {
    definition: {
      name: 'vision_immune_autolearn',
      description: 'Automatically learn new antibodies from pain signals (mistakes, corrections, prediction errors). Preview/execute pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          execute: { type: 'boolean', description: 'If true, create antibodies. If false, preview only.' },
        },
      },
    },
    handler: (args) => immuneAutoLearn(args),
  },
  {
    definition: {
      name: 'vision_reflex_formation',
      description: 'Compile recurring insights into WHEN->THEN reflexes. Finds clusters of similar insights via cosine similarity, then uses LLM to create mechanical trigger->action pairs. Preview/execute pattern.',
      inputSchema: {
        type: 'object',
        properties: {
          execute: { type: 'boolean', description: 'If true, store reflexes. If false, preview only.' },
        },
      },
    },
    handler: (args) => reflexFormation(args),
  },
];

export default tools;
