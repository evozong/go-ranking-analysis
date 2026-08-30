import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from './dbCore.js';
import { parseOpenGotha, type ParsedGame } from './openGotha.js';
import { resolveCanonicalPlayer } from './players.js';

export class DuplicateImportError extends Error {
  eventId: number;
  constructor(eventId: number) {
    super('This tournament file has already been imported');
    this.eventId = eventId;
  }
}

export interface ImportSummary {
  eventId: number;
  name: string;
  date: string | null;
  eventPlayers: number;
  playersCreated: number;
  playersMatched: number;
  gamesInserted: number;
  nonGames: number;
}

export async function importTournament(pool: Pool, fileBytes: Buffer): Promise<ImportSummary> {
  const hash = createHash('sha256').update(fileBytes).digest('hex');
  const parsed = parseOpenGotha(fileBytes.toString('utf8'));

  return withTransaction(pool, async (client) => {
    const dupe = await client.query<{ id: number }>(
      'SELECT id FROM events WHERE source_hash = $1',
      [hash],
    );
    if (dupe.rows[0]) throw new DuplicateImportError(dupe.rows[0].id);

    const eventInsert = await client.query<{ id: number }>(
      `INSERT INTO events (id, name, date, source_hash, imported_at)
       VALUES ((SELECT COALESCE(MAX(id), 0) + 1 FROM events), $1, $2, $3, $4)
       RETURNING id`,
      [parsed.name, parsed.date, hash, new Date().toISOString()],
    );
    const eventId = eventInsert.rows[0].id;

    const keyToEventPlayerId = new Map<string, number>();
    let playersCreated = 0;
    let playersMatched = 0;

    for (const p of parsed.players) {
      const { playerId, created } = await resolveCanonicalPlayer(client, p.displayName);
      if (created) playersCreated++;
      else playersMatched++;

      const epInsert = await client.query<{ id: number }>(
        `INSERT INTO event_players
           (event_id, player_id, og_key, first_name, last_name, display_name, rank, club, country, egf_pin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          eventId,
          playerId,
          p.ogKey,
          p.firstName,
          p.lastName,
          p.displayName,
          p.rank,
          p.club,
          p.country,
          p.egfPin,
        ],
      );
      keyToEventPlayerId.set(p.ogKey, epInsert.rows[0].id);
    }

    let gamesInserted = 0;
    let nonGames = 0;

    for (const g of parsed.games) {
      const whiteId = keyToEventPlayerId.get(g.whiteKey);
      if (whiteId === undefined) {
        throw new Error(`Game references unknown player key "${g.whiteKey}"`);
      }
      const blackId = g.blackKey === null ? null : keyToEventPlayerId.get(g.blackKey) ?? null;
      if (g.blackKey !== null && blackId === null) {
        throw new Error(`Game references unknown player key "${g.blackKey}"`);
      }

      await client.query(
        `INSERT INTO games
           (event_id, round_number, white_event_player_id, black_event_player_id,
            winner_event_player_id, is_game, result_type, result_raw, handicap)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          eventId,
          g.roundNumber,
          whiteId,
          blackId,
          winnerEventPlayerId(g, whiteId, blackId),
          g.outcome.isGame ? 1 : 0,
          g.outcome.type,
          g.outcome.raw,
          g.handicap,
        ],
      );
      gamesInserted++;
      if (!g.outcome.isGame) nonGames++;
    }

    return {
      eventId,
      name: parsed.name,
      date: parsed.date,
      eventPlayers: parsed.players.length,
      playersCreated,
      playersMatched,
      gamesInserted,
      nonGames,
    };
  });
}

function winnerEventPlayerId(
  g: ParsedGame,
  whiteId: number,
  blackId: number | null,
): number | null {
  if (g.outcome.winnerColor === 'white') return whiteId;
  if (g.outcome.winnerColor === 'black') return blackId;
  return null;
}
