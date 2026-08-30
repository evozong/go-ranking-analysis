# Switch the server from SQLite to Neon Postgres

## Context

`server/` currently persists to a local file via `better-sqlite3` (`server/src/db.ts`,
`server/data.db`). We want the app to run against **Neon Postgres** instead, with two
Neon environments:

- `dev` — a developer's local branch, used by `npm run dev` and `npm test`.
- `stg` — shared staging, before promoting to prod.
- `prd` — production (not created yet; plan supports it but leaves it unconfigured).

**`APP_ENV` is the single switch.** Its allowed values are exactly `dev`, `stg`, `prd`
(case-insensitive); `db.ts` throws if it is unset or anything else. `npm test` does
**not** inject or override `APP_ENV` — it runs against whatever database `.env.local`
selects. A dev keeps `APP_ENV=dev` in `.env.local` so both `npm run dev` and
`npm test` hit the `dev` branch; test-run churn is further contained by a unique
per-test Postgres schema (`test_<hex>`, created and dropped around each test file), so
pointing `APP_ENV` at `stg` instead is still safe if a dev wants that.

The connection is configured as **discrete `pg` fields**, not a single URL, so that the
only secret is the password. Non-secret parts (user, database, per-branch host) live in
a committed `server/.env.defaults`; passwords **and `APP_ENV` itself** live in a
git-ignored `server/.env.local` (keeping `APP_ENV` out of the repo means a prod
deploy can't accidentally inherit it — prod sets `APP_ENV=prd` in its own secret store,
and `db.ts` throws if `APP_ENV` is unset rather than defaulting).
Env var names are **postfixed by environment**: `PGHOST_DEV`, `PGHOST_POOLED_DEV`,
`PGPASSWORD_DEV`, `PGHOST_STG`, `PGHOST_POOLED_STG`, `PGPASSWORD_STG`, `PGHOST_PRD`,
… with shared `PGUSER` / `PGDATABASE`. The test harness always uses the **direct**
(non-pooled) `PGHOST_<ENV>` regardless of environment, because it relies on
per-connection `SET search_path`, which PgBouncer transaction pooling drops.

`better-sqlite3` is synchronous; `pg` is async. This migration therefore also converts
the entire server data layer to `async/await`. The `web/` workspace talks only to
`/api` and is **not touched**.

There is no production data to migrate — `data.db` is a git-ignored local dev artifact.
Starting fresh on Neon is expected. (Optional one-off SQLite→Neon dump can be done
later if a dev wants their local data.)

## What I need from you to connect locally

1. **`stg` branch hosts** (non-secret, go in committed `server/.env.defaults`):
   `PGHOST_STG` (direct, `ep-patient-sound-a64ff7u3.us-west-2.aws.neon.tech`) and
   `PGHOST_POOLED_STG` (same with `-pooler` before the first dot). Plus `PGUSER`
   (`neondb_owner`) and `PGDATABASE` (`neondb`).
2. **`dev` branch host** — create a Neon `dev` branch in the console; put its
   `PGHOST_DEV` (direct) and `PGHOST_POOLED_DEV` in `.env.defaults`. The harness uses
   the direct one; the pooled one is only for `npm run dev` with `APP_ENV=dev`.
3. **`server/.env.local`** (git-ignored): `APP_ENV` (`dev` recommended so both
   `npm run dev` and `npm test` use the `dev` branch; `stg` also works),
   `PGPASSWORD_DEV`, `PGPASSWORD_STG`.
4. `PGHOST_PRD` / `PGHOST_POOLED_PRD` / `PGPASSWORD_PRD` — not now; set in the prod
   deploy's secret store later.

**Security:** the credentials pasted into `server/.env.example` earlier are effectively
public. Rotate the `stg` role password in the Neon console before putting it in
`.env.local`; the old `server/.env.example` file is deleted (replaced by
`.env.defaults`, step 7).

## Approach

### 1. Dependencies (`server/package.json`)

