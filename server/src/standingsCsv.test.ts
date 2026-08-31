import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import {
  buildOpenGothaXml,
  downloadFilename,
  parseStandingsTable,
  StandingsParseError,
  type StandingsTable,
} from './standingsCsv.js';
import { parseOpenGotha } from './openGotha.js';
import { importTournament } from './importTournament.js';
import { makeTestDb } from './testdb.js';

// standings-sample.csv is a FULLY SYNTHETIC fixture built by
// fixtures/standings-sample.gen.py: 13 invented players (an ODD field, so every
// fully-paired round yields a real `0+` bye), 5 rounds, deterministic Swiss-ish
// pairing. Exercises comma-in-name rows, a single-round absence (`0-` ->
// participating bit 0), the odd-field byes, and one forced `=` jigo. No real
// tournament data.
const here = dirname(fileURLToPath(import.meta.url));
const sampleCsv = readFileSync(
  join(here, 'fixtures', 'standings-sample.csv'),
  'utf8',
);

const attrs = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
});

function convert(csv: string, name = 'Synthetic Open', date = '2025-04-19') {
  const table = parseStandingsTable(csv);
  const xml = buildOpenGothaXml(table, { name, date });
  return { table, xml, parsed: parseOpenGotha(xml) };
}

function byeCount(table: StandingsTable): number {
  return table.cells.flat().filter((c) => c.opp === 0 && c.result === '+').length;
}

function gameCount(table: StandingsTable): number {
  let n = 0;
  table.cells.forEach((row, pi) => {
    row.forEach((c) => {
      if (c.opp > pi + 1) n++; // count each real pairing once, from the low side
    });
  });
  return n;
}

test('converts the sample: 13 players, 5 rounds, round-trips through parseOpenGotha', () => {
  const { table, xml, parsed } = convert(sampleCsv);

  assert.equal(table.rounds, 5);
  assert.equal(table.players.length, 13);
  assert.equal(parsed.players.length, 13);

  const root = attrs.parse(xml);
  assert.equal(
    root.Tournament.TournamentParameterSet.GeneralParameterSet['@_numberOfRounds'],
    '5',
  );
  const playerEls = root.Tournament.Players.Player;
  assert.equal(playerEls.length, 13);
  for (const el of playerEls) {
    assert.equal(String(el['@_participating']).length, 5);
  }
});

test('the odd field forces a bye every fully-paired round; each `0+` becomes one bye game', () => {
  const { table, parsed } = convert(sampleCsv);
  const byes = parsed.games.filter((g) => g.outcome.type === 'bye');
  assert.equal(byes.length, byeCount(table));
  assert.equal(byes.length, 4); // rounds 1,2,4,5 (round 3 has an even field)

  // Rae Quinn (num 9) takes the round-5 bye.
  const rae = byes.find((g) => g.whiteKey === 'RAEQUINN');
  assert.ok(rae);
  assert.equal(rae!.roundNumber, 5);
  assert.equal(rae!.blackKey, null);
  assert.equal(rae!.outcome.isGame, false);
});

test('a `0-` round drops the game and clears the participating bit', () => {
  const { xml, parsed } = convert(sampleCsv);
  const root = attrs.parse(xml);
  const will = root.Tournament.Players.Player.find(
    (p: any) => p['@_name'] === 'Will Yorke',
  );
  // Will Yorke sat out round 3 only.
  assert.equal(will['@_participating'], '11011');

  const rounds = parsed.games
    .filter((g) => g.whiteKey === 'WILLYORKE' || g.blackKey === 'WILLYORKE')
    .map((g) => g.roundNumber)
    .sort();
  assert.deepEqual(rounds, [1, 2, 4, 5]); // round 1 is the bye; no round-3 entry
});

test('a mirrored pairing is emitted once, winner as Black', () => {
  const { parsed } = convert(sampleCsv);
  // Eve Frost (3) beat Gus Hale (4) in round 1; both rows record it.
  const pair = parsed.games.filter(
    (g) =>
      g.roundNumber === 1 &&
      [g.whiteKey, g.blackKey].includes('EVEFROST') &&
      [g.whiteKey, g.blackKey].includes('GUSHALE'),
  );
  assert.equal(pair.length, 1);
  assert.equal(pair[0].blackKey, 'EVEFROST'); // winner emitted as Black
  assert.equal(pair[0].whiteKey, 'GUSHALE');
  assert.equal(pair[0].outcome.winnerColor, 'black');
});

