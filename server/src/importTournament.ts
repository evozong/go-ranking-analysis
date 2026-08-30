import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
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

export function importTournament(db: Database, fileBytes: Buffer): ImportSummary {
  const hash = createHash('sha256').update(fileBytes).digest('hex');

  const dupe = db
    .prepare('SELECT id FROM events WHERE source_hash = ?')
    .get(hash) as { id: number } | undefined;
  if (dupe) throw new DuplicateImportError(dupe.id);

  const parsed = parseOpenGotha(fileBytes.toString('utf8'));

  const run = db.transaction((): ImportSummary => {
    const eventInfo = db
      .prepare(
        `INSERT INTO events (name, date, source_hash, imported_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(parsed.name, parsed.date, hash, new Date().toISOString());
    const eventId = Number(eventInfo.lastInsertRowid);

    const insertEventPlayer = db.prepare(
      `INSERT INTO event_players
         (event_id, player_id, og_key, first_name, last_name, display_name, rank, club, country, egf_pin)
       VALUES (@event_id, @player_id, @og_key, @first_name, @last_name, @display_name, @rank, @club, @country, @egf_pin)`,
    );

    const keyToEventPlayerId = new Map<string, number>();
    let playersCreated = 0;
    let playersMatched = 0;

    for (const p of parsed.players) {
      const { playerId, created } = resolveCanonicalPlayer(db, p.displayName);
      if (created) playersCreated++;
      else playersMatched++;

      const info = insertEventPlayer.run({
        event_id: eventId,
        player_id: playerId,
        og_key: p.ogKey,
        first_name: p.firstName,
        last_name: p.lastName,
        display_name: p.displayName,
        rank: p.rank,
        club: p.club,
        country: p.country,
        egf_pin: p.egfPin,
      });
      keyToEventPlayerId.set(p.ogKey, Number(info.lastInsertRowid));
    }

    const insertGame = db.prepare(
      `INSERT INTO games
         (event_id, round_number, white_event_player_id, black_event_player_id,
          winner_event_player_id, is_game, result_type, result_raw, handicap)
       VALUES (@event_id, @round_number, @white_event_player_id, @black_event_player_id,
               @winner_event_player_id, @is_game, @result_type, @result_raw, @handicap)`,
    );

    let gamesInserted = 0;
    let nonGames = 0;

    for (const g of parsed.games) {
      const whiteId = keyToEventPlayerId.get(g.whiteKey);
      if (whiteId === undefined) {
        throw new Error(`Game references unknown player key "${g.whiteKey}"`);
      }
      const blackId =
        g.blackKey === null ? null : keyToEventPlayerId.get(g.blackKey) ?? null;
      if (g.blackKey !== null && blackId === null) {
        throw new Error(`Game references unknown player key "${g.blackKey}"`);
      }

      insertGame.run({
        event_id: eventId,
        round_number: g.roundNumber,
        white_event_player_id: whiteId,
        black_event_player_id: blackId,
        winner_event_player_id: winnerEventPlayerId(g, whiteId, blackId),
        is_game: g.outcome.isGame ? 1 : 0,
        result_type: g.outcome.type,
        result_raw: g.outcome.raw,
        handicap: g.handicap,
      });
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

  return run();
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
