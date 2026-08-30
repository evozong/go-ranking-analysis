import express from 'express';
import { ensureSchema, pool } from './db.js';
import { createRouter } from './routes.js';

async function main() {
  await ensureSchema();

  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(pool));

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  const PORT = Number(process.env.PORT ?? 3001);
  app.listen(PORT, () => {
    console.log(`go-ranking-analysis API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('failed to start server:', err);
  process.exit(1);
});
