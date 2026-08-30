import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DuplicateImportError,
  importTournament,
} from './importTournament.js';
import {
  getMatchups,
  getPlayerDetail,
  getPlayerHistory,
  listEvents,
  listPlayers,
  remapEventPlayer,
} from './analysis.js';
import { makeTestDb, readFixture } from './testdb.js';

function canonicalId(db: any, normalized: string): number {
  return (
    db.prepare('SELECT id FROM players WHERE normalized_name = ?').get(normalized) as {
      id: number;
    }
  ).id;
}

test('imports a tournament and reports accurate counts', () => {
  const db = makeTestDb();
  const summary = importTournament(db, readFixture('sample.xml'));

  assert.equal(summary.name, 'Spring Open 2024');
  assert.equal(summary.date, '2024-03-15');
  assert.equal(summary.eventPlayers, 4);
  assert.equal(summary.playersCreated, 4);
  assert.equal(summary.playersMatched, 0);
  assert.equal(summary.gamesInserted, 6); // 5 games + 1 bye
  assert.equal(summary.nonGames, 2); // 1 by-default + 1 bye

  // seeded Open events remain, with NULL dates
  const opens = db
    .prepare("SELECT id, date FROM events WHERE id IN (1,2) ORDER BY id")
    .all() as { id: number; date: string | null }[];
  assert.deepEqual(opens, [
    { id: 1, date: null },
    { id: 2, date: null },
  ]);

  // jigo row
  const jigo = db
    .prepare("SELECT winner_event_player_id AS w FROM games WHERE result_type = 'draw'")
    .get() as { w: number | null };
  assert.equal(jigo.w, null);

  // by-default row
  const bydef = db
    .prepare("SELECT is_game FROM games WHERE result_type = 'forfeit'")
    .get() as { is_game: number };
  assert.equal(bydef.is_game, 0);
});

test('re-importing the identical file is rejected as a duplicate', () => {
  const db = makeTestDb();
  importTournament(db, readFixture('sample.xml'));
  let caught: unknown;
  try {
    importTournament(db, readFixture('sample.xml'));
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof DuplicateImportError);
  assert.equal((caught as DuplicateImportError).eventId, 3); // ids 1,2 seeded, 3 is first import
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 3);
});

test('a shared player across two files links to one canonical player', () => {
  const db = makeTestDb();
  importTournament(db, readFixture('sample.xml'));
  const second = importTournament(db, readFixture('sample2.xml'));

  assert.equal(second.playersMatched, 1); // "JOHN SMITH" matches "John Smith"
  assert.equal(second.playersCreated, 1); // "Carol King" is new

  const johnId = canonicalId(db, 'john smith');
  const links = db
    .prepare('SELECT COUNT(*) AS n FROM event_players WHERE player_id = ?')
    .get(johnId) as { n: number };
  assert.equal(links.n, 2); // one event_players row per event
});

test('player detail splits opponents into losing / even / winning with W–L', () => {
  const db = makeTestDb();
  importTournament(db, readFixture('sample.xml'));
  importTournament(db, readFixture('sample2.xml'));

  const johnId = canonicalId(db, 'john smith');
  const detail = getPlayerDetail(db, johnId)!;

  assert.equal(detail.player.name, 'John Smith');
  assert.equal(detail.events.length, 2);

  const winning = detail.winning.find((r) => r.opponentName === 'Jane Doe');
  assert.deepEqual(
    { w: winning?.wins, l: winning?.losses },
    { w: 1, l: 0 },
  );
  const losing = detail.losing.find((r) => r.opponentName === 'Bob Jones');
  assert.deepEqual({ w: losing?.wins, l: losing?.losses }, { w: 0, l: 1 });
  const even = detail.even.find((r) => r.opponentName === 'Carol King');
  assert.deepEqual({ w: even?.wins, l: even?.losses }, { w: 1, l: 1 });

  // Amy only ever met John via a by-default forfeit -> excluded from b/c/d
  const amyAnywhere = [...detail.losing, ...detail.even, ...detail.winning].some(
    (r) => r.opponentName === 'Amy Adams',
  );
  assert.equal(amyAnywhere, false);
});

test('history is reverse-chronological, spans events, and includes non-games', () => {
  const db = makeTestDb();
  importTournament(db, readFixture('sample.xml'));
  importTournament(db, readFixture('sample2.xml'));

  const johnId = canonicalId(db, 'john smith');
  const page = getPlayerHistory(db, johnId, 1);

  assert.equal(page.pageSize, 30);
  assert.equal(page.page, 1);
  assert.equal(page.hasMore, false);
  // 3 games in Spring + 2 in Autumn = 5 rows for John
  assert.equal(page.total, 5);
  assert.equal(page.items.length, 5);

  // newest first: Autumn Open 2024 (2024-10-11) before Spring Open 2024
  assert.equal(page.items[0].eventName, 'Autumn Open 2024');
  assert.equal(page.items.at(-1)!.eventName, 'Spring Open 2024');

  const forfeit = page.items.find((i) => i.resultType === 'forfeit');
  assert.ok(forfeit);
  assert.equal(forfeit!.outcome, 'nongame');
  assert.equal(forfeit!.opponentName, 'Amy Adams');
});

test('matchups requires a filter and returns canonical names', () => {
  const db = makeTestDb();
  const { eventId } = importTournament(db, readFixture('sample.xml'));

  assert.throws(() => getMatchups(db, {}));

  const rows = getMatchups(db, { event: eventId });
  assert.equal(rows.length, 6);
  const r1 = rows.find((r) => r.roundNumber === 1 && r.whiteName === 'John Smith');
  assert.equal(r1?.blackName, 'Jane Doe');
  assert.equal(r1?.winnerName, 'John Smith');
  assert.equal(r1?.resultType, 'game');

  const bye = rows.find((r) => r.resultType === 'bye');
  assert.equal(bye?.blackName, null);
});

test('remapEventPlayer repoints a mis-matched player without re-import', () => {
  const db = makeTestDb();
  importTournament(db, readFixture('sample.xml'));

  const bob = db
    .prepare("SELECT id, player_id FROM event_players WHERE og_key = 'JONESBOB'")
    .get() as { id: number; player_id: number };

  const res = remapEventPlayer(db, bob.id, { newName: 'Robert Jones' });
  assert.equal(res.playerName, 'Robert Jones');
  // Bob Jones had no other event_players -> the orphaned canonical row is removed
  assert.equal(res.deletedCanonicalPlayerId, bob.player_id);

  const johnId = canonicalId(db, 'john smith');
  const detail = getPlayerDetail(db, johnId)!;
  const losing = detail.losing.find((r) => r.opponentName === 'Robert Jones');
  assert.deepEqual({ w: losing?.wins, l: losing?.losses }, { w: 0, l: 1 });
  assert.equal(
    detail.losing.some((r) => r.opponentName === 'Bob Jones'),
    false,
  );
});

test('listPlayers / listEvents surface counts', () => {
  const db = makeTestDb();
  importTournament(db, readFixture('sample.xml'));

  const players = listPlayers(db);
  const john = players.find((p) => p.name === 'John Smith')!;
  assert.equal(john.eventCount, 1);
  assert.equal(john.gameCount, 2); // 2 real games (R1 win, R3 loss); forfeit excluded

  const events = listEvents(db).filter((e) => e.id > 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'Spring Open 2024');
  assert.equal(events[0].playerCount, 4);
  assert.equal(events[0].gameCount, 4); // 3 game + 1 draw; forfeit & bye excluded
});
