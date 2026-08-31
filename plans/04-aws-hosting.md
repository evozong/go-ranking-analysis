# Plan 04: Deploy to AWS for $0 — Lambda API + S3/CloudFront SPA

> Status: **implemented** in commits `e3129db` and `c6d11e2` on branch
> `feat/serverless-api`. See **Implementation notes** at the end for how the
> shipped result diverged from this design.

## Context

The database now lives in Neon (cloud, free tier). The server (`server/`, Express +
`pg`) and web SPA (`web/`, React + Vite) still only run locally. The user wants a
**fully free** hosting setup and proposes AWS Lambda for the API + the Vite build in
S3 for the SPA.

This is a good fit and stays genuinely free for a hobby-scale app:

| component | mechanism | cost |
|---|---|---|
| API | Lambda + **Function URL** (not API Gateway) | Lambda always-free: 1M req + 400k GB-s / mo. Function URL adds no per-request charge. |
| SPA | S3 (private) behind **one CloudFront distribution** | CloudFront always-free: 1 TB egress + 10M req / mo, free TLS, $0 S3→CloudFront transfer. S3 storage after the 12-mo free tier is ~$0.01/mo for a few MB. |
| DB | Neon | already free |
| domain | the `*.cloudfront.net` URL (no Route 53) | free |

**Realistic bill: $0.00/mo now, ~$0.01/mo after 12 months.** API Gateway is
deliberately avoided (its 1M-req free tier is 12-month only, then $1/M).

### Why one CloudFront distribution in front of both

`web/src/api.ts` calls the API only via **relative `/api/...` paths** — no absolute
base URL, no `VITE_` env var (confirmed across `api.ts:113-153`). The server has
**no CORS handling at all** (`server/src/server.ts`, no `cors` dep). Rather than add
CORS + a build-time API base, use a single CloudFront distribution with two origins:

- default behavior → S3 origin (SPA), with 403/404 → `/index.html` (SPA fallback)
- `/api/*` behavior → Lambda Function URL origin, caching disabled, all methods +
  headers + body forwarded

The SPA stays same-origin with the API. **Zero frontend code changes.**

## Server changes (`server/`)

### 1. Split the Express app from the HTTP listener

`server/src/server.ts:5` builds `app` inline and never exports it; `main()` calls
`initSchema()` then `app.listen()`.

- New `server/src/app.ts` — `export function createApp(): express.Express` containing
  the middleware stack currently in `server.ts:5-15` (`express.json()`, `/api` router
  from `createRouter(pool)`, 404, error handler). No `listen`, no `initSchema`.
- `server/src/server.ts` becomes the **local-dev entry only**: `import { createApp }`,
  `await initSchema()`, `createApp().listen(PORT)`. Unchanged behavior for
  `npm run dev`.
- New `server/src/lambda.ts` — the Lambda handler:
  ```ts
  import serverlessExpress from '@codegenie/serverless-express';
  import { createApp } from './app.js';
  export const handler = serverlessExpress({ app: createApp() });
  ```
  Add `@codegenie/serverless-express` to `server/package.json` deps (maintained
  successor to aws-serverless-express; handles `event.isBase64Encoded` from Function
  URLs, needed for the multipart upload path).

### 1b. Bundle the handler with esbuild

OpenTofu does not bundle Node code (unlike CDK), and the deps are hoisted to the
repo-root `node_modules` by the npm workspace, so zipping `server/dist` alone is not
enough. Bundle to a single self-contained file instead.

- Add `esbuild` to `server/package.json` devDeps and a script:
  ```
  "build:lambda": "esbuild src/lambda.ts --bundle --platform=node --target=node22 --format=cjs --outfile=dist-lambda/index.js --external:pg-native --external:pg-cloudflare"
  ```
  Output: `server/dist-lambda/index.js` — Lambda handler `index.handler`, CJS (no
  `package.json` alongside it, so the Node runtime treats `.js` as CJS).
- `.gitignore`: add `dist-lambda/`.

### 2. Move schema init off the request path

`initSchema()` runs `schema.sql` and is currently called once at startup
(`server.ts:20`). It must NOT run per Lambda cold start (latency + races + Neon
connection pressure), and `schema.sql` is not copied into `dist/` by `tsc -b`.

