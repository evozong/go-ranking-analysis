import { createHash, randomBytes } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { SignJWT, jwtVerify } from 'jose';
import type { Db, Queryable } from './db.js';

// --- Config -----------------------------------------------------------------
// Read + validate the AUTH_* env at import; throw loudly if a required key is
// missing (same discipline as db.ts / APP_ENV). AUTH_REDIRECT_URI /
// AUTH_WEB_ORIGIN have non-secret defaults in .env.defaults; the three secrets
// come from .env.local (local) or the deploy's secret store (stg/prd).

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is required for auth. Set the AUTH_* keys in server/.env.local ` +
        `(see server/.env.example) or the deploy's secret store.`,
    );
  }
  return v;
}

const APP_ENV = (process.env.APP_ENV ?? '').toUpperCase();

export const authConfig = {
  clientId: required('AUTH_GOOGLE_CLIENT_ID'),
  clientSecret: required('AUTH_GOOGLE_CLIENT_SECRET'),
  redirectUri: required('AUTH_REDIRECT_URI'),
  webOrigin: required('AUTH_WEB_ORIGIN').replace(/\/$/, ''),
  sessionTtlDays: Number(process.env.AUTH_SESSION_TTL_DAYS ?? 7),
  // Secure cookies everywhere except local dev (APP_ENV=dev, plain http).
  cookieSecure: APP_ENV !== 'DEV',
};

const sessionKey = new TextEncoder().encode(required('AUTH_SESSION_SECRET'));
const SESSION_TTL_SEC = authConfig.sessionTtlDays * 24 * 60 * 60;
// Re-issue the session cookie once it is older than this, so an active user
// never hits the sliding window's hard cap.
const RENEW_AFTER_SEC = 24 * 60 * 60;
const TX_TTL_SEC = 10 * 60;

const SESSION_COOKIE = 'session';
const TX_COOKIE = 'auth_tx';

// --- Allowlist (with a short in-process cache) -----------------------------
// Authorisation is re-checked from allowed_emails on every request; the cache
// just bounds DB load. A removed row takes effect within ALLOW_CACHE_MS.
let allowCacheMs = Number(process.env.AUTH_ALLOW_CACHE_MS ?? 60_000);
const allowCache = new Map<string, { ok: boolean; exp: number }>();

/** Test-only: shrink/restore the allowlist cache TTL. */
export function setAllowCacheTtl(ms: number): void {
  allowCacheMs = ms;
}
/** Test-only: drop all cached allowlist entries. */
export function clearAllowCache(): void {
  allowCache.clear();
}

export async function isAllowed(db: Queryable, email: string): Promise<boolean> {
  const key = email.trim().toLowerCase();
  const now = Date.now();
  const hit = allowCache.get(key);
  if (hit && hit.exp > now) return hit.ok;
  const { rowCount } = await db.query(
    'SELECT 1 FROM allowed_emails WHERE email = $1',
    [key],
  );
  const ok = (rowCount ?? 0) > 0;
  allowCache.set(key, { ok, exp: now + allowCacheMs });
  return ok;
}

// --- Session cookie (stateless signed JWT) --------------------------------

export interface SessionClaims {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

interface VerifiedSession extends SessionClaims {
  iat: number;
}

function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeSec: number },
): string {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSec}`,
  ];
  if (authConfig.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export async function createSessionCookie(claims: SessionClaims): Promise<string> {
  const jwt = await new SignJWT({
    email: claims.email,
    name: claims.name,
    picture: claims.picture,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${authConfig.sessionTtlDays}d`)
    .sign(sessionKey);
  return serializeCookie(SESSION_COOKIE, jwt, { maxAgeSec: SESSION_TTL_SEC });
}

/** Verify signature + exp; return null on any failure. */
export async function readSession(
  cookies: Record<string, string | undefined> | undefined,
): Promise<VerifiedSession | null> {
  const raw = cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, sessionKey);
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      return null;
    }
    return {
      sub: payload.sub,
      email: payload.email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
      iat: typeof payload.iat === 'number' ? payload.iat : 0,
    };
  } catch {
    return null;
  }
}

function clearCookie(name: string): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (authConfig.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

// --- Middleware -----------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionClaims | null;
    }
  }
}

/**
 * Attaches `req.user` (or null). Does NOT block — mounted before /api so that
 * /api/auth/* stays reachable; `requireAuthorised` is the gate. Sliding
 * renewal: re-issue the cookie when the current one is more than ~1 day old.
 */
export const authMiddleware: RequestHandler = (req, res, next) => {
  void (async () => {
    const session = await readSession(req.cookies);
    req.user = session;
    if (session && Date.now() / 1000 - session.iat > RENEW_AFTER_SEC) {
      res.append('Set-Cookie', await createSessionCookie(session));
    }
    next();
  })().catch(next);
};

export function requireAuthorised(db: Db): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      if (!req.user) {
        res.status(401).json({ error: 'authentication required' });
        return;
      }
      if (!(await isAllowed(db, req.user.email))) {
        res.status(403).json({ error: 'not authorised' });
        return;
      }
      next();
    })().catch(next);
  };
}

// --- OAuth transaction cookie (PKCE verifier + state) --------------------

