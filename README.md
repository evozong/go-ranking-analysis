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

Single origin: with `APP_ENV=prd` the server also serves the built `web/dist`, so
`/api` and the SPA share an origin and the session cookie is first-party (no
CORS). Run `npm run build` before deploying.

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
