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

## Authentication (Google sign-in, invite-only)

The whole app sits behind Google sign-in and an **invite list**. Not signed in →
only the public landing page (`/`); every data API returns 401. Signed in but not
invited → still only the landing page; APIs return 403. Signed in **and** on the
list → the full app.

### One-time Google Cloud setup

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client
   ID → Web application**.
2. **Authorized redirect URIs** — add every environment's callback (one client is
   shared across all of them; this isn't app data):
   - `http://localhost:3001/api/auth/callback` — dev **and** `npm test`
   - `https://<stg-host>/api/auth/callback` — staging
   - `https://<prod-host>/api/auth/callback` — production
3. **OAuth consent screen**: External; scopes `openid`, `email`, `profile`. While
   the screen is in "Testing" only listed test users can sign in — either add the
   invitees as test users or click **Publish app** (no verification needed for
   these basic scopes).
4. Copy the **Client ID** and **Client secret** into `server/.env.local`.

### Env vars (`server/.env.local`)

```
AUTH_GOOGLE_CLIENT_ID=...
AUTH_GOOGLE_CLIENT_SECRET=...
AUTH_SESSION_SECRET=...     # 32+ random bytes, base64: openssl rand -base64 48
# AUTH_SESSION_TTL_DAYS=7   # optional, sliding session lifetime (default 7)
```

`AUTH_REDIRECT_URI` and `AUTH_WEB_ORIGIN` default to `localhost` in the committed
`server/.env.defaults`; stg/prd override them (plus the three secrets) from their
secret store. The server refuses to start (and `npm test` for `auth.test.ts`
falls back to dummy values) if the three secrets are missing.

The session is a stateless signed `HttpOnly` cookie (`jose`, HS256) with a
sliding 7-day window; there is no session table. Google tokens never reach the
browser — the server is the OIDC client and issues its own session.

### Managing the invite list

The `allowed_emails` table **is** the mechanism — no env var, no CLI. Add or
remove invitees by editing rows directly (Neon console / `psql`):

```sql
INSERT INTO allowed_emails (email) VALUES ('friend@example.com')
  ON CONFLICT (email) DO NOTHING;
DELETE FROM allowed_emails WHERE email = 'friend@example.com';
```

Emails are stored lowercased. Authorisation is re-checked per request with a
~60-second in-process cache, so a change takes effect within a minute — no
restart, no re-login. `schema.sql` seeds the owner's own email so the first
sign-in isn't locked out.

### Production

Production runs on **Vercel** as a single project (see "Deploying to Vercel"
below): the static `web/dist` bundle on Vercel's CDN plus one serverless function
(`api/index.ts`) wrapping the Express app, both on the same Vercel domain. `/api`
and the SPA share an origin, so the session cookie stays first-party (no CORS).

## Scripts (run from the repo root)

| command | what it does |
|---|---|
| `npm run dev` | runs the API (`tsx watch`) and the Vite dev server together |
| `npm run build` | type-checks + builds both workspaces |
| `npm test` | runs the server test suite (`node:test` via `tsx`) |

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

## Deploying to Vercel

One Vercel project serves both halves from the same domain:

- **`web/dist`** → Vercel's CDN (`buildCommand: npm run build -w web`).
- **`api/index.ts`** → a single serverless function that forwards each request
  to the Express `app` from `server/src/app.ts`. Vercel compiles the entry to
  CommonJS while the server workspace is native ESM, so the app is pulled in
  through a memoized dynamic `import()` rather than a static re-export.
  `vercel.json` rewrites every `/api/*` path to it and everything else to
  `/index.html` (SPA history fallback).

`server/src/app.ts` builds the app; `server/src/server.ts` is only the local-dev
`listen` entry. Schema init is a lazy, memoized gate (`ensureSchema()`), run once
per warm function instance on the first request — `schema.sql` is idempotent so a
cross-instance double-run is harmless. `schema.sql` ships with the function via
`includeFiles` in `vercel.json`; `db.ts` reads it from `server/src/schema.sql`
relative to `process.cwd()` when the bundled sibling path is gone.

### One-time setup

1. **Neon `prd` branch** — create it in the Neon console; note its direct host,
   pooled host, and role password. Schema + the owner-email seed apply on the
   first request.
