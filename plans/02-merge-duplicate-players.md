# Merge duplicate players from the Players list

## Context

Today the only way to fix a mis-identified player is on the **Event page**, one
`event_players` row at a time (`remapEventPlayer`). But the same real person often ends up
as two *canonical* `players` rows (different spelling / spacing / accented vs. plain), and
that's easiest to see on the name-sorted **Players list**, where the near-duplicates sit
next to each other.

This change turns the Players list into a second, list-wide way to spot and fix
duplicates: it **highlights likely duplicate pairs**, and lets you **select two or more
players, pick the keeper, and merge** the rest into it. Merging repoints every
`event_players` row from the merged players onto the keeper and deletes the now-empty
canonical rows — after that, all their game history shows up under one player.

## Backend

### `server/src/analysis.ts` — new `mergePlayers()`

Sibling to the existing `remapEventPlayer()` (reuse its transaction + orphan-cleanup
shape). Signature `mergePlayers(db, keepId: number, mergeIds: number[]): MergeResult`.

- Add `class MergeError extends Error {}` (mirrors `RemapError`).
- Validate inside one `db.transaction`:
  - `keepId` exists in `players`; else `MergeError('keeper not found')`.
  - `mergeIds` non-empty, does not contain `keepId`, deduped; every id exists; else
    `MergeError`.
- `UPDATE event_players SET player_id = @keep WHERE player_id IN (<mergeIds>)` — capture
  `info.changes` as `movedEventPlayers`.
- `DELETE FROM players WHERE id IN (<mergeIds>)`.
- Return `{ keepId, keepName, mergedCount: mergeIds.length, movedEventPlayers }`.
- No change needed for `games` — they reference `event_players`, not `players`.
- `normalized_name` UNIQUE is safe: merged rows are deleted, keeper keeps its own name.

### `server/src/analysis.ts` — new `findDuplicateHints()`

`findDuplicateHints(db): DuplicateHint[]` where
`DuplicateHint = { reason: 'egf' | 'name'; playerIds: number[] }`.

- **Same EGF pin** (strong):
  `SELECT egf_pin, GROUP_CONCAT(DISTINCT player_id) FROM event_players
   WHERE egf_pin IS NOT NULL AND TRIM(egf_pin) <> '' GROUP BY egf_pin
   HAVING COUNT(DISTINCT player_id) > 1` → one hint per pin.
- **Similar name**: load `SELECT id, normalized_name FROM players`; O(n²) over the list
  (local DB, small n). Flag a pair when either:
  - the two names have the **same set of whitespace-split tokens** in a different order
    (`"smith john"` vs `"john smith"`), or
  - **Levenshtein distance ≤ 2** and the shorter name length ≥ 4 (small helper, ~15 lines,
    added in `analysis.ts`).
  Emit one hint `{ reason: 'name', playerIds: [a, b] }` per flagged pair.
- No group-merging across hints; the frontend just needs "who is suspicious and why".
- **Co-occurrence filter (applies to every hint, both reasons):** discard a hint if any
  two of its `playerIds` both have an `event_players` row in the *same* event — one real
  person is not entered twice in one tournament, so co-occurrence is a strong false-
  positive signal. Check with
  `SELECT 1 FROM event_players a JOIN event_players b
     ON b.event_id = a.event_id AND b.player_id > a.player_id
   WHERE a.player_id IN (<ids>) AND b.player_id IN (<ids>) LIMIT 1`
  per candidate hint (for a >2-member EGF group, drop the whole group on any co-occurring
  pair). A shared EGF pin *with* co-occurrence is contradictory source data — still
  suppressed here; the user can merge manually from the list if they know better.

### `server/src/routes.ts` — two routes

- `GET /api/players/duplicate-hints` → `findDuplicateHints(db)`.
  Register **before** `GET /api/players/:id` so `:id` doesn't swallow it.
- `POST /api/players/merge` body `{ keepId: number, mergeIds: number[] }` →
  `mergePlayers(...)`; catch `MergeError` → `400 { error }` (same pattern as the
  `event-players` PATCH handler).

### `server/src/analysis.test.ts` — new file

- `mergePlayers`: create 3 canonical players via `resolveCanonicalPlayer`, hand-insert a
  couple of `event_players` rows per player against seeded event id 1, merge two into the
  third, assert: merged `players` rows gone, their `event_players` now point at the
  keeper, `movedEventPlayers` correct, keeper's `event_players` count is the sum.
- `mergePlayers` rejects `keepId` inside `mergeIds` and unknown ids with `MergeError`.
- `findDuplicateHints`: `"John Smith"` + `"Jon Smith"` (disjoint events) → a `name` hint;
  two players whose `event_players` share an `egf_pin` → an `egf` hint; and a name-similar
  pair that both appear in the *same* event → **no** hint (co-occurrence filter).

## Frontend

### `web/src/api.ts`

