import { createApp } from './app.js';
import { initSchema } from './db.js';

// Local-dev / self-hosted entry point. In AWS the app runs via `lambda.ts` and
// the schema is applied out-of-band by `migrate.ts`, so neither `initSchema()`
// nor `listen()` belongs in the shared `createApp()`.
const PORT = Number(process.env.PORT ?? 3001);

async function main(): Promise<void> {
  await initSchema();
  createApp().listen(PORT, () => {
    console.log(`go-ranking-analysis API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
