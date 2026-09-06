// Pure standings computation: no McMahon initial band is imported (every
// player is assumed to start the event at the same score), so "standings"
// here is a plain win-count ranking. 1 point per win (including a bye or a
// forfeit win), 0.5 for a draw, 0 otherwise. SOS/SOSOS are the standard sum
// of (real) opponents' final score / SOS, excluding bye rounds.

export interface StandingsCell {
  opponentName: string | null; // null for a bye
  label: string; // "Win" | "Loss" | "Draw" | "Bye" | "Forfeit win" | "Forfeit loss" | "Both win" | "Both lose" | "No result"
  points: number; // 0, 0.5, or 1
}

export interface StandingsRow {
  eventPlayerId: number;
  playerId: number;
  name: string;
  rank: string | null;
  score: number;
  sos: number;
  sosos: number;
  rounds: (StandingsCell | null)[]; // index 0 = round 1; length === StandingsTable.rounds
}

export interface StandingsTable {
  rounds: number;
  rows: StandingsRow[];
}

export interface StandingsPlayerInput {
  eventPlayerId: number;
  playerId: number;
  name: string;
  rank: string | null;
}

export interface StandingsGameInput {
  roundNumber: number | null;
  whiteId: number;
  blackId: number | null;
  winnerId: number | null;
  resultType: string;
}

function cellLabel(resultType: string, points: number): string {
  switch (resultType) {
    case 'game':
      return points === 1 ? 'Win' : 'Loss';
    case 'draw':
      return 'Draw';
    case 'forfeit':
      return points === 1 ? 'Forfeit win' : 'Forfeit loss';
    case 'both_win':
      return 'Both win';
    case 'both_lose':
      return 'Both lose';
    case 'no_result':
      return 'No result';
    default:
      return resultType;
  }
}

export function computeStandings(
  players: StandingsPlayerInput[],
  games: StandingsGameInput[],
): StandingsTable {
  const nameOf = new Map(players.map((p) => [p.eventPlayerId, p.name]));
  const rounds = games.reduce((m, g) => Math.max(m, g.roundNumber ?? 0), 0);

  const score = new Map<number, number>(players.map((p) => [p.eventPlayerId, 0]));
  const opponents = new Map<number, number[]>(players.map((p) => [p.eventPlayerId, []]));
  const cells = new Map<number, Map<number, StandingsCell>>();
  for (let rd = 1; rd <= rounds; rd++) cells.set(rd, new Map());

  const addScore = (id: number, pts: number): void =>
    void score.set(id, (score.get(id) ?? 0) + pts);
  const setCell = (rd: number | null, id: number, cell: StandingsCell): void => {
    if (rd != null) cells.get(rd)?.set(id, cell);
  };

  for (const g of games) {
    if (g.blackId == null) {
      addScore(g.whiteId, 1);
      setCell(g.roundNumber, g.whiteId, { opponentName: null, label: 'Bye', points: 1 });
      continue;
    }

    let whitePts = 0;
    let blackPts = 0;
    switch (g.resultType) {
      case 'game':
      case 'forfeit':
        whitePts = g.winnerId === g.whiteId ? 1 : 0;
        blackPts = g.winnerId === g.blackId ? 1 : 0;
        break;
      case 'draw':
        whitePts = blackPts = 0.5;
        break;
      case 'both_win':
        whitePts = blackPts = 1;
        break;
      default: // both_lose, no_result
        whitePts = blackPts = 0;
    }
    addScore(g.whiteId, whitePts);
    addScore(g.blackId, blackPts);
    opponents.get(g.whiteId)?.push(g.blackId);
    opponents.get(g.blackId)?.push(g.whiteId);

    setCell(g.roundNumber, g.whiteId, {
      opponentName: nameOf.get(g.blackId) ?? null,
      label: cellLabel(g.resultType, whitePts),
      points: whitePts,
    });
    setCell(g.roundNumber, g.blackId, {
      opponentName: nameOf.get(g.whiteId) ?? null,
      label: cellLabel(g.resultType, blackPts),
      points: blackPts,
    });
  }

  const sos = new Map<number, number>();
  for (const p of players) {
    const opp = opponents.get(p.eventPlayerId) ?? [];
    sos.set(p.eventPlayerId, opp.reduce((sum, oid) => sum + (score.get(oid) ?? 0), 0));
  }
  const sosos = new Map<number, number>();
  for (const p of players) {
    const opp = opponents.get(p.eventPlayerId) ?? [];
    sosos.set(p.eventPlayerId, opp.reduce((sum, oid) => sum + (sos.get(oid) ?? 0), 0));
  }

  const rows: StandingsRow[] = players.map((p) => ({
    eventPlayerId: p.eventPlayerId,
    playerId: p.playerId,
    name: p.name,
    rank: p.rank,
    score: score.get(p.eventPlayerId) ?? 0,
    sos: sos.get(p.eventPlayerId) ?? 0,
    sosos: sosos.get(p.eventPlayerId) ?? 0,
    rounds: Array.from(
      { length: rounds },
      (_, i) => cells.get(i + 1)?.get(p.eventPlayerId) ?? null,
    ),
  }));

  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.sos - a.sos ||
      b.sosos - a.sosos ||
      a.name.localeCompare(b.name),
  );

  return { rounds, rows };
}
