import type { Pool } from 'pg';
import type { Queryable } from './dbTypes.js';
import { normalizeName, resolveCanonicalPlayer } from './players.js';
import { withTransaction } from './dbCore.js';

export const HISTORY_PAGE_SIZE = 30;

export interface PlayerListItem {
  id: number;
  name: string;
  gameCount: number;
  eventCount: number;
}

export async function listPlayers(db: Queryable): Promise<PlayerListItem[]> {
  const { rows } = await db.query<PlayerListItem>(
    `WITH participations AS (
       SELECT wep.player_id AS player_id FROM games g
         JOIN event_players wep ON wep.id = g.white_event_player_id
        WHERE g.is_game = 1 AND wep.player_id IS NOT NULL
       UNION ALL
       SELECT bep.player_id AS player_id FROM games g
         JOIN event_players bep ON bep.id = g.black_event_player_id
        WHERE g.is_game = 1 AND bep.player_id IS NOT NULL
     ),
     game_counts AS (
       SELECT player_id, COUNT(*) AS n FROM participations GROUP BY player_id
     ),
     event_counts AS (
       SELECT player_id, COUNT(DISTINCT event_id) AS n FROM event_players
        WHERE player_id IS NOT NULL GROUP BY player_id
     )
     SELECT p.id AS id, p.display_name AS name,
       COALESCE(gc.n, 0)::int AS "gameCount",
       COALESCE(ec.n, 0)::int AS "eventCount"
     FROM players p
     LEFT JOIN game_counts gc ON gc.player_id = p.id
     LEFT JOIN event_counts ec ON ec.player_id = p.id
     ORDER BY LOWER(p.display_name)`,
  );
  return rows;
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

export async function getPlayerDetail(
  db: Queryable,
  playerId: number,
): Promise<PlayerDetail | null> {
  const playerRes = await db.query<{ id: number; name: string }>(
    'SELECT id, display_name AS name FROM players WHERE id = $1',
    [playerId],
  );
  const player = playerRes.rows[0];
  if (!player) return null;

  const eventsRes = await db.query<PlayerDetail['events'][number]>(
    `WITH participations AS (
       SELECT g.event_id AS event_id FROM games g
         JOIN event_players wep ON wep.id = g.white_event_player_id
        WHERE g.is_game = 1 AND wep.player_id = $1
       UNION ALL
       SELECT g.event_id AS event_id FROM games g
         JOIN event_players bep ON bep.id = g.black_event_player_id
        WHERE g.is_game = 1 AND bep.player_id = $1
     ),
     game_counts AS (
       SELECT event_id, COUNT(*) AS n FROM participations GROUP BY event_id
     )
     SELECT ep.event_id AS "eventId", e.name AS "eventName", e.date AS date,
       COALESCE(gc.n, 0)::int AS "gameCount"
     FROM event_players ep
     JOIN events e ON e.id = ep.event_id
     LEFT JOIN game_counts gc ON gc.event_id = ep.event_id
     WHERE ep.player_id = $1
     ORDER BY e.date IS NULL, e.date DESC`,
    [playerId],
  );

  const rollupRes = await db.query<OpponentRecord>(
    `WITH pg AS (
       SELECT
         CASE WHEN wep.player_id = $1 THEN bep.player_id ELSE wep.player_id END AS opponent_id,
         CASE WHEN (wep.player_id = $1 AND g.winner_event_player_id = wep.id)
                   OR (bep.player_id = $1 AND g.winner_event_player_id = bep.id)
              THEN 1 ELSE 0 END AS won
       FROM games g
       JOIN event_players wep ON wep.id = g.white_event_player_id
       JOIN event_players bep ON bep.id = g.black_event_player_id
       WHERE g.is_game = 1 AND g.result_type = 'game'
         AND (wep.player_id = $1 OR bep.player_id = $1)
     )
     SELECT pg.opponent_id AS "opponentId", p.display_name AS "opponentName",
       SUM(pg.won)::int AS wins, SUM(1 - pg.won)::int AS losses
     FROM pg JOIN players p ON p.id = pg.opponent_id
     GROUP BY pg.opponent_id, p.display_name
     ORDER BY LOWER(p.display_name)`,
    [playerId],
  );

  const losing: OpponentRecord[] = [];
  const even: OpponentRecord[] = [];
  const winning: OpponentRecord[] = [];
  for (const r of rollupRes.rows) {
    if (r.losses > r.wins) losing.push(r);
    else if (r.losses === r.wins) even.push(r);
    else winning.push(r);
  }

  return { player, events: eventsRes.rows, losing, even, winning };
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

export async function getPlayerHistory(
  db: Queryable,
  playerId: number,
  page: number,
): Promise<HistoryPage> {
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const offset = (safePage - 1) * HISTORY_PAGE_SIZE;

  const totalRes = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM games g
     JOIN event_players wep ON wep.id = g.white_event_player_id
     LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
     WHERE wep.player_id = $1 OR bep.player_id = $1`,
    [playerId],
  );
  const total = totalRes.rows[0].n;

  const rowsRes = await db.query<any>(
    `SELECT
       g.event_id AS "eventId", e.name AS "eventName", e.date AS date,
       g.round_number AS "roundNumber",
       CASE WHEN wep.player_id = $1 THEN bep.player_id ELSE wep.player_id END AS "opponentId",
       CASE WHEN wep.player_id = $1 THEN bp.display_name ELSE wp.display_name END AS "opponentName",
       g.is_game AS "isGame", g.result_type AS "resultType",
       g.winner_event_player_id AS "winnerEpId",
       CASE WHEN wep.player_id = $1 THEN wep.id ELSE bep.id END AS "myEpId"
     FROM games g
     JOIN events e ON e.id = g.event_id
     JOIN event_players wep ON wep.id = g.white_event_player_id
     JOIN players wp ON wp.id = wep.player_id
     LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
     LEFT JOIN players bp ON bp.id = bep.player_id
     WHERE wep.player_id = $1 OR bep.player_id = $1
     ORDER BY e.date IS NULL, e.date DESC, g.round_number DESC, g.id DESC
     LIMIT $2 OFFSET $3`,
    [playerId, HISTORY_PAGE_SIZE, offset],
  );

  const items: HistoryItem[] = rowsRes.rows.map((r) => {
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

const EVENT_COUNTS_CTE = `
  WITH game_counts AS (
    SELECT event_id, COUNT(*) AS n FROM games WHERE is_game = 1 GROUP BY event_id
  ),
  player_counts AS (
    SELECT event_id, COUNT(*) AS n FROM event_players GROUP BY event_id
  )
`;

export async function listEvents(db: Queryable): Promise<EventListItem[]> {
  const { rows } = await db.query<EventListItem>(
    `${EVENT_COUNTS_CTE}
     SELECT e.id, e.name, e.date,
       COALESCE(gc.n, 0)::int AS "gameCount",
       COALESCE(pc.n, 0)::int AS "playerCount"
     FROM events e
     LEFT JOIN game_counts gc ON gc.event_id = e.id
     LEFT JOIN player_counts pc ON pc.event_id = e.id
     ORDER BY e.date IS NULL, e.date DESC, e.id DESC`,
  );
  return rows;
}

export async function getEvent(db: Queryable, eventId: number): Promise<EventListItem | null> {
  const { rows } = await db.query<EventListItem>(
    `${EVENT_COUNTS_CTE}
     SELECT e.id, e.name, e.date,
       COALESCE(gc.n, 0)::int AS "gameCount",
       COALESCE(pc.n, 0)::int AS "playerCount"
     FROM events e
     LEFT JOIN game_counts gc ON gc.event_id = e.id
     LEFT JOIN player_counts pc ON pc.event_id = e.id
     WHERE e.id = $1`,
    [eventId],
  );
  return rows[0] ?? null;
}

export interface EventPlayerRow {
  eventPlayerId: number;
  rawName: string;
  rank: string | null;
  canonicalPlayerId: number | null;
  canonicalName: string | null;
}

export async function getEventPlayers(db: Queryable, eventId: number): Promise<EventPlayerRow[]> {
  const { rows } = await db.query<EventPlayerRow>(
    `SELECT ep.id AS "eventPlayerId", ep.display_name AS "rawName", ep.rank AS rank,
       ep.player_id AS "canonicalPlayerId", p.display_name AS "canonicalName"
     FROM event_players ep
     LEFT JOIN players p ON p.id = ep.player_id
     WHERE ep.event_id = $1
     ORDER BY LOWER(ep.display_name)`,
    [eventId],
  );
  return rows;
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

export async function getMatchups(
  db: Queryable,
  filter: { player?: number; event?: number },
): Promise<MatchupRow[]> {
  const clauses: string[] = [];
  const params: number[] = [];
  if (filter.player !== undefined) {
    params.push(filter.player);
    clauses.push(`(wep.player_id = $${params.length} OR bep.player_id = $${params.length})`);
  }
  if (filter.event !== undefined) {
    params.push(filter.event);
    clauses.push(`g.event_id = $${params.length}`);
  }
  if (clauses.length === 0) {
    throw new Error('getMatchups requires at least one of player / event');
  }

  const { rows } = await db.query<MatchupRow>(
    `SELECT
       g.event_id AS "eventId", e.name AS "eventName", e.date AS date,
       g.round_number AS "roundNumber",
       wp.display_name AS "whiteName",
       bp.display_name AS "blackName",
       winp.display_name AS "winnerName",
       g.result_type AS "resultType"
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
    params,
  );
  return rows;
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
export async function remapEventPlayer(
  pool: Pool,
  eventPlayerId: number,
  body: { playerId?: number; newName?: string },
): Promise<RemapResult> {
  return withTransaction(pool, async (client) => {
    const epRes = await client.query<{ id: number; player_id: number | null }>(
      'SELECT id, player_id FROM event_players WHERE id = $1',
      [eventPlayerId],
    );
    const ep = epRes.rows[0];
    if (!ep) throw new RemapError('event player not found');

    let targetId: number;
    if (typeof body.newName === 'string' && body.newName.trim() !== '') {
      targetId = (await resolveCanonicalPlayer(client, body.newName)).playerId;
    } else if (typeof body.playerId === 'number') {
      const exists = await client.query('SELECT id FROM players WHERE id = $1', [body.playerId]);
      if (!exists.rows[0]) throw new RemapError('target canonical player not found');
      targetId = body.playerId;
    } else {
      throw new RemapError('provide either playerId or newName');
    }

    await client.query('UPDATE event_players SET player_id = $1 WHERE id = $2', [
      targetId,
      eventPlayerId,
    ]);

    // Clean up the previously-linked canonical player if it is now orphaned.
    let deletedCanonicalPlayerId: number | null = null;
    const prev = ep.player_id;
    if (prev !== null && prev !== targetId) {
      const stillUsed = await client.query(
        'SELECT 1 FROM event_players WHERE player_id = $1 LIMIT 1',
        [prev],
      );
      if (stillUsed.rows.length === 0) {
        await client.query('DELETE FROM players WHERE id = $1', [prev]);
        deletedCanonicalPlayerId = prev;
      }
    }

    const nameRes = await client.query<{ n: string }>(
      'SELECT display_name AS n FROM players WHERE id = $1',
      [targetId],
    );

    return {
      eventPlayerId,
      playerId: targetId,
      playerName: nameRes.rows[0].n,
      deletedCanonicalPlayerId,
    };
  });
}

// Exported for tests.
export { normalizeName };
