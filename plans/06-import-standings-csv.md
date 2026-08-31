# Import a tournament from a parsed standings-table CSV

## Context

The importer only accepts OpenGotha `.xml`. Investigating the "no byes recorded"
bug surfaced that the tournament records this user actually has on hand are
**parsed standings tables exported as CSV** (e.g.
`20250419_go_academy_intermediate_r5_standings_table.csv`), not OpenGotha files.
A hand-reconstructed `.xml` for one of them was non-conformant (invented
`<ByePlayer><Bye result=.../></ByePlayer>` shape, spaced player keys) — proof that
"reconstruct the XML by hand" is error-prone.

Goal: add a **second import path** that takes a standings CSV, converts it to a
**DTD-conformant OpenGotha `.xml`**, hands that file back to the user for
download, and ingests it through the **existing** import pipeline in the same
request. The current "Import from OpenGotha XML" path stays exactly as-is for when
a real file is available.

## The CSV format (from the sample)

Header: `Num,Pl,Name,Female,Rk,NbW,R1..Rn,NBW,SOS,SOSOS`

- `Num` — 1-based pairing number; equals row order. This is what `Rx` cells
  reference.
- `Name` — full display name (may contain a comma, e.g. `"Chan Yat Hei, George"`,
  so a real quoted-CSV parse is required).
- `Rk` — rank string (`30K` throughout the sample).
- `Rx` cell grammar (OpenGotha **"short" `gameFormat`**): `<opponentNum><result>`
  where result is `+` win, `-` loss, `=` jigo. Special: `0+` = **bye**; `0-` =
  **not paired / absent** that round.
- `Pl`, `Female`, `NbW`, `NBW`, `SOS`, `SOSOS` — derived/label columns; ignored
  (recomputed by any consumer; not in the OpenGotha DTD or our schema).

Each real game appears in **both** players' rows; the converter must emit it once.

### Format limitation (confirmed against OpenGotha source)

`ScoredPlayer.halfGamesStrings` builds each cell as `oooo r t c h` (opponent,
result, type, colour, handicap) but emits `t`/`c`/`h` **only in "full"
`gameFormat`**; in "short" it drops them (`if (!bFull) strTyp = ""`). The sample
CSV is short format, so:

- A **forfeit loss is indistinguishable from a played loss** — both are `43-`.
  The converter therefore emits **every** `<opp>±` cell (real opponent) as a plain
  `<Game>` (`RESULT_BLACKWINS` / `RESULT_WHITEWINS` / `RESULT_EQUAL`). **No cell
  can be flagged `_BYDEF`.** Forfeit fidelity needs the real OpenGotha `.xml`.
- `0-` conflates "not assigned" and "absent"; `0+` is a bye only because this
  tournament set `genNBW2ValueBye="2"`. Both are treated structurally (bye vs
  no-game) as below; the win/points value is left for a consumer to recompute.
- If a **full-format** CSV is ever uploaded (cells contain `!`, `w`, `b`, `/`, or
  a handicap digit), `parseStandingsTable` strips the trailing type/colour/
  handicap chars and treats the cell as short — a `!` forfeit becomes a normal
  result. (Honoring `!` is possible later but out of scope; see Out of scope.)

## Reference: OpenGotha format authority

- DTD: `tournamentfiles/tournament.dtd` in `lucvannier/opengotha`. Byes are
  `<ByePlayers><ByePlayer roundNumber="1" player="KEY"/></ByePlayers>` (plural
  wrapper, flat leaf, `roundNumber` 1-based). `player` is
  `(name + firstName)` with spaces stripped, upper-cased.
- Our parser [server/src/openGotha.ts](server/src/openGotha.ts) already handles
  that exact bye shape (`tournament?.ByePlayers?.ByePlayer`) and builds the same
  key via `playerKey(lastName, firstName)`.

## Approach

One new server module, one new route, a mode toggle on the import page. Convert +
import happen in a single request; the generated XML is returned alongside the
summary so the browser can offer it as a download.

