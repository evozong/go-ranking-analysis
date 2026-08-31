import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { SignJWT } from 'jose';
import type { Db } from './db.js';
import { makeTestDb } from './testdb.js';

// auth.ts validates AUTH_* env at import — provide fakes before importing it.
// (These are only used when .env.local doesn't already supply real values; the
// tests never talk to Google.)
const ENV_FALLBACKS: Record<string, string> = {
  AUTH_GOOGLE_CLIENT_ID: 'test-client-id',
  AUTH_GOOGLE_CLIENT_SECRET: 'test-client-secret',
  AUTH_SESSION_SECRET: 'test-session-secret-that-is-long-enough-xx',
  AUTH_REDIRECT_URI: 'http://localhost:3001/api/auth/callback',
  AUTH_WEB_ORIGIN: 'http://localhost:5173',
};
for (const [k, v] of Object.entries(ENV_FALLBACKS)) {
  if (!process.env[k]) process.env[k] = v;
}

const {
  isAllowed,
  clearAllowCache,
  setAllowCacheTtl,
  createSessionCookie,
  readSession,
  createAuthRouter,
  authMiddleware,
  requireAuthorised,
} = await import('./auth.js');

const SECRET = new TextEncoder().encode(process.env.AUTH_SESSION_SECRET);
const WEB_ORIGIN = process.env.AUTH_WEB_ORIGIN!;

/** Forge a valid `session` cookie value without going through Google. */
async function signTestSession(
  claims: { sub: string; email: string; name?: string; picture?: string },
  opts: { iat?: number; exp?: number } = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email, name: claims.name, picture: claims.picture })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt(opts.iat ?? nowSec)
    .setExpirationTime(opts.exp ?? nowSec + 7 * 24 * 60 * 60)
    .sign(SECRET);
}

function cookieHeader(setCookie: string[] | undefined, name: string): string | undefined {
  const line = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return line?.split(';')[0].split('=').slice(1).join('=');
}

interface TestServer {
  base: string;
  fakePayload: { value: Record<string, unknown> };
  fakeIdToken: { value: string | null };
}

/** Mount the auth router + a gated stub route on an ephemeral server. */
async function startServer(
  t: { after: (fn: () => unknown) => void },
  db: Db,
): Promise<TestServer> {
  const fakePayload = {
    value: {
      sub: 'google-sub-1',
      email: 'someone@example.com',
      email_verified: true,
      name: 'Some One',
      picture: 'https://lh3.googleusercontent.com/x',
    } as Record<string, unknown>,
  };
  const fakeIdToken = { value: 'fake-id-token' as string | null };

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/auth',
    createAuthRouter({
      db,
      verifyIdToken: async () => fakePayload.value,
      exchangeCode: async () => ({ id_token: fakeIdToken.value }),
    }),
  );
  app.use(authMiddleware);
  app.use('/api', requireAuthorised(db), (_req, res) => res.json({ ok: true }));

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, fakePayload, fakeIdToken };
}

// --- isAllowed --------------------------------------------------------------

test('isAllowed: present -> true, absent -> false, case-insensitive', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  clearAllowCache();

  await db.query("INSERT INTO allowed_emails (email) VALUES ('invited@example.com')");

  assert.equal(await isAllowed(db, 'invited@example.com'), true);
  assert.equal(await isAllowed(db, '  Invited@Example.com '), true);
  assert.equal(await isAllowed(db, 'stranger@example.com'), false);
});

test('isAllowed: a row deleted after a cached hit flips to false once the cache expires', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  clearAllowCache();
  setAllowCacheTtl(200);
  t.after(() => setAllowCacheTtl(60_000));

  await db.query("INSERT INTO allowed_emails (email) VALUES ('temp@example.com')");
  assert.equal(await isAllowed(db, 'temp@example.com'), true); // now cached true

  await db.query("DELETE FROM allowed_emails WHERE email = 'temp@example.com'");

  // The stale `true` stays until the cache entry expires (~200ms), then the
  // next call re-reads the row and sees it gone. Poll so DB latency can't flake.
  const deadline = Date.now() + 5_000;
  let flipped = false;
  while (Date.now() < deadline) {
    if ((await isAllowed(db, 'temp@example.com')) === false) {
      flipped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(flipped, true, 'cached true should expire and re-read as false');
});

// --- session cookie roundtrip --------------------------------------------

test('session cookie roundtrip: valid, tampered, expired, wrong secret', async () => {
  const claims = { sub: 's1', email: 'a@example.com', name: 'A', picture: 'p' };
  const setCookie = await createSessionCookie(claims);
  const value = setCookie.split(';')[0].split('=').slice(1).join('=');

  const ok = await readSession({ session: value });
  assert.equal(ok?.email, 'a@example.com');
  assert.equal(ok?.sub, 's1');
  assert.equal(ok?.name, 'A');

  assert.equal(await readSession({ session: value + 'x' }), null); // tampered
  assert.equal(await readSession({}), null); // absent

  const expired = await signTestSession(claims, {
    iat: 1_000_000,
    exp: Math.floor(Date.now() / 1000) - 10,
  });
  assert.equal(await readSession({ session: expired }), null);

  const wrongSecret = await new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('s1')
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode('a-totally-different-secret-value-xxxxxx'));
  assert.equal(await readSession({ session: wrongSecret }), null);
});