- Remove: `better-sqlite3`, `@types/better-sqlite3`.
- Add: `pg`, `@types/pg`.
- Scripts (repeat `--env-file`; later file wins). No script injects `APP_ENV` — the
  database target is whatever `.env.local` sets:
  - `dev`: `tsx watch --env-file=.env.defaults --env-file-if-exists=.env.local src/server.ts`
  - `test`: `tsx --env-file=.env.defaults --env-file-if-exists=.env.local --test src/**/*.test.ts`
  - `start`: unchanged (`node dist/server.js`), env supplied by the deploy.
- Node 26 already supports `--env-file` / `--env-file-if-exists`; no `dotenv` needed.

### 2. Connection + env switch (`server/src/db.ts` — rewrite)

- `const E = process.env.APP_ENV?.toUpperCase()` — **throw** unless `E` is one of
  `DEV` / `STG` / `PRD` (no default, so a misconfigured prod deploy fails loudly
  instead of silently using `stg`). A comment lists the three allowed values. `E` picks
  the `_DEV` / `_STG` / `_PRD` postfix.
- Export a shared resolver so the runtime pool and the test harness build their configs
  the same way:
  ```ts
  export function connConfig({ direct = false } = {}): pg.PoolConfig {
    const host = direct
      ? process.env[`PGHOST_${E}`]
      : process.env[`PGHOST_POOLED_${E}`] ?? process.env[`PGHOST_${E}`];
    const password = process.env[`PGPASSWORD_${E}`];
    // throw a clear error if host or password is missing
    return {
      host, user: process.env.PGUSER, password, database: process.env.PGDATABASE,
      ssl: { rejectUnauthorized: true },   // Neon: TLS + SCRAM channel binding handled by pg
      max: 10,
    };
  }
  export const pool = new pg.Pool(connConfig());
  ```
  (Plain multi-statement DDL in `initSchema` runs fine over the pooled endpoint; the
  test harness passes `{ direct: true }` because it needs per-connection `SET
  search_path`.)
- Export a `Queryable` type — `{ query(text, params?): Promise<{ rows: any[]; rowCount: number | null }> }`
  — satisfied by both `pg.Pool` and `pg.PoolClient`; read-only data-layer functions take
  `db: Queryable`. Export `type Db = pg.Pool` for the functions that open a transaction.
- Export `initSchema(db: Queryable = pool)` — runs `schema.sql` (still idempotent).
- Export `withTransaction<T>(db: Db, fn: (client: Queryable) => Promise<T>): Promise<T>`
  — checks out a client **from `db`** (so tests transact on their own isolated-schema
  pool, not the runtime pool), `BEGIN` / `COMMIT` / `ROLLBACK` on throw / `release()` in
  `finally`. Replaces `db.transaction(...)`. `importTournament` / `mergePlayers` /
  `remapEventPlayer` take `db: Db` and pass it through; `createRouter` takes `db: Db`.

### 3. Schema dialect (`server/src/schema.sql`)

