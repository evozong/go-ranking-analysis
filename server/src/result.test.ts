import test from 'node:test';
import assert from 'node:assert/strict';
import { mapResult } from './result.js';

test('white/black wins are real games with a winner', () => {
  assert.deepEqual(mapResult('RESULT_WHITEWINS'), {
    isGame: true,
    type: 'game',
    winnerColor: 'white',
    raw: 'RESULT_WHITEWINS',
  });
  assert.deepEqual(mapResult('RESULT_BLACKWINS'), {
    isGame: true,
    type: 'game',
    winnerColor: 'black',
    raw: 'RESULT_BLACKWINS',
  });
});

test('jigo is a real game, drawn, no winner', () => {
  const o = mapResult('RESULT_EQUAL');
  assert.equal(o.isGame, true);
  assert.equal(o.type, 'draw');
  assert.equal(o.winnerColor, null);
});

test('by-default results are non-games but keep a winner colour', () => {
  assert.equal(mapResult('RESULT_WHITEWINS_BYDEF').isGame, false);
  assert.equal(mapResult('RESULT_WHITEWINS_BYDEF').type, 'forfeit');
  assert.equal(mapResult('RESULT_WHITEWINS_BYDEF').winnerColor, 'white');
  assert.equal(mapResult('RESULT_BLACKWINS_BYDEF').winnerColor, 'black');
});

test('both-lose / both-win variants map to non-games with no winner', () => {
  for (const e of ['RESULT_BOTHLOSE', 'RESULT_BOTHLOSE_BYDEF']) {
    assert.equal(mapResult(e).type, 'both_lose');
    assert.equal(mapResult(e).isGame, false);
    assert.equal(mapResult(e).winnerColor, null);
  }
  for (const e of ['RESULT_BOTHWIN', 'RESULT_BOTHWIN_BYDEF']) {
    assert.equal(mapResult(e).type, 'both_win');
    assert.equal(mapResult(e).isGame, false);
  }
});

test('unknown / unexpected values fall back to no_result', () => {
  assert.equal(mapResult('RESULT_UNKNOWN').type, 'no_result');
  assert.equal(mapResult('SOMETHING_ELSE').type, 'no_result');
  assert.equal(mapResult('').type, 'no_result');
  assert.equal(mapResult(null).type, 'no_result');
});

test('matching is case-insensitive on the raw enum', () => {
  assert.equal(mapResult('result_whitewins').winnerColor, 'white');
});
