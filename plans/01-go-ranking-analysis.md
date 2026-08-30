# Go Ranking Analysis — Implementation Plan

## Context

Greenfield repo (only `README.md` + `.gitignore`). Goal: a local Node + TypeScript web
app that ingests Go tournament results and lets the user explore head-to-head history for
any player.

Decisions:

- **Ingestion**: user uploads one **OpenGotha tournament file** (`.xml`) at a time to the
  API. The API parses it and records the event, its players, games, and results.
  Re-uploading the same file is **rejected** (duplicate).
- **Stack**: local Node + TypeScript; **SQLite** (`better-sqlite3`); **Express JSON API**
  + **React SPA** (Vite).
- **Player identity — two layers**:
  - `event_players`: every `<Player>` in an uploaded file becomes its own row
    (`eventPlayerId`), keeping the raw name + details exactly as they appeared in that
    file. `games` reference `eventPlayerId`s, never canonical ids directly.
  - `players`: the canonical/main table (stable integer id). During import each
    `event_players` row is linked to a canonical player: case-insensitive match on
    `normalized_name` → link if found, else create a new `players` row and link.
  - Because the link (`event_players.player_id`) is stored, a mis-matched event player can
    be **remapped** later to the correct canonical player without re-importing.
- **`events` table** (renamed from `competitions`): holds real tournaments **and** two
  always-present seeded rows — `Open (Ranked)` (id 1) and `Open (Unranked)` (id 2) — which
  are containers for individually-entered standalone games. No `kind` column for now.
  Standalone-game entry is a **future path**; this build only seeds the two rows.
- **Non-game results** (forfeit / both-lose / unknown / bye) are stored but flagged so
  they're excluded from win/loss analysis while still shown in history.

Outcome: an upload endpoint, a JSON API, and a React UI with five pages — Import, Players,
Player info (reverse-chronological paginated history + opponents split into losing / even /
winning records with W–L counts), Events, Event info (roster + matchups/results).

## OpenGotha file format (to verify against a real sample on first run)

OpenGotha saves an XML tree:

```xml
<Tournament>
  <Players>
    <Player firstName="John" name="Smith" rank="5D" grade="5D" club="XXXX"
            country="FR" egfPin="12345678" .../>
    ...
  </Players>
  <Games>
    <Game roundNumber="1" whitePlayer="SMITHJOHN" blackPlayer="DOEJANE"
          handicap="0" knownColor="true" result="RESULT_WHITEWINS" tableNumber="1"/>
    ...
  </Games>
  <TournamentParameterSet>
    <GeneralParameterSet name="Spring Open 2024" shortName="..." beginDate="2024-03-15"
                         endDate="2024-03-17" numberOfRounds="5" .../>
  </TournamentParameterSet>
  <ByePlayer .../>   <!-- byes, if present -->
</Tournament>
```

- **Player key** used in `<Game>` = `(name + firstName).toUpperCase()` with whitespace
  removed. Confirm exact rule against a real file (`server/src/openGotha.ts`, one marked
  spot to adjust). Build a `key -> eventPlayerId` map while inserting `<Players>`.
- **Event name / date**: `GeneralParameterSet@name` and `@beginDate`. That single date is
  used for every round (no reliable per-round dates).
- **`result` enum → outcome** (`server/src/result.ts`):
  | enum | is_game | result_type | winner |
  |---|---|---|---|
  | `RESULT_WHITEWINS` | 1 | `game` | white |
  | `RESULT_BLACKWINS` | 1 | `game` | black |
  | `RESULT_EQUAL` | 1 | `draw` | none |
  | `RESULT_WHITEWINS_BYDEF` | 0 | `forfeit` | white |
  | `RESULT_BLACKWINS_BYDEF` | 0 | `forfeit` | black |
  | `RESULT_BOTHLOSE` / `_BYDEF` | 0 | `both_lose` | none |
  | `RESULT_BOTHWIN` / `_BYDEF` | 0 | `both_win` | none |
  | `RESULT_UNKNOWN` / other | 0 | `no_result` | none |
  Byes (from `<ByePlayer>` if present): one `games` row, `black_event_player_id` NULL,
  `is_game` 0, `result_type` `bye`.

## Project layout

```
package.json            # npm workspaces + root scripts (concurrently)
tsconfig.base.json
server/
  package.json  tsconfig.json
  src/
    schema.sql          # DDL + seed of the two Open events
    db.ts               # better-sqlite3 connection, applies schema.sql
    openGotha.ts        # XML -> { event, players[], games[] }  (ADJUST player-key rule here)
    result.ts           # OpenGotha result enum -> {isGame,type,winnerColor}  (ADJUST here)
    players.ts          # normalizeName() + resolveCanonicalPlayer() (match-or-create)
    importTournament.ts # orchestrates a single-file import inside one transaction
    analysis.ts         # SQL: matchups table + per-player payload
    routes.ts           # Express routes
    server.ts           # app entry (port 3001)
    *.test.ts           # node:test, with a small sample .xml fixture
web/
  package.json  vite.config.ts  index.html
  src/
    main.tsx  App.tsx  api.ts  styles.css
    pages/ImportPage.tsx  pages/PlayersPage.tsx  pages/PlayerPage.tsx
    pages/EventsPage.tsx  pages/EventPage.tsx
    components/HistoryTable.tsx  components/RecordTable.tsx  components/MatchupTable.tsx
```

