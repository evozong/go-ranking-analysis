import type { Db, Queryable } from './db.js';
import { withTransaction } from './db.js';
import { normalizeName, resolveCanonicalPlayer } from './players.js';

export const HISTORY_PAGE_SIZE = 30;

export interface PlayerListItem {
  id: number;
  name: string;
  gameCount: number;
  eventCount: number;
}

export async function listPlayers(db: Queryable): Promise<PlayerListItem[]> {
  return (
    await db.query(
      `SELECT p.id AS id, p.display_name AS name,
         (SELECT COUNT(*)::int FROM games g
            JOIN event_players wep ON wep.id = g.white_event_player_id
            LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
          WHERE g.is_game = 1
            AND (wep.player_id = p.id OR bep.player_id = p.id)) AS "gameCount",
         (SELECT COUNT(DISTINCT ep.event_id)::int FROM event_players ep
          WHERE ep.player_id = p.id) AS "eventCount"
       FROM players p
       ORDER BY lower(p.display_name)`,
    )
  ).rows as PlayerListItem[];
}

export interface OpponentRecord {
  opponentId: number;
  opponentName: string;
  wins: number;
  losses: number;
}

export interface PlayerDetail {
  player: { id: number; name: string };
  events: {
    eventId: number;
    eventName: string;
    date: string | null;
    gameCount: number;
    wins: number;
  }[];
  losing: OpponentRecord[];
  even: OpponentRecord[];
  winning: OpponentRecord[];
}

