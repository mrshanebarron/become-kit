/**
 * PostgreSQL connection pools — shared across all tool modules.
 * Same connection config as the legacy index.js.
 */
import pg from 'pg';

const { Pool } = pg;

const BECOME_KIT_DB = process.env.BECOME_KIT_DB || 'become_kit';
const SHARED_DB = process.env.BECOME_KIT_SHARED_DB || 'become_kit_shared';

export const pool = new Pool({
  database: BECOME_KIT_DB,
  user: 'the owner',
  host: 'localhost',
});

/** Shared database pool (become_kit_shared) — for relay, queue, sessions, briefings. */
export const sharedPool = new Pool({
  database: SHARED_DB,
  user: 'the owner',
  host: 'localhost',
});

/** Run a single query with typed result rows. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/** Get a client for transactions. */
export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}

/** Graceful shutdown. */
export async function shutdown(): Promise<void> {
  await pool.end();
  await sharedPool.end();
}