## Database schema (`server/src/schema.sql`)

- `events` — `id` PK, `name` TEXT NOT NULL, `date` TEXT NULL (ISO `YYYY-MM-DD`),
  `source_hash` TEXT UNIQUE NULL (sha256 of the uploaded file; NULL for the two Open rows),
  `imported_at` TEXT.
  Seed: `INSERT OR IGNORE INTO events (id,name) VALUES (1,'Open (Ranked)'),(2,'Open (Unranked)');`
- `players` — canonical table. `id` PK, `display_name` TEXT (first-seen `"First Last"`),
  `normalized_name` TEXT UNIQUE.
- `event_players` — `id` PK (the `eventPlayerId`), `event_id` FK,
  `player_id` FK → `players.id` (nullable in principle; always set by the importer),
  `og_key` TEXT (the key used in `<Game>`), `first_name` TEXT, `last_name` TEXT,
  `display_name` TEXT (raw `"First Last"` from the file), `rank` TEXT NULL,
  `club` TEXT NULL, `country` TEXT NULL, `egf_pin` TEXT NULL.
  UNIQUE(`event_id`, `og_key`). Index `event_players(player_id)`.
- `games` — `id` PK, `event_id` FK, `round_number` INTEGER NULL,
  `white_event_player_id` FK → `event_players.id`,
  `black_event_player_id` FK NULL (NULL for bye),
  `winner_event_player_id` FK NULL (white or black; NULL for draw/non-game),
  `is_game` INTEGER (0/1), `result_type` TEXT
  (`game`|`draw`|`forfeit`|`both_win`|`both_lose`|`bye`|`no_result`),
  `result_raw` TEXT, `handicap` INTEGER NULL.
- Indexes: `games(white_event_player_id)`, `games(black_event_player_id)`,
  `games(winner_event_player_id)`, `games(event_id)`.
- Analysis resolves a game's participants to canonical players by joining
  `games` → `event_players` → `players`.

## Ingestion — `POST /api/imports` (multipart, field `file`)

Uses `multer` memory storage, ~10 MB limit. All steps in one `better-sqlite3` transaction:

1. Read bytes; `sha256`. If `SELECT 1 FROM events WHERE source_hash = ?` → **409**
   `{ error: "This tournament file has already been imported", eventId }`.
2. Parse XML (`fast-xml-parser`). Extract event `name` + `beginDate`; error 422 if the
   file isn't a recognizable OpenGotha tournament.
3. `INSERT INTO events (name, date, source_hash, imported_at)`.
4. For each `<Player>`: `INSERT INTO event_players` (raw names + details), then
   `resolveCanonicalPlayer(display_name)` — normalize (trim + collapse internal whitespace
   + lowercase), `SELECT id FROM players WHERE normalized_name = ?`; if none,
   `INSERT INTO players` (`display_name` from this file). Set `event_players.player_id`.
   Record `og_key -> eventPlayerId` in a map.
5. For each `<Game>` (and `<ByePlayer>` if present): map keys → `eventPlayerId`s, map
   `result` via `result.ts`, `INSERT INTO games`.
6. Commit. Respond `201 { eventId, name, date, eventPlayers, playersCreated, playersMatched,
   gamesInserted, nonGames }`.

No CLI importer and no `data/` folder — ingestion is API-only.

## JSON API (`server/src/routes.ts`, port 3001)

- `GET /api/matchups?player=<canonicalPlayerId>&event=<eventId>` → `[{ eventName, date,
  roundNumber, whiteName, blackName, winnerName|null, resultType }]` — names are the
  **canonical** player names (via `games`→`event_players`→`players`). Ordered `date` DESC,
  `roundNumber` DESC. **At least one** of `player` / `event` is required; both may be given
  (AND). Missing both → `400`. No unfiltered listing.
- `GET /api/players` → `[{ id, name, gameCount, eventCount }]`, name-sorted (canonical).
  `gameCount` counts real games (`is_game = 1`); `eventCount` = distinct events the player
  appears in.
- `GET /api/players/:id` → player metadata only (no game list):
  - `player`: `{ id, name }`
  - `events`: `[{ eventId, eventName, date, gameCount }]` — events this player took part
    in, `gameCount` = their games in that event, date DESC.
  - `losing` / `even` / `winning` — **sections (b)/(c)/(d)**: games rolled up per opponent.
    Each is `[{ opponentId, opponentName, wins, losses }]` over **real games only**
    (`is_game = 1 AND result_type = 'game'`), split by `losses > wins` / `losses == wins` /
    `wins > losses` (draws/non-games excluded from the tallies).

  Aggregation: join `games` to `event_players` on white/black; `UNION ALL` of
  (canonical player as white) and (as black), selecting the opponent's canonical
  `player_id` and `won = (winner_event_player_id = <this side's event_player id>)`, then
  `GROUP BY` opponent `player_id`.

