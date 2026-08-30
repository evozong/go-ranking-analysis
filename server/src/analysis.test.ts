import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicateHints,
  getPlayerDetail,
  mergePlayers,
  MergeError,
} from './analysis.js';
import { resolveCanonicalPlayer } from './players.js';
import { makeTestDb } from './testdb.js';

function addEp(
  db: any,
  eventId: number,
  playerId: number,
  key: string,
  extra: { egf_pin?: string } = {},
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO event_players (event_id, player_id, og_key, display_name, egf_pin)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(eventId, playerId, key, key, extra.egf_pin ?? null).lastInsertRowid,
  );
}

function addGame(
  db: any,
  eventId: number,
  white: number,
  black: number,
  winner: number | null,
): void {
  db.prepare(
    `INSERT INTO games
       (event_id, round_number, white_event_player_id, black_event_player_id,
        winner_event_player_id, is_game, result_type)
     VALUES (?, 1, ?, ?, ?, 1, 'game')`,
  ).run(eventId, white, black, winner);
}

test('mergePlayers repoints event_players onto the keeper and deletes merged rows', () => {
  const db = makeTestDb();
  const a = resolveCanonicalPlayer(db, 'Ann Lee').playerId;
  const b = resolveCanonicalPlayer(db, 'Anna Lee').playerId;
  const keep = resolveCanonicalPlayer(db, 'Bob Fox').playerId;

  addEp(db, 1, a, 'a1');
  addEp(db, 2, a, 'a2');
  addEp(db, 1, b, 'b1');
  addEp(db, 2, b, 'b2');
  addEp(db, 1, keep, 'k1');

  const res = mergePlayers(db, keep, [a, b]);
  assert.equal(res.keepId, keep);
  assert.equal(res.keepName, 'Bob Fox');
  assert.equal(res.mergedCount, 2);
  assert.equal(res.movedEventPlayers, 4);

  const gone = db
    .prepare('SELECT COUNT(*) AS n FROM players WHERE id IN (?, ?)')
    .get(a, b) as { n: number };
  assert.equal(gone.n, 0);

  const onKeeper = db
    .prepare('SELECT COUNT(*) AS n FROM event_players WHERE player_id = ?')
    .get(keep) as { n: number };
  assert.equal(onKeeper.n, 5);
});

test('mergePlayers rejects keepId inside mergeIds and unknown ids', () => {
  const db = makeTestDb();
  const a = resolveCanonicalPlayer(db, 'Ann Lee').playerId;
  const b = resolveCanonicalPlayer(db, 'Bob Fox').playerId;

  assert.throws(() => mergePlayers(db, a, [a, b]), MergeError);
  assert.throws(() => mergePlayers(db, a, [999999]), MergeError);
  assert.throws(() => mergePlayers(db, 999999, [a]), MergeError);
  assert.throws(() => mergePlayers(db, a, []), MergeError);
});

test('findDuplicateHints flags similar names, shared EGF pins, and skips co-occurring pairs', () => {
  const db = makeTestDb();
  const john = resolveCanonicalPlayer(db, 'John Smith').playerId;
  const jon = resolveCanonicalPlayer(db, 'Jon Smith').playerId;
  const zed = resolveCanonicalPlayer(db, 'Zed Alpha').playerId;
  const yan = resolveCanonicalPlayer(db, 'Yan Beta').playerId;
  const kate = resolveCanonicalPlayer(db, 'Kate Ray').playerId;
  const kata = resolveCanonicalPlayer(db, 'Kata Ray').playerId;

  // John / Jon: similar name, disjoint events -> name hint.
  addEp(db, 1, john, 'john1');
  addEp(db, 2, jon, 'jon2');

  // Zed / Yan: share an EGF pin across two events -> egf hint.
  addEp(db, 1, zed, 'zed1', { egf_pin: '12345' });
  addEp(db, 2, yan, 'yan2', { egf_pin: '12345' });

  // Kate / Kata: similar name but both play in event 1 -> suppressed.
  addEp(db, 1, kate, 'kate1');
  addEp(db, 1, kata, 'kata1');

  const hints = findDuplicateHints(db);

  const nameHint = hints.find(
    (h) => h.reason === 'name' && h.playerIds.includes(john) && h.playerIds.includes(jon),
  );
  assert.ok(nameHint, 'expected a name hint for John / Jon Smith');

  const egfHint = hints.find((h) => h.reason === 'egf');
  assert.ok(egfHint, 'expected an egf hint');
  assert.deepEqual([...egfHint!.playerIds].sort((x, y) => x - y), [zed, yan].sort((x, y) => x - y));

  const suppressed = hints.some(
    (h) => h.playerIds.includes(kate) && h.playerIds.includes(kata),
  );
  assert.equal(suppressed, false, 'co-occurring pair must not produce a hint');
});

test('getPlayerDetail reports per-event wins and orders opponent records by wins', () => {
  const db = makeTestDb();
  const k = resolveCanonicalPlayer(db, 'Keeper One').playerId;
  const zoe = resolveCanonicalPlayer(db, 'Zoe Q').playerId;
  const amy = resolveCanonicalPlayer(db, 'Amy Q').playerId;

  const kEp = addEp(db, 1, k, 'k');
  const zoeEp = addEp(db, 1, zoe, 'zoe');
  const amyEp = addEp(db, 1, amy, 'amy');

  // K beats Zoe 3-0, beats Amy 2-1. Both land in the winning section.
  addGame(db, 1, kEp, zoeEp, kEp);
  addGame(db, 1, kEp, zoeEp, kEp);
  addGame(db, 1, kEp, zoeEp, kEp);
  addGame(db, 1, kEp, amyEp, kEp);
  addGame(db, 1, kEp, amyEp, kEp);
  addGame(db, 1, kEp, amyEp, amyEp);

  const detail = getPlayerDetail(db, k)!;

  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0].gameCount, 6);
  assert.equal(detail.events[0].wins, 5);

  // wins DESC, then name: Zoe (3) before Amy (2), despite "Amy" sorting first.
  assert.deepEqual(
    detail.winning.map((r) => r.opponentName),
    ['Zoe Q', 'Amy Q'],
  );
});
