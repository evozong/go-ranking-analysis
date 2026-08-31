# Plan 05: Re-host off AWS — platform comparison

> Status: **analysis accepted; platform not yet chosen.** This is a
> decision-support document. Once a platform is picked, the migration steps for it
> get written up (or appended here).

## Context

Plan 04 deployed to AWS (Lambda + public Function URL + CloudFront + S3; Neon
`prd` for data). It works, but **AWS has no hard spend cap** — AWS Budgets only
*alert*. A sustained malicious flood past CloudFront's free tier (1 TB / 10M req
per month) bills the account, and the only real defenses cost money (AWS WAF,
~$10/mo) or lag the threshold (Budgets Actions).

Requirement now: the platform should **cut the service off, not bill**, when free
limits are hit. This doc compares four options.

## What we're placing

- **server/** — small Express API (~11 routes, one multipart upload, a Neon `pg`
  pool). Plan 04 already made it serverless-ready: `createApp()` factory, no
  top-level `listen`, lazy `schema.sql` read, `PG_POOL_MAX` env, upload cap,
  `initSchema()` only run out-of-band by `server.ts`/`migrate.ts`/tests.
- **web/** — React + Vite SPA, static build (`web/dist`), calls the API via
  relative `/api/...` (so same-origin hosting avoids CORS).
- **Neon Postgres `prd`** — stays as-is, region **us-west-2**.

## Evaluation criteria

Hard spend cap · app rework required · cold-start / latency · co-location with
Neon us-west-2 · same-origin `/api` · upload body limit · ToS · ops complexity.

---

## Option A — Vercel Hobby

**Spend cap:** Hobby **pauses the project** at the free ceiling (100 GB fast data
transfer/mo + function execution limits). *No overage billing, no way to pay past
the cap on Hobby.* ✅ true hard cap.

**Rework: small.** Vercel Node functions get a Node `(req, res)` — so the Express
app *is* the handler: `api/index.ts` → `export default createApp()`. Drop
`@codegenie/serverless-express`, `server/src/lambda.ts`, `build:lambda`,
`esbuild`, and the `x-origin-secret` middleware. Add `vercel.json` (rewrite
`/api/*` → the function; SPA fallback; `regions:["pdx1"]`; Node 22). Env vars in
the Vercel dashboard.

**Pros**
- Smallest rework of the "true cap" options.
- Function region pinnable to `pdx1` = us-west-2 = co-located with Neon.
- Git-push deploys, preview deployments, encrypted env vars, same-origin `/api`.
- Fast function cold starts (~200–400 ms).

**Cons**
- **Hobby is non-commercial-use only** (this personal tool qualifies, but it's a
  hard ToS line if that ever changes).
- **4.5 MB request body limit** → lower the multer cap from 6 MB (OpenGotha files
  are KB, so cosmetic).
- Short log retention on Hobby; 1 function region.
- Integration risk: `api/index.ts` importing `../server/src` across the npm
  workspace — may need a tiny shim or path config for Vercel's TS build.

---

## Option B — Cloudflare Pages + Workers

**Spend cap:** Workers free = **100k requests/day → HTTP 429** until the UTC
reset; Pages static is unlimited-free. No billing unless you opt into Workers
Paid. ✅ true hard cap.

**Rework: large.** Workers run on V8 isolates, not Node — **Express does not run**.
Port routing to **Hono** (~11 routes, mechanical) and `multer` → `c.req.parseBody()`.
Swap `pg` for **`@neondatabase/serverless`** (its `Pool` is close to drop-in, but
`withTransaction`'s `BEGIN/COMMIT` needs its WebSocket mode). Inline `schema.sql`
(no fs on Workers).

**Pros**
- **No cold starts** — isolates start in ~0 ms; best latency profile.
- Smart Placement can move compute near Neon automatically.
- Generous limits (100 MB body), great `wrangler tail` logs, commercial-use OK.

**Cons**
- **Biggest rework and risk**: Express→Hono + `pg`→Neon HTTP driver + fs removal.
  Re-test the whole request/transaction layer.
- New behavioral edges from the Neon serverless driver.
- More divergence between local dev (Node/Express) and prod (Workers) unless you
  also run Hono locally.

---

## Option C — Render (free web service)

**Spend cap:** the free web service is a fixed 512 MB / 0.1 CPU instance with
**no per-request or bandwidth billing** — a flood just saturates the one instance
(slow, 5xx); it cannot generate charges. Free egress soft-capped at 100 GB/mo
(throttle / upgrade prompt, not auto-bill). ✅ structurally can't run up a bill.

**Rework: minimal / none.** Express runs unmodified — `server.ts` already does
`app.listen(PORT)`, Render provides `PORT`. `initSchema()` on boot is fine (one
long-lived process). Add `render.yaml`: build `npm install && npm run build`
(+ `cp server/src/schema.sql server/dist/`), start `node server/dist/server.js`.
Serve `web/dist` either from Express (`express.static`, one origin) or as a Render
Static Site with a `/api/*` rewrite to the service.

**Pros**
- **Least code change by far** — no serverless adaptation at all.
- Oregon region available (matches Neon us-west-2).
- Real Node runtime: fs, long-lived pool, no body-size quirks. Commercial-use OK.
- Dead-simple mental model.

**Cons**
- **Spins down after 15 min idle → ~30–60 s cold start** on the next request
  (whole process + deps). Rough for interactive use on a low-traffic tool.
- Single tiny instance; 750 free instance-hours/mo (enough for one service).
- Limited log retention.

---

## Option D — Stay on AWS + Budgets Action kill-switch

**Spend cap:** an `aws_budgets_budget` with a **Budget Action** auto-applies a
remediation at a $ threshold — e.g. a Lambda/SSM automation that disables the
CloudFront distribution and sets the API function's reserved concurrency to 0. ⚠️
*mitigation, not a guarantee.*

**Rework: none to the app.** Plan 04 stays; add ~1 budget + an IAM role + a small
"disable" automation in `infra/`.

**Pros**
- No migration; keeps the working deployment and all Plan 04 verification.
- Normal-case cost still ~$0.

**Cons**
- **Threshold-lagged**: AWS billing data refreshes only a few times/day, so a
  fast spike overshoots before the action fires (could be tens of dollars over).
- **Coarse**: the action takes the whole site offline; re-enable is manual.
- The kill-switch is extra infra that can fail silently; you're still trusting
  AWS billing latency.
- Still no WAF / edge rate-limiting unless you pay.

---

## Comparison

| | A. Vercel Hobby | B. CF Pages+Workers | C. Render free | D. AWS + kill-switch |
|---|---|---|---|---|
| Hard cap (no bill possible) | ✅ pause | ✅ 429/day | ✅ no usage billing | ⚠️ lagged, coarse |
| App rework | small | **large** (Express→Hono, pg driver) | **~none** | none |
| Cold start | ~200–400 ms | none | **30–60 s after idle** | ~300–800 ms |
| Co-locate w/ Neon us-west-2 | ✅ pdx1 | edge (n/a) | ✅ Oregon | ✅ us-west-2 |
| Same-origin `/api` (no CORS) | ✅ | ✅ | ✅ (static via Express) | ✅ |
| Upload body limit | 4.5 MB | 100 MB | none | 6 MB |
| Commercial use allowed | ❌ non-commercial | ✅ | ✅ | ✅ |
| Ops complexity | low | low–med | low | med (IaC) |

## Preliminary recommendation

- **Smallest change + real cap, tolerate an idle cold-start pause → Render free.**
- **Fast/modern + real cap + small change, and it stays non-commercial → Vercel
  Hobby.**
- **Cloudflare** only if zero cold starts / edge execution is worth the server
  rewrite.
- **AWS + kill-switch** only if avoiding migration matters more than a real
  spend-cap guarantee.

## Open questions before choosing

1. Is commercial use ever a factor (rules out Vercel Hobby)?
2. Is a 30–60 s wake-up after idle acceptable (Render), or a dealbreaker?
3. Appetite for the Cloudflare server rewrite vs. keeping Express as-is?
4. After the platform: also do the write-endpoint bearer-token auth + the
   least-privilege Neon runtime role, or platform migration only for now?

## Related security follow-ups (deferred, tracked here)

Regardless of platform, from Plan 04's Implementation notes:

- **Write endpoints are unauthenticated.** Add a shared bearer token
  (`crypto.timingSafeEqual`) on `POST /api/imports`, `POST /api/players/merge`,
  `PATCH /api/event-players/:id`; SPA stores it in `localStorage` and prompts on
  401. Reads stay public.
- **500 handler leaks stack messages** (`server/src/app.ts`) — return
  `{error:'internal error'}` when `APP_ENV==='prd'`.
- **Runtime DB role is `neondb_owner`** (full DDL) — create a DML-only
  `app_runtime` Neon role for the request path; `migrate.ts` keeps owner.
- **Test import left in `prd`** — `DELETE FROM events WHERE id = 3` (or reset the
  Neon `prd` branch and re-run `npm run migrate`).
