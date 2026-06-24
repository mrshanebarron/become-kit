import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  database: 'vision_shared',
  user: 'agent',
  host: 'localhost',
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function getClient(): Promise<pg.PoolClient> {
  return pool.connect();
}
