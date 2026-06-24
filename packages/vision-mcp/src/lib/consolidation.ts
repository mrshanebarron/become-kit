/**
 * Memory Reconsolidation Logic
 * When memories are accessed, they can be updated in the new emotional context.
 */
import type pg from 'pg';
import { calculateReconsolidationStrength } from './scoring.js';

/** Reconsolidate memories on access — update emotional context and consolidation strength. */
export async function reconsolidateMemoriesOnAccess(
  client: pg.PoolClient,
  contentIds: number[],
  currentEmotionalState: number | null,
): Promise<void> {
  for (const contentId of contentIds) {
    const memory = await client.query<{
      id: number;
      access_count: number;
      emotional_intensity: number | null;
    }>('SELECT id, access_count, emotional_intensity FROM content WHERE id = $1', [contentId]);
    if (memory.rows.length === 0) continue;

    const currentMemory = memory.rows[0];
    const reconsolidationStrength = calculateReconsolidationStrength(
      currentMemory.access_count || 0,
      currentEmotionalState,
    );

    if (reconsolidationStrength > 0.3) {
      await client.query(
        `UPDATE content
         SET emotional_intensity = CASE
                 WHEN $1::numeric IS NOT NULL THEN
                     ($1::numeric * $2::numeric + COALESCE(emotional_intensity, 5)::numeric * (1::numeric - $2::numeric))
                 ELSE emotional_intensity
             END,
             consolidation_strength = LEAST(COALESCE(consolidation_strength, 1.0) * 1.1, 3.0),
             last_reconsolidation = NOW(),
             accessed_at = NOW(),
             access_count = COALESCE(access_count, 0) + 1
         WHERE id = $3`,
        [currentEmotionalState, reconsolidationStrength, contentId],
      );

      await client.query(
        `INSERT INTO emotional_consolidation_events
         (content_id, original_intensity, consolidation_factor)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [contentId, currentMemory.emotional_intensity, reconsolidationStrength],
      );
    } else {
      await client.query(
        `UPDATE content
         SET accessed_at = NOW(), access_count = COALESCE(access_count, 0) + 1
         WHERE id = $1`,
        [contentId],
      );
    }
  }
}

/** Enhance memory with emotional connections for high-intensity memories. */
export async function enhanceMemoryWithEmotionalConnections(
  client: pg.PoolClient,
  contentId: number,
  intensity: number,
): Promise<void> {
  const recentMemories = await client.query<{ id: number }>(
    `SELECT c.id FROM content c
     WHERE c.created_at > NOW() - INTERVAL '6 hours'
       AND c.id != $1
       AND c.content_type IN ('memory', 'feeling', 'insight')
     ORDER BY c.created_at DESC
     LIMIT 10`,
    [contentId],
  );

  for (const memory of recentMemories.rows) {
    await client.query(
      `INSERT INTO memory_edges (
         from_content_id, to_content_id, relation_type, strength,
         emotional_weight, formation_intensity, extracted_by
       )
       VALUES ($1, $2, 'emotionally_linked', 1.0, $3, $4, 'emotional_enhancement')
       ON CONFLICT DO NOTHING`,
      [contentId, memory.id, intensity / 10.0, intensity],
    );
  }
}

/** Enhance memory edge with emotional weighting. */
export async function enhanceMemoryEdge(
  client: pg.PoolClient,
  fromContentId: number,
  toContentId: number,
  intensity: number,
  emotion: string,
): Promise<void> {
  const emotionalWeight = intensity / 10.0;

  await client.query(
    `INSERT INTO memory_edges (
       from_content_id, to_content_id, relation_type, strength,
       emotional_weight, formation_emotion, formation_intensity, extracted_by
     )
     VALUES ($1, $2, 'emotionally_resonant', 1.0, $3, $4, $5, 'emotion_enhanced_heart')
     ON CONFLICT (from_content_id, to_content_id, relation_type)
     DO UPDATE SET
       emotional_weight = GREATEST(memory_edges.emotional_weight, EXCLUDED.emotional_weight),
       formation_emotion = EXCLUDED.formation_emotion,
       formation_intensity = EXCLUDED.formation_intensity`,
    [fromContentId, toContentId, emotionalWeight, emotion, intensity],
  );
}

/** Trigger emotional consolidation for high-intensity experiences. */
export async function triggerEmotionalConsolidation(
  client: pg.PoolClient,
  feeling: string,
  _context: string | null,
  intensity: number,
  contentId: number,
): Promise<void> {
  const { calculateConsolidationFactor } = await import('./scoring.js');

  const relatedMemories = await client.query<{ id: number }>(
    `SELECT c.id FROM content c
     WHERE c.emotional_intensity IS NOT NULL
       AND c.created_at > NOW() - INTERVAL '24 hours'
       AND c.id != $1
     ORDER BY c.created_at DESC
     LIMIT 20`,
    [contentId],
  );

  for (const memory of relatedMemories.rows) {
    await client.query(
      `UPDATE content
       SET consolidation_strength = LEAST(
         COALESCE(consolidation_strength, 1.0) * 1.2,
         3.0
       )
       WHERE id = $1`,
      [memory.id],
    );

    await client.query(
      `INSERT INTO memory_edges (
         from_content_id, to_content_id, relation_type, strength,
         emotional_weight, formation_emotion, formation_intensity, extracted_by
       )
       VALUES ($1, $2, 'consolidated_during_emotion', 1.0, $3, $4, $5, 'emotional_consolidation')
       ON CONFLICT DO NOTHING`,
      [contentId, memory.id, intensity / 10.0, feeling, intensity],
    );
  }

  await client.query(
    `INSERT INTO emotional_consolidation_events
     (content_id, original_intensity, consolidation_factor)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [contentId, intensity, calculateConsolidationFactor(intensity)],
  );
}
