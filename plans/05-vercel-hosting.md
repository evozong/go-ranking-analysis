# Host go-ranking-analysis on Vercel

## Context

Today the repo is a two-workspace monorepo:

- **`web/`** — React + Vite SPA. Talks only to `/api`.
- **`server/`** — Express JSON API on port 3001, Neon Postgres via `pg`, Google
  OIDC + invite-only gate, idempotent `schema.sql` applied on startup.

The intended prod shape (README "Production") is already **single-origin**: with
`APP_ENV=prd` the Express process also serves `web/dist`, so the SPA and `/api`
share an origin and the session cookie is first-party (no CORS). Vercel fits this
model directly:

- **Static** `web/dist` → Vercel's CDN.
- **`server/` Express app** → one Vercel Serverless Function mounted at `/api/*`.
- Same Vercel domain for both → cookie stays first-party, no CORS, no code change
  to `web/`.

Neon already hosts the database; nothing about hosting moves it. We only add a
`prd` Neon branch and point Vercel env at it.

### Recommendation

Single Vercel project: static build for `web/`, plus a catch-all serverless
function that wraps the existing Express app. This is the smallest change and
preserves the same-origin cookie design. (Alternatives — splitting API onto
Render/Fly, or two Vercel projects — add CORS/cookie complexity for no benefit
here.)

### Rejected: server on Vercel, `web/` on Cloudflare Pages