interface TxClaims {
  v: string; // PKCE code_verifier
  s: string; // state
}

async function createTxCookie(tx: TxClaims): Promise<string> {
  const jwt = await new SignJWT({ v: tx.v, s: tx.s })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TX_TTL_SEC}s`)
    .sign(sessionKey);
  return serializeCookie(TX_COOKIE, jwt, { maxAgeSec: TX_TTL_SEC });
}

async function readTxCookie(
  cookies: Record<string, string | undefined> | undefined,
): Promise<TxClaims | null> {
  const raw = cookies?.[TX_COOKIE];
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, sessionKey);
    if (typeof payload.v !== 'string' || typeof payload.s !== 'string') return null;
    return { v: payload.v, s: payload.s };
  } catch {
    return null;
  }
}

function base64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// --- Google verification seam -------------------------------------------

export interface IdTokenPayload {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

export type VerifyIdToken = (args: {
  idToken: string;
  audience: string;
}) => Promise<IdTokenPayload | undefined>;

export type ExchangeCode = (args: {
  code: string;
  codeVerifier: string;
}) => Promise<{ id_token?: string | null }>;

const googleClient = new OAuth2Client({
  clientId: authConfig.clientId,
  clientSecret: authConfig.clientSecret,
  redirectUri: authConfig.redirectUri,
});

export const realVerifyIdToken: VerifyIdToken = async ({ idToken, audience }) => {
  const ticket = await googleClient.verifyIdToken({ idToken, audience });
  return ticket.getPayload();
};

const realExchangeCode: ExchangeCode = async ({ code, codeVerifier }) => {
  const { tokens } = await googleClient.getToken({
    code,
    codeVerifier,
    redirect_uri: authConfig.redirectUri,
  });
  return { id_token: tokens.id_token };
};

// --- Auth router -------------------------------------------------------

export function createAuthRouter(opts: {
  db: Db;
  verifyIdToken?: VerifyIdToken;
  exchangeCode?: ExchangeCode;
}): Router {
  const { db } = opts;
  const verifyIdToken = opts.verifyIdToken ?? realVerifyIdToken;
  const exchangeCode = opts.exchangeCode ?? realExchangeCode;
  const r = Router();

  // Begin sign-in: build PKCE + state, stash them in a short-lived signed
  // cookie, redirect to Google.
  r.get('/login', (_req, res, next) => {
    void (async () => {
      const codeVerifier = base64url(randomBytes(32));
      const codeChallenge = base64url(
        createHash('sha256').update(codeVerifier).digest(),
      );
      const state = base64url(randomBytes(16));
      res.append('Set-Cookie', await createTxCookie({ v: codeVerifier, s: state }));
      const url = googleClient.generateAuthUrl({
        access_type: 'online',
        scope: ['openid', 'email', 'profile'],
        prompt: 'select_account',
        state,
        code_challenge_method: 'S256' as never,
        code_challenge: codeChallenge,
        redirect_uri: authConfig.redirectUri,
      });
      res.redirect(url);
    })().catch(next);
  });

  // Google redirect target: validate state, exchange the code, verify the ID
  // token, mint our own session. Any failure -> clear cookies, bounce to the
  // SPA with ?auth_error=1.
  r.get('/callback', (req, res, next) => {
    void (async () => {
      const home = `${authConfig.webOrigin}/`;
      try {
        const tx = await readTxCookie(req.cookies);
        const code = typeof req.query.code === 'string' ? req.query.code : '';
        const state = typeof req.query.state === 'string' ? req.query.state : '';
        if (!tx || !code || !state || state !== tx.s) {
          throw new Error('invalid oauth state');
        }
        const { id_token } = await exchangeCode({ code, codeVerifier: tx.v });
        if (!id_token) throw new Error('no id_token in token response');
        const payload = await verifyIdToken({
          idToken: id_token,
          audience: authConfig.clientId,
        });
        const verified =
          payload?.email_verified === true || payload?.email_verified === 'true';
        if (!payload?.email || !payload.sub || !verified) {
          throw new Error('email not verified');
        }
        res.append(
          'Set-Cookie',
          await createSessionCookie({
            sub: payload.sub,
            email: payload.email.toLowerCase(),
            name: payload.name,
            picture: payload.picture,
          }),
        );
        res.append('Set-Cookie', clearCookie(TX_COOKIE));
        res.redirect(home);
      } catch {
        res.append('Set-Cookie', clearCookie(SESSION_COOKIE));
        res.append('Set-Cookie', clearCookie(TX_COOKIE));
        res.redirect(`${authConfig.webOrigin}/?auth_error=1`);
      }
    })().catch(next);
  });

  r.post('/logout', (_req, res) => {
    res.append('Set-Cookie', clearCookie(SESSION_COOKIE));
    res.status(204).end();
  });

  // Public: drives the SPA nav + route guards.
  r.get('/me', (req, res, next) => {
    void (async () => {
      const session = await readSession(req.cookies);
      if (!session) {
        res.json({ authenticated: false, authorised: false });
        return;
      }
      const authorised = await isAllowed(db, session.email);
      res.json({
        authenticated: true,
        authorised,
        email: session.email,
        name: session.name,
        picture: session.picture,
      });
    })().catch(next);
  });

  return r;
}
