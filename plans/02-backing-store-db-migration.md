# Backing Store — DB Migration Plan

> **Superseded** by `plans/03-postgres-stg-prd-migration.md`: the app has since moved from
> SQLite to a traditional Postgres database with separate staging/production environments.
> Kept here for the record of the original SQLite-first reasoning.

## Context

`plans/01-go-ranking-analysis.md` already designs the app's persistence around **SQLite**
(`better-sqlite3`) as a single local file — there is no earlier non-DB backing store (no
JSON files, no in-memory store) to migrate away from. This plan exists to explicitly lock
in that decision, justify it against a "free, extremely low traffic" constraint, and lay
out the one scenario where a plain local SQLite file stops being enough: **if the app is
ever deployed somewhere with an ephemeral or read-only filesystem** (most serverless /
PaaS free tiers). It defines a migration path for that case that costs $0 and touches as
little code as possible.

## Recommendation: SQLite now, Turso only if/when hosted

**Primary: SQLite (file-based, as already planned).** For a single-user / small-club Go
ranking tool with negligible traffic, a `.db` file is the correct answer, not a stepping
stone:

- **$0 forever** — no server, no managed-service bill, no usage tier to outgrow.
- **Zero ops** — no network hop, no connection pool, no separate service to keep alive or
  monitor.
- **Plenty of headroom** — SQLite comfortably handles far more write/read volume than a
  handful of tournament uploads and browsing sessions will ever produce.
- **Trivial backup** — the entire database is one file; `cp ranking.db ranking.db.bak` is a
  complete, restorable backup.

This only breaks down if the app is deployed to infrastructure that doesn't guarantee a
persistent, writable disk across restarts/deploys (e.g. Vercel/Netlify functions, most
free-tier PaaS containers). Running it locally, on a VPS, or on a home server with a normal
disk — the SQLite file is sufficient indefinitely and this plan requires no further action.

**Fallback if hosting requires it: [Turso](https://turso.tech) (libSQL).** Turso is a
hosted, SQLite-compatible database (libSQL, a SQLite fork with network replication) with a
free tier that comfortably covers this project's scale (multiple databases, generous
storage and monthly row-read/write allowances — well beyond what a low-traffic ranking
tool needs). It's the fallback specifically because it's **wire-compatible with SQLite's
SQL surface**, so `schema.sql` and every query in `analysis.ts` / `importTournament.ts`
carry over unchanged — only the driver and connection string change.

Alternatives considered and rejected:

- **Supabase / Neon (hosted Postgres)** — real free tiers exist, but they mean adopting
  Postgres's dialect/tooling and running a heavier client for a workload this small. No
  benefit over SQLite/Turso here.
- **PlanetScale** — no longer offers a free tier; excluded on cost grounds alone.
- **Cloudflare D1** — also SQLite-based and free, but only worth it if the app is
  specifically deployed on Cloudflare Workers/Pages. Turso is the more portable default;
  swap in D1 instead if a Workers deployment is chosen later (same rationale, same
  near-zero migration cost).

## Making the fallback painless: one abstraction point

To keep a future SQLite → Turso switch to a config change instead of a rewrite, introduce a
single connection module and never import `better-sqlite3` (or a libSQL client) anywhere
else:

```
server/src/db.ts   # the only file that knows which driver is in use
```

- `db.ts` reads a `DATABASE_URL` env var.
  - Unset / `file:./ranking.db` → open with `better-sqlite3` (local file, current plan).
  - `libsql://...` (a Turso database URL + auth token) → open with `@libsql/client` instead.
- Both drivers expose the same query surface needed here (parameterized `run`/`get`/`all`),
  so `analysis.ts`, `importTournament.ts`, and `routes.ts` are written once against a thin
  wrapper and never branch on which backend is active.
- `schema.sql` stays the single source of truth for the schema in both cases — applied on
  startup locally, applied once via `turso db shell` (or the same apply-on-startup code
  path) when hosted.

This costs nothing today (it's the same amount of code as calling `better-sqlite3`
directly) and means the migration, if it's ever needed, is: create a free Turso database,
set `DATABASE_URL`, install `@libsql/client`, done — no schema or query changes.

## Migration steps (only needed if/when hosting requires it)

1. `turso db create go-ranking` (free account, no card required) → get the database URL and
   an auth token.
2. Apply `server/src/schema.sql` against it: `turso db shell go-ranking < server/src/schema.sql`.
3. Add `@libsql/client` to `server/package.json`; extend `db.ts`'s driver switch as above.
4. Set `DATABASE_URL` / `DATABASE_AUTH_TOKEN` in the hosting environment.
5. One-time data carry-over, if the local `.db` file already has data: `turso db shell
   go-ranking < <(sqlite3 ranking.db .dump)` (SQLite's `.dump` output is valid input for
   libSQL's shell for this project's schema — no `AUTOINCREMENT`/extension usage to worry
   about).
6. Verify: re-run the same checks as plan 01's Verification section (`/api/events`,
   `/api/players`, an import) against the hosted database before switching traffic over.

## Non-goals

- No ORM. The query surface is small and explicit SQL (as planned in `analysis.ts`) stays
  easier to reason about than an ORM layer, in both the SQLite and Turso cases.
- No connection pooling / multi-tenant concerns — traffic is low enough that a single
  connection (local) or Turso's built-in handling (hosted) is sufficient.
- No decision made yet to actually deploy anywhere. This plan only removes the cost of that
  decision later; nothing here changes plan 01's local-first build.
