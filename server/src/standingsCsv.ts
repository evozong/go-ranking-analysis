// Second import path: a *parsed standings table* exported as CSV (the format the
// user actually has on hand) → a DTD-conformant OpenGotha `.xml` string, which is
// then fed through the existing `parseOpenGotha` / `importTournament` pipeline.
//
// The CSV is OpenGotha's "short" `gameFormat` standings dump. Header:
//   Num,Pl,Name,Female,Rk,NbW,R1..Rn,NBW,SOS,SOSOS
// Only Num / Name / Rk / R1..Rn carry information we keep; the rest are
// derived/label columns recomputed by any consumer.
//
// Rx cell grammar: `<opponentNum><result>` where result is `+` win, `-` loss,
// `=` jigo. `0+` = bye, `0-` = not paired / absent that round. Short format
// cannot distinguish a forfeit loss from a played loss, so every cell with a real
// opponent becomes a plain <Game>; nothing is emitted as `_BYDEF`. See
// plans/06-import-standings-csv.md for the full rationale.

import { playerKey } from './openGotha.js';

export class StandingsParseError extends Error {}

export type CellResult = '+' | '-' | '=';

export interface Cell {
  /** 1-based opponent pairing number, or 0 for a bye (`0+`) / absence (`0-`). */
  opp: number;
  result: CellResult;
}

export interface StandingsPlayer {
  num: number;
  name: string;
  rank: string;
  female: boolean | null; // from the optional "Female" column; null = unknown
}

