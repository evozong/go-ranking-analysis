import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotOpenGothaError, parseOpenGotha, playerKey } from './openGotha.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, 'fixtures', 'sample.xml'), 'utf8');

test('playerKey is lastName+firstName, upper-cased, whitespace stripped', () => {
  assert.equal(playerKey('Smith', 'John'), 'SMITHJOHN');
  assert.equal(playerKey('van der Berg', 'Jan Willem'), 'VANDERBERGJANWILLEM');
});

test('parses event name and begin date', () => {
  const t = parseOpenGotha(sample);
  assert.equal(t.name, 'Spring Open 2024');
  assert.equal(t.date, '2024-03-15');
});

test('parses every player with raw details and an og_key', () => {
  const t = parseOpenGotha(sample);
  assert.equal(t.players.length, 4);
  const john = t.players.find((p) => p.ogKey === 'SMITHJOHN');
  assert.ok(john);
  assert.equal(john!.firstName, 'John');
  assert.equal(john!.lastName, 'Smith');
  assert.equal(john!.displayName, 'John Smith');
  assert.equal(john!.rank, '5D');
  assert.equal(john!.club, 'ABCD');
  assert.equal(john!.egfPin, '11111111');
});

test('parses games including one jigo and one by-default', () => {
  const t = parseOpenGotha(sample);
  // 5 <Game> rows + 1 bye
  assert.equal(t.games.length, 6);

  const jigo = t.games.find((g) => g.outcome.type === 'draw');
  assert.ok(jigo);
  assert.equal(jigo!.outcome.isGame, true);

  const bydef = t.games.find((g) => g.outcome.type === 'forfeit');
  assert.ok(bydef);
  assert.equal(bydef!.outcome.isGame, false);
  assert.equal(bydef!.outcome.winnerColor, 'white');

  const bye = t.games.find((g) => g.outcome.type === 'bye');
  assert.ok(bye);
  assert.equal(bye!.blackKey, null);
  assert.equal(bye!.whiteKey, 'ADAMSAMY');
  assert.equal(bye!.outcome.isGame, false);
});

test('rejects files that are not OpenGotha tournaments', () => {
  assert.throws(() => parseOpenGotha('<html><body>nope</body></html>'), NotOpenGothaError);
  assert.throws(() => parseOpenGotha('not even xml <<<'), NotOpenGothaError);
  assert.throws(
    () => parseOpenGotha('<Tournament><Players></Players></Tournament>'),
    NotOpenGothaError,
  );
});