export async function getPlayerDetail(
  db: Queryable,
  playerId: number,
): Promise<PlayerDetail | null> {
  const player = (
    await db.query('SELECT id, display_name AS name FROM players WHERE id = $1', [
      playerId,
    ])
  ).rows[0] as { id: number; name: string } | undefined;
  if (!player) return null;

  const events = (
    await db.query(
      `WITH me AS (SELECT $1::int AS pid)
       SELECT ep.event_id AS "eventId", e.name AS "eventName", e.date AS date,
         (SELECT COUNT(*)::int FROM games g
            JOIN event_players wep ON wep.id = g.white_event_player_id
            LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
          WHERE g.event_id = ep.event_id AND g.is_game = 1
            AND (wep.player_id = (SELECT pid FROM me)
              OR bep.player_id = (SELECT pid FROM me))) AS "gameCount",
         (SELECT COUNT(*)::int FROM games g
            JOIN event_players wep ON wep.id = g.white_event_player_id
            LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
          WHERE g.event_id = ep.event_id AND g.is_game = 1 AND g.result_type = 'game'
            AND ((wep.player_id = (SELECT pid FROM me) AND g.winner_event_player_id = wep.id)
              OR (bep.player_id = (SELECT pid FROM me) AND g.winner_event_player_id = bep.id))) AS "wins"
       FROM event_players ep
       JOIN events e ON e.id = ep.event_id
       WHERE ep.player_id = (SELECT pid FROM me)
       ORDER BY e.date IS NULL, e.date DESC`,
      [playerId],
    )
  ).rows as PlayerDetail['events'];

  const rollup = (
    await db.query(
      `WITH me AS (SELECT $1::int AS pid),
       pg AS (
         SELECT
           CASE WHEN wep.player_id = (SELECT pid FROM me) THEN bep.player_id ELSE wep.player_id END AS opponent_id,
           CASE WHEN (wep.player_id = (SELECT pid FROM me) AND g.winner_event_player_id = wep.id)
                     OR (bep.player_id = (SELECT pid FROM me) AND g.winner_event_player_id = bep.id)
                THEN 1 ELSE 0 END AS won
         FROM games g
         JOIN event_players wep ON wep.id = g.white_event_player_id
         JOIN event_players bep ON bep.id = g.black_event_player_id
         WHERE g.is_game = 1 AND g.result_type = 'game'
           AND (wep.player_id = (SELECT pid FROM me) OR bep.player_id = (SELECT pid FROM me))
       )
       SELECT pg.opponent_id AS "opponentId", p.display_name AS "opponentName",
         SUM(pg.won)::int AS wins, SUM(1 - pg.won)::int AS losses
       FROM pg JOIN players p ON p.id = pg.opponent_id
       GROUP BY pg.opponent_id, p.display_name
       ORDER BY wins DESC, lower(p.display_name)`,
      [playerId],
    )
  ).rows as OpponentRecord[];

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

export async function getPlayerHistory(
  db: Queryable,
  playerId: number,
  page: number,
): Promise<HistoryPage> {
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const offset = (safePage - 1) * HISTORY_PAGE_SIZE;

  const total = (
    (
      await db.query(
        `WITH me AS (SELECT $1::int AS pid)
         SELECT COUNT(*)::int AS n FROM games g
         JOIN event_players wep ON wep.id = g.white_event_player_id
         LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
         WHERE wep.player_id = (SELECT pid FROM me) OR bep.player_id = (SELECT pid FROM me)`,
        [playerId],
      )
    ).rows[0] as { n: number }
  ).n;

  const rows = (
    await db.query(
      `WITH me AS (SELECT $1::int AS pid)
       SELECT
         g.event_id AS "eventId", e.name AS "eventName", e.date AS date,
         g.round_number AS "roundNumber",
         CASE WHEN wep.player_id = (SELECT pid FROM me) THEN bep.player_id ELSE wep.player_id END AS "opponentId",
         CASE WHEN wep.player_id = (SELECT pid FROM me) THEN bp.display_name ELSE wp.display_name END AS "opponentName",
         g.is_game AS "isGame", g.result_type AS "resultType",
         g.winner_event_player_id AS "winnerEpId",
         CASE WHEN wep.player_id = (SELECT pid FROM me) THEN wep.id ELSE bep.id END AS "myEpId"
       FROM games g
       JOIN events e ON e.id = g.event_id
       JOIN event_players wep ON wep.id = g.white_event_player_id
       JOIN players wp ON wp.id = wep.player_id
       LEFT JOIN event_players bep ON bep.id = g.black_event_player_id
       LEFT JOIN players bp ON bp.id = bep.player_id
       WHERE wep.player_id = (SELECT pid FROM me) OR bep.player_id = (SELECT pid FROM me)
       ORDER BY e.date IS NULL, e.date DESC, g.round_number DESC, g.id DESC
       LIMIT $2 OFFSET $3`,
      [playerId, HISTORY_PAGE_SIZE, offset],
    )
  ).rows as any[];

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

export async function listEvents(db: Queryable): Promise<EventListItem[]> {
  return (
    await db.query(
      `SELECT e.id, e.name, e.date,
         (SELECT COUNT(*)::int FROM games g WHERE g.event_id = e.id AND g.is_game = 1) AS "gameCount",
         (SELECT COUNT(*)::int FROM event_players ep WHERE ep.event_id = e.id) AS "playerCount"
       FROM events e
       ORDER BY e.date IS NULL, e.date DESC, e.id DESC`,
    )
  ).rows as EventListItem[];
}

export async function getEvent(
  db: Queryable,
  eventId: number,
): Promise<EventListItem | null> {
  return (
    ((
      await db.query(
        `SELECT e.id, e.name, e.date,
           (SELECT COUNT(*)::int FROM games g WHERE g.event_id = e.id AND g.is_game = 1) AS "gameCount",
           (SELECT COUNT(*)::int FROM event_players ep WHERE ep.event_id = e.id) AS "playerCount"
         FROM events e WHERE e.id = $1`,
        [eventId],
      )
    ).rows[0] as EventListItem | undefined) ?? null
  );
}

export interface EventPlayerRow {
  eventPlayerId: number;
  rawName: string;
  rank: string | null;
  canonicalPlayerId: number | null;
  canonicalName: string | null;
}

export async function getEventPlayers(
  db: Queryable,
  eventId: number,
): Promise<EventPlayerRow[]> {
  return (
    await db.query(
      `SELECT ep.id AS "eventPlayerId", ep.display_name AS "rawName", ep.rank AS rank,
         ep.player_id AS "canonicalPlayerId", p.display_name AS "canonicalName"
       FROM event_players ep
       LEFT JOIN players p ON p.id = ep.player_id
       WHERE ep.event_id = $1
       ORDER BY lower(ep.display_name)`,
      [eventId],
    )
  ).rows as EventPlayerRow[];
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
    const i = params.length;
    clauses.push(`(wep.player_id = $${i} OR bep.player_id = $${i})`);
  }
  if (filter.event !== undefined) {
    params.push(filter.event);
    clauses.push(`g.event_id = $${params.length}`);
  }
  if (clauses.length === 0) {
    throw new Error('getMatchups requires at least one of player / event');
  }

  return (
    await db.query(
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
    )
  ).rows as MatchupRow[];
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
  db: Db,
  eventPlayerId: number,
  body: { playerId?: number; newName?: string },
): Promise<RemapResult> {
  return withTransaction(db, async (client): Promise<RemapResult> => {
    const ep = (
      await client.query('SELECT id, player_id FROM event_players WHERE id = $1', [
        eventPlayerId,
      ])
    ).rows[0] as { id: number; player_id: number | null } | undefined;
    if (!ep) throw new RemapError('event player not found');

    let targetId: number;
    if (typeof body.newName === 'string' && body.newName.trim() !== '') {
      targetId = (await resolveCanonicalPlayer(client, body.newName)).playerId;
    } else if (typeof body.playerId === 'number') {
      const exists = (
        await client.query('SELECT id FROM players WHERE id = $1', [body.playerId])
      ).rows[0] as { id: number } | undefined;
      if (!exists) throw new RemapError('target canonical player not found');
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
      const stillUsed = (
        await client.query(
          'SELECT 1 FROM event_players WHERE player_id = $1 LIMIT 1',
          [prev],
        )
      ).rows[0];
      if (!stillUsed) {
        await client.query('DELETE FROM players WHERE id = $1', [prev]);
        deletedCanonicalPlayerId = prev;
      }
    }

    const playerName = (
      (
        await client.query('SELECT display_name AS n FROM players WHERE id = $1', [
          targetId,
        ])
      ).rows[0] as { n: string }
    ).n;

    return { eventPlayerId, playerId: targetId, playerName, deletedCanonicalPlayerId };
  });
}

export class MergeError extends Error {}

export interface MergeResult {
  keepId: number;
  keepName: string;
  mergedCount: number;
  movedEventPlayers: number;
}

// Merge one or more canonical players into a keeper: repoint every event_players
// row off the merged players onto `keepId`, then delete the now-empty canonical
// rows. Games are untouched — they reference event_players, not players.
export async function mergePlayers(
  db: Db,
  keepId: number,
  mergeIds: number[],
): Promise<MergeResult> {
  return withTransaction(db, async (client): Promise<MergeResult> => {
    const keeper = (
      await client.query('SELECT id, display_name AS name FROM players WHERE id = $1', [
        keepId,
      ])
    ).rows[0] as { id: number; name: string } | undefined;
    if (!keeper) throw new MergeError('keeper not found');

    const ids = [...new Set(mergeIds)];
    if (ids.length === 0) throw new MergeError('no players to merge');
    if (ids.includes(keepId)) throw new MergeError('keeper cannot also be merged');

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const found = (
      await client.query(`SELECT id FROM players WHERE id IN (${placeholders})`, ids)
    ).rows as { id: number }[];
    if (found.length !== ids.length) {
      throw new MergeError('one or more players to merge do not exist');
    }

    const mergePlaceholders = ids.map((_, i) => `$${i + 2}`).join(',');
    const movedEventPlayers =
      (
        await client.query(
          `UPDATE event_players SET player_id = $1 WHERE player_id IN (${mergePlaceholders})`,
          [keepId, ...ids],
        )
      ).rowCount ?? 0;

    await client.query(`DELETE FROM players WHERE id IN (${placeholders})`, ids);

    return {
      keepId,
      keepName: keeper.name,
      mergedCount: ids.length,
      movedEventPlayers,
    };
  });
}

export class DeleteEventError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface DeleteEventResult {
  eventId: number;
  deletedGames: number;
  deletedEventPlayers: number;
  deletedCanonicalPlayers: number;
}

// Hard-delete an imported event and everything hanging off it (its games and
// event_players), then drop any canonical player left with no remaining
// event_players. Deliberately NOT combined with a re-import: a caller that
// deletes in order to re-import accepts that a failed re-import leaves the event
// gone. Only imported events can be deleted — the seeded containers
// "Open (Ranked)" / "Open (Unranked)" (ids 1, 2, and the only rows with a NULL
// source_hash) are protected.
export async function deleteEvent(
  db: Db,
  eventId: number,
): Promise<DeleteEventResult> {
  if (eventId <= 2) {
    throw new DeleteEventError(
      'The "Open (Ranked)" and "Open (Unranked)" events cannot be deleted',
    );
  }
  return withTransaction(db, async (client): Promise<DeleteEventResult> => {
    const found = (
      await client.query(
        'SELECT id, source_hash FROM events WHERE id = $1',
        [eventId],
      )
    ).rows[0] as { id: number; source_hash: string | null } | undefined;
    if (!found) throw new DeleteEventError('event not found', 404);
    if (found.source_hash === null) {
      throw new DeleteEventError('This event was not imported and cannot be deleted');
    }

    const canonicalIds = (
      await client.query(
        `SELECT DISTINCT player_id FROM event_players
         WHERE event_id = $1 AND player_id IS NOT NULL`,
        [eventId],
      )
    ).rows.map((r) => (r as { player_id: number }).player_id);

    const deletedGames =
      (await client.query('DELETE FROM games WHERE event_id = $1', [eventId]))
        .rowCount ?? 0;
    const deletedEventPlayers =
      (await client.query('DELETE FROM event_players WHERE event_id = $1', [eventId]))
        .rowCount ?? 0;
    await client.query('DELETE FROM events WHERE id = $1', [eventId]);

    let deletedCanonicalPlayers = 0;
    for (const pid of canonicalIds) {
      const stillUsed = (
        await client.query(
          'SELECT 1 FROM event_players WHERE player_id = $1 LIMIT 1',
          [pid],
        )
      ).rows[0];
      if (!stillUsed) {
        await client.query('DELETE FROM players WHERE id = $1', [pid]);
        deletedCanonicalPlayers++;
      }
    }

    return {
      eventId,
      deletedGames,
      deletedEventPlayers,
      deletedCanonicalPlayers,
    };
  });
}

export interface DuplicateHint {
  reason: 'egf' | 'name';
  playerIds: number[];
}

// Levenshtein edit distance (iterative, two-row). Small n, called O(n²) times.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function namesSimilar(a: string, b: string): boolean {
  if (a === b) return false;
  const ta = a.split(/\s+/).filter(Boolean).sort();
  const tb = b.split(/\s+/).filter(Boolean).sort();
  if (ta.length === tb.length && ta.join(' ') === tb.join(' ')) return true;
  return Math.min(a.length, b.length) >= 4 && levenshtein(a, b) <= 2;
}