export interface StandingsTable {
  rounds: number;
  players: StandingsPlayer[];
  /** cells[playerIndex][roundIndex] */
  cells: Cell[][];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// RFC 4180 quoted-CSV reader (tiny; handles "" escaping and commas in quotes).
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^﻿/, ''); // strip BOM

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
    } else if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      endField();
      i++;
    } else if (c === '\r') {
      // swallow; handle the \n (or lone \r) as the row break
      if (s[i + 1] === '\n') i++;
      endRow();
      i++;
    } else if (c === '\n') {
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  // trailing field / row (unless the file ended exactly on a newline)
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

// ---------------------------------------------------------------------------
// parseStandingsTable
// ---------------------------------------------------------------------------

// Short-format cell: leading opponent number + one result sign. A full-format
// dump appends type/colour/handicap chars (`!`, `w`, `b`, `/`, a digit) which we
// deliberately drop — a `!` forfeit is treated as a normal result (out of scope).
const CELL_RE = /^(\d+)([+\-=])([!wb/\d]*)$/;

// "true"/"false" (case-insensitive) -> boolean; anything else (incl. an empty
// cell, or no "Female" column at all) -> null (unknown).
function parseFemale(v: string | undefined): boolean | null {
  const s = v?.trim().toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

export function parseStandingsTable(csvText: string): StandingsTable {
  const rows = parseCsv(csvText).filter(
    (r) => !(r.length === 1 && r[0].trim() === ''),
  );
  if (rows.length === 0) {
    throw new StandingsParseError('CSV is empty');
  }

  // Columns are located by name (not fixed position), so exports that add or
  // drop label columns still parse. Required: Num (first column), Name, Rk, and
  // a contiguous run of R1..Rn. "Female" is optional; everything else is ignored.
  const header = rows[0].map((h) => h.trim());
  const colIdx = (name: string): number =>
    header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const nameIdx = colIdx('Name');
  const rankIdx = colIdx('Rk');
  const femaleIdx = colIdx('Female');
  const roundIdxs = header
    .map((h, i) => (/^R\d+$/i.test(h) ? i : -1))
    .filter((i) => i >= 0);
  const roundsContiguous = roundIdxs.every(
    (v, i) => i === 0 || v === roundIdxs[i - 1] + 1,
  );

  if (
    colIdx('Num') !== 0 ||
    nameIdx < 0 ||
    rankIdx < 0 ||
    roundIdxs.length === 0 ||
    !roundsContiguous
  ) {
    throw new StandingsParseError(
      'Unexpected header row; need a "Num" first column plus "Name", "Rk" and a ' +
        'contiguous run of "R1".."Rn" columns',
    );
  }

  const rounds = roundIdxs.length;
  const roundStart = roundIdxs[0];

  const dataRows = rows.slice(1);
  const players: StandingsPlayer[] = [];
  const cells: Cell[][] = [];
  const warnings: string[] = [];
  const seenKeys = new Map<string, number>();

  dataRows.forEach((r, ri) => {
    if (r.length !== header.length) {
      throw new StandingsParseError(
        `Row ${ri + 2} has ${r.length} fields, expected ${header.length}`,
      );
    }
    const num = Number.parseInt(r[0].trim(), 10);
    if (num !== ri + 1) {
      throw new StandingsParseError(
        `Row ${ri + 2}: Num "${r[0].trim()}" is not sequential (expected ${ri + 1})`,
      );
    }
    const name = r[nameIdx].trim();
    if (!name) {
      throw new StandingsParseError(`Row ${ri + 2}: empty Name`);
    }
    const key = playerKey(name, '');
    const clash = seenKeys.get(key);
    if (clash !== undefined) {
      throw new StandingsParseError(
        `Rows ${clash + 2} and ${ri + 2} normalize to the same player key "${key}"`,
      );
    }
    seenKeys.set(key, ri);

    players.push({
      num,
      name,
      rank: r[rankIdx].trim(),
      female: femaleIdx >= 0 ? parseFemale(r[femaleIdx]) : null,
    });

    const rowCells: Cell[] = [];
    for (let rd = 0; rd < rounds; rd++) {
      const raw = r[roundStart + rd].trim();
      const m = CELL_RE.exec(raw);
      if (!m) {
        throw new StandingsParseError(
          `Row ${ri + 2} round ${rd + 1}: cell "${raw}" does not match <opponent><+|-|=>`,
        );
      }
      const opp = Number.parseInt(m[1], 10);
      const result = m[2] as CellResult;
      if (opp === 0 && result === '=') {
        throw new StandingsParseError(
          `Row ${ri + 2} round ${rd + 1}: "0=" is not a valid cell`,
        );
      }
      if (opp === num) {
        throw new StandingsParseError(
          `Row ${ri + 2} round ${rd + 1}: player paired against themselves`,
        );
      }
      rowCells.push({ opp, result });
    }
    cells.push(rowCells);
  });

  // opponent numbers must be in range (checked after we know the player count)
  cells.forEach((rowCells, ri) => {
    rowCells.forEach((cell, rd) => {
      if (cell.opp > players.length) {
        throw new StandingsParseError(
          `Row ${ri + 2} round ${rd + 1}: opponent ${cell.opp} is out of range (${players.length} players)`,
        );
      }
    });
  });

  return { rounds, players, cells, warnings };
}

// ---------------------------------------------------------------------------
// buildOpenGothaXml
// ---------------------------------------------------------------------------

function xmlEscape(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Rough EGF-linear rank → rating. Approximate and never read by our importer; it
// only helps an OpenGotha round-trip look sane. 1D = 100, each kyu step below is
// -100 (1K = 0, 30K = -2900); each dan step above is +100.
function rankToRating(rank: string): string {
  const m = /^(\d+)\s*([KkDd])$/.exec(rank.trim());
  if (!m) return '';
  const n = Number.parseInt(m[1], 10);
  const isDan = m[2].toUpperCase() === 'D';
  return String(isDan ? 100 + (n - 1) * 100 : 100 - n * 100);
}

export interface BuildOptions {
  name: string;
  date: string | null; // ISO YYYY-MM-DD
}

export function buildOpenGothaXml(
  table: StandingsTable,
  { name, date }: BuildOptions,
): string {
  const { rounds, players, cells, warnings } = table;
  const beginDate = date ?? '';

  // OpenGotha has no gender field and we want the generated file to stay
  // DTD-conformant, so a female entrant (the optional CSV "Female" column set to
  // "true") is recorded by suffixing " (F)" onto the player name. This suffix is
  // part of the name everywhere — the <Player> attribute AND the key that
  // <Game>/<ByePlayer> reference — so the file is internally consistent.
  const displayNameOf = (p: StandingsPlayer): string =>
    p.female === true ? `${p.name} (F)` : p.name;

  // --- <Player> rows: participating bit is 0 only for a `0-` (absent) round ---
  const playerXml = players.map((p, pi) => {
    const participating = cells[pi]
      .map((c) => (c.opp === 0 && c.result === '-' ? '0' : '1'))
      .join('');
    const rk = xmlEscape(p.rank);
    return (
      `    <Player name="${xmlEscape(displayNameOf(p))}" firstName="" rank="${rk}" ` +
      `grade="${rk}" country="" club="" rating="${rankToRating(p.rank)}" ` +
      `ratingOrigin="" smmsCorrection="0" participating="${participating}" ` +
      `registeringStatus="FIN"/>`
    );
  });

  const keyOf = (num: number): string =>
    playerKey(displayNameOf(players[num - 1]), '');

  // --- <Game> rows: emit each pairing once, from the lower pairing number ---
  const gameXml: string[] = [];
  cells.forEach((rowCells, pi) => {
    const num = pi + 1;
    rowCells.forEach((cell, rd) => {
      const opp = cell.opp;
      if (opp === 0 || opp < num) return; // bye/absence, or the mirror side

      const round = rd + 1;
      const mirror = cells[opp - 1][rd];
      let winner: 'a' | 'b' | 'draw';
      if (cell.result === '+') winner = 'a';
      else if (cell.result === '-') winner = 'b';
      else winner = 'draw';

      const expected: CellResult =
        cell.result === '+' ? '-' : cell.result === '-' ? '+' : '=';
      if (mirror.opp !== num || mirror.result !== expected) {
        warnings.push(
          `Round ${round}: player ${num} reports "${opp}${cell.result}" but ` +
            `player ${opp} reports "${mirror.opp}${mirror.result}"`,
        );
        // Trust whichever side claims a win.
        if (cell.result !== '+' && mirror.opp === num && mirror.result === '+') {
          winner = 'b';
        }
      }

      const a = keyOf(num);
      const b = keyOf(opp);
      let black: string;
      let white: string;
      let result: string;
      if (winner === 'draw') {
        white = a;
        black = b;
        result = 'RESULT_EQUAL';
      } else {
        // winner → Black, loser → White (colour is unknown, cosmetic only)
        black = winner === 'a' ? a : b;
        white = winner === 'a' ? b : a;
        result = 'RESULT_BLACKWINS';
      }
      gameXml.push(
        `    <Game roundNumber="${round}" blackPlayer="${black}" ` +
          `whitePlayer="${white}" knownColor="false" handicap="0" ` +
          `result="${result}"/>`,
      );
    });
  });

  // --- <ByePlayers>: one leaf per `0+` cell ---
  const byeXml: string[] = [];
  cells.forEach((rowCells, pi) => {
    rowCells.forEach((cell, rd) => {
      if (cell.opp === 0 && cell.result === '+') {
        byeXml.push(
          `    <ByePlayer roundNumber="${rd + 1}" player="${keyOf(pi + 1)}"/>`,
        );
      }
    });
  });

  const nm = xmlEscape(name);
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Tournament dataVersion="201">',
    '  <Players>',
    ...playerXml,
    '  </Players>',
    '  <Games>',
    ...gameXml,
    '  </Games>',
  ];
  if (byeXml.length > 0) {
    parts.push('  <ByePlayers>', ...byeXml, '  </ByePlayers>');
  }
  parts.push(
    '  <TournamentParameterSet>',
    `    <GeneralParameterSet name="${nm}" shortName="${nm}" ` +
      `beginDate="${xmlEscape(beginDate)}" endDate="${xmlEscape(beginDate)}" ` +
      `numberOfRounds="${rounds}" size="19" komi="7.5" genMMFloor="30K" ` +
      `genMMBar="4D" genMMZero="30K"/>`,
    '  </TournamentParameterSet>',
    '</Tournament>',
    '',
  );
  return parts.join('\n');
}

// Name for the generated file the browser downloads:
// "<yyyymmdd> <tournament name> opengotha.xml" (the date is dropped when unknown).
// Only characters illegal in filenames are stripped; spaces and the name's own
// punctuation are kept.
export function downloadFilename(name: string, date: string | null): string {
  const stamp = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.replace(/-/g, '') : '';
  const safeName =
    name
      .replace(/[/\\:*?"<>|\p{Cc}]/gu, '') // drop chars illegal in a filename
      .replace(/\s+/g, ' ')
      .trim() || 'tournament';
  return `${stamp ? `${stamp} ` : ''}${safeName} opengotha.xml`;
}
