import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connConfig, initSchema } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

// Connection config for the tests: the same APP_ENV-selected fields as the
// runtime (normally the `dev` branch), forced to the direct (non-pooled) host
// because the harness pins each connection to a per-test schema via the
// `search_path` startup option (which PgBouncer transaction pooling would drop).
// Keep the pool small — many test files may run in parallel processes.
function testConfig(searchPath?: string): pg.PoolConfig {
  const base = { ...connConfig({ direct: true }), max: 5 };
  return searchPath ? { ...base, options: `-c search_path=${searchPath}` } : base;
}

export interface TestDb {
  db: pg.Pool;
  cleanup: () => Promise<void>;
}

// A fresh, isolated Postgres schema with the app schema applied. For tests only.
// Each call gets a unique `test_<hex>` schema so test files run in parallel safely.
export async function makeTestDb(): Promise<TestDb> {
  const schemaName = `test_${randomBytes(8).toString('hex')}`;

  const admin = new pg.Pool(testConfig());
  await admin.query(`CREATE SCHEMA "${schemaName}"`);

  // Every connection in this pool starts with search_path pinned to the schema.
  const db = new pg.Pool(testConfig(schemaName));
  await initSchema(db);

  const cleanup = async (): Promise<void> => {
    await db.end();
    await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await admin.end();
  };

  return { db, cleanup };
}

export function readFixture(name: string): Buffer {
  return readFileSync(join(here, 'fixtures', name));
}
