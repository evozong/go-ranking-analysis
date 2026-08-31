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

// Lazy, memoized schema gate. On Vercel the function is imported (never
// `listen`ed), so schema init can't sit on the listen path — instead the first
// request per warm instance awaits this once. `schema.sql` is idempotent, so a
// rare double-run across instances is harmless. Local dev (`server.ts`) awaits
// it up front before `listen`, so the middleware below resolves instantly.
let schemaReady: Promise<void> | undefined;
export function ensureSchema(): Promise<void> {
  return (schemaReady ??= initSchema());
}

const app = express();
app.use(cookieParser());
app.use(express.json());

app.use((_req, _res, next) => ensureSchema().then(() => next(), next));

// Public auth endpoints (login redirect, Google callback, logout, /me).
app.use('/api/auth', createAuthRouter({ db: pool, verifyIdToken: realVerifyIdToken }));

// Everything else under /api requires a valid session AND an allowlisted email.
app.use(authMiddleware);
app.use('/api', requireAuthorised(pool), createRouter(pool));

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: (err as Error).message });
};
app.use(errorHandler);

export default app;
