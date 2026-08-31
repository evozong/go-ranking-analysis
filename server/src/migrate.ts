import { initSchema, pool } from './db.js';

// One-off schema apply for environments where the app process never runs it
// (i.e. Lambda). Run from a machine that can reach the target Neon branch:
//   APP_ENV=prd PGHOST_PRD=... PGHOST_POOLED_PRD=... PGPASSWORD_PRD=... \
//     npm run migrate -w server
// schema.sql is idempotent, so re-running after any schema change is safe.
async function main(): Promise<void> {
  await initSchema();
  await pool.end();
  console.log(`schema applied (APP_ENV=${process.env.APP_ENV})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
