import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRankMovements } from './rankMovements.js';
import type {
  StandingsGameInput,
  StandingsPlayerInput,
} from './standings.js';

const players: StandingsPlayerInput[] = [
  { eventPlayerId: 1, playerId: 1, name: 'A', rank: '1D' },
  { eventPlayerId: 2, playerId: 2, name: 'B', rank: '1D' },
  { eventPlayerId: 3, playerId: 3, name: 'C', rank: '1D' },
  { eventPlayerId: 4, playerId: 4, name: 'D', rank: '1D' },
];

test('tracks each player position after every round and orders by final position', () => {
  const games: StandingsGameInput[] = [
    // R1: A beats B, C beats D
    { roundNumber: 1, whiteId: 1, blackId: 2, winnerId: 1, resultType: 'game' },
    { roundNumber: 1, whiteId: 3, blackId: 4, winnerId: 3, resultType: 'game' },
    // R2: A beats C, B beats D  -> A 2-0, then C/B 1-1, D 0-2
    { roundNumber: 2, whiteId: 1, blackId: 3, winnerId: 1, resultType: 'game' },
    { roundNumber: 2, whiteId: 2, blackId: 4, winnerId: 2, resultType: 'game' },
    // R3: A beats D, C beats B -> A 3-0, C 2-1, B 1-2, D 0-3
    { roundNumber: 3, whiteId: 1, blackId: 4, winnerId: 1, resultType: 'game' },
    { roundNumber: 3, whiteId: 3, blackId: 2, winnerId: 3, resultType: 'game' },
  ];

  const mv = computeRankMovements(players, games);

  assert.equal(mv.rounds, 3);
  assert.deepEqual(
    mv.series.map((s) => s.name),
    ['A', 'C', 'B', 'D'],
  );
  const byName = new Map(mv.series.map((s) => [s.name, s]));
  assert.deepEqual(byName.get('A')!.positions, [1, 1, 1]);
  assert.deepEqual(byName.get('D')!.positions, [4, 4, 4]);
  // B: after R1 winners (A,C) rank above losers; A>B by SOS after R1 tie? all
  // 1-0 vs 0-1 -> B is 2nd or 3rd among {A,B}. After R2 B climbs to a 1-1 tie
  // with C, after R3 B falls to 3rd.
  assert.equal(byName.get('B')!.positions.length, 3);
  assert.equal(byName.get('B')!.finalPosition, 3);
  assert.equal(byName.get('C')!.finalPosition, 2);
});

test('returns empty series when there are no rounds', () => {
  assert.deepEqual(computeRankMovements(players, []), { rounds: 0, series: [] });
});

test('ignores games with a null round number', () => {
  const games: StandingsGameInput[] = [
    { roundNumber: 1, whiteId: 1, blackId: 2, winnerId: 1, resultType: 'game' },
    { roundNumber: null, whiteId: 3, blackId: 4, winnerId: 3, resultType: 'game' },
  ];
  const mv = computeRankMovements(players, games);
  assert.equal(mv.rounds, 1);
  assert.equal(mv.series.length, 4);
  assert.ok(mv.series.every((s) => s.positions.length === 1));
});

test('every player gets a position in every round even with no game that round', () => {
  const games: StandingsGameInput[] = [
    { roundNumber: 1, whiteId: 1, blackId: null, winnerId: null, resultType: 'bye' },
    { roundNumber: 2, whiteId: 2, blackId: 3, winnerId: 2, resultType: 'game' },
  ];
  const mv = computeRankMovements(players, games);
  assert.equal(mv.rounds, 2);
  for (const s of mv.series) {
    assert.equal(s.positions.length, 2);
    assert.ok(s.positions.every((p) => p >= 1 && p <= 4));
  }
  // Distinct positions 1..4 in each round.
  for (let r = 0; r < 2; r++) {
    const col = mv.series.map((s) => s.positions[r]).sort();
    assert.deepEqual(col, [1, 2, 3, 4]);
  }
});
