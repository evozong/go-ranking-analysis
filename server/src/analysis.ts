import type { Database } from 'better-sqlite3';
import { normalizeName, resolveCanonicalPlayer } from './players.js';

export const HISTORY_PAGE_SIZE = 30;

export interface PlayerListItem {
  id: number;
  name: string;
  gameCount: number;
  eventCount: number;
}

export function listPlayers(db: Database): PlayerListItem[] {
  return db
    .prepare(
      `SELECT p.id AS id, p.display_name AS name,
         (SELECT COUNT(*) FROM games g
            JOIN event_players wep ON wep.id = g.white_event_player_id
            LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
          WHERE g.is_game = 1
            AND (wep.player_id = p.id OR bep.player_id = p.id)) AS gameCount,
         (SELECT COUNT(DISTINCT ep.event_id) FROM event_players ep
          WHERE ep.player_id = p.id) AS eventCount
       FROM players p
       ORDER BY p.display_name COLLATE NOCASE`,
    )
    .all() as PlayerListItem[];
}

export interface OpponentRecord {
  opponentId: number;
  opponentName: string;
  wins: number;
  losses: number;
}

export interface PlayerDetail {
  player: { id: number; name: string };
  events: { eventId: number; eventName: string; date: string | null; gameCount: number }[];
  losing: OpponentRecord[];
  even: OpponentRecord[];
  winning: OpponentRecord[];
}

export function getPlayerDetail(db: Database, playerId: number): PlayerDetail | null {
  const player = db
    .prepare('SELECT id, display_name AS name FROM players WHERE id = ?')
    .get(playerId) as { id: number; name: string } | undefined;
  if (!player) return null;

  const events = db
    .prepare(
      `SELECT ep.event_id AS eventId, e.name AS eventName, e.date AS date,
         (SELECT COUNT(*) FROM games g
            JOIN event_players wep ON wep.id = g.white_event_player_id
            LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
          WHERE g.event_id = ep.event_id AND g.is_game = 1
            AND (wep.player_id = @pid OR bep.player_id = @pid)) AS gameCount
       FROM event_players ep
       JOIN events e ON e.id = ep.event_id
       WHERE ep.player_id = @pid
       ORDER BY e.date IS NULL, e.date DESC`,
    )
    .all({ pid: playerId }) as PlayerDetail['events'];

  const rollup = db
    .prepare(
      `WITH pg AS (
         SELECT
           CASE WHEN wep.player_id = @pid THEN bep.player_id ELSE wep.player_id END AS opponent_id,
           CASE WHEN (wep.player_id = @pid AND g.winner_event_player_id = wep.id)
                     OR (bep.player_id = @pid AND g.winner_event_player_id = bep.id)
                THEN 1 ELSE 0 END AS won
         FROM games g
         JOIN event_players wep ON wep.id = g.white_event_player_id
         JOIN event_players bep ON bep.id = g.black_event_player_id
         WHERE g.is_game = 1 AND g.result_type = 'game'
           AND (wep.player_id = @pid OR bep.player_id = @pid)
       )
       SELECT pg.opponent_id AS opponentId, p.display_name AS opponentName,
         SUM(pg.won) AS wins, SUM(1 - pg.won) AS losses
       FROM pg JOIN players p ON p.id = pg.opponent_id
       GROUP BY pg.opponent_id, p.display_name
       ORDER BY p.display_name COLLATE NOCASE`,
    )
    .all({ pid: playerId }) as OpponentRecord[];

  const losing: OpponentRecord[] = [];
  const even: OpponentRecord[] = [];
  const winning: OpponentRecord[] = [];
  for (const r of rollup) {
    if (r.losses > r.wins) losing.push(r);
    else if (r.losses === r.wins) even.push(r);
    else winning.push(r);
  }

  return { player, events, losing, even, winning };
}

export interface HistoryItem {
  eventId: number;
  eventName: string;
  date: string | null;
  roundNumber: number | null;
  opponentId: number | null;
  opponentName: string | null;
  outcome: 'win' | 'loss' | 'draw' | 'nongame';
  resultType: string;
}

