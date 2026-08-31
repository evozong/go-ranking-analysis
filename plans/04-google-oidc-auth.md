# Google OIDC login + invite-only access control

## Context

The app currently has **no authentication**. `server/` exposes `/api/*` (Express, port
3001) to anyone who can reach it; `web/` (React SPA, Vite 5173, `/api` proxied to 3001)
renders five routes with `/` redirecting to `/events`. Neon Postgres is the data store,
`server/src/schema.sql` is idempotent and auto-applied on startup.

Goal: put the whole app behind **Google sign-in** and make access **invite-only**:

- The owner maintains a list of authorised email addresses.
- A visitor who is **not signed in** sees only a public **main page** (a new `/`
  landing page). Every other page and every data API returns 401.
- A visitor who **signs in with Google but is not on the allowlist** is authenticated
  but **not authorised**: still only the main page; every other page redirects back to
  `/` and every data API returns 403. The main page tells them they're signed in as
  X and need to be invited.
- A visitor who **signs in and is on the allowlist** gets the full app.

### Design decisions

- **Flow: server-side OAuth 2.0 / OIDC Authorization Code flow with PKCE.** The
  Express server is the OIDC client (holds `client_secret`), handles the Google
  redirect callback, verifies the ID token, and issues its **own** session as a
  signed, `HttpOnly` cookie. Google tokens never reach the browser JS. Chosen over a
  frontend Google Identity Services button because it keeps tokens out of JS, gives a
  clean server-controlled logout, and the SPA only ever talks to same-origin `/api`.
- **Session: stateless signed JWT cookie** (`jose`, HS256, `AUTH_SESSION_SECRET`),
  payload `{ sub, email, name, picture }`. No session table.
  **Authorisation is re-checked from the `allowed_emails` table on every request**
  (with a short in-process cache), so a deleted row takes effect within the cache TTL
  regardless of outstanding cookies — no session revocation store needed.
- **Session lifetime: sliding 7-day window.** The cookie is minted at login with
  `exp = now + 7d` (`Max-Age` matched). `authMiddleware` re-issues it (fresh 7-day
  `exp`, same claims) when the current one is more than ~1 day old, so an active user
  is never logged out mid-session while an idle cookie still dies 7 days after last
  use. On expiry the next request 401s and the SPA routes to `/`; "Sign in with
  Google" then does a normally-silent redirect (no password/consent) if the user's
  Google session is still alive. `AUTH_SESSION_TTL_DAYS` (default 7) makes this
  tunable.
- **No token storage.** Google's ID token is used once at the callback to establish
  identity and then discarded; we request only `openid email profile` and call no
  Google API afterward, so there is **no access token or refresh token to keep**
  (`access_type=online`, no offline scope). `name` + `picture` are **claims in that
  ID token** — we copy them into our own session cookie at callback time, so
  `/api/auth/me` can return them and the browser loads the avatar directly from its
  public `lh3.googleusercontent.com` URL with no further Google calls. `ProfileMenu`
  falls back to an initial glyph if that URL ever fails to load.
  - **Caveat — `name`/`picture` can be stale.** They are a snapshot from the last
    *full* sign-in. The sliding re-issue only re-signs the existing claims with a
    fresh `exp` (no Google call), so it does **not** refresh them — a continuously
    active user could carry an out-of-date avatar/name for weeks. Accepted trade-off:
    it's cosmetic, and avoiding redirects is the whole point of sliding renewal. If it
    ever matters, the escape hatch is `AUTH_SESSION_TTL_DAYS=1` + dropping the sliding
    re-issue, so the ~daily (normally invisible) re-auth refreshes the claims too.
  Our own session is the
  self-contained signed cookie — verified by signature + `exp`, not looked up
  anywhere — so there is nothing to persist server-side. The one tradeoff: an
  individual cookie can't be force-revoked before it expires; removing the person's
  `allowed_emails` row still cuts off all data access within the cache TTL. If instant
  "sign out everywhere" / per-session revocation is ever wanted, that's a `sessions`
  table (or a `token_version` column on a users table) — listed under follow-ups.
  The only thing written mid-flow is the PKCE `code_verifier` + `state`, held in a
  10-minute signed cookie, never the DB.
- **Allowlist: the `allowed_emails` table is the whole mechanism.** No env var, no
  startup sync, no CLI. The owner adds/removes invitees by editing rows directly in
  the DB (Neon console / `psql`). `schema.sql` seeds the owner's own email so the
  first sign-in isn't locked out (idempotent `INSERT … ON CONFLICT DO NOTHING`, same
  pattern as the seeded `Open` events).
