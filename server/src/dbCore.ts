import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

// Side-effect-free on import (no env var access, no connection created) so it's safe for
// both the real db.ts (backed by DATABASE_URL) and testdb.ts (backed by pg-mem) to depend on.

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function ensureSchema(target: Pick<Pool, 'query'>): Promise<void> {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const statements = schema
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await target.query(stmt);
  }
}

// Runs fn inside a single transaction on a dedicated client, committing on success and
// rolling back on any thrown error. Use for any multi-statement write (imports, remaps).
export async function withTransaction<T>(
  target: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
