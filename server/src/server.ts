import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { initSchema, pool } from './db.js';
import {
  authMiddleware,
  createAuthRouter,
  realVerifyIdToken,
  requireAuthorised,
} from './auth.js';
import { createRouter } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP_ENV = (process.env.APP_ENV ?? '').toUpperCase();

const app = express();
app.use(cookieParser());
app.use(express.json());

// Public auth endpoints (login redirect, Google callback, logout, /me).
app.use('/api/auth', createAuthRouter({ db: pool, verifyIdToken: realVerifyIdToken }));

// Everything else under /api requires a valid session AND an allowlisted email.
app.use(authMiddleware);
app.use('/api', requireAuthorised(pool), createRouter(pool));

// Prod: single origin — serve the built SPA alongside /api.
if (APP_ENV === 'PRD') {
  const webDist = join(here, '../../web/dist');
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(join(webDist, 'index.html')));
}

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