- **Library: `google-auth-library`** (Google-maintained, lightweight) for the auth-code
  redirect URL, code→token exchange, and `verifyIdToken`. `openid-client` is the
  heavier standards-complete alternative; not needed for a Google-only app.
- **Prod origin:** assumed **single origin** — Express serves the built `web/dist` and
  `/api` together — so the session cookie is first-party with no CORS. A step adds the
  static serving for `APP_ENV=prd`. If prod will instead split web/API across origins,
  we'd add CORS + `SameSite=None`; flag this and the plan adjusts.

## Google Cloud setup (manual, one-time — documented in README)

1. Google Cloud Console → **APIs & Services → Credentials → Create OAuth client ID →
   Web application**.
2. **Authorized redirect URIs**: `http://localhost:3001/api/auth/callback` (dev) and
   the prod callback URL (e.g. `https://<prod-host>/api/auth/callback`).
3. **OAuth consent screen**: External. Scopes: `openid`, `email`, `profile`. While in
   "Testing" only listed test users can sign in at all — either add the invitees as
   test users or click **Publish app** (no verification needed for these basic scopes).
4. Copy the **Client ID** and **Client secret** into `server/.env.local` (below).

## Approach

### 1. Dependencies (`server/package.json`)

Add: `google-auth-library`, `jose`, `cookie-parser`, `@types/cookie-parser`.

### 2. Config + schema

- **`server/src/schema.sql`** — append:
  ```sql
  CREATE TABLE IF NOT EXISTS allowed_emails (
    email    TEXT PRIMARY KEY,   -- lowercased
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  INSERT INTO allowed_emails (email) VALUES ('evozong@gmail.com')
    ON CONFLICT (email) DO NOTHING;
  ```
- **`server/.env.example`** — document the new `AUTH_*` keys.
- **`server/.env.defaults`** — add the non-secret dev defaults:
  `AUTH_REDIRECT_URI=http://localhost:3001/api/auth/callback`,
  `AUTH_WEB_ORIGIN=http://localhost:5173`.
- **`server/.env.local`** (git-ignored) — the secrets:
  ```
  AUTH_GOOGLE_CLIENT_ID=...
  AUTH_GOOGLE_CLIENT_SECRET=...
  AUTH_SESSION_SECRET=<32+ random bytes, base64>
  # AUTH_SESSION_TTL_DAYS=7   # optional, defaults to 7
  ```
  Prod supplies the same three (plus prod `AUTH_REDIRECT_URI` / `AUTH_WEB_ORIGIN`) from
  its secret store.

### 3. `server/src/auth.ts` (new) — the auth core

- **Config loader**: read + validate the `AUTH_*` env at import; throw loudly if a
  required key is missing (same discipline as `db.ts` / `APP_ENV`). Derive
  `cookieSecure = APP_ENV !== 'dev'`.
- **`isAllowed(db, email): Promise<boolean>`**: `SELECT 1 FROM allowed_emails WHERE
  email = $1`, wrapped in a ~60s in-process cache (`Map<email, {ok, exp}>`, or just
  cache the whole set). Email compared lowercased.
- **Session helpers** (`jose`):
  - `createSessionCookie(claims)` → `Set-Cookie` string: signed JWT with
    `exp = now + AUTH_SESSION_TTL_DAYS` (default 7), cookie `HttpOnly`, `SameSite=Lax`,
    `Secure` when `cookieSecure`, `Path=/`, `Max-Age` matched to `exp`.
  - `readSession(req): Claims | null` → verify signature + `exp`; return null on any
    failure.
  - `clearCookie()` → expired `Set-Cookie`.
- **`authMiddleware`** (mounted before the `/api` data router): attaches
  `req.user = readSession(req)` (or null). Does **not** itself block — the data router
  wrapper does — so `/api/auth/*` stays reachable. **Sliding renewal**: if `req.user`
  and its `iat` is more than ~1 day old, set a fresh `createSessionCookie(req.user)` on
  the response, so active users never hit the 7-day cap.
- **`requireAuthorised(db)`**: middleware — 401 `{error:'authentication required'}` if
  no `req.user`; 403 `{error:'not authorised'}` if `!(await isAllowed(db, req.user.email))`;
  else `next()`.
