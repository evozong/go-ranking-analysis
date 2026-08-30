import { Router } from 'express';
import multer from 'multer';
import type { Database } from 'better-sqlite3';
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

export function createRouter(db: Database): Router {
  const r = Router();

  r.post('/imports', upload.single('file'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing file (multipart field "file")' });
    }
    try {
      const summary = importTournament(db, req.file.buffer);
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
  });

  r.get('/matchups', (req, res) => {
    const player = intParam(req.query.player);
    const event = intParam(req.query.event);
    if (player === undefined && event === undefined) {
      return res
        .status(400)
        .json({ error: 'At least one of "player" or "event" is required' });
    }
    return res.json(getMatchups(db, { player, event }));
  });

  r.get('/players', (_req, res) => {
    res.json(listPlayers(db));
  });

  r.get('/players/duplicate-hints', (_req, res) => {
    res.json(findDuplicateHints(db));
  });

  r.post('/players/merge', (req, res) => {
    const keepId = typeof req.body?.keepId === 'number' ? req.body.keepId : undefined;
    const mergeIds = Array.isArray(req.body?.mergeIds)
      ? (req.body.mergeIds as unknown[]).filter((x): x is number => typeof x === 'number')
      : undefined;
    if (keepId === undefined || mergeIds === undefined) {
      return res.status(400).json({ error: 'keepId and mergeIds are required' });
    }
    try {
      return res.json(mergePlayers(db, keepId, mergeIds));
    } catch (err) {
      if (err instanceof MergeError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  });

  r.get('/players/:id', (req, res) => {
    const id = intParam(req.params.id);
    if (id === undefined) return res.status(400).json({ error: 'bad id' });
    const detail = getPlayerDetail(db, id);
    if (!detail) return res.status(404).json({ error: 'player not found' });
    return res.json(detail);
  });

  r.get('/players/:id/history', (req, res) => {
    const id = intParam(req.params.id);
    if (id === undefined) return res.status(400).json({ error: 'bad id' });
    const page = intParam(req.query.page) ?? 1;
    return res.json(getPlayerHistory(db, id, page));
  });

  r.get('/events', (_req, res) => {
    res.json(listEvents(db));
  });

  r.get('/events/:id', (req, res) => {
    const id = intParam(req.params.id);
    if (id === undefined) return res.status(400).json({ error: 'bad id' });
    const event = getEvent(db, id);
    if (!event) return res.status(404).json({ error: 'event not found' });
    return res.json(event);
  });

  r.get('/events/:id/players', (req, res) => {
    const id = intParam(req.params.id);
    if (id === undefined) return res.status(400).json({ error: 'bad id' });
    return res.json(getEventPlayers(db, id));
  });

  r.patch('/event-players/:eventPlayerId', (req, res) => {
    const id = intParam(req.params.eventPlayerId);
    if (id === undefined) return res.status(400).json({ error: 'bad id' });
    try {
      const result = remapEventPlayer(db, id, {
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
  });

  return r;
}
