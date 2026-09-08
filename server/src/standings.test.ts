import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStandings,
  type StandingsGameInput,
  type StandingsPlayerInput,
} from './standings.js';

test('computeStandings scores wins/draws/byes/forfeits and ranks by score then SOS then SOSOS', () => {
  const players: StandingsPlayerInput[] = [
    { eventPlayerId: 1, playerId: 1, name: 'A', rank: '1D' },
    { eventPlayerId: 2, playerId: 2, name: 'B', rank: '1D' },
    { eventPlayerId: 3, playerId: 3, name: 'C', rank: '1D' },
    { eventPlayerId: 4, playerId: 4, name: 'D', rank: '1D' },
    { eventPlayerId: 5, playerId: 5, name: 'E', rank: '1D' },
  ];
  const games: StandingsGameInput[] = [
    // round 1
    { roundNumber: 1, whiteId: 1, blackId: 2, winnerId: 1, resultType: 'game' }, // A beats B
    { roundNumber: 1, whiteId: 3, blackId: 4, winnerId: 3, resultType: 'game' }, // C beats D
    { roundNumber: 1, whiteId: 5, blackId: null, winnerId: null, resultType: 'bye' }, // E bye
    // round 2
    { roundNumber: 2, whiteId: 1, blackId: 3, winnerId: null, resultType: 'draw' }, // A vs C draw
    { roundNumber: 2, whiteId: 2, blackId: 4, winnerId: 2, resultType: 'forfeit' }, // B forfeit-wins vs D
  ];

  const table = computeStandings(players, games);

  assert.equal(table.rounds, 2);

  const byName = Object.fromEntries(table.rows.map((r) => [r.name, r]));
  assert.equal(byName.A.score, 1.5);
  assert.equal(byName.B.score, 1);
  assert.equal(byName.C.score, 1.5);
  assert.equal(byName.D.score, 0);
  assert.equal(byName.E.score, 1);

  // SOS excludes bye rounds; E played no real opponent.
  assert.equal(byName.A.sos, 2.5); // score(B) + score(C) = 1 + 1.5
  assert.equal(byName.B.sos, 1.5); // score(A) + score(D) = 1.5 + 0
  assert.equal(byName.C.sos, 1.5); // score(D) + score(A) = 0 + 1.5
  assert.equal(byName.D.sos, 2.5); // score(C) + score(B) = 1.5 + 1
  assert.equal(byName.E.sos, 0);

  assert.equal(byName.A.sosos, 3); // sos(B) + sos(C) = 1.5 + 1.5
  assert.equal(byName.B.sosos, 5); // sos(A) + sos(D) = 2.5 + 2.5
  assert.equal(byName.E.sosos, 0);

  // Ranked by score desc, then SOS desc, then SOSOS desc.
  assert.deepEqual(
    table.rows.map((r) => r.name),
    ['A', 'C', 'B', 'E', 'D'],
  );

  // Round-by-round cells: win/loss/draw/forfeit/bye labels and opponent names.
  assert.deepEqual(byName.A.rounds[0], {
    opponentName: 'B',
    opponentPlayerId: 2,
    label: 'Win',
    points: 1,
  });
  assert.deepEqual(byName.B.rounds[0], {
    opponentName: 'A',
    opponentPlayerId: 1,
    label: 'Loss',
    points: 0,
  });
  assert.deepEqual(byName.E.rounds[0], {
    opponentName: null,
    opponentPlayerId: null,
    label: 'Bye',
    points: 1,
  });
  assert.deepEqual(byName.A.rounds[1], {
    opponentName: 'C',
    opponentPlayerId: 3,
    label: 'Draw',
    points: 0.5,
  });
  assert.deepEqual(byName.B.rounds[1], {
    opponentName: 'D',
    opponentPlayerId: 4,
    label: 'Forfeit win',
    points: 1,
  });
  assert.deepEqual(byName.D.rounds[1], {
    opponentName: 'B',
    opponentPlayerId: 2,
    label: 'Forfeit loss',
    points: 0,
  });
  // E has no round-2 cell (didn't play that round).
  assert.equal(byName.E.rounds[1], null);
});

test('computeStandings handles both_win, both_lose, and no_result', () => {
  const players: StandingsPlayerInput[] = [
    { eventPlayerId: 1, playerId: 1, name: 'P', rank: null },
    { eventPlayerId: 2, playerId: 2, name: 'Q', rank: null },
  ];
  const games: StandingsGameInput[] = [
    { roundNumber: 1, whiteId: 1, blackId: 2, winnerId: null, resultType: 'both_win' },
    { roundNumber: 2, whiteId: 1, blackId: 2, winnerId: null, resultType: 'both_lose' },
    { roundNumber: 3, whiteId: 1, blackId: 2, winnerId: null, resultType: 'no_result' },
  ];

  const table = computeStandings(players, games);
  const byName = Object.fromEntries(table.rows.map((r) => [r.name, r]));

  assert.equal(byName.P.score, 1);
  assert.equal(byName.Q.score, 1);
  assert.deepEqual(byName.P.rounds[0], {
    opponentName: 'Q',
    opponentPlayerId: 2,
    label: 'Both win',
    points: 1,
  });
  assert.deepEqual(byName.P.rounds[1], {
    opponentName: 'Q',
    opponentPlayerId: 2,
    label: 'Both lose',
    points: 0,
  });
  assert.deepEqual(byName.P.rounds[2], {
    opponentName: 'Q',
    opponentPlayerId: 2,
    label: 'No result',
    points: 0,
  });
});
