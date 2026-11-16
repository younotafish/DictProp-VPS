import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { wantsSecureCookies } from '../canonical-host.js';
import { deleteSession, extendSession, getSession, type UserRow } from '../db.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';
import { renewedExpiry, SESSION_LIFETIME_MS } from '../session-renewal.js';

export type AuthUser = {
  id: string;
  email: string;
  displayName: string | null;
  photoUrl: string | null;
  isAdmin: boolean;
};

export type AuthVariables = {
  user: AuthUser;
  requestId: string;
};

/** The app's Hono environment: what middleware sets on the context for the routes after it. */
export type AppEnv = { Variables: AuthVariables };

// Synthetic user used ONLY when DEV_AUTH_BYPASS=1 (local development). Never enabled in prod.
export const DEV_AUTH_USER: AuthUser = {
  id: 'dev-user',
  email: 'dev@localhost',
  displayName: 'Dev (auth bypass)',
  photoUrl: null,
  isAdmin: true,
};

export const SESSION_COOKIE = 'session';

/**
 * Send the session cookie: to every path, never to scripts, and for as long as the session row lasts, `maxAgeMs`
 * (a new session's lifetime unless told otherwise), through Max-Age rather than an Expires date the device's clock
 * would judge. Anything that hands out or renews a session sends the cookie through here, so a renewed cookie
 * carries the sign-in's attributes.
 */
export function setSessionCookie(c: Context, token: string, maxAgeMs: number = SESSION_LIFETIME_MS): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: wantsSecureCookies(c.req),
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

/** Tell the browser to stop sending the session cookie. */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function userRowToAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    photoUrl: row.photo_url,
    isAdmin: row.is_admin === 1,
  };
}

/** The session an owner's request came with: its cookie's token, and when the session was created and expires. */
export interface OwnerSession {
  token: string;
  createdAt: number;
  expiresAt: number;
}

/** What a request's session cookie amounts to. The synthetic owner of DEV_AUTH_BYPASS has no session. */
export type SessionState =
  | { kind: 'owner'; user: AuthUser; session?: OwnerSession }
  | { kind: 'anonymous' }
  | { kind: 'expired' }
  | { kind: 'not-owner' };

/**
 * Resolve the request's session: the one place the API, /api/auth/me and the static-site gate look a session
 * up, and clean up after one that can't be used. Local development with DEV_AUTH_BYPASS=1 is always the
 * synthetic owner.
 */
export function resolveSession(c: Context): SessionState {
  if (env.DEV_AUTH_BYPASS) return { kind: 'owner', user: DEV_AUTH_USER };
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return { kind: 'anonymous' };
  const session = getSession(token);
  if (!session) {
    // An expired or unknown session never comes back, so the browser can stop sending its cookie.
    clearSessionCookie(c);
    return { kind: 'expired' };
  }
  if (!isOwnerUser(session.user, env.OWNER_GOOGLE_EMAIL)) {
    // Only the owner keeps a session: one from before the owner email changed ends here.
    deleteSession(token);
    clearSessionCookie(c);
    return { kind: 'not-owner' };
  }
  return {
    kind: 'owner',
    user: userRowToAuthUser(session.user),
    session: { token, createdAt: session.createdAt, expiresAt: session.expiresAt },
  };
}

/**
 * Keep a session in use signed in. Once it has less than RENEW_BELOW_MS left, it moves to a full lifetime from now,
 * though never past SESSION_CAP_MS after the sign-in, and its cookie goes out again for exactly the time left, so the
 * browser keeps the cookie as long as the row lasts. Only when the row moved: a renewal the database couldn't write
 * leaves both as they were, and a later request tries again.
 */
function renewSession(c: Context, { token, createdAt, expiresAt }: OwnerSession): void {
  const now = Date.now();
  const next = renewedExpiry(expiresAt, createdAt, now);
  if (next !== null && extendSession(token, next)) setSessionCookie(c, token, next - now);
}

/**
 * The session gate for every API route after it: health and the sign-in routes are registered before it. It is the
 * one place a session renews. /api/auth/gate can't: Caddy's forward_auth drops the Set-Cookie of the response it
 * accepts, so the row would move while the browser's cookie kept its old Max-Age and expired first. /api/auth/me
 * stays a read-only check, and the app follows it with API requests anyway.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const state = resolveSession(c);
  switch (state.kind) {
    case 'anonymous': return c.json({ error: 'Not authenticated' }, 401);
    case 'expired': return c.json({ error: 'Session expired' }, 401);
    case 'not-owner': return c.json({ error: 'owner_only' }, 403);
    case 'owner':
      c.set('user', state.user);
      await next();
      // Once the route has made its response, so the renewed cookie joins whatever response that is.
      if (state.session) renewSession(c, state.session);
  }
};
