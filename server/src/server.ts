import app, { ensureSchema } from './app.js';

const PORT = Number(process.env.PORT ?? 3001);

async function main(): Promise<void> {
  await ensureSchema();
  app.listen(PORT, () => {
    console.log(`go-ranking-analysis API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
