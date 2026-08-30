# Go Ranking Analysis

Local Node + TypeScript web app that ingests Go tournament results (OpenGotha `.xml`
files) and lets you explore head-to-head history for any player.

- **server/** — Express JSON API (port 3001) + Postgres (hosted free on [Neon](https://neon.tech)).
- **web/** — React + Vite SPA (port 5173), proxies `/api` → 3001.

## Requirements

- Node 20+.
- A Postgres database to connect to. See
  [`plans/03-postgres-stg-prd-migration.md`](plans/03-postgres-stg-prd-migration.md) for
  setting up a free Neon project with separate staging/production branches — local
  development always points at staging, never production.

## Setup

```
npm install
cp server/.env.example server/.env   # then fill in DATABASE_URL (staging connection string)
```

## Scripts (run from the repo root)

| command | what it does |
|---|---|
| `npm run dev` | runs the API (`tsx watch`) and the Vite dev server together |
| `npm run build` | type-checks + builds both workspaces |
| `npm test` | runs the server test suite (`node:test` via `tsx`) |

The API connects to Postgres via `DATABASE_URL` (see Setup above) and applies
`server/src/schema.sql` on every startup — it's idempotent, so this also doubles as the
project's migration mechanism. `npm test` never touches a real database: it runs against
an in-memory Postgres-compatible engine ([`pg-mem`](https://github.com/oguimbal/pg-mem)),
so it stays fast, offline, and can't affect staging or production data.

## Using it

1. `npm run dev`, open http://localhost:5173.
2. **Import** → upload an OpenGotha `.xml`. Re-uploading the same file is rejected (409).
3. **Events** / **Players** to browse; a player page shows reverse-chronological game
   history plus opponents split into losing / even / winning records.
4. On an event page you can **remap** a mis-matched player to the correct canonical
   player (or a fresh one) without re-importing.

## Layout notes

- `server/src/openGotha.ts` — XML → tournament struct. The `<Game>` player-key rule
  (`playerKey()`) has a marked spot to adjust if a real file disagrees.
- `server/src/result.ts` — OpenGotha `result` enum → normalized outcome; also a marked
  adjust spot.
- `server/src/schema.sql` — schema + seed of the two always-present `Open` events.
