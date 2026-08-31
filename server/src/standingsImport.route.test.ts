import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createRouter } from './routes.js';
import { makeTestDb } from './testdb.js';

const here = dirname(fileURLToPath(import.meta.url));
const sampleCsv = readFileSync(
  join(here, 'fixtures', 'standings-sample.csv'),
  'utf8',
);

async function startApp(t: any) {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(db));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, db };
}

function form(csv: string, name: string, date: string): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'standings.csv');
  fd.append('name', name);
  fd.append('date', date);
  return fd;
}

test('POST /standings/import converts, imports, and returns the XML', async (t) => {
  const { base } = await startApp(t);

  const res = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Club Championship', '2025-04-19'),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.eventPlayers, 13);
  assert.equal(body.nonGames, 4);
  assert.equal(body.filename, '20250419 Club Championship opengotha.xml');
  assert.match(body.xml, /^<\?xml version="1\.0"/);
});

test('re-importing a standings CSV for an existing (name, date) is a 409, not a crash', async (t) => {
  const { base } = await startApp(t);

  const first = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Club Championship', '2025-04-19'),
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  // Same name + date, even with the CSV byte-for-byte identical -> 409.
  const dupe = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'club championship', '2025-04-19'), // case-insensitive
  });
  assert.equal(dupe.status, 409);
  const dupeBody = await dupe.json();
  assert.equal(dupeBody.eventId, firstBody.eventId);

  // And it did NOT create a second event.
  const events = await (await fetch(`${base}/api/events`)).json();
  assert.equal(
    events.filter((e: any) => /club championship/i.test(e.name)).length,
    1,
  );
});

test('the downloaded XML round-trips through POST /imports as a 409 duplicate', async (t) => {
  const { base } = await startApp(t);

  const conv = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Club Championship', '2025-04-19'),
  });
  const { xml, eventId } = await conv.json();

  const fd = new FormData();
  fd.append('file', new Blob([xml], { type: 'application/xml' }), 'club.xml');
  const res = await fetch(`${base}/api/imports`, { method: 'POST', body: fd });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).eventId, eventId);
});

test('a different tournament name is treated as a new event', async (t) => {
  const { base } = await startApp(t);

  const a = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Spring Cup', '2025-04-19'),
  });
  assert.equal(a.status, 201);
  const b = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Autumn Cup', '2025-10-11'),
  });
  assert.equal(b.status, 201);
  assert.notEqual((await a.json()).eventId, (await b.json()).eventId);
});

test('missing name is a 400', async (t) => {
  const { base } = await startApp(t);
  const fd = new FormData();
  fd.append('file', new Blob([sampleCsv], { type: 'text/csv' }), 'standings.csv');
  const res = await fetch(`${base}/api/standings/import`, { method: 'POST', body: fd });
  assert.equal(res.status, 400);
});

test('a malformed CSV is a 422', async (t) => {
  const { base } = await startApp(t);
  const res = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form('Name,Rank\nAlice,30K', 'Whatever', '2025-01-01'),
  });
  assert.equal(res.status, 422);
});

test('DELETE /events/:id hard-deletes the event and its data', async (t) => {
  const { base } = await startApp(t);

  const imp = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Club Championship', '2025-04-19'),
  });
  const { eventId } = await imp.json();

  const del = await fetch(`${base}/api/events/${eventId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const body = await del.json();
  assert.equal(body.eventId, eventId);
  assert.equal(body.deletedEventPlayers, 13);

  const gone = await fetch(`${base}/api/events/${eventId}`);
  assert.equal(gone.status, 404);
});

test('DELETE /events/:id refuses seeded events (400) and unknown ids (404)', async (t) => {
  const { base } = await startApp(t);
  assert.equal((await fetch(`${base}/api/events/1`, { method: 'DELETE' })).status, 400);
  assert.equal(
    (await fetch(`${base}/api/events/99999`, { method: 'DELETE' })).status,
    404,
  );
});

test('delete-and-override: DELETE the duplicate, then re-import succeeds', async (t) => {
  const { base } = await startApp(t);

  const first = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Club Championship', '2025-04-19'),
  });
  const firstId = (await first.json()).eventId;

  const dupe = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Club Championship', '2025-04-19'),
  });
  assert.equal(dupe.status, 409);

  // This is exactly what the "Delete and override existing data" button does.
  const del = await fetch(`${base}/api/events/${firstId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);

  const retry = await fetch(`${base}/api/standings/import`, {
    method: 'POST',
    body: form(sampleCsv, 'Club Championship', '2025-04-19'),
  });
  assert.equal(retry.status, 201);
  const retryBody = await retry.json();
  assert.notEqual(retryBody.eventId, firstId);
  assert.equal(retryBody.eventPlayers, 13);

  const events = await (await fetch(`${base}/api/events`)).json();
  assert.equal(
    events.filter((e: any) => e.name === 'Club Championship').length,
    1,
  );
});
