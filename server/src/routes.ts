import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { DuplicateImportError, importTournament } from './importTournament.js';
import { NotOpenGothaError } from './openGotha.js';
import {
  getEvent,
  getEventPlayers,
  getMatchups,
  getPlayerDetail,
  getPlayerHistory,
  listEvents,
  listPlayers,
  remapEventPlayer,
  RemapError,
} from './analysis.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function intParam(v: unknown): number | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

// Express 4 doesn't catch rejected promises from async handlers; forward them to next().
function asyncHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

export function createRouter(pool: Pool): Router {
  const r = Router();

  r.post(
    '/imports',
    upload.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'Missing file (multipart field "file")' });
      }
      try {
        const summary = await importTournament(pool, req.file.buffer);
        return res.status(201).json(summary);
      } catch (err) {
        if (err instanceof DuplicateImportError) {
          return res.status(409).json({
            error: 'This tournament file has already been imported',
            eventId: err.eventId,
          });
        }
        if (err instanceof NotOpenGothaError) {
          return res.status(422).json({ error: err.message });
        }
        console.error('import failed:', err);
        return res.status(500).json({ error: (err as Error).message });
      }
    }),
  );

  r.get(
    '/matchups',
    asyncHandler(async (req, res) => {
      const player = intParam(req.query.player);
      const event = intParam(req.query.event);
      if (player === undefined && event === undefined) {
        return res
          .status(400)
          .json({ error: 'At least one of "player" or "event" is required' });
      }
      return res.json(await getMatchups(pool, { player, event }));
    }),
  );

  r.get(
    '/players',
    asyncHandler(async (_req, res) => {
      res.json(await listPlayers(pool));
    }),
  );

  r.get(
    '/players/:id',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      const detail = await getPlayerDetail(pool, id);
      if (!detail) return res.status(404).json({ error: 'player not found' });
      return res.json(detail);
    }),
  );

  r.get(
    '/players/:id/history',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      const page = intParam(req.query.page as string | undefined) ?? 1;
      return res.json(await getPlayerHistory(pool, id, page));
    }),
  );

  r.get(
    '/events',
    asyncHandler(async (_req, res) => {
      res.json(await listEvents(pool));
    }),
  );

  r.get(
    '/events/:id',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      const event = await getEvent(pool, id);
      if (!event) return res.status(404).json({ error: 'event not found' });
      return res.json(event);
    }),
  );

  r.get(
    '/events/:id/players',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      return res.json(await getEventPlayers(pool, id));
    }),
  );

  r.patch(
    '/event-players/:eventPlayerId',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.eventPlayerId);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      try {
        const result = await remapEventPlayer(pool, id, {
          playerId: typeof req.body?.playerId === 'number' ? req.body.playerId : undefined,
          newName: typeof req.body?.newName === 'string' ? req.body.newName : undefined,
        });
        return res.json(result);
      } catch (err) {
        if (err instanceof RemapError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }),
  );

  return r;
}
