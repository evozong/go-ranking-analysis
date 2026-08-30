import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, resolveCanonicalPlayer } from './players.js';
import { makeTestDb } from './testdb.js';

test('normalizeName trims, collapses whitespace, lowercases', () => {
  assert.equal(normalizeName('  John   Smith '), 'john smith');
  assert.equal(normalizeName('JANE\tDOE'), 'jane doe');
});

test('resolveCanonicalPlayer creates on first sight, matches case-insensitively after', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  const a = await resolveCanonicalPlayer(db, 'John Smith');
  assert.equal(a.created, true);

  const b = await resolveCanonicalPlayer(db, '  john   SMITH ');
  assert.equal(b.created, false);
  assert.equal(b.playerId, a.playerId);

  const c = await resolveCanonicalPlayer(db, 'Jane Doe');
  assert.equal(c.created, true);
  assert.notEqual(c.playerId, a.playerId);

  const count = (
    (await db.query('SELECT COUNT(*)::int AS n FROM players')).rows[0] as { n: number }
  ).n;
  assert.equal(count, 2);
});

test('the first-seen display name is preserved on the canonical row', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  await resolveCanonicalPlayer(db, 'John Smith');
  await resolveCanonicalPlayer(db, 'JOHN SMITH');
  const row = (await db.query('SELECT display_name FROM players')).rows[0] as {
    display_name: string;
  };
  assert.equal(row.display_name, 'John Smith');
});
