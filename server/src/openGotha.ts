import { XMLParser } from 'fast-xml-parser';
import { mapResult, type Outcome } from './result.js';

export interface ParsedPlayer {
  ogKey: string;
  firstName: string;
  lastName: string;
  displayName: string; // "First Last"
  rank: string | null;
  club: string | null;
  country: string | null;
  egfPin: string | null;
}

export interface ParsedGame {
  roundNumber: number | null;
  whiteKey: string;
  blackKey: string | null; // null for a bye
  handicap: number | null;
  outcome: Outcome;
}

export interface ParsedTournament {
  name: string;
  date: string | null; // ISO YYYY-MM-DD
  players: ParsedPlayer[];
  games: ParsedGame[];
}

export class NotOpenGothaError extends Error {}

// Build the key used to reference a player from <Game whitePlayer=... blackPlayer=...>.
// OpenGotha uses lastName + firstName, uppercased, with all whitespace removed.
// ADJUST HERE if a real file disagrees.
export function playerKey(lastName: string, firstName: string): string {
  return `${lastName}${firstName}`.replace(/\s+/g, '').toUpperCase();
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function intOrNull(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: true,
});

export function parseOpenGotha(xml: string): ParsedTournament {
  let root: any;
  try {
    root = parser.parse(xml);
  } catch (err) {
    throw new NotOpenGothaError(`File is not valid XML: ${(err as Error).message}`);
  }

  const tournament = root?.Tournament;
  if (!tournament || typeof tournament !== 'object') {
    throw new NotOpenGothaError('Missing <Tournament> root element');
  }

  const gps =
    tournament?.TournamentParameterSet?.GeneralParameterSet ?? undefined;
  const name = str(gps?.['@_name']);
  if (!name) {
    throw new NotOpenGothaError(
      'Missing tournament name (TournamentParameterSet/GeneralParameterSet@name)',
    );
  }
  const date = normalizeDate(str(gps?.['@_beginDate']));

  const rawPlayers = toArray<any>(tournament?.Players?.Player);
  if (rawPlayers.length === 0) {
    throw new NotOpenGothaError('Tournament has no <Player> entries');
  }

  const players: ParsedPlayer[] = rawPlayers.map((p) => {
    const firstName = str(p['@_firstName']) ?? '';
    const lastName = str(p['@_name']) ?? '';
    const displayName = `${firstName} ${lastName}`.trim() || lastName || firstName;
    return {
      ogKey: playerKey(lastName, firstName),
      firstName,
      lastName,
      displayName,
      rank: str(p['@_rank']) ?? str(p['@_grade']),
      club: str(p['@_club']),
      country: str(p['@_country']),
      egfPin: str(p['@_egfPin']),
    };
  });

  const games: ParsedGame[] = toArray<any>(tournament?.Games?.Game).map((g) => ({
    roundNumber: intOrNull(g['@_roundNumber']),
    whiteKey: normKey(g['@_whitePlayer']),
    blackKey: normKey(g['@_blackPlayer']) || null,
    handicap: intOrNull(g['@_handicap']),
    outcome: mapResult(str(g['@_result'])),
  }));

  // Byes: <ByePlayer roundNumber=... player=...> (element name varies; accept a few).
  const byeEntries = [
    ...toArray<any>(tournament?.ByePlayer),
    ...toArray<any>(tournament?.ByePlayers?.ByePlayer),
  ];
  for (const b of byeEntries) {
    const key = normKey(b['@_player'] ?? b['@_playerKey'] ?? b['@_name']);
    if (!key) continue;
    games.push({
      roundNumber: intOrNull(b['@_roundNumber']),
      whiteKey: key,
      blackKey: null,
      handicap: null,
      outcome: { isGame: false, type: 'bye', winnerColor: null, raw: 'BYE' },
    });
  }

  return { name, date, players, games };
}

function normKey(v: unknown): string {
  return str(v)?.replace(/\s+/g, '').toUpperCase() ?? '';
}

// Accepts YYYY-MM-DD or YYYY/MM/DD (and similar) and returns ISO YYYY-MM-DD.
function normalizeDate(v: string | null): string | null {
  if (!v) return null;
  const m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
