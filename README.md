# Go Ranking Analysis

Local Node + TypeScript web app that ingests Go tournament results (OpenGotha `.xml`
files) and lets you explore head-to-head history for any player.

- **server/** — Express JSON API (port 3001) + Neon Postgres (`pg`), async data layer.
- **web/** — React + Vite SPA (port 5173), proxies `/api` → 3001.

## Requirements

- Node 22+ (developed on Node 26; uses the built-in `--env-file` / `--env-file-if-exists`).
- A Neon Postgres project with a `stg` branch and a per-developer `dev` branch. No
  native build step.

## Setup

```
npm install
```

Then configure the server's database connection (`server/`):

1. The `stg` + `dev` branch hosts and shared `PGUSER` / `PGDATABASE` are already
   in the committed `server/.env.defaults`. If you want your own `dev` branch,
   create one in the Neon console and point `PGHOST_DEV` / `PGHOST_POOLED_DEV` at
   it.
2. `cd server && cp .env.example .env.local`, then fill in:
   - `APP_ENV` — one of `dev | stg | prd`. Use `dev` locally so both
     `npm run dev` and `npm test` hit the `dev` branch; `stg` also works.
   - `PGPASSWORD_DEV` — the `dev` branch role password.
   - `PGPASSWORD_STG` — the `stg` role password (only needed if `APP_ENV=stg`).

`server/.env.local` is git-ignored. Connection fields are postfixed by
environment (`PGHOST_DEV`, `PGPASSWORD_DEV`, `PGHOST_STG`, …) and `APP_ENV`
selects which set is used; prod supplies `APP_ENV=prd` + `PGHOST_PRD` /
`PGPASSWORD_PRD` from its own secret store.

## Scripts (run from the repo root)

| command | what it does |
|---|---|
| `npm run dev` | runs the API (`tsx watch`) and the Vite dev server together |
| `npm run build` | type-checks + builds both workspaces |
| `npm test` | runs the server test suite (`node:test` via `tsx`) |
| `npm run deploy` | builds, bundles the Lambda, and `tofu apply`s the AWS stack (see [infra/](infra/README.md)) |

The server scripts layer env files: `--env-file=.env.defaults` then
`--env-file-if-exists=.env.local` (later file wins). No script injects `APP_ENV`
— `npm test` runs against whatever branch `APP_ENV` selects in `.env.local`
(normally `dev`), and gives each test file its own transient `test_<hex>` schema
(created and dropped per test) so a run never touches real data even when pointed
at `stg`. If Neon connection limits bite under parallel test files, add
`--test-concurrency=1` to the `test` script.

The API connects to Neon Postgres using discrete `PG*_<ENV>` fields (see Setup);
there is no local database file. `schema.sql` is idempotent and auto-applied on
startup, including the two seeded `Open` events.

## Deployment

`server/` runs on **AWS Lambda** (`server/src/lambda.ts`, an esbuild bundle of the
same Express app) behind a **CloudFront** distribution that also serves the built
`web/` SPA from a private **S3** bucket. `/api/*` routes to Lambda; everything else
is the SPA. DB is a Neon `prd` branch. It fits inside the AWS always-free tiers
(~$0/month).

Lambda does **not** run `initSchema()` — apply the schema out-of-band with
`npm run migrate -w server` (pointed at `prd`) before deploying and after any
`schema.sql` change. Full runbook: [infra/README.md](infra/README.md).

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
- `server/src/app.ts` — builds the Express app (no `listen`, no schema). Shared by
  `server.ts` (local `listen`) and `lambda.ts` (AWS handler). `migrate.ts` is the
  standalone schema apply.
