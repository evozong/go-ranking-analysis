import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

// APP_ENV selects the environment postfix for the pg connection fields
// (PGHOST_<ENV>, PGHOST_POOLED_<ENV>, PGPASSWORD_<ENV>). It is deliberately
// required with no default — a misconfigured prod deploy should fail loudly
// rather than silently inherit `stg`.
//
// Allowed values (case-insensitive): dev | stg | prd
//   dev  — a developer's local branch; `npm run dev` and `npm test` use it
//          (tests are further schema-isolated per test file)
//   stg  — shared staging branch
//   prd  — production (APP_ENV=prd set in the deploy's own secret store)
const ALLOWED_APP_ENVS = ['DEV', 'STG', 'PRD'] as const;
const E = process.env.APP_ENV?.toUpperCase();
if (!E || !(ALLOWED_APP_ENVS as readonly string[]).includes(E)) {
  throw new Error(
    `APP_ENV must be one of dev | stg | prd (got ${
      process.env.APP_ENV ? `"${process.env.APP_ENV}"` : 'unset'
    }). Set it in server/.env.local (local) or the deploy's secret store (prod).`,
  );
}

// Resolve the discrete pg connection fields for the selected APP_ENV.
// `direct: true` forces the non-pooled PGHOST_<ENV> (the test harness needs
// per-connection `SET search_path`, which PgBouncer transaction pooling drops).
export function connConfig({ direct = false }: { direct?: boolean } = {}): pg.PoolConfig {
  const host = direct
    ? process.env[`PGHOST_${E}`]
    : process.env[`PGHOST_POOLED_${E}`] ?? process.env[`PGHOST_${E}`];
  const password = process.env[`PGPASSWORD_${E}`];
  if (!host) {
    throw new Error(
      `Missing ${direct ? '' : `PGHOST_POOLED_${E} / `}PGHOST_${E} in the environment.`,
    );
  }
  if (!password) {
    throw new Error(`Missing PGPASSWORD_${E} in the environment.`);
  }
  return {
    host,
    user: process.env.PGUSER,
    password,
    database: process.env.PGDATABASE,
    ssl: { rejectUnauthorized: true }, // Neon: TLS + SCRAM channel binding handled by pg
    // One pool per process. Lambda containers are single-concurrency, so prod
    // sets PG_POOL_MAX=2 to avoid multiplying Neon connections under scale;
    // local dev / self-hosted keeps the default 10.
    max: Number(process.env.PG_POOL_MAX ?? 10),
  };
}

export const pool = new pg.Pool(connConfig());

// Anything that can run a parameterized query: both pg.Pool and pg.PoolClient
// satisfy this, so every read-only data-layer function accepts one.
export interface Queryable {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
}

// A connection pool: what the transactional data-layer functions need so they
// can check out a dedicated client. Both the runtime `pool` and each test's
// isolated-schema pool satisfy this.
export type Db = pg.Pool;

// Read lazily, not at module load: the Lambda bundle never calls initSchema()
// (schema is applied out-of-band by migrate.ts) and must not need schema.sql
// packaged next to it.
let schemaSql: string | undefined;

// Apply the (idempotent) schema. Safe to run on every startup.
export async function initSchema(db: Queryable = pool): Promise<void> {
  schemaSql ??= readFileSync(join(here, 'schema.sql'), 'utf8');
  await db.query(schemaSql);
}

// Run `fn` inside a single transaction on a dedicated client checked out of
// `db` (defaults to the runtime pool; tests pass their isolated-schema pool).
export async function withTransaction<T>(
  db: Db,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
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
