#!/usr/bin/env node
/**
 * migrate — apply the organ schema migrations to the become-kit database.
 *
 * Reads every .sql file in ../migrations in lexical order and applies it inside
 * a transaction, tracking applied migrations in a `_migrations` table so re-runs
 * are idempotent. Enables pgvector first (the embedding columns need it).
 *
 *   BECOME_KIT_DB_URL   full Postgres connection string (preferred), OR
 *   BECOME_KIT_DB       database name (default: become_kit) on the local socket.
 */
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function connectionConfig(): pg.PoolConfig {
  if (process.env.BECOME_KIT_DB_URL) {
    return { connectionString: process.env.BECOME_KIT_DB_URL };
  }
  return { database: process.env.BECOME_KIT_DB || 'become_kit' };
}

export async function migrate(): Promise<{ applied: string[]; skipped: number }> {
  const pool = new pg.Pool(connectionConfig());
  const applied: string[] = [];
  let skipped = 0;
  const client = await pool.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gin');
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name),
    );

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) {
        skipped++;
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
  return { applied, skipped };
}

// CLI entry
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  migrate()
    .then(({ applied, skipped }) => {
      console.log(`migrations: applied ${applied.length}, skipped ${skipped} (already applied)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('migrate failed:', err.message);
      process.exit(1);
    });
}