- New `server/src/migrate.ts` — tiny script: `import { initSchema } from './db.js'; await initSchema(); process.exit(0)`.
- New `server/package.json` script:
  `"migrate": "tsx --env-file=.env.defaults --env-file-if-exists=.env.local src/migrate.ts"`.
- Run it **once from a dev machine** against the `prd` Neon branch (set
  `APP_ENV=prd` + the `*_PRD` vars in `.env.local` or inline) before the first
  deploy and after any `schema.sql` change. `schema.sql` is idempotent so re-runs
  are safe.
- The Lambda bundle then never needs `schema.sql`; `server.ts` keeps calling
  `initSchema()` for local dev only.

### 3. Pool tuning for Lambda

`server/src/db.ts:54` creates a module-level `pg.Pool` with `max: 10` on the pooled
Neon host — the singleton and pooled host are both correct for Lambda. Lower
concurrency per container:

- `max: Number(process.env.PG_POOL_MAX ?? 10)` in `connConfig()` (`db.ts:51`), and
  set `PG_POOL_MAX=2` in the Lambda environment. Local dev keeps the default 10.

### 4. Honest upload limit

Function URLs (like Lambda sync invoke) cap the request payload at ~6 MB; multer is
set to 10 MiB (`routes.ts:25-26`). OpenGotha XML files are a few KB, so this is
cosmetic — lower the multer `fileSize` limit to `6 * 1024 * 1024` so an oversized
upload fails in-app with a clear 400 rather than at the platform edge.

## Infrastructure — OpenTofu (new `infra/` directory)

OpenTofu (`tofu`, already installed) with the `hashicorp/aws` provider using awscli
profile **`admin`**. Local state file (single operator; gitignored). Not an npm
workspace — plain `.tf` files.

Files:

- `infra/versions.tf` — `terraform { required_version >= 1.6 }`, `required_providers`
  aws `~> 5.0`, archive `~> 2.0`, null `~> 3.0`. Provider block
  `region = var.aws_region` (default `us-west-2`, matches the Neon project) +
  `profile = var.aws_profile` (default `admin`).
- `infra/variables.tf` — `aws_region`, `aws_profile`, and the three secrets:
  `pg_password_prd`, `pg_host_prd`, `pg_host_pooled_prd` (all `sensitive = true`, no
  defaults).
- `infra/lambda.tf`:
  - `data "archive_file"` zipping `../server/dist-lambda` → `lambda.zip`.
  - `aws_iam_role` + attach `AWSLambdaBasicExecutionRole` (CloudWatch logs only; no
    VPC — Neon is reached over the public internet with TLS).
  - `aws_cloudwatch_log_group` (`/aws/lambda/${name}`, `retention_in_days = 14`).
  - `aws_lambda_function` — `runtime = "nodejs22.x"`, `architectures = ["arm64"]`,
    `handler = "index.handler"`, `memory_size = 512`, `timeout = 30`,
    `source_code_hash` from the archive. `environment.variables`: `APP_ENV = "prd"`,
    `PGUSER = "neondb_owner"`, `PGDATABASE = "neondb"`, `PG_POOL_MAX = "2"`,
    `PGHOST_PRD`, `PGHOST_POOLED_PRD`, `PGPASSWORD_PRD` from the vars.
  - `aws_lambda_function_url` — `authorization_type = "AWS_IAM"` (locked to
    CloudFront via OAC below; not publicly hittable).
- `infra/s3.tf`:
  - `aws_s3_bucket` (name from `var` or `random_id` suffix), `aws_s3_bucket_public_access_block`
    all-true, `aws_s3_bucket_ownership_controls` `BucketOwnerEnforced`.
  - `aws_cloudfront_origin_access_control` (type `s3`, sigv4, always) for the bucket.
  - `aws_s3_bucket_policy` granting `s3:GetObject` to the CloudFront distribution ARN
    (service principal `cloudfront.amazonaws.com`, `AWS:SourceArn` condition).
