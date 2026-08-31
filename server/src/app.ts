import express, { type ErrorRequestHandler, type Express } from 'express';
import { pool } from './db.js';
import { createRouter } from './routes.js';

// Builds the Express app without binding a port or touching the schema. Both the
// local-dev entry (`server.ts`) and the Lambda handler (`lambda.ts`) call this so
// they run the exact same middleware stack.
export function createApp(): Express {
  const app = express();

  // When ORIGIN_SECRET is set (the Lambda deploy), require the matching header
  // that CloudFront injects on every origin request. This cloaks the public
  // Function URL — a direct hit to the *.lambda-url host has no such header.
  // Unset locally, so `npm run dev` is unaffected.
  const originSecret = process.env.ORIGIN_SECRET;
  if (originSecret) {
    app.use((req, res, next) => {
      if (req.get('x-origin-secret') === originSecret) return next();
      res.status(403).json({ error: 'forbidden' });
    });
  }

  app.use(express.json());
  app.use('/api', createRouter(pool));

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  };
  app.use(errorHandler);

  return app;
}
