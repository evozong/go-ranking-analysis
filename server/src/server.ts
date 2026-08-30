import express, { type ErrorRequestHandler } from 'express';
import { initSchema, pool } from './db.js';
import { createRouter } from './routes.js';

const app = express();
app.use(express.json());
app.use('/api', createRouter(pool));

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: (err as Error).message });
};
app.use(errorHandler);

const PORT = Number(process.env.PORT ?? 3001);

async function main(): Promise<void> {
  await initSchema();
  app.listen(PORT, () => {
    console.log(`go-ranking-analysis API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