test('sliding renewal: >1-day-old cookie is re-issued, fresh one is not', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  const { base } = await startServer(t, db);
  await db.query("INSERT INTO allowed_emails (email) VALUES ('someone@example.com')");
  clearAllowCache();

  const nowSec = Math.floor(Date.now() / 1000);
  const stale = await signTestSession(
    { sub: 's1', email: 'someone@example.com' },
    { iat: nowSec - 3 * 24 * 60 * 60 },
  );
  const staleRes = await fetch(`${base}/api/anything`, {
    headers: { cookie: `session=${stale}` },
  });
  assert.equal(staleRes.status, 200);
  assert.ok(
    cookieHeader(staleRes.headers.getSetCookie(), 'session'),
    'stale cookie should be re-issued',
  );

  const fresh = await signTestSession({ sub: 's1', email: 'someone@example.com' });
  const freshRes = await fetch(`${base}/api/anything`, {
    headers: { cookie: `session=${fresh}` },
  });
  assert.equal(freshRes.status, 200);
  assert.equal(
    cookieHeader(freshRes.headers.getSetCookie(), 'session'),
    undefined,
    'fresh cookie should not be re-issued',
  );
});

// --- requireAuthorised gate --------------------------------------------

test('gate: no cookie -> 401, non-allowlisted -> 403, allowlisted -> 200', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  const { base } = await startServer(t, db);
  clearAllowCache();
  await db.query("INSERT INTO allowed_emails (email) VALUES ('member@example.com')");

  const anon = await fetch(`${base}/api/players`);
  assert.equal(anon.status, 401);
  assert.deepEqual(await anon.json(), { error: 'authentication required' });

  const stranger = await signTestSession({ sub: 'g2', email: 'stranger@example.com' });
  const forbidden = await fetch(`${base}/api/players`, {
    headers: { cookie: `session=${stranger}` },
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: 'not authorised' });

  const member = await signTestSession({ sub: 'g3', email: 'member@example.com' });
  const allowed = await fetch(`${base}/api/players`, {
    headers: { cookie: `session=${member}` },
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true });
});

// --- /api/auth/callback ----------------------------------------------

async function loginTx(base: string): Promise<{ txCookie: string; state: string }> {
  const res = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
  const setCookie = res.headers.getSetCookie();
  const txCookie = cookieHeader(setCookie, 'auth_tx')!;
  const location = res.headers.get('location')!;
  const state = new URL(location).searchParams.get('state')!;
  return { txCookie, state };
}

test('callback: valid verifier + matching state -> session cookie + 302 home', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  const { base } = await startServer(t, db);

  const { txCookie, state } = await loginTx(base);
  const res = await fetch(
    `${base}/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `auth_tx=${txCookie}` }, redirect: 'manual' },
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${WEB_ORIGIN}/`);
  const session = cookieHeader(res.headers.getSetCookie(), 'session');
  assert.ok(session, 'a session cookie is set');
  const claims = await readSession({ session });
  assert.equal(claims?.email, 'someone@example.com');
});

test('callback: email_verified false -> no session, 302 ?auth_error=1', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  const { base, fakePayload } = await startServer(t, db);
  fakePayload.value = { ...fakePayload.value, email_verified: false };

  const { txCookie, state } = await loginTx(base);
  const res = await fetch(
    `${base}/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`,
    { headers: { cookie: `auth_tx=${txCookie}` }, redirect: 'manual' },
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${WEB_ORIGIN}/?auth_error=1`);
  assert.ok(!cookieHeader(res.headers.getSetCookie(), 'session'), 'no session established');
});

test('callback: mismatched state -> redirect to ?auth_error=1, no session', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  const { base } = await startServer(t, db);

  const { txCookie } = await loginTx(base);
  const res = await fetch(`${base}/api/auth/callback?code=abc&state=not-the-state`, {
    headers: { cookie: `auth_tx=${txCookie}` },
    redirect: 'manual',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `${WEB_ORIGIN}/?auth_error=1`);
  assert.ok(!cookieHeader(res.headers.getSetCookie(), 'session'), 'no session established');
});

// --- /api/auth/me --------------------------------------------------------

test('/api/auth/me reflects anon / signed-in / allowlisted', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  const { base } = await startServer(t, db);
  clearAllowCache();
  await db.query("INSERT INTO allowed_emails (email) VALUES ('member@example.com')");

  const anon = await (await fetch(`${base}/api/auth/me`)).json();
  assert.deepEqual(anon, { authenticated: false, authorised: false });

  const stranger = await signTestSession({ sub: 'g2', email: 'stranger@example.com' });
  const strangerMe = await (
    await fetch(`${base}/api/auth/me`, { headers: { cookie: `session=${stranger}` } })
  ).json();
  assert.equal(strangerMe.authenticated, true);
  assert.equal(strangerMe.authorised, false);
  assert.equal(strangerMe.email, 'stranger@example.com');

  const member = await signTestSession({
    sub: 'g3',
    email: 'member@example.com',
    name: 'Mem Ber',
    picture: 'https://lh3.googleusercontent.com/m',
  });
  const memberMe = await (
    await fetch(`${base}/api/auth/me`, { headers: { cookie: `session=${member}` } })
  ).json();
  assert.deepEqual(memberMe, {
    authenticated: true,
    authorised: true,
    email: 'member@example.com',
    name: 'Mem Ber',
    picture: 'https://lh3.googleusercontent.com/m',
  });
});

// --- /api/auth/logout --------------------------------------------------

test('/api/auth/logout clears the session cookie', async (t) => {
  const { db, cleanup } = await makeTestDb();
  t.after(cleanup);
  const { base } = await startServer(t, db);

  const res = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(res.status, 204);
  const cleared = (res.headers.getSetCookie() ?? []).find((c) =>
    c.startsWith('session='),
  );
  assert.ok(cleared);
  assert.match(cleared!, /Max-Age=0/);
});