- `infra/cloudfront.tf`:
  - `aws_cloudfront_origin_access_control` (type `lambda`, sigv4, always) for the
    Function URL origin + `aws_lambda_permission` allowing
    `cloudfront.amazonaws.com` (`source_arn` = distribution ARN) to
    `lambda:InvokeFunctionUrl`.
  - `aws_cloudfront_distribution`:
    - origin 1: S3 bucket regional domain, `origin_access_control_id` = S3 OAC.
    - origin 2: Function URL host (strip `https://` / trailing `/` from
      `aws_lambda_function_url.url`), `custom_origin_config` https-only,
      `origin_access_control_id` = Lambda OAC.
    - default cache behavior → origin 1, `viewer_protocol_policy = redirect-to-https`,
      compress, AWS managed `CachingOptimized` policy.
    - ordered cache behavior `path_pattern = "/api/*"` → origin 2,
      `allowed_methods = [all 7]`, `cache_policy_id` = managed `CachingDisabled`,
      `origin_request_policy_id` = managed `AllViewerExceptHostHeader`.
    - `custom_error_response` for 403 and 404 → `/index.html`, `response_code = 200`
      (SPA deep-link routing).
    - `viewer_certificate.cloudfront_default_certificate = true` (free
      `*.cloudfront.net` HTTPS; no custom domain).
    - `price_class = PriceClass_100`.
- `infra/upload.tf` — publish `web/dist`:
  - `aws_s3_object` `for_each = fileset("${path.module}/../web/dist", "**")`, `key` =
    each path, `source` + `etag = filemd5(...)`, `content_type` via a
    `lookup(local.mime, regex("\\.[^.]+$", key), "application/octet-stream")` map
    (html/js/css/svg/json/woff2/png/ico).
  - `null_resource` invalidation: `triggers = { dist = sha1(join("", [for f in fileset(... ) : filemd5(...)])) }`,
    `local-exec` → `aws cloudfront create-invalidation --distribution-id ... --paths "/*" --profile admin`.
- `infra/outputs.tf` — `app_url` (= `https://${distribution.domain_name}`),
  `distribution_id`, `function_url`.
- `infra/terraform.tfvars.example` (committed) + `infra/terraform.tfvars`
  (gitignored) for the secrets.
- `infra/.gitignore` — `.terraform/`, `*.tfstate`, `*.tfstate.*`, `terraform.tfvars`,
  `.terraform.lock.hcl` kept (committed).
- `infra/README.md` — the deploy runbook; required reading before running `tofu`
  per the repo convention.

Root `package.json` script:
- `"deploy": "npm run build && npm run build:lambda -w server && tofu -chdir=infra apply"`
  (`npm run build` type-checks + builds both workspaces incl. `web/dist`;
  `build:lambda` produces `server/dist-lambda/index.js`; `tofu apply` ships both.)

## One-time setup (documented in `infra/README.md`, not scripted)

1. Create the Neon **`prd`** branch in the Neon console; note its direct host,
   pooled host, and role password.
2. `cp infra/terraform.tfvars.example infra/terraform.tfvars` and fill in
   `pg_host_prd`, `pg_host_pooled_prd`, `pg_password_prd`.
3. `npm run migrate` against `prd` — set `APP_ENV=prd` + the `*_PRD` vars and run
   `npm run migrate -w server`. Applies `schema.sql` + seeds the two `Open` events.
4. `tofu -chdir=infra init`.
5. `npm run deploy` (from repo root) — builds both workspaces, bundles the Lambda,
   then `tofu apply`. Note the `app_url` output.
6. Re-run `npm run deploy` for any future code or `web/` change; re-run
   `npm run migrate` first whenever `schema.sql` changes.

## Verification

- **Local unchanged**: `npm run dev` still serves SPA + API on 5173/3001; `npm test`
  untouched.
- **Handler unit test**: `server/src/lambda.test.ts` builds a fake Function URL v2
  event for `GET /api/events`-style path and awaits `handler(event)`.
- **Post-deploy smoke** (against the CloudFront domain): `curl .../api/events` →
  200 JSON; SPA loads; import an OpenGotha `.xml` → 201, re-import → 409; deep-link
  `.../players/1` resolves.
- **Cost check**: AWS Billing → Free Tier page shows Lambda + CloudFront usage well
  under the always-free limits.

## Security notes (reference only — NOT implemented in this plan)