### New — `server/src/standingsCsv.ts`

- `parseStandingsTable(csvText: string): StandingsTable`
  - Tiny RFC-4180 quoted-field reader (≈20 lines): handles `""` escaping and
    commas inside quotes. No new dependency.
  - Returns `{ rounds: number, players: { num, name, rank }[], cells: Cell[][],
    warnings: string[] }` where `Cell = { opp: number, result: '+' | '-' | '=' }`.
  - `class StandingsParseError extends Error` for malformed input (mirrors
    `NotOpenGothaError`): bad header, ragged rows, cell that doesn't match the
    grammar, `Num` not sequential, two rows whose names normalize to the same
    OpenGotha key.
- `buildOpenGothaXml(table, { name, date }): string` — hand-rolled serializer
  (small, fully controlled, easy to keep DTD-valid), XML-escaping all attribute
  values:
  - `<?xml version="1.0" encoding="UTF-8"?>` then `<Tournament dataVersion="201">`
    (no DOCTYPE — matches real exports).
  - `<Players>`: per row,
    `<Player name="<full name>" firstName="" rank="<Rk>" grade="<Rk>" country=""
    club="" rating="<rank→rating>" ratingOrigin="" smmsCorrection="0"
    participating="<per-round 1/0>" registeringStatus="FIN"/>`.
    Key = full name, spaces stripped, upper-cased — matches `playerKey()` with an
    empty `firstName`.
  - `<Games>`: walk `cells`; for `opp = j > 0` emit once when `num < j`. Winner →
    `blackPlayer`, loser → `whitePlayer`, `knownColor="false"`, `handicap="0"`,
    `result="RESULT_BLACKWINS"`; `=` → `whitePlayer`/`blackPlayer` in row order,
    `result="RESULT_EQUAL"`. `roundNumber` 1-based. Cross-check row `j`'s mirror
    cell; on disagreement push a `warning` and trust the side that says `+`.
  - `<ByePlayers>`: for every `0+` cell,
    `<ByePlayer roundNumber="<r>" player="<KEY>"/>`.
  - `0-` cell: emit no game; set that round's `participating` digit to `0`
    (default `1`).
  - `<TournamentParameterSet><GeneralParameterSet name="<name>" shortName="<name>"
    beginDate="<date>" endDate="<date>" numberOfRounds="<rounds>" size="19"
    komi="7.5" genMMFloor="30K" genMMBar="4D" genMMZero="30K" .../></...>` — just
    enough to satisfy `parseOpenGotha` (which requires `@name`) and the DTD.
  - Rank→rating: small lookup (`30K → -2950` … `1D → 100`, roughly EGF-linear);
    approximate and documented. Our importer never reads it; it only aids an
    OpenGotha round-trip.

### New — `server/src/standingsCsv.test.ts`

Fixture: `server/src/fixtures/standings-sample.csv` (the provided file). Assert by
running `buildOpenGothaXml(...)` through `parseOpenGotha` (no DB):

- 85 players; `numberOfRounds` inferred as 5; `participating` length 5.
- Wu Dasheng Jayden → exactly one `bye` game in round 1 (`blackKey` null,
  `isGame` false).
- Adam Wee Thye Xiang → a game only in round 1; `participating` `"10000"`.
- A known pairing (Wei Zhenghan vs opp in R1) appears exactly once, not
  duplicated from the opponent's row.
- Comma-in-name rows (`Chan Yat Hei, George`, `Tan Yuxin, Benjamin`) parse as one
  field; keys `CHANYATHEI,GEORGE` etc.
- Small synthetic CSV with a `=` cell → one `draw` game (`isGame` true, no
  winner).
- Malformed inputs raise `StandingsParseError`.

One DB-backed test in the style of
[server/src/importTournament.test.ts](server/src/importTournament.test.ts):
convert the fixture, `importTournament(db, Buffer.from(xml))`, assert
`eventPlayers === 85` and `nonGames === <bye count>`.

### `server/src/routes.ts`

