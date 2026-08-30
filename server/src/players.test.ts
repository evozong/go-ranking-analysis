import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, resolveCanonicalPlayer } from './players.js';
import { makeTestDb } from './testdb.js';

test('normalizeName trims, collapses whitespace, lowercases', () => {
  assert.equal(normalizeName('  John   Smith '), 'john smith');
  assert.equal(normalizeName('JANE\tDOE'), 'jane doe');
});

test('resolveCanonicalPlayer creates on first sight, matches case-insensitively after', () => {
  const db = makeTestDb();

  const a = resolveCanonicalPlayer(db, 'John Smith');
  assert.equal(a.created, true);

  const b = resolveCanonicalPlayer(db, '  john   SMITH ');
  assert.equal(b.created, false);
  assert.equal(b.playerId, a.playerId);

  const c = resolveCanonicalPlayer(db, 'Jane Doe');
  assert.equal(c.created, true);
  assert.notEqual(c.playerId, a.playerId);

  const count = (db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n;
  assert.equal(count, 2);
});

test('the first-seen display name is preserved on the canonical row', () => {
  const db = makeTestDb();
  resolveCanonicalPlayer(db, 'John Smith');
  resolveCanonicalPlayer(db, 'JOHN SMITH');
  const row = db.prepare('SELECT display_name FROM players').get() as {
    display_name: string;
  };
  assert.equal(row.display_name, 'John Smith');
});