This plan keeps the API private by design: the Lambda Function URL is
`authorization_type = AWS_IAM` and locked to the one CloudFront distribution via a
`lambda` OAC + scoped `aws_lambda_permission`. The items below are what you would
add *if you ever expose the Function URL publicly*:

1. **Reserved concurrency cap** on the function (e.g. `5`) — a flood is throttled
   (429) instead of running up cost.
2. **AWS Budgets alert at ~$1** — detection, not prevention.
3. **Bearer-token auth on the three write routes** (`/api/imports`,
   `/api/players/merge`, `PATCH /api/event-players/:id`); reads stay open.
4. **Server-side proxy injecting a shared secret** — rebuilds the OAC pattern
   without CloudFront (e.g. a Cloudflare Worker forwarding `/api/*` and adding a
   secret header the Lambda requires).
5. `authType = AWS_IAM` without CloudFront is not usable from a browser SPA (needs
   SigV4 signing).

Also: CORS is not a security control, and AWS WAF cannot attach to a bare Lambda
Function URL (only to CloudFront / API Gateway / ALB).

## Out of scope

- CORS, configurable `VITE_API_BASE`, split (non-AWS) frontend hosting.
- Custom domain / Route 53 (use the `*.cloudfront.net` URL).
- CI/CD pipeline (deploy is a manual `npm run deploy` from a dev machine).
- Per-route auth (deferred to the security notes above).

---

## Implementation notes (how the shipped result diverged)

The design above was approved, but several things had to change during
implementation (commits `e3129db`, `c6d11e2`):

1. **Lambda bundle is ESM, not CJS.** `db.ts` uses `import.meta.url`, which esbuild
   can't emit under `--format=cjs`. Switched to `--format=esm --outfile=index.mjs`
   with a `createRequire` banner. `schema.sql` `readFileSync` was also made lazy so
   the bundle never needs the file.

2. **AWS credentials via `deploy.sh`.** The `admin` profile is a login-session
   profile the tofu AWS provider's Go SDK can't read. `infra/deploy.sh` exports
   real creds with `aws configure export-credentials` before running `tofu`; the
   provider block dropped its `profile` argument.

3. **SPA routing uses a CloudFront Function, not `custom_error_response`.** Mapping
   403/404 → `/index.html` would also have masked the API's legitimate JSON 404s
   (`player not found`, `event not found`). Replaced with a viewer-request
   CloudFront Function that rewrites extension-less, non-`/api/` paths to
   `/index.html`.

4. **OAC on the Lambda origin was abandoned.** CloudFront OAC only signs GET/HEAD
   origin requests; for POST/PUT the *browser client* must send an
   `x-amz-content-sha256` body hash ("Lambda doesn't support unsigned payloads"),
   which the SPA's `fetch` upload cannot do — every `POST /api/imports` returned
   403. Replaced with:
   - Function URL `authorization_type = **NONE**`.
   - A `random_password` **`x-origin-secret`** that CloudFront injects as a custom
     origin header on every `/api/*` request; `createApp()` rejects any request
     lacking it (`server/src/app.ts`). A direct hit to the `*.lambda-url` host gets
     the app's 403 — the URL is cloaked, not truly private.
   - The Lambda OAC and the custom origin request policy were removed; `/api/*`
     now uses the managed `AllViewerExceptHostHeader` policy.

5. **A `NONE` Function URL needs BOTH `lambda:InvokeFunctionUrl` AND
   `lambda:InvokeFunction` for principal `*`.** The `InvokeFunction` requirement is
   new as of October 2025 and is added automatically by neither Terraform nor AWS;
   without it every request 403s at the Function-URL auth layer.

6. **Consequence — the API is publicly reachable and unauthenticated through
   CloudFront.** The `x-origin-secret` only stops requests that bypass CloudFront.
   Anyone hitting `https://<dist>.cloudfront.net/api/*` reaches the full API,
   including the write endpoints, and AWS has no hard spend cap. This motivated
   **Plan 05** (re-host onto a platform that hard-stops at free-tier limits).

Shipped app URL: `https://d2t7e0pec1z3uv.cloudfront.net` (verified end-to-end,
including multipart import 201 → 409).
