# infra/ — AWS hosting (OpenTofu)

Deploys the app to AWS for ~$0/month:

- **API** — the Express app (`server/src/lambda.ts`) on **Lambda** + a **Function
  URL** (`authorization_type = NONE`). CloudFront injects a secret `x-origin-secret`
  header on every origin request and the app rejects anything without it, so a
  direct hit to the `*.lambda-url` host gets 403. (OAC / `AWS_IAM` was the first
  approach but CloudFront OAC only signs GET/HEAD, so POST uploads always 403'd.)
- **SPA** — `web/dist` in a **private S3 bucket** behind the same **CloudFront**
  distribution. `/api/*` routes to the Lambda origin; everything else serves the
  SPA, with a CloudFront Function rewriting extension-less paths to `/index.html`
  for client-side routing.
- **DB** — the existing Neon project, new `prd` branch.

Stays inside the always-free tiers (Lambda 1M req + 400k GB-s/mo; CloudFront 1 TB
+ 10M req/mo, free TLS). S3 storage for a few MB of assets is ~$0.01/mo after the
first 12 months. No API Gateway, no Route 53, no custom domain.

State is a **local file** (`terraform.tfstate`, git-ignored) — single operator.

## First-time setup

1. **Neon `prd` branch.** In the Neon console create a branch named `prd` off
   `main`. From its Connection details note the **direct** host, the **pooled**
   host (`-pooler`), and the role password.

2. **tfvars.**
   ```
   cp terraform.tfvars.example terraform.tfvars
   # fill in pg_host_prd, pg_host_pooled_prd, pg_password_prd
   ```

3. **Apply the schema to `prd`** (the Lambda never runs `initSchema()`):
   ```
   cd ../server
   APP_ENV=prd \
     PGHOST_PRD=<direct-host> PGHOST_POOLED_PRD=<pooled-host> \
     PGPASSWORD_PRD=<password> \
     npm run migrate
   cd ../infra
   ```
   Re-run this whenever `server/src/schema.sql` changes (it is idempotent).

4. **Init + deploy.**
   ```
   tofu init
   cd .. && npm run deploy        # build both workspaces + bundle Lambda + tofu apply
   ```
   `npm run deploy` (repo root) runs `npm run build`, `npm run build:lambda -w
   server`, then `infra/deploy.sh apply`. First apply takes ~10–15 min (the
   CloudFront distribution). Note the `app_url` output.

## Redeploys

Any code or `web/` change:
```
npm run deploy
```
It re-bundles, re-uploads changed files (etag-based), and invalidates `/*`.

## Credentials

The `admin` profile is a login-session profile that the tofu AWS provider can't
read directly. **`deploy.sh`** wraps `tofu`, exporting real creds first via
`aws configure export-credentials --profile admin`. Run tofu through it:
```
infra/deploy.sh plan
infra/deploy.sh apply
infra/deploy.sh destroy
```
Plain `tofu <cmd>` in this dir works only for credential-free commands
(`init`, `validate`, `fmt`). Override the profile with `AWS_PROFILE_DEPLOY`.

Prereqs: that profile logged in, `tofu` + `aws` + Node 22+ on PATH.

## Files

| file | what |
|---|---|
| `versions.tf` | providers, `aws` provider bound to `var.aws_profile` |
| `variables.tf` | region/profile/name + the three `pg_*_prd` secrets |
| `lambda.tf` | zip from `server/dist-lambda`, role, log group, function, Function URL, `random_password` origin secret |
| `s3.tf` | private bucket + OAC bucket policy |
| `cloudfront.tf` | S3 OAC, SPA-rewrite function, distribution (S3 default + `/api/*` → Lambda with the secret `custom_header`) |
| `spa-rewrite.js` | CloudFront viewer-request: extension-less path → `/index.html` |
| `upload.tf` | `web/dist` → S3 objects + `/*` invalidation |
| `outputs.tf` | `app_url`, `distribution_id`, `function_url`, `bucket` |
| `deploy.sh` | exports creds from the login-session profile, then runs `tofu` |

## Teardown

```
tofu destroy
```
The S3 bucket must be empty first if `tofu` cannot remove the objects it manages
— it manages all of them here, so `destroy` handles it. The Neon `prd` branch is
not managed by this config; delete it in the Neon console.

## Not here (see plans/ security notes)

CORS, WAF, per-route request auth, reserved-concurrency caps, budget alarms — all
deferred. The Function URL is public but cloaked by the `x-origin-secret` header
that only CloudFront knows.