- `GET /api/players/:id/history?page=<n>` → **section (a)**: the flat per-game log,
  reverse-chronological (`date` DESC, `roundNumber` DESC), **paginated 30 per page**
  (`page` 1-based, default 1). Response:
  `{ page, pageSize: 30, total, hasMore, items: [{ eventId, eventName, date, roundNumber,
     opponentId, opponentName|null, outcome: 'win'|'loss'|'draw'|'nongame', resultType }] }`.
  This is the same set of games the `losing`/`even`/`winning` rollup aggregates (that
  rollup additionally filters to real games) — no extra data, just kept separate because
  the list can be long.
- `GET /api/events` → `[{ id, name, date, gameCount, playerCount }]`, date DESC.
- `GET /api/events/:id` → `{ id, name, date, gameCount, playerCount }`.
- `GET /api/events/:id/players` → `[{ eventPlayerId, rawName, rank, canonicalPlayerId,
  canonicalName }]` — for reviewing/fixing an import's matches.
- `PATCH /api/event-players/:eventPlayerId` `{ playerId }` → repoint that event player to
  another canonical player (used to correct a bad match). `{ newName }` alternative:
  create a fresh canonical player and link to it. Optionally deletes a canonical player
  that no longer has any `event_players`.

## Frontend (React + Vite + React Router; `vite.config.ts` proxies `/api` → 3001)

Five pages; `/` redirects to `/events`. Simple top nav (Events / Players / Import).

- `/import` **ImportPage** — file input → `POST /api/imports`; shows the summary or the
  409/422 error, and a link to the new event.
- `/players` **PlayersPage** — list of all canonical players from `GET /api/players`
  (name, gameCount, eventCount); client-side text filter; no pagination. Row → `/players/:id`.
- `/players/:id` **PlayerPage** — from `GET /api/players/:id`: player name, `events` list,
  and (b) **Losing records** (`losses > wins`, W–L), (c) **Even records**
  (`wins == losses`), (d) **Winning records** (`wins > losses`). Plus (a) **HistoryTable**
  fed by `GET /api/players/:id/history?page=`, reverse-chronological, Prev/Next over
  30-row pages.
- `/events` **EventsPage** — list of recorded events from `GET /api/events` (name, date,
  gameCount, playerCount). Row → `/events/:id`.
- `/events/:id` **EventPage** — from `GET /api/events/:id` + `GET /api/events/:id/players`
  + `GET /api/matchups?event=:id`: event name/date, the list of players in the event (raw
  name, rank, matched canonical name linked to their page, with an inline remap control →
  `PATCH /api/event-players/:id`), and the matchup table (round, white, black, winner,
  resultType).
- `api.ts` typed fetch helpers; single `styles.css`, no component library.

## Root scripts (`package.json`, npm workspaces `server`, `web`)

- `npm run dev` → `concurrently` `tsx watch server/src/server.ts` + `vite`
- `npm run build` → `tsc -b` + `vite build`
- `npm test` → `node --test` in `server/`

Deps: `better-sqlite3`, `express`, `multer`, `fast-xml-parser`, `tsx`, `typescript`,
`concurrently` (server/root); `react`, `react-dom`, `react-router-dom`, `vite`,
`@vitejs/plugin-react` (web). Tests use built-in `node:test`.

## Verification

1. `npm run dev`. Open `/import`, upload a real OpenGotha `.xml`. Confirm the summary
   counts (players linked, games inserted, non-games) match the file.
2. Re-upload the same file → **409** "already imported".
3. `sqlite3` spot-check: `SELECT COUNT(*) FROM games;`; a jigo row is `result_type='draw'`,
   `winner_id` NULL; a `_BYDEF` row is `is_game=0`; the two Open events still exist with
   `date` NULL.
4. Upload a second tournament sharing a player (same name, different case) with the first.
   Confirm both events' `event_players` link to the **one** canonical player. On that
   player's page: history is newest-first and spans both events; an opponent with a losing
   record shows only in section (b) with the right W–L, an even one only in (c), a winning
   one only in (d); forfeits/byes appear in history but not in b/c/d.
5. `PATCH /api/event-players/:id` to repoint one event player to a different canonical
   player; confirm the matchups table and the affected player pages update, with no
   re-import.
6. `npm test` — `openGotha.ts` parses the sample fixture (players, games, one jigo, one
   `_BYDEF`) and `result.ts` maps every enum value correctly; `resolveCanonicalPlayer`
   matches case-insensitively and creates on miss.