test('comma-in-name rows parse as a single field and keep the comma in the key', () => {
  const { table, parsed } = convert(sampleCsv);
  assert.ok(table.players.some((p) => p.name === 'Kwan Yat Hei, George'));
  assert.ok(table.players.some((p) => p.name === 'Tan Yu Xin, Benjamin'));
  assert.ok(parsed.players.some((p) => p.ogKey === 'KWANYATHEI,GEORGE'));
  assert.ok(parsed.players.some((p) => p.ogKey === 'TANYUXIN,BENJAMIN'));
});

test('a `=` cell yields a draw game with no winner', () => {
  // the fixture has exactly one jigo (Anna Bell vs Carl Dean, round 1)
  const { parsed: fromFixture } = convert(sampleCsv);
  const draws = fromFixture.games.filter((g) => g.outcome.type === 'draw');
  assert.equal(draws.length, 1);
  assert.equal(draws[0].outcome.winnerColor, null);

  const csv = [
    'Num,Pl,Name,Female,Rk,NbW,R1,NBW,SOS,SOSOS',
    '1,,Alice,false,30K,0,2=,0,0,0',
    '2,,Bob,false,30K,0,1=,0,0,0',
  ].join('\n');
  const { parsed } = convert(csv);
  assert.equal(parsed.games.length, 1);
  assert.equal(parsed.games[0].outcome.type, 'draw');
  assert.equal(parsed.games[0].outcome.isGame, true);
  assert.equal(parsed.games[0].outcome.winnerColor, null);
});

test('malformed inputs raise StandingsParseError', () => {
  const good = 'Num,Pl,Name,Female,Rk,NbW,R1,NBW,SOS,SOSOS';
  assert.throws(
    () => parseStandingsTable('Name,Rank\nAlice,30K'),
    StandingsParseError,
  ); // bad header
  assert.throws(
    () => parseStandingsTable(`${good}\n1,,Alice,false,30K,0,2+,0,0`),
    StandingsParseError,
  ); // ragged row (9 fields)
  assert.throws(
    () => parseStandingsTable(`${good}\n1,,Alice,false,30K,0,??,0,0,0`),
    StandingsParseError,
  ); // bad cell
  assert.throws(
    () =>
      parseStandingsTable(
        `${good}\n2,,Alice,false,30K,0,2+,0,0,0\n1,,Bob,false,30K,0,1-,0,0,0`,
      ),
    StandingsParseError,
  ); // Num not sequential
  assert.throws(
    () =>
      parseStandingsTable(
        `${good}\n1,,Al Ice,false,30K,0,2-,0,0,0\n2,,Al  Ice,false,30K,0,1+,0,0,0`,
      ),
    StandingsParseError,
  ); // duplicate normalized key
});

test('downloadFilename is "<yyyymmdd> <name> opengotha.xml"', () => {
  assert.equal(
    downloadFilename('Go Academy Intermediate', '2025-04-19'),
    '20250419 Go Academy Intermediate opengotha.xml',
  );
  // no date -> stamp omitted
  assert.equal(
    downloadFilename('Spring Cup', null),
    'Spring Cup opengotha.xml',
  );
  // filename-illegal characters are stripped, inner punctuation/spaces kept
  assert.equal(
    downloadFilename('  A/B: "Champs"  ', '2025-01-02'),
    '20250102 AB Champs opengotha.xml',
  );
});

test('DB import of the converted sample records every player, game and bye', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);

  const { table, xml } = convert(sampleCsv);
  const summary = await importTournament(db, Buffer.from(xml, 'utf8'));

  assert.equal(summary.eventPlayers, 13);
  assert.equal(summary.nonGames, byeCount(table));
  assert.equal(summary.nonGames, 4);
  assert.equal(summary.gamesInserted, gameCount(table) + byeCount(table));
  assert.equal(summary.gamesInserted, 34);
});
