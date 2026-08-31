import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteEvent,
  DeleteEventError,
  findDuplicateHints,
  getPlayerDetail,
  mergePlayers,
  MergeError,
} from './analysis.js';
import { resolveCanonicalPlayer } from './players.js';
import type { Queryable } from './db.js';
import { makeTestDb } from './testdb.js';

async function addEp(
  db: Queryable,
  eventId: number,
  playerId: number,
  key: string,
  extra: { egf_pin?: string } = {},
): Promise<number> {
  return (
    (
      await db.query(
        `INSERT INTO event_players (event_id, player_id, og_key, display_name, egf_pin)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [eventId, playerId, key, key, extra.egf_pin ?? null],
      )
    ).rows[0] as { id: number }
  ).id;
}

async function addGame(
  db: Queryable,
  eventId: number,
  white: number,
  black: number,
  winner: number | null,
): Promise<void> {
  await db.query(
    `INSERT INTO games
       (event_id, round_number, white_event_player_id, black_event_player_id,
        winner_event_player_id, is_game, result_type)
     VALUES ($1, 1, $2, $3, $4, 1, 'game')`,
    [eventId, white, black, winner],
  );
}

test('mergePlayers repoints event_players onto the keeper and deletes merged rows', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  const a = (await resolveCanonicalPlayer(db, 'Ann Lee')).playerId;
  const b = (await resolveCanonicalPlayer(db, 'Anna Lee')).playerId;
  const keep = (await resolveCanonicalPlayer(db, 'Bob Fox')).playerId;

  await addEp(db, 1, a, 'a1');
  await addEp(db, 2, a, 'a2');
  await addEp(db, 1, b, 'b1');
  await addEp(db, 2, b, 'b2');
  await addEp(db, 1, keep, 'k1');

  const res = await mergePlayers(db, keep, [a, b]);
  assert.equal(res.keepId, keep);
  assert.equal(res.keepName, 'Bob Fox');
  assert.equal(res.mergedCount, 2);
  assert.equal(res.movedEventPlayers, 4);

  const gone = (
    await db.query('SELECT COUNT(*)::int AS n FROM players WHERE id IN ($1, $2)', [a, b])
  ).rows[0] as { n: number };
  assert.equal(gone.n, 0);

  const onKeeper = (
    await db.query('SELECT COUNT(*)::int AS n FROM event_players WHERE player_id = $1', [
      keep,
    ])
  ).rows[0] as { n: number };
  assert.equal(onKeeper.n, 5);
});

test('deleteEvent removes the event, its games/event_players, and orphaned canonical players', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  const evId = (
    await db.query(
      "INSERT INTO events (name, source_hash) VALUES ('Cup', 'test-hash') RETURNING id",
    )
  ).rows[0].id as number;

  const solo = (await resolveCanonicalPlayer(db, 'Solo Player')).playerId;
  const shared = (await resolveCanonicalPlayer(db, 'Shared Player')).playerId;

  const ep1 = await addEp(db, evId, solo, 's1');
  const ep2 = await addEp(db, evId, shared, 'h1');
  await addEp(db, 1, shared, 'h-open'); // `shared` also appears in a seeded event
  await addGame(db, evId, ep1, ep2, ep1);

  const res = await deleteEvent(db, evId);
  assert.deepEqual(res, {
    eventId: evId,
    deletedGames: 1,
    deletedEventPlayers: 2,
    deletedCanonicalPlayers: 1, // only `solo`; `shared` is still used by event 1
  });

  const count = async (sql: string, p: unknown[]) =>
    ((await db.query(sql, p)).rows[0] as { n: number }).n;
  assert.equal(await count('SELECT COUNT(*)::int n FROM events WHERE id = $1', [evId]), 0);
  assert.equal(await count('SELECT COUNT(*)::int n FROM games WHERE event_id = $1', [evId]), 0);
  assert.equal(await count('SELECT COUNT(*)::int n FROM players WHERE id = $1', [solo]), 0);
  assert.equal(await count('SELECT COUNT(*)::int n FROM players WHERE id = $1', [shared]), 1);
});

test('deleteEvent refuses the Open containers, non-imported events, and unknown ids', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  // ids 1 & 2 are "Open (Ranked)" / "Open (Unranked)"
  await assert.rejects(() => deleteEvent(db, 1), DeleteEventError);
  await assert.rejects(() => deleteEvent(db, 2), DeleteEventError);
  await assert.rejects(() => deleteEvent(db, 99999), DeleteEventError);

  // an event with no import source (NULL source_hash) is also protected
  const bare = (
    await db.query("INSERT INTO events (name) VALUES ('Manual') RETURNING id")
  ).rows[0].id as number;
  await assert.rejects(() => deleteEvent(db, bare), DeleteEventError);
  assert.equal(
    ((await db.query('SELECT COUNT(*)::int n FROM events WHERE id = $1', [bare])).rows[0] as { n: number }).n,
    1,
  );

  // the two Open rows are still there
  assert.equal(
    ((await db.query('SELECT COUNT(*)::int n FROM events WHERE id IN (1,2)')).rows[0] as { n: number }).n,
    2,
  );
});

test('mergePlayers rejects keepId inside mergeIds and unknown ids', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  const a = (await resolveCanonicalPlayer(db, 'Ann Lee')).playerId;
  const b = (await resolveCanonicalPlayer(db, 'Bob Fox')).playerId;

  await assert.rejects(() => mergePlayers(db, a, [a, b]), MergeError);
  await assert.rejects(() => mergePlayers(db, a, [999999]), MergeError);
  await assert.rejects(() => mergePlayers(db, 999999, [a]), MergeError);
  await assert.rejects(() => mergePlayers(db, a, []), MergeError);
});

test('findDuplicateHints flags similar names, shared EGF pins, and skips co-occurring pairs', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  const john = (await resolveCanonicalPlayer(db, 'John Smith')).playerId;
  const jon = (await resolveCanonicalPlayer(db, 'Jon Smith')).playerId;
  const zed = (await resolveCanonicalPlayer(db, 'Zed Alpha')).playerId;
  const yan = (await resolveCanonicalPlayer(db, 'Yan Beta')).playerId;
  const kate = (await resolveCanonicalPlayer(db, 'Kate Ray')).playerId;
  const kata = (await resolveCanonicalPlayer(db, 'Kata Ray')).playerId;
  const amyF = (await resolveCanonicalPlayer(db, 'Amy Lin (F)')).playerId;
  const amy = (await resolveCanonicalPlayer(db, 'Amy Lin')).playerId;
  const bo = (await resolveCanonicalPlayer(db, 'Bo (F)')).playerId;
  const cy = (await resolveCanonicalPlayer(db, 'Cy (F)')).playerId;

  // John / Jon: similar name, disjoint events -> name hint.
  await addEp(db, 1, john, 'john1');
  await addEp(db, 2, jon, 'jon2');

  // Zed / Yan: share an EGF pin across two events -> egf hint.
  await addEp(db, 1, zed, 'zed1', { egf_pin: '12345' });
  await addEp(db, 2, yan, 'yan2', { egf_pin: '12345' });

  // Kate / Kata: similar name but both play in event 1 -> suppressed.
  await addEp(db, 1, kate, 'kate1');
  await addEp(db, 1, kata, 'kata1');

  // "Amy Lin (F)" / "Amy Lin": same name once the CSV gender marker is dropped
  // -> name hint. Bo (F) / Cy (F): the shared marker must not by itself pull
  // two unrelated short names together.
  await addEp(db, 1, amyF, 'amyf1');
  await addEp(db, 2, amy, 'amy2');
  await addEp(db, 1, bo, 'bo1');
  await addEp(db, 2, cy, 'cy2');

  const hints = await findDuplicateHints(db);

  const nameHint = hints.find(
    (h) => h.reason === 'name' && h.playerIds.includes(john) && h.playerIds.includes(jon),
  );
  assert.ok(nameHint, 'expected a name hint for John / Jon Smith');

  const egfHint = hints.find((h) => h.reason === 'egf');
  assert.ok(egfHint, 'expected an egf hint');
  assert.deepEqual(
    [...egfHint!.playerIds].sort((x, y) => x - y),
    [zed, yan].sort((x, y) => x - y),
  );

  const suppressed = hints.some(
    (h) => h.playerIds.includes(kate) && h.playerIds.includes(kata),
  );
  assert.equal(suppressed, false, 'co-occurring pair must not produce a hint');

  const markerHint = hints.find(
    (h) =>
      h.reason === 'name' &&
      h.playerIds.includes(amyF) &&
      h.playerIds.includes(amy),
  );
  assert.ok(markerHint, 'expected a name hint for "Amy Lin (F)" / "Amy Lin"');

  const markerFalsePositive = hints.some(
    (h) => h.playerIds.includes(bo) && h.playerIds.includes(cy),
  );
  assert.equal(
    markerFalsePositive,
    false,
    'the shared " (F)" marker must not manufacture a hint',
  );
});

test('getPlayerDetail reports per-event wins and orders opponent records by wins', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  const k = (await resolveCanonicalPlayer(db, 'Keeper One')).playerId;
  const zoe = (await resolveCanonicalPlayer(db, 'Zoe Q')).playerId;
  const amy = (await resolveCanonicalPlayer(db, 'Amy Q')).playerId;

  const kEp = await addEp(db, 1, k, 'k');
  const zoeEp = await addEp(db, 1, zoe, 'zoe');
  const amyEp = await addEp(db, 1, amy, 'amy');

  // K beats Zoe 3-0, beats Amy 2-1. Both land in the winning section.
  await addGame(db, 1, kEp, zoeEp, kEp);
  await addGame(db, 1, kEp, zoeEp, kEp);
  await addGame(db, 1, kEp, zoeEp, kEp);
  await addGame(db, 1, kEp, amyEp, kEp);
  await addGame(db, 1, kEp, amyEp, kEp);
  await addGame(db, 1, kEp, amyEp, amyEp);

  const detail = (await getPlayerDetail(db, k))!;

  assert.equal(detail.events.length, 1);
  assert.equal(detail.events[0].gameCount, 6);
  assert.equal(detail.events[0].wins, 5);

  // wins DESC, then name: Zoe (3) before Amy (2), despite "Amy" sorting first.
  assert.deepEqual(
    detail.winning.map((r) => r.opponentName),
    ['Zoe Q', 'Amy Q'],
  );
});