- **`createAuthRouter({ db, verifyIdToken })`** — `verifyIdToken` injectable so tests
  don't hit Google. Routes (all under `/api/auth`):
  - `GET /login` — build PKCE `code_verifier` + `state`; stash both in a short-lived
    (`10m`) `HttpOnly` cookie (`auth_tx`, signed); 302 to Google's auth URL
    (`scope=openid email profile`, `access_type=online`, `prompt=select_account`).
  - `GET /callback` — validate `state` against the `auth_tx` cookie; exchange `code`
    (+ `code_verifier`) for tokens; `verifyIdToken({ idToken, audience: clientId })`;
    require `payload.email_verified === true`. Set the session cookie from
    `{ sub, email: email.toLowerCase(), name, picture }`, clear `auth_tx`, 302 to
    `AUTH_WEB_ORIGIN + '/'`. On any failure: clear cookies, 302 to
    `AUTH_WEB_ORIGIN + '/?auth_error=1'`.
  - `POST /logout` — clear the session cookie, 204.
  - `GET /me` — **public**; returns
    `{ authenticated: boolean, authorised: boolean, email?, name?, picture? }` for the
    SPA to drive nav + route guards. `authorised` calls `isAllowed`.

### 4. `server/src/server.ts` — wire it up

```
app.use(cookieParser());
await initSchema();   // creates allowed_emails + seeds the owner's email
app.use('/api/auth', createAuthRouter({ db: pool, verifyIdToken: realVerify }));
app.use(authMiddleware);                       // sets req.user
app.use('/api', requireAuthorised(pool), createRouter(pool));   // everything else gated
// prod only: serve the SPA from the same origin
if (APP_ENV === 'prd') {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(join(webDist, 'index.html')));
}
```

`createRouter` in `routes.ts` is unchanged — the whole data API is gated wholesale.

### 5. Web — `web/src/auth.tsx` (new)

- `AuthProvider` — on mount `fetch('/api/auth/me')`, hold
  `{ status: 'loading' | 'anon' | 'unauthorised' | 'ok', user }`.
- `useAuth()` hook.
- `login()` → `window.location.href = '/api/auth/login'`.
- `logout()` → `POST /api/auth/logout` then reset state / redirect to `/`.

### 6. Web — routing + guard

- **`web/src/pages/LandingPage.tsx`** (new) — the public main page. Brief description
  of the app. If `anon`: "Sign in with Google" button. If `unauthorised`: "You're
  signed in as {email} but not on the invite list — ask the owner to add you." If
  `ok`: a "Go to app →" link to `/events`. Renders `?auth_error=1` as a small notice.
- **`web/src/components/RequireAuth.tsx`** (new) — if `loading` render nothing/spinner;
  if `ok` render `<Outlet/>`; otherwise `<Navigate to="/" replace/>`.
