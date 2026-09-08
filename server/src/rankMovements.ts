// Per-round placement tracking. For every round r (1..rounds) we recompute the
// cumulative standings from all games played through round r and record each
// player's finishing position (1 = top). The result is one integer series per
// player — e.g. positions [6, 10, 8, 4, 3] means the player sat 6th after round
// 1, 10th after round 2, … 3rd after the final round. Series are ordered by
// final-round position so the caller can lay them out top-to-bottom directly.
//
// Tie-breaks and scoring match computeStandings exactly (it does the work): the
// "as of round r" SOS/SOSOS fall out naturally because only through-round-r
// games are fed in.

import {
  computeStandings,
  type StandingsGameInput,
  type StandingsPlayerInput,
} from './standings.js';

export interface RankMovementSeries {
  eventPlayerId: number;
  playerId: number;
  name: string;
  rank: string | null;
  finalPosition: number;
  positions: number[]; // index 0 = after round 1; length === rounds
}

export interface RankMovements {
  rounds: number;
  series: RankMovementSeries[]; // ordered by finalPosition, ascending
}

export function computeRankMovements(
  players: StandingsPlayerInput[],
  games: StandingsGameInput[],
): RankMovements {
  const rounds = games.reduce((m, g) => Math.max(m, g.roundNumber ?? 0), 0);

  if (rounds === 0 || players.length === 0) {
    return { rounds: Math.max(rounds, 0), series: [] };
  }

  const positions = new Map<number, number[]>(
    players.map((p) => [p.eventPlayerId, []]),
  );

  for (let rd = 1; rd <= rounds; rd++) {
    const throughRd = games.filter(
      (g) => g.roundNumber != null && g.roundNumber >= 1 && g.roundNumber <= rd,
    );
    const table = computeStandings(players, throughRd);
    table.rows.forEach((row, i) => {
      positions.get(row.eventPlayerId)?.push(i + 1);
    });
  }

  const series: RankMovementSeries[] = players.map((p) => {
    const pos = positions.get(p.eventPlayerId) ?? [];
    return {
      eventPlayerId: p.eventPlayerId,
      playerId: p.playerId,
      name: p.name,
      rank: p.rank,
      finalPosition: pos[pos.length - 1] ?? players.length,
      positions: pos,
    };
  });

  series.sort(
    (a, b) => a.finalPosition - b.finalPosition || a.name.localeCompare(b.name),
  );

  return { rounds, series };
}
