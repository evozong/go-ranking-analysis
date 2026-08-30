# Postgres Migration + Staging/Production Environments

## Context

Supersedes `plans/02-backing-store-db-migration.md`. Two explicit decisions:

1. Move off SQLite (`better-sqlite3`) onto a **traditional SQL database**: **Postgres**,
   hosted for free on **[Neon](https://neon.tech)**.
2. Run **two environments** — **staging** and **production** — so that local development
   and manual testing never touch production data. Local dev (`npm run dev`) always points
   at staging; only a deployed production instance's own environment variable points at
   production.

This is a real code migration (not just a plan): the server's data-access layer has been
rewritten from `better-sqlite3`'s synchronous API to `pg` (node-postgres)'s async `Pool` /
`PoolClient` API, `schema.sql` has been rewritten in Postgres dialect, and unit tests now
run against [`pg-mem`](https://github.com/oguimbal/pg-mem) (an in-memory Postgres-compatible
engine) instead of an in-memory SQLite file, so the whole suite stays hermetic and offline.

## Why Neon

- **Free tier is real and sufficient**: generous storage/compute for a low-traffic hobby
  app, no credit card required to start.
- **Instant branching**: a Neon "branch" is a full copy-on-write Postgres database forked
  from another branch in seconds. This maps directly onto the stg/prd requirement — one
  Neon project, two branches, two connection strings, no second account or provider needed.
- **Standard Postgres wire protocol** — the app uses the ordinary `pg` driver, nothing
  Neon-specific in application code.

## Setting up the two environments (manual, one-time — do this yourself)

I can't provision a Neon account on your behalf; there's no API access to it from here.
Steps, either via [console.neon.tech](https://console.neon.tech) or the `neonctl` CLI:

1. **Create a Neon account** (free, GitHub/Google/email sign-in, no card).
2. **Create one project** for this app, e.g. `go-ranking-analysis`. Neon creates a default
   branch called `main` — treat this as **production**.
3. **Create a second branch off `main`** called `staging` (Console: project → Branches →
   "New Branch", parent = `main`; CLI: `neonctl branches create --name staging`). This is
   an independent, isolated database — writes to it never touch `main`.
4. **Grab both connection strings** (Console: project → Connection Details, pick the branch
   from the dropdown; CLI: `neonctl connection-string main` / `neonctl connection-string
   staging`). Each looks like:
   ```
   postgresql://<user>:<password>@<host>.neon.tech/<database>?sslmode=require
   ```
5. **Local dev**: `cp server/.env.example server/.env`, set `DATABASE_URL` to the
   **staging** connection string. `.env` is git-ignored — never commit it.
6. **Production**: wherever this app ends up deployed, set `DATABASE_URL` to the
   **production** (`main`-branch) connection string via that platform's own secret/env
   mechanism — not a committed file. (No hosting platform is chosen yet; this repo is still
   run locally via `npm run dev`. This step is here for when that changes.)

From here on, `npm run dev` — and anything else run locally — reads and writes the staging
database only. A schema change picked up by `ensureSchema()` (see below) applies to
whichever `DATABASE_URL` is active; run it against staging first, confirm it, then apply the
same change to production by pointing `DATABASE_URL` at the production connection string
for one `ensureSchema` run (or, once a deploy pipeline exists, let it apply on production
startup the same way it does locally).

## What changed in the codebase

- **`server/src/schema.sql`** — rewritten in Postgres dialect: `SERIAL PRIMARY KEY`
  instead of SQLite's implicit `INTEGER PRIMARY KEY` rowid aliasing, `ON CONFLICT DO
  NOTHING` instead of `INSERT OR IGNORE`. `events.id` keeps two explicitly-seeded rows
  (1, 2) with no `SERIAL` default; `importTournament` computes the next id itself
  (`SELECT COALESCE(MAX(id),0)+1 FROM events`) inside its transaction, avoiding the
  sequence-desync issue that comes from mixing explicit-id seed rows with a `SERIAL`
  column. Still applied on every startup and still fully idempotent — this doubles as
  the project's migration mechanism, same as before.
- **`server/src/dbCore.ts`** (new) — `ensureSchema(target)` and `withTransaction(pool,
  fn)`, both side-effect-free at import (no env var access, no connection). Everything
  that needs transactions or schema application (`analysis.ts`, `importTournament.ts`,
  `testdb.ts`) depends on this instead of on `db.ts`, so importing them never requires
  `DATABASE_URL` to be set — that's what keeps `npm test` connection-free.
- **`server/src/db.ts`** — creates the real `pg.Pool` from `DATABASE_URL` (throws with a
  clear message if unset), enables TLS unless the host is `localhost` (Neon requires TLS;
  a local Postgres for manual testing does not).
- **Every data-access function** (`analysis.ts`, `players.ts`, `importTournament.ts`) is
  now `async`, using positional `$1, $2...` parameters (reused across repeats, e.g. `$1`
  standing in for every occurrence of a player id in a query) instead of `better-sqlite3`'s
  named `@param` binding, and `RETURNING id` instead of reading `lastInsertRowid`. Multi-
  statement writes (`importTournament`, `remapEventPlayer`) run inside
  `withTransaction`, which does `BEGIN` / commit-or-`ROLLBACK` / `client.release()` on a
  checked-out `PoolClient`.
- **Postgres identifier casing**: Postgres folds unquoted identifiers to lowercase, so
  every camelCase column alias in a query is double-quoted (`AS "gameCount"`) to survive
  into the JSON responses as written; `COUNT(...)` results are cast `::int` (Postgres
  returns `bigint` for aggregates, which `pg` otherwise returns as a string).
- **Three queries were restructured** (`listPlayers`, `listEvents`/`getEvent`, and the
  per-event game counts in `getPlayerDetail`) from a correlated scalar subquery in the
  `SELECT` list to a `WITH ... LEFT JOIN` shape. This was forced by a `pg-mem` limitation
  (it doesn't resolve outer-row references inside a correlated `SELECT`-list subquery),
  but the rewrite is arguably better Postgres anyway and behaves identically on real
  Postgres — verified against both `pg-mem` and a real local Postgres 16 instance.
- **`routes.ts`** — handlers are `async`; since Express 4 doesn't catch rejected promises
  from route handlers itself, each is wrapped in a small `asyncHandler` that forwards
  rejections to `next()`.
- **`server.ts`** — startup is now `async`: `await ensureSchema()` before `app.listen()`.
- **Tests** (`*.test.ts`) — `makeTestDb()` in `testdb.ts` now returns a `pg-mem`-backed
  `Pool` (via `pg-mem`'s `adapters.createPg()`, which mimics the real `pg` module's
  interface) with the same `schema.sql` applied, instead of an in-memory SQLite database.
  Tests never set `DATABASE_URL` and never touch the network — verified with `npm test`
  (22/22 passing) and cross-checked end-to-end against a real local Postgres 16 (import,
  duplicate-rejection, player/event listing, and the full HTTP API all produced identical
  results to the `pg-mem` run).

## Non-goals

- No hosting/deployment decision made here — this only sets up the two databases and
  points local dev at staging. Wiring `DATABASE_URL` into an actual deployment happens
  when a hosting platform is chosen.
- No separate migration tool (e.g. `node-pg-migrate`, Prisma Migrate). `schema.sql` stays
  the single idempotent source of truth, consistent with how this project has worked since
  plan 01; revisit only if the schema outgrows what `CREATE TABLE/INDEX IF NOT EXISTS` can
  express.
- `pg-mem` is a test-only stand-in, not a claim that it's a viable runtime backend — it's
  used solely so `npm test` stays fast, offline, and safely isolated from both Neon
  environments.