- **`web/src/components/ProfileMenu.tsx`** (new) — the top-right control in the header,
  rendered on every page (including the landing page). No profile page — there are no
  user preferences.
  - `anon` → a small "Sign in" button that calls `login()`.
  - `ok` / `unauthorised` → a round 28px avatar (the `picture` claim; falls back to a
    generic person glyph / the email's first initial if it fails to load). Clicking it
    opens a small dropdown showing the name + email and a **Sign out** item that calls
    `logout()`. Close on outside-click / `Esc`; plain React state, no menu library.
- **`web/src/main.tsx`** — wrap the tree in `AuthProvider`; restructure routes:
  ```
  / (App layout)
    index            → LandingPage        (public)
    element RequireAuth
      events, events/:id, players, players/:id, import   (gated)
  ```
  (`/` no longer auto-redirects to `/events`; the landing page links there.)
- **`web/src/App.tsx`** — show the nav links only when `status === 'ok'`; render
  `<ProfileMenu/>` at the right end of the header.
- **`web/src/api.ts`** — `req()` sends same-origin cookies by default; on `401`/`403`
  throw a typed `ApiError` the pages already surface, and have `AuthProvider` treat a
  401 from any call as "session expired → go to `/`".

### 7. Dev ergonomics

Vite already proxies `/api` → 3001, which covers `/api/auth/*`. The Google redirect
URI points straight at the server (`:3001/api/auth/callback`); the callback 302s the
browser back to `AUTH_WEB_ORIGIN` (`:5173`). The session cookie is set on host
`localhost` (cookies ignore port) so it rides along to `:5173` and through the proxy.
No CORS in dev.

## Tests (`server/src/auth.test.ts`, new — `node:test` + `makeTestDb`)

1. **`isAllowed`** — email present in `allowed_emails` → true; absent → false;
   comparison is case-insensitive; a row deleted after a cached `true` flips to false
   once the ~60s cache entry expires.
2. **session cookie roundtrip** — `createSessionCookie` → `readSession` returns the
   claims; tampered payload → null; expired (`exp` in past) → null; wrong secret → null.
   Sliding renewal: a request with a >1-day-old (still valid) cookie gets a fresh
   `Set-Cookie` on the response; a <1-day-old one does not.
3. **`requireAuthorised`** against a test DB + router built with a **fake
   `verifyIdToken`**:
   - no cookie → `GET /api/players` 401.
   - valid session, email **not** in `allowed_emails` → 403.
   - valid session, email in `allowed_emails` → 200.
4. **`/api/auth/callback`** with the fake verifier returning
   `{ email, email_verified: true, ... }` and a matching `state`/`auth_tx` cookie →
   `Set-Cookie` session present, 302 `Location` = `AUTH_WEB_ORIGIN + '/'`.
   - `email_verified: false` → no session cookie, 302 to `/?auth_error=1`.
   - mismatched `state` → 400/redirect, no session.
5. **`/api/auth/me`** — anon → `{authenticated:false,authorised:false}`; signed-in
   non-allowlisted → `{authenticated:true,authorised:false,email}`; allowlisted →
   `{authenticated:true,authorised:true,...}`.
6. **`/api/auth/logout`** — response clears the cookie (`Max-Age=0`).

Add a `testdb.ts` (or `auth.test.ts`-local) helper `signTestSession(claims)` so tests 3
and 5 can forge a valid cookie without going through Google.

## Files touched

- **New**: `server/src/auth.ts`, `server/src/auth.test.ts`, `web/src/auth.tsx`,
  `web/src/pages/LandingPage.tsx`, `web/src/components/RequireAuth.tsx`,
  `web/src/components/ProfileMenu.tsx`.
- **Edit**: `server/src/schema.sql` (add + seed `allowed_emails`), `server/src/server.ts`
  (cookie-parser, auth router + gate, prod static),
  `server/package.json` (deps), `server/.env.example`,
  `server/.env.defaults`, `web/src/main.tsx` (AuthProvider + guarded routes),
  `web/src/App.tsx` (nav visibility + `<ProfileMenu/>`), `web/src/api.ts` (401/403
  handling), `web/src/styles.css` (landing, header, avatar + dropdown), `README.md`
  (Google Cloud setup, new env vars, invite-list workflow), `.gitignore` (unchanged —
  `.env*` already ignored).
- **Regenerated**: `package-lock.json`.

## Verification

1. `npm install`; create the Google OAuth client; fill `server/.env.local` with the
   three `AUTH_*` secrets.
2. `npm run dev` → `initSchema` creates + seeds `allowed_emails`; open
   `http://localhost:5173/` → landing page, "Sign in with Google", no nav links.
3. `curl -i localhost:5173/api/players` → **401**.
4. Sign in with `evozong@gmail.com` (the seeded row) → bounced back to `/`, nav
   appears, `/events` loads, import/players/matchups all work.
5. Sign in with a **different** Google account → landing page says "signed in as … not
   on the invite list"; visiting `/events` redirects to `/`; `curl` `/api/players`
   with that session cookie → **403**.
6. `INSERT INTO allowed_emails (email) VALUES ('other@gmail.com');` in the Neon console
   → within ~60s that account gets full access without re-login.
7. `DELETE FROM allowed_emails WHERE email = 'other@gmail.com';` → within ~60s that
   account drops back to 403, no restart.
8. Logout → session cookie cleared, back to the anonymous landing page.
9. Tamper the session cookie in devtools → next API call 401 → redirected to `/`.
10. `npm test` → the new `auth.test.ts` passes alongside the existing suite; no
    `test_*` schemas left behind.
11. `npm run build` → both workspaces type-check and build.

## Out of scope / follow-ups

- In-app admin UI for the allowlist (direct DB row edits only for now).
- Roles/permissions beyond the single authorised/not-authorised bit.
- Server-side session store / per-session revocation ("sign out everywhere"). Not
  needed now — nothing calls Google APIs, and allowlist removal already cuts data
  access within ~60s.
- Refresh tokens / offline access (session is a 7-day cookie; user re-signs in after).
- Rate-limiting the callback endpoint.
- Splitting web/API across origins in prod (would add CORS + `SameSite=None`).