- Types `DuplicateHint`, `MergeResult`.
- `api.playerDuplicateHints()` → `GET /api/players/duplicate-hints`.
- `api.mergePlayers(keepId, mergeIds)` → `POST /api/players/merge` (JSON), like the
  existing `remapEventPlayer` helper.

### `web/src/pages/PlayersPage.tsx`

Extend the existing page (keep the name filter). Add:

- Second `useAsync` for `api.playerDuplicateHints()`, re-run with a `refreshKey` bump
  after a successful merge (same pattern as `EventPage`).
- From hints build `Map<playerId, { reasons: Set<'egf'|'name'>; others: number[] }>`.
- **Table**: new leading checkbox column, and a "Possible duplicate" badge column — a
  small `.hint` pill (`same EGF pin` / `similar name`) with a `title=` listing the other
  players' names it matched. Rows that appear in any hint also get a highlight class.
- Optional checkbox above the table: **"Only possible duplicates"** — filters `rows` to
  ids present in the hint map (composes with the text filter).
- Selection state `Set<number>`. When `selected.size >= 2`, show a **merge bar** (reuse
  the `.remap` inline-controls style): a radio group of the selected players to choose the
  keeper (defaults to the first selected), a `Merge N players` button, and `Cancel`.
- On merge: `await api.mergePlayers(keepId, [...selected].filter(id => id !== keepId))`,
  then clear selection, bump `refreshKey`, surface any error inline (`.error`).

### `web/src/styles.css`

Add a `.hint` pill style and a subtle row-highlight class. Small, follows the existing
lightweight CSS.

## Also: show "games won" per event on the Player detail page

Currently the **Events** table on `PlayerPage` shows Date / Event / Games. Add a **Won**
column = real games this player won in that event.

- `server/src/analysis.ts` `getPlayerDetail()` — add a `wins` correlated subquery to the
  `events` query, alongside the existing `gameCount` one:
  `... WHERE g.event_id = ep.event_id AND g.is_game = 1 AND g.result_type = 'game'
   AND ((wep.player_id = @pid AND g.winner_event_player_id = wep.id)
     OR (bep.player_id = @pid AND g.winner_event_player_id = bep.id))` → `AS wins`.
  Add `wins: number` to `PlayerDetail['events']`.
- `web/src/api.ts` — add `wins: number` to `PlayerEventRef`.
- `web/src/pages/PlayerPage.tsx` — add `<th>Won</th>` header and `<td>{e.wins}</td>` cell
  to the Events table.
- `server/src/analysis.test.ts` — extend a `getPlayerDetail` case (or add one) asserting
  `events[].wins` matches the seeded winners.

## Also: rename & reorder the opponent-record sections on the Player detail page

- `web/src/pages/PlayerPage.tsx` — change the three `<h2>` headings:
  `Losing records` → `上家`, `Even records` → `平手`, `Winning records` → `下家`.
  (`d.losing` / `d.even` / `d.winning` keep their names in code; only the labels change.)
- `server/src/analysis.ts` `getPlayerDetail()` — change the rollup `ORDER BY` from
  `p.display_name COLLATE NOCASE` to `wins DESC, p.display_name COLLATE NOCASE` so each of
  the three sections lists opponents by decreasing wins, then name. The JS split into
  losing/even/winning preserves row order, so no further sorting needed.
- `server/src/analysis.test.ts` — assert the ordering in one `getPlayerDetail` case.

## Reversibility

A merge only repoints `event_players.player_id` and deletes the emptied canonical rows —
every `event_players` row survives with its original raw name in `display_name`. So a
merge is undoable manually from the Event page (Remap → existing/new, recreating the
original name if needed). What's *not* provided: a one-click un-merge, and a recreated
canonical player gets a fresh `players.id`.

## Out of scope

One-click un-merge / merge history log; auto-merging without confirmation; changing the
EventPage remap flow; merging from the Player detail page.

## Verification

1. `npm test` — new `analysis.test.ts` passes alongside the existing suites.
2. `npm run build` — type-checks server + web.
3. `npm run dev`, open http://localhost:5173:
   - Import `server/src/fixtures/sample.xml` and `sample2.xml` (an overlapping-roster pair
     is ideal; otherwise import the same players under a tweaked-spelling file).
   - **Players** page: near-identical names show a "similar name" pill; players sharing an
     EGF pin show a "same EGF pin" pill.
   - Tick two duplicate rows → merge bar appears → choose keeper → `Merge 2 players`.
   - List refreshes: one row gone; open the keeper — its **Events** and **Game history**
     now include the merged player's games; the hint pill for that pair is gone.
   - On the keeper's page, the **Events** table now has a **Won** column; the value per
     row equals the wins counted in that player's history for that event.
   - `curl -s localhost:3001/api/players/duplicate-hints` returns the expected groups;
     `curl -X POST localhost:3001/api/players/merge -H 'content-type: application/json'
     -d '{"keepId":1,"mergeIds":[1]}'` returns `400`.