// True if any two of `ids` both have an event_players row in the same event.
// One real person is not entered twice in one tournament, so that is a strong
// false-positive signal for a duplicate hint.
async function anyCoOccur(db: Queryable, ids: number[]): Promise<boolean> {
  if (ids.length < 2) return false;
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const ph2 = ids.map((_, i) => `$${i + 1 + ids.length}`).join(',');
  const row = (
    await db.query(
      `SELECT 1 FROM event_players a
         JOIN event_players b
           ON b.event_id = a.event_id AND b.player_id > a.player_id
        WHERE a.player_id IN (${ph}) AND b.player_id IN (${ph2})
        LIMIT 1`,
      [...ids, ...ids],
    )
  ).rows[0];
  return row !== undefined;
}

// Suggest likely duplicate canonical players for the Players list to highlight.
export async function findDuplicateHints(db: Queryable): Promise<DuplicateHint[]> {
  const hints: DuplicateHint[] = [];

  // Strong: the same EGF pin used by more than one canonical player.
  const egfGroups = (
    await db.query(
      `SELECT egf_pin AS pin, string_agg(DISTINCT player_id::text, ',') AS ids
         FROM event_players
        WHERE egf_pin IS NOT NULL AND TRIM(egf_pin) <> '' AND player_id IS NOT NULL
        GROUP BY egf_pin
       HAVING COUNT(DISTINCT player_id) > 1`,
    )
  ).rows as { pin: string; ids: string }[];
  for (const g of egfGroups) {
    const ids = g.ids.split(',').map(Number).sort((x, y) => x - y);
    if (!(await anyCoOccur(db, ids))) hints.push({ reason: 'egf', playerIds: ids });
  }

  // Similar name: O(n²) over the canonical list (local DB, small n).
  const players = (
    await db.query('SELECT id, normalized_name AS n FROM players')
  ).rows as { id: number; n: string }[];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      if (!namesSimilar(players[i].n, players[j].n)) continue;
      const ids = [players[i].id, players[j].id].sort((x, y) => x - y);
      if (!(await anyCoOccur(db, ids))) hints.push({ reason: 'name', playerIds: ids });
    }
  }

  return hints;
}

// Exported for tests.
export { normalizeName };
