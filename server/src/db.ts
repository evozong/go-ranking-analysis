import 'dotenv/config';
import pg from 'pg';
import { ensureSchema as ensureSchemaOn, withTransaction } from './dbCore.js';

export type { Pool, PoolClient } from 'pg';
export { withTransaction };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and point it at your ' +
      'staging Postgres database (see plans/03-postgres-stg-prd-migration.md).',
  );
}

// Neon (and most managed Postgres) require TLS; a plain local Postgres on localhost does not.
const useSsl = !/localhost|127\.0\.0\.1/.test(connectionString);

export const pool = new pg.Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

export async function ensureSchema(): Promise<void> {
  await ensureSchemaOn(pool);
}