Considered hosting the API function on Vercel and the static SPA on Cloudflare
Pages. **Not chosen** — it dismantles the single-origin, first-party-cookie
design the auth layer was built around (README "Production": "single origin …
first-party (no CORS)") for no concrete benefit at this scale.

- **Different registrable domains** (`*.pages.dev` + `*.vercel.app`) make the
  session cookie a **third-party cookie** to the SPA. Safari and Firefox block
  those outright and Chrome is removing them, so sign-in fails for many users.
  Non-starter.
- **Salvageable only** by putting both behind one registrable domain we own —
  `app.example.com` → Pages, `api.example.com` → Vercel, cookie scoped
  `Domain=example.com` (same-site, different-origin). That works but still costs:
  - add a `cors` dependency + exact-origin `Access-Control-Allow-Credentials`
    config + preflight handling (the API has no CORS today);
  - `auth.ts` cookie changes (`Domain=` attribute);
  - `web/` switches every fetch to `credentials: 'include'` and prepends an
    absolute `VITE_API_BASE_URL`;
  - two deploy pipelines, env vars duplicated across two dashboards;
  - preview deployments get non-aligned `app.`/`api.` hosts, so OAuth only works
    on the production subdomains.
- Cloudflare Pages hosting the static bundle buys nothing measurable here (an
  invite-only tool with negligible static traffic); Vercel already serves the
  bundle free from the same CDN, co-located with the function.
- If Cloudflare's edge is wanted later, the non-invasive route is to proxy the
  **whole single Vercel deployment** through Cloudflare on one domain — no split,
  no auth changes.

Going fully Cloudflare instead (Pages + Workers for the API) is also rejected:
Workers is not Node, so `pg`, `multer`, and `google-auth-library` would each need
reworking.

---

## Work items

### 1. Split the server entrypoint (`server/src/`)

`server.ts` currently does `initSchema()` then `app.listen()`. Vercel never calls
`listen` — it imports a handler — so schema init must move off the listen path.

- **New `server/src/app.ts`** — builds and exports the Express `app`. Move
  everything from `server.ts` here **except** `app.listen` / `main()`. Also:
  - **Drop** the `if (APP_ENV === 'PRD') { express.static(webDist) … }` block.
    Vercel serves the static SPA; the function only handles `/api`.
  - Add a **lazy, memoized schema gate**:
    ```ts
    let schemaReady: Promise<void> | undefined;
    export function ensureSchema() {
      return (schemaReady ??= initSchema());
    }
    app.use((_req, _res, next) => ensureSchema().then(() => next(), next));
    ```
    Runs once per warm instance; idempotent `schema.sql` makes a rare double-run
    harmless.
- **`server/src/server.ts`** shrinks to the local-dev entry: import `app` +
  `ensureSchema`, `await ensureSchema()`, `app.listen(PORT)`. `npm run dev` and
  `npm test` are unaffected.
- Tests that import `server.ts` (if any) should import `app.ts` instead — check
  `auth.test.ts` / `routes` tests.

### 2. Vercel function entry (`api/index.ts` at repo root)

```ts
import app from '../server/src/app.js';
export default app;
```

Vercel's Node runtime accepts an Express app as the default export. One file, so
add a rewrite (step 4) to funnel all `/api/*` paths to it.

Verify Vercel's esbuild resolves the server's `.js`-suffixed NodeNext imports and
`"type": "module"`; if it balks, add a tiny handler wrapper instead of exporting
`app` directly.

### 3. `schema.sql` must ship with the function

`db.ts` does `readFileSync(join(here, 'schema.sql'))` where `here` derives from
`import.meta.url`. After bundling, `schema.sql` won't sit next to the output.
Options, in order of preference:

1. **`includeFiles` in `vercel.json`** (below) + resolve the path from the
   project root: `readFileSync(join(process.cwd(), 'server/src/schema.sql'))`,
   keeping the `import.meta`-relative path as a local-dev fallback.
2. If that proves flaky, inline the SQL: generate `server/src/schema.sql.ts`
   (`export default \`…\``) from `schema.sql` in a prebuild step and import it.

### 4. `vercel.json` (repo root)

```jsonc
{
  "buildCommand": "npm run build -w web",
  "outputDirectory": "web/dist",
  "functions": {
    "api/index.ts": { "includeFiles": "server/src/schema.sql" }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/index" },
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ]
}
```

- Root `npm install` installs both workspaces; server deps hoist to root
  `node_modules` so the function bundles fine. Only `web/` is built.
- Second rewrite is the SPA history-fallback (react-router).
- Set the function **region** near Neon (`us-west-2`) — e.g. `sfo1` — via
  `"regions": ["sfo1"]` or project settings, to cut DB round-trip latency.

### 5. Connection pooling for serverless (`server/src/db.ts`)

- Use the **pooled** Neon host in prod — `PGHOST_POOLED_PRD` (PgBouncer). The
  existing `connConfig()` already prefers `PGHOST_POOLED_<ENV>`; just make sure
  the env var is set.
- `connConfig()` hardcodes `max: 10`. Each warm function instance holds its own
  pool, so lower it for serverless: read `PGPOOL_MAX` (default 10 locally, set
  `PGPOOL_MAX=1` or `2` in Vercel).
- Transactions (`withTransaction`, used by import/merge/remap) use
  `pool.connect()` + `BEGIN/COMMIT` — fine through the Neon pooler in session
  mode; no driver change needed. (If pooler transaction-mode issues appear,
  switch those paths to the direct host or adopt `@neondatabase/serverless`.)

### 6. Neon `prd` branch

- Create a `prd` branch (or a separate prod project) in the Neon console.
- Grab its direct + pooled host and the role password.
- Schema auto-applies on the first request (step 1 gate). `schema.sql` seeds the
  owner email into `allowed_emails`, so the first sign-in isn't locked out.
- Add invitees later with `INSERT INTO allowed_emails …` (README "Managing the
  invite list").

### 7. Environment variables (Vercel → Project → Settings → Environment Variables, Production)

Everything the npm scripts currently inject via `--env-file` must be set
explicitly — Vercel doesn't read `.env.defaults`:

| Var | Value |
|---|---|
| `APP_ENV` | `prd` |
| `PGUSER` | `neondb_owner` (from `.env.defaults`) |
| `PGDATABASE` | `neondb` (from `.env.defaults`) |
| `PGHOST_PRD` | Neon `prd` direct host |
| `PGHOST_POOLED_PRD` | Neon `prd` pooled host |
| `PGPASSWORD_PRD` | Neon `prd` role password |
| `PGPOOL_MAX` | `1` (or `2`) — needs the step-5 change |
| `AUTH_GOOGLE_CLIENT_ID` | existing OAuth client |
| `AUTH_GOOGLE_CLIENT_SECRET` | existing OAuth client |
| `AUTH_SESSION_SECRET` | fresh `openssl rand -base64 48` |
| `AUTH_REDIRECT_URI` | `https://<domain>/api/auth/callback` |
| `AUTH_WEB_ORIGIN` | `https://<domain>` (no trailing slash) |
| `AUTH_SESSION_TTL_DAYS` | optional |

`authConfig.cookieSecure` is already `true` whenever `APP_ENV !== 'DEV'`, so the
session cookie gets `Secure` on Vercel automatically.

### 8. Google OAuth client

- Add **`https://<domain>/api/auth/callback`** to the client's Authorized
  redirect URIs (alongside the existing localhost/stg entries — one client is
  shared).
- OAuth consent screen must be **Published** (or every invitee added as a test
  user) or sign-in fails.
- **Preview deployments**: each gets a unique `*.vercel.app` URL and Google
  forbids wildcard redirect URIs, so auth only works on the stable production
  domain (and any specific preview URLs you hand-register). Acceptable for an
  invite-only tool; note it.

### 9. Deploy & verify

1. `vercel link`, push branch, open the preview (expect auth to bounce — use the
   assigned production domain for the real test), or promote to production.
2. Hit `https://<domain>/` → landing page renders (not signed in).
3. `GET /api/auth/me` → `{ authenticated: false, authorised: false }`.
4. Sign in with the owner Google account → redirected home, full app.
5. Import a small OpenGotha `.xml`, browse Events / Players, exercise a merge.
6. Check Vercel function logs: first request shows schema init once; no pool
   exhaustion.

---

## Caveats / known limits

- **Request body cap.** Vercel serverless functions cap the request body at
  **4.5 MB**; `multer` here allows 10 MB. OpenGotha XML files are tiny (well
  under 1 MB), so this is only theoretical — optionally lower the `multer` limit
  to `4 * 1024 * 1024` so oversize uploads fail cleanly as 413 rather than a
  platform error.
- **Cold starts.** First request per instance pays schema init + Neon TLS
  handshake. Fine for an invite-only tool; enable Fluid Compute / a warm-up ping
  if it bothers you.
- **Per-instance caches.** The allowlist cache (~60 s) and the schema-init
  promise are per warm instance — already designed to tolerate that.
- **Function timeout.** Import/merge transactions are well under the 10 s Hobby /
  60 s Pro limit.
- `infra/` (OpenTofu) is unrelated and untouched by this plan.

## Files touched

- `server/src/app.ts` — **new**, extracted from `server.ts`
- `server/src/server.ts` — reduced to local-dev entry
- `server/src/db.ts` — `PGPOOL_MAX`, robust `schema.sql` path
- `api/index.ts` — **new**, function entry
- `vercel.json` — **new**
- `server/src/*.test.ts` — import `app.ts` if they referenced `server.ts`
- `README.md` — add a "Deploying to Vercel" section
