import { newDb } from 'pg-mem';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { ensureSchema } from './dbCore.js';

const here = dirname(fileURLToPath(import.meta.url));

// A fresh in-memory Postgres-compatible database with the schema applied. For tests only —
// this deliberately never touches the real staging/production databases (see
// plans/03-postgres-stg-prd-migration.md): unit tests stay hermetic, offline, and fast.
export async function makeTestDb(): Promise<Pool> {
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool: MemPool } = mem.adapters.createPg();
  const pool = new MemPool() as unknown as Pool;
  await ensureSchema(pool);
  return pool;
}

export function readFixture(name: string): Buffer {
  return readFileSync(join(here, 'fixtures', name));
}
