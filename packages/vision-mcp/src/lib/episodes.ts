/**
 * Active Episode Tracking (Whole Memory Integration)
 * When an episode is active, new content auto-links to it.
 */
import type pg from 'pg';
import { query } from '../db/pool.js';

// Postgres error code for "undefined_table" — relation does not exist.
// We tolerate this so sibling DBs (agent, agent) that haven't received every
// migration can still execute vault_remember without aborting the outer transaction.
const PG_UNDEFINED_TABLE = '42P01';

function isMissingRelation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === PG_UNDEFINED_TABLE;
}

/** Get active episode ID from state table. Returns null if state table is absent. */
export async function getActiveEpisode(client?: pg.PoolClient): Promise<number | null> {
  const q = client ? client.query.bind(client) : query;
  try {
    const result = await q<{ value: string }>(
      "SELECT value FROM state WHERE key = 'active_episode_id'",
    );
    if (result.rows.length > 0) {
      const id = parseInt(result.rows[0].value);
      if (!isNaN(id)) return id;
    }
    return null;
  } catch (e) {
    if (isMissingRelation(e)) return null;
    throw e;
  }
}

/** Link content to active episode via memory_edges. Fails soft on missing schema. */
export async function linkToActiveEpisode(
  client: pg.PoolClient,
  contentId: number,
  relationType = 'part_of',
): Promise<boolean> {
  let activeEpisodeId: number | null;
  try {
    activeEpisodeId = await getActiveEpisode(client);
  } catch (e) {
    if (isMissingRelation(e)) return false;
    throw e;
  }
  if (!activeEpisodeId) return false;

  let episodeContentId: number;
  try {
    const epResult = await client.query<{ content_id: number }>(
      'SELECT content_id FROM narrative_episodes WHERE id = $1',
      [activeEpisodeId],
    );
    if (epResult.rows.length === 0 || !epResult.rows[0].content_id) return false;
    episodeContentId = epResult.rows[0].content_id;
  } catch (e) {
    if (isMissingRelation(e)) return false;
    throw e;
  }

  try {
    await client.query(
      `INSERT INTO memory_edges (from_content_id, to_content_id, relation_type, strength, extracted_by)
       VALUES ($1, $2, $3, 1.0, 'auto_episode_link')
       ON CONFLICT (from_content_id, to_content_id, relation_type) DO NOTHING`,
      [episodeContentId, contentId, relationType],
    );
    return true;
  } catch (e) {
    if (isMissingRelation(e)) return false;
    console.error('Failed to link to episode:', (e as Error).message);
    return false;
  }
}
