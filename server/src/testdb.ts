import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// A fresh in-memory database with the schema applied. For tests only.
export function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

export function readFixture(name: string): Buffer {
  return readFileSync(join(here, 'fixtures', name));
}