- Drop the `PRAGMA` lines.
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`
  (for `players`, `event_players`, `games`). `events.id` (`INTEGER PRIMARY KEY`, seeded
  with explicit 1/2) → same `GENERATED BY DEFAULT AS IDENTITY` so both the explicit seed
  and importer-generated ids work.
- `INSERT OR IGNORE INTO events ...` → `INSERT INTO events (id, name) VALUES (...) ON CONFLICT (id) DO NOTHING;`
- After the seed, realign the identity sequence:
  `SELECT setval(pg_get_serial_sequence('events','id'), GREATEST((SELECT MAX(id) FROM events), 1));`
- `CREATE TABLE/INDEX IF NOT EXISTS`, `TEXT`, `TEXT UNIQUE`, `REFERENCES`, composite
  `UNIQUE (...)` all carry over unchanged.
- Keep `is_game` as `SMALLINT` 0/1 (importer already passes 1/0) to minimize churn.

### 4. Query dialect fixes (`analysis.ts`, `players.ts`, `importTournament.ts`)

Every exported function becomes `async`, returns a `Promise`, and awaits DB calls.
Replace `db.prepare(sql).get(p)` / `.all(p)` / `.run(p)` with
`(await db.query(sql, values)).rows[0]` / `.rows` / result, rewriting every query to
plain `$1..$n` positional placeholders (no named-param shim — match `pg` convention).
For the few queries that reference one id many times (`getPlayerDetail` rollup CTE,
`getPlayerHistory`, `getMatchups`), restructure to bind it once via a leading
`WITH me AS (SELECT $1::int AS pid)` CTE joined into the body, so each stays a
single-bind call.

Mechanical dialect edits across those queries:

- `lastInsertRowid` → add `RETURNING id` and read `rows[0].id`.
- `.changes` → `result.rowCount`.
- `COLLATE NOCASE` in `ORDER BY` → `ORDER BY lower(<col>)`.
- Aggregates return `bigint`/`numeric` as **strings** in `pg` — add `::int` casts:
  `COUNT(*)::int`, `COUNT(DISTINCT ...)::int`, `SUM(pg.won)::int`, `SUM(1 - pg.won)::int`,
  `{ n: COUNT(*)::int }`, etc. (`getPlayerDetail` rollup, `listPlayers`, `getPlayerDetail`
  events subquery, `getPlayerHistory` total, `listEvents`, `getEvent`).
- `GROUP_CONCAT(DISTINCT player_id)` → `string_agg(DISTINCT player_id::text, ',')`
  (in `findDuplicateHints` EGF group query).
- `ORDER BY e.date IS NULL, e.date DESC` — valid in Postgres, leave as is.
- `db.transaction((): T => { ... })()` in `remapEventPlayer` / `mergePlayers` /
  `importTournament` → `await withTransaction(async (client) => { ... })`; pass `client`
  down into `resolveCanonicalPlayer(client, ...)` (works via `Queryable`).
- `importTournament`: the pre-transaction dup check + `parseOpenGotha` stay outside the
  transaction (query on the passed-in `db`); the prepared `insertEventPlayer` /
  `insertGame` loops become plain `await client.query(text, values)` calls.
- `intParam` and numeric coercions in `routes.ts` are unaffected (casts above already
  return numbers).

### 5. Routes + server bootstrap

- `server/src/routes.ts`: `createRouter(db: Db)`; every handler becomes `async`.
  Wrap handlers in a small `asyncHandler(fn)` (`(req,res,next) => fn(req,res,next).catch(next)`)
  since Express 4 does not catch async rejections. Known typed errors
  (`DuplicateImportError`, `NotOpenGothaError`, `MergeError`, `RemapError`) keep their
  existing status mapping; unknown errors fall through to an error middleware.
- `server/src/server.ts`: add `app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: err.message }); })`.
  Call `await initSchema()` before `app.listen(...)` (wrap in an `async main()`).

### 6. Test harness (`server/src/testdb.ts` — rewrite) + all `*.test.ts`

- `makeTestDb()` → `async makeTestDb()` returning `{ db: pg.Pool, cleanup: () => Promise<void> }`:
  - Build its own `pg.Pool` config via `connConfig({ direct: true })` from `db.ts` — the
    same `APP_ENV`-selected fields as the runtime, forced to the direct host. Not the
    `db.ts` runtime `pool` object.
  - Generate a unique schema name `test_<16 hex>`.
  - Admin pool (same config): `CREATE SCHEMA "<name>"`.
  - Data pool with `pool.on('connect', c => c.query('SET search_path TO "<name>"'))`,
    then `await initSchema(dataPool)`.
  - `cleanup`: `await dataPool.end()`, `DROP SCHEMA "<name>" CASCADE`, `await admin.end()`.
  - Per-schema isolation means test files can still run in parallel processes safely,
    and stay clear of real data even when `APP_ENV` points at `stg`.
- `readFixture` unchanged.
- Each test (`players.test.ts`, `analysis.test.ts`, `importTournament.test.ts`):
  - `test('...', async (t) => { const { db, cleanup } = await makeTestDb(); t.after(cleanup); ... })`.
  - Convert the local helpers (`addEp`, `addGame`, `canonicalId`) and inline
    `db.prepare(...).get()/.all()` assertions to `await db.query(...)` reading `.rows`.
  - `await` every call to the now-async data-layer functions.
- If Neon connection limits bite under parallel files, add `--test-concurrency=1` to the
  test script (note in README).

### 7. Config files

- Replace the old `server/.env.example` (had live creds) with a secret-free template.
  Create **`server/.env.defaults`** (committed, no secrets, **no `APP_ENV`**):
  ```
  PGUSER=neondb_owner
  PGDATABASE=neondb
  PGHOST_DEV=ep-<dev-branch>.us-west-2.aws.neon.tech
  PGHOST_POOLED_DEV=ep-<dev-branch>-pooler.us-west-2.aws.neon.tech
  PGHOST_STG=ep-patient-sound-a64ff7u3.us-west-2.aws.neon.tech
  PGHOST_POOLED_STG=ep-patient-sound-a64ff7u3-pooler.us-west-2.aws.neon.tech
  # PGHOST_PRD / PGHOST_POOLED_PRD — set in the prod deploy's secret store
  ```
- Rewrite **`server/.env.example`** (committed template, no secrets) documenting the
  keys and allowed `APP_ENV` values; a dev copies it to git-ignored
  **`server/.env.local`** and fills in:
  ```
  APP_ENV=dev          # one of dev | stg | prd
  PGPASSWORD_DEV=
  PGPASSWORD_STG=       # only needed if APP_ENV=stg
  ```
- `.gitignore`: ignore all `.env*` except the committed templates
  (`!.env.defaults`, `!.env.example`). The `*.db*` / `data/` lines can stay or be
  removed.
- `README.md`: update Requirements (Neon/Postgres, no native build step), Setup
  (`PGHOST_DEV` / `PGHOST_POOLED_DEV` in `.env.defaults`; `cp .env.example .env.local`
  and fill in `APP_ENV` + `PGPASSWORD_DEV` / `PGPASSWORD_STG`), Scripts table (layered
  `--env-file`; `npm test` targets whatever `APP_ENV` selects), and the "writes its
  database to `server/data.db`" paragraph (now discrete `PG*_<ENV>` vars; schema
  auto-applied on startup).

## Files touched

- Rewrite: `server/src/db.ts`, `server/src/testdb.ts`, `server/src/schema.sql`
- Async conversion + dialect: `server/src/analysis.ts`, `server/src/players.ts`,
  `server/src/importTournament.ts`, `server/src/routes.ts`, `server/src/server.ts`
- Tests: `server/src/analysis.test.ts`, `server/src/importTournament.test.ts`,
  `server/src/players.test.ts`
- Config: `server/package.json`, rewrite `server/.env.example` (secret-free template),
  add `server/.env.defaults` (committed) + `server/.env.local` (git-ignored),
  `.gitignore`, `README.md`
- `package-lock.json` regenerated by `npm install`

## Verification

1. `npm install` (root) — confirm `pg` installed, `better-sqlite3` gone, no native build.
2. `server/.env.defaults` has the `dev` + `stg` hosts; `server/.env.local` has
   `APP_ENV` (`dev` or `stg`) + `PGPASSWORD_DEV` / `PGPASSWORD_STG`.
3. `npm test` — the full server suite passes against the branch `APP_ENV` selects; each
   run leaves no `test_*` schemas behind (spot-check with `\dn` / a `SELECT` on
   `information_schema.schemata`).
4. `npm run dev` — server boots, logs the listening line, `schema.sql` applied to the
   `APP_ENV` branch (verify tables + seeded `events` 1/2 exist in the Neon console).
5. In the browser (http://localhost:5173):
   - Import `events/`-style OpenGotha `.xml` → 201 with summary; re-upload → 409.
   - Players list shows counts + duplicate hints; open a player → history pagination,
     losing/even/winning splits, per-event wins.
   - Event page → remap a player; Players page → merge two canonical players.
6. Restart `npm run dev` → data persists (now in Neon, not a local file).