2. **Google OAuth client** — add `https://<domain>/api/auth/callback` to the
   shared client's Authorized redirect URIs, and make sure the consent screen is
   **Published** (or every invitee is a test user). Preview deployments get
   unique `*.vercel.app` URLs that Google won't accept, so auth only works on the
   stable production domain.
3. **`vercel link`** the repo (`npm i -g vercel` first).
4. **Environment variables** (Vercel → Project → Settings → Environment
   Variables, Production) — Vercel does not read `.env.defaults`, so set them all:

   | Var | Value |
   |---|---|
   | `APP_ENV` | `prd` |
   | `PGUSER` | `neondb_owner` |
   | `PGDATABASE` | `neondb` |
   | `PGHOST_PRD` | Neon `prd` direct host |
   | `PGHOST_POOLED_PRD` | Neon `prd` pooled host |
   | `PGPASSWORD_PRD` | Neon `prd` role password |
   | `PGPOOL_MAX` | `1` (or `2`) — one pool per warm instance |
   | `AUTH_GOOGLE_CLIENT_ID` | existing OAuth client |
   | `AUTH_GOOGLE_CLIENT_SECRET` | existing OAuth client |
   | `AUTH_SESSION_SECRET` | fresh `openssl rand -base64 48` |
   | `AUTH_REDIRECT_URI` | `https://<domain>/api/auth/callback` |
   | `AUTH_WEB_ORIGIN` | `https://<domain>` (no trailing slash) |
   | `AUTH_SESSION_TTL_DAYS` | optional |

   `cookieSecure` is already `true` whenever `APP_ENV !== 'DEV'`.

### Deploy & verify

1. `vercel --prod` (or push and promote from the dashboard).
2. `https://<domain>/` → landing page renders when not signed in.
3. `GET /api/auth/me` → `{ authenticated: false, authorised: false }`.
4. Sign in with the owner Google account → redirected home, full app.
5. Import a small OpenGotha `.xml`, browse Events / Players, exercise a merge.
6. Function logs: schema init runs once per cold start; no pool exhaustion.

### Known limits

- Vercel caps the request body at 4.5 MB; `multer` is set to 4 MB so oversize
  uploads fail as a clean 413. OpenGotha files are well under 1 MB.
- Cold starts pay schema init + Neon TLS handshake. Fine for an invite-only tool.
- The allowlist cache (~60 s) and the schema-init promise are per warm instance.

## Using it

1. `npm run dev`, open http://localhost:5173.
2. **Import** → upload an OpenGotha `.xml`. Re-uploading the same file is rejected (409).
   Or switch to **Standings CSV** mode and upload a parsed standings-table CSV
   (`Num,Pl,Name,Female,Rk,NbW,R1..Rn,NBW,SOS,SOSOS`): it is converted to a
   DTD-conformant OpenGotha `.xml` (downloaded automatically) and imported through
   the same pipeline in one request. Name/date pre-fill from the filename and stay
   editable. Short-format standings can't mark forfeits, so every played result
   becomes a plain game; `0+` is a bye, `0-` a not-paired round. Re-importing a
   CSV whose tournament name + date already exist is rejected (409), as is
   re-uploading the generated `.xml` through the OpenGotha path.
3. **Events** / **Players** to browse; a player page shows reverse-chronological game
   history plus opponents split into losing / even / winning records.
4. On an event page you can **remap** a mis-matched player to the correct canonical
   player (or a fresh one) without re-importing.
5. On the **Players** page, likely duplicate canonical players are flagged (same EGF
   pin / similar name); tick two or more rows, pick the keeper, and **merge** to
   repoint their game history onto one player.

## Layout notes

- `server/src/standingsCsv.ts` — standings-table CSV → DTD-conformant OpenGotha
  XML string (`parseStandingsTable` + `buildOpenGothaXml`). Fed straight into the
  existing importer; rank→rating is an approximate EGF-linear lookup our importer
  never reads.
- `server/src/openGotha.ts` — XML → tournament struct. The `<Game>` player-key rule
  (`playerKey()`) has a marked spot to adjust if a real file disagrees.
- `server/src/result.ts` — OpenGotha `result` enum → normalized outcome; also a marked
  adjust spot.
- `server/src/schema.sql` — schema + seed of the two always-present `Open` events.
