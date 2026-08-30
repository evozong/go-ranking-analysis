import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import type { Db } from './db.js';
import {
  DuplicateImportError,
  importTournament,
} from './importTournament.js';
import { NotOpenGothaError } from './openGotha.js';
import {
  findDuplicateHints,
  getEvent,
  getEventPlayers,
  getMatchups,
  getPlayerDetail,
  getPlayerHistory,
  listEvents,
  listPlayers,
  mergePlayers,
  MergeError,
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

// Express 4 does not forward rejected promises to error middleware; wrap async
// handlers so their rejections reach `next`.
function asyncHandler(
  fn: (...args: Parameters<RequestHandler>) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function createRouter(db: Db): Router {
  const r = Router();

  r.post(
    '/imports',
    upload.single('file'),
    asyncHandler(async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'Missing file (multipart field "file")' });
      }
      try {
        const summary = await importTournament(db, req.file.buffer);
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
        throw err;
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
      return res.json(await getMatchups(db, { player, event }));
    }),
  );

  r.get(
    '/players',
    asyncHandler(async (_req, res) => {
      res.json(await listPlayers(db));
    }),
  );

  r.get(
    '/players/duplicate-hints',
    asyncHandler(async (_req, res) => {
      res.json(await findDuplicateHints(db));
    }),
  );

  r.post(
    '/players/merge',
    asyncHandler(async (req, res) => {
      const keepId = typeof req.body?.keepId === 'number' ? req.body.keepId : undefined;
      const mergeIds = Array.isArray(req.body?.mergeIds)
        ? (req.body.mergeIds as unknown[]).filter(
            (x): x is number => typeof x === 'number',
          )
        : undefined;
      if (keepId === undefined || mergeIds === undefined) {
        return res.status(400).json({ error: 'keepId and mergeIds are required' });
      }
      try {
        return res.json(await mergePlayers(db, keepId, mergeIds));
      } catch (err) {
        if (err instanceof MergeError) {
          return res.status(400).json({ error: err.message });
        }
        throw err;
      }
    }),
  );

  r.get(
    '/players/:id',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      const detail = await getPlayerDetail(db, id);
      if (!detail) return res.status(404).json({ error: 'player not found' });
      return res.json(detail);
    }),
  );

  r.get(
    '/players/:id/history',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      const page = intParam(req.query.page) ?? 1;
      return res.json(await getPlayerHistory(db, id, page));
    }),
  );

  r.get(
    '/events',
    asyncHandler(async (_req, res) => {
      res.json(await listEvents(db));
    }),
  );

  r.get(
    '/events/:id',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      const event = await getEvent(db, id);
      if (!event) return res.status(404).json({ error: 'event not found' });
      return res.json(event);
    }),
  );

  r.get(
    '/events/:id/players',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.id);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      return res.json(await getEventPlayers(db, id));
    }),
  );

  r.patch(
    '/event-players/:eventPlayerId',
    asyncHandler(async (req, res) => {
      const id = intParam(req.params.eventPlayerId);
      if (id === undefined) return res.status(400).json({ error: 'bad id' });
      try {
        const result = await remapEventPlayer(db, id, {
          playerId:
            typeof req.body?.playerId === 'number' ? req.body.playerId : undefined,
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