export interface HistoryPage {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  items: HistoryItem[];
}

export function getPlayerHistory(
  db: Database,
  playerId: number,
  page: number,
): HistoryPage {
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const offset = (safePage - 1) * HISTORY_PAGE_SIZE;

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM games g
         JOIN event_players wep ON wep.id = g.white_event_player_id
         LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
         WHERE wep.player_id = @pid OR bep.player_id = @pid`,
      )
      .get({ pid: playerId }) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT
         g.event_id AS eventId, e.name AS eventName, e.date AS date,
         g.round_number AS roundNumber,
         CASE WHEN wep.player_id = @pid THEN bep.player_id ELSE wep.player_id END AS opponentId,
         CASE WHEN wep.player_id = @pid THEN bp.display_name ELSE wp.display_name END AS opponentName,
         g.is_game AS isGame, g.result_type AS resultType,
         g.winner_event_player_id AS winnerEpId,
         CASE WHEN wep.player_id = @pid THEN wep.id ELSE bep.id END AS myEpId
       FROM games g
       JOIN events e ON e.id = g.event_id
       JOIN event_players wep ON wep.id = g.white_event_player_id
       JOIN players wp ON wp.id = wep.player_id
       LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
       LEFT JOIN players bp ON bp.id = bep.player_id
       WHERE wep.player_id = @pid OR bep.player_id = @pid
       ORDER BY e.date IS NULL, e.date DESC, g.round_number DESC, g.id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all({ pid: playerId, limit: HISTORY_PAGE_SIZE, offset }) as any[];

  const items: HistoryItem[] = rows.map((r) => {
    let outcome: HistoryItem['outcome'];
    if (!r.isGame) outcome = 'nongame';
    else if (r.resultType === 'draw') outcome = 'draw';
    else if (r.winnerEpId === r.myEpId) outcome = 'win';
    else outcome = 'loss';
    return {
      eventId: r.eventId,
      eventName: r.eventName,
      date: r.date,
      roundNumber: r.roundNumber,
      opponentId: r.opponentId ?? null,
      opponentName: r.opponentName ?? null,
      outcome,
      resultType: r.resultType,
    };
  });

  return {
    page: safePage,
    pageSize: HISTORY_PAGE_SIZE,
    total,
    hasMore: offset + items.length < total,
    items,
  };
}

export interface EventListItem {
  id: number;
  name: string;
  date: string | null;
  gameCount: number;
  playerCount: number;
}

export function listEvents(db: Database): EventListItem[] {
  return db
    .prepare(
      `SELECT e.id, e.name, e.date,
         (SELECT COUNT(*) FROM games g WHERE g.event_id = e.id AND g.is_game = 1) AS gameCount,
         (SELECT COUNT(*) FROM event_players ep WHERE ep.event_id = e.id) AS playerCount
       FROM events e
       ORDER BY e.date IS NULL, e.date DESC, e.id DESC`,
    )
    .all() as EventListItem[];
}

export function getEvent(db: Database, eventId: number): EventListItem | null {
  return (
    (db
      .prepare(
        `SELECT e.id, e.name, e.date,
           (SELECT COUNT(*) FROM games g WHERE g.event_id = e.id AND g.is_game = 1) AS gameCount,
           (SELECT COUNT(*) FROM event_players ep WHERE ep.event_id = e.id) AS playerCount
         FROM events e WHERE e.id = ?`,
      )
      .get(eventId) as EventListItem | undefined) ?? null
  );
}

export interface EventPlayerRow {
  eventPlayerId: number;
  rawName: string;
  rank: string | null;
  canonicalPlayerId: number | null;
  canonicalName: string | null;
}

export function getEventPlayers(db: Database, eventId: number): EventPlayerRow[] {
  return db
    .prepare(
      `SELECT ep.id AS eventPlayerId, ep.display_name AS rawName, ep.rank AS rank,
         ep.player_id AS canonicalPlayerId, p.display_name AS canonicalName
       FROM event_players ep
       LEFT JOIN players p ON p.id = ep.player_id
       WHERE ep.event_id = ?
       ORDER BY ep.display_name COLLATE NOCASE`,
    )
    .all(eventId) as EventPlayerRow[];
}

export interface MatchupRow {
  eventId: number;
  eventName: string;
  date: string | null;
  roundNumber: number | null;
  whiteName: string | null;
  blackName: string | null;
  winnerName: string | null;
  resultType: string;
}

export function getMatchups(
  db: Database,
  filter: { player?: number; event?: number },
): MatchupRow[] {
  const clauses: string[] = [];
  const params: Record<string, number> = {};
  if (filter.player !== undefined) {
    clauses.push('(wep.player_id = @player OR bep.player_id = @player)');
    params.player = filter.player;
  }
  if (filter.event !== undefined) {
    clauses.push('g.event_id = @event');
    params.event = filter.event;
  }
  if (clauses.length === 0) {
    throw new Error('getMatchups requires at least one of player / event');
  }

  return db
    .prepare(
      `SELECT
         g.event_id AS eventId, e.name AS eventName, e.date AS date,
         g.round_number AS roundNumber,
         wp.display_name AS whiteName,
         bp.display_name AS blackName,
         winp.display_name AS winnerName,
         g.result_type AS resultType
       FROM games g
       JOIN events e ON e.id = g.event_id
       JOIN event_players wep ON wep.id = g.white_event_player_id
       JOIN players wp ON wp.id = wep.player_id
       LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
       LEFT JOIN players bp ON bp.id = bep.player_id
       LEFT JOIN event_players winep ON winep.id = g.winner_event_player_id
       LEFT JOIN players winp ON winp.id = winep.player_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY e.date IS NULL, e.date DESC, g.round_number DESC, g.id DESC`,
    )
    .all(params) as MatchupRow[];
}

export class RemapError extends Error {}

export interface RemapResult {
  eventPlayerId: number;
  playerId: number;
  playerName: string;
  deletedCanonicalPlayerId: number | null;
}

// Repoint one event_players row to another canonical player.
// Body is either { playerId } (existing canonical) or { newName } (create fresh).
export function remapEventPlayer(
  db: Database,
  eventPlayerId: number,
  body: { playerId?: number; newName?: string },
): RemapResult {
  const run = db.transaction((): RemapResult => {
    const ep = db
      .prepare('SELECT id, player_id FROM event_players WHERE id = ?')
      .get(eventPlayerId) as { id: number; player_id: number | null } | undefined;
    if (!ep) throw new RemapError('event player not found');

    let targetId: number;
    if (typeof body.newName === 'string' && body.newName.trim() !== '') {
      targetId = resolveCanonicalPlayer(db, body.newName).playerId;
    } else if (typeof body.playerId === 'number') {
      const exists = db
        .prepare('SELECT id FROM players WHERE id = ?')
        .get(body.playerId) as { id: number } | undefined;
      if (!exists) throw new RemapError('target canonical player not found');
      targetId = body.playerId;
    } else {
      throw new RemapError('provide either playerId or newName');
    }

    db.prepare('UPDATE event_players SET player_id = ? WHERE id = ?').run(
      targetId,
      eventPlayerId,
    );

    // Clean up the previously-linked canonical player if it is now orphaned.
    let deletedCanonicalPlayerId: number | null = null;
    const prev = ep.player_id;
    if (prev !== null && prev !== targetId) {
      const stillUsed = db
        .prepare('SELECT 1 FROM event_players WHERE player_id = ? LIMIT 1')
        .get(prev);
      if (!stillUsed) {
        db.prepare('DELETE FROM players WHERE id = ?').run(prev);
        deletedCanonicalPlayerId = prev;
      }
    }

    const playerName = (
      db.prepare('SELECT display_name AS n FROM players WHERE id = ?').get(targetId) as {
        n: string;
      }
    ).n;

    return { eventPlayerId, playerId: targetId, playerName, deletedCanonicalPlayerId };
  });

  return run();
}

// Exported for tests.
export { normalizeName };