Add `POST /standings/import`, `upload.single('file')` (reuse the existing
`multer` memory-storage instance):

```
name = String(req.body?.name ?? '').trim()      // 400 if empty
date = String(req.body?.date ?? '').trim() || null
xml  = buildOpenGothaXml(parseStandingsTable(req.file.buffer.toString('utf8')), { name, date })
summary = await importTournament(db, Buffer.from(xml))
res.status(201).json({ ...summary, xml, filename: `${slug(name)}.xml` })
```

Error mapping mirrors `POST /imports`: `StandingsParseError` → 422,
`DuplicateImportError` → 409 (`{ error, eventId }`), `NotOpenGothaError` → 422.
`POST /imports` is untouched.

### `web/src/api.ts`

Add:

```
importStandings(file: File, name: string, date: string):
  Promise<ImportSummary & { xml: string; filename: string }>
```

`FormData` with `file`, `name`, `date` → `POST /api/standings/import`. Reuse the
`req<T>` helper and `ApiError`.

### `web/src/pages/ImportPage.tsx`

- Add a mode toggle (two radios): **OpenGotha XML** (current form, unchanged) and
  **Standings CSV**.
- CSV form: `<input type="file" accept=".csv,text/csv">`, a **Tournament name**
  text field, and a **Date** `<input type="date">`. On file pick, pre-fill name +
  date by parsing the filename
  (`^(\d{4})(\d{2})(\d{2})[_-](.+?)(?:[_-]r\d+)?(?:[_-]standings.*)?\.csv$` →
  date `YYYY-MM-DD`, name = slug with `_`→space, title-cased); both stay
  editable.
- Submit → `api.importStandings(...)`; on success trigger a client download of
  `xml` (`Blob` + a transient `<a download={filename}>`), then render the
  existing summary panel (reuse that JSX). Reuse the current `ApiError` /
  `dupeEventId` error handling.
- Optional: one line on `web/src/pages/LandingPage.tsx` noting CSV standings are
  also accepted.

## Decisions baked in

- **Single request** converts and imports; XML comes back for download.
- **Filename-derived, editable** name/date.
- **`0-` → no game + `participating` bit `0`.** There is no opponent, and short
  format cannot mark forfeits anyway (see Format limitation), so every cell with a
  real opponent is a plain `<Game>`; nothing is emitted as `_BYDEF`.
- Colors are absent from the CSV → winner emitted as **Black**,
  `knownColor="false"`. Cosmetic only; analysis ignores color.
- `name` carries the full display name, `firstName=""` — lossless and consistent
  with canonical-name matching in
  [server/src/players.ts](server/src/players.ts) (`resolveCanonicalPlayer` keys
  off the display name).

## Verification

- `npm test -w server` — new `standingsCsv.test.ts` plus the existing suite green.
- `npm run dev`, open `/import`:
  1. CSV mode → pick
     `20250419_go_academy_intermediate_r5_standings_table.csv`; confirm name
     pre-fills (≈ "Go Academy Intermediate") and date `2025-04-19`; adjust name.
  2. Submit → `.xml` downloads; summary shows 85 event players, ~210 games, 1
     non-game (the bye), and an "open event" link.
  3. Event page: Wu Dasheng Jayden shows a round-1 bye; Wei Zhenghan shows 5
     games.
  4. Switch to XML mode, re-upload the just-downloaded `.xml` → expect **409
     duplicate** (proves the generated file is stable and parses through the
     existing path).
- Optional: `xmllint --noout --dtdvalid tournament.dtd downloaded.xml` (fetch
  `tournament.dtd` from the OpenGotha repo) for external DTD validation.

## Out of scope

- Distinguishing forfeits from played games, or "absent" from "not assigned" —
  short-format standings cannot express either (see Format limitation). Honoring a
  `!` forfeit marker from a full-format CSV could be added later.
- Splitting given/family names; inferring board colors; keeping
  `SOS`/`SOSOS`/`Pl`/`Female`.
- Any change to the existing OpenGotha XML import path or the DB schema.
