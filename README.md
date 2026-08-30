# Go Ranking Analysis

Local Node + TypeScript web app that ingests Go tournament results (OpenGotha `.xml`
files) and lets you explore head-to-head history for any player.

- **server/** — Express JSON API (port 3001) + SQLite (`better-sqlite3`).
- **web/** — React + Vite SPA (port 5173), proxies `/api` → 3001.

## Requirements

- Node 20+ (developed on Node 26; `better-sqlite3` v13 ships a prebuilt binary for it).

## Setup

```
npm install
```

## Scripts (run from the repo root)

| command | what it does |
|---|---|
| `npm run dev` | runs the API (`tsx watch`) and the Vite dev server together |
| `npm run build` | type-checks + builds both workspaces |
| `npm test` | runs the server test suite (`node:test` via `tsx`) |

The API writes its database to `server/data.db` (override with `DB_PATH`). It is
git-ignored. Delete it to start fresh.

## Using it

1. `npm run dev`, open http://localhost:5173.
2. **Import** → upload an OpenGotha `.xml`. Re-uploading the same file is rejected (409).
3. **Events** / **Players** to browse; a player page shows reverse-chronological game
   history plus opponents split into losing / even / winning records.
4. On an event page you can **remap** a mis-matched player to the correct canonical
   player (or a fresh one) without re-importing.
5. On the **Players** page, likely duplicate canonical players are flagged (same EGF
   pin / similar name); tick two or more rows, pick the keeper, and **merge** to
   repoint their game history onto one player.

## Layout notes

- `server/src/openGotha.ts` — XML → tournament struct. The `<Game>` player-key rule
  (`playerKey()`) has a marked spot to adjust if a real file disagrees.
- `server/src/result.ts` — OpenGotha `result` enum → normalized outcome; also a marked
  adjust spot.
- `server/src/schema.sql` — schema + seed of the two always-present `Open` events.
