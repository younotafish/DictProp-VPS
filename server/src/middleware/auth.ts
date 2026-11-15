import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie } from 'hono/cookie';
import { deleteSession, getSessionUser, type UserRow } from '../db.js';
import { env } from '../env.js';
import { isOwnerUser } from '../owner-access.js';

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

export function userRowToAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    photoUrl: row.photo_url,
    isAdmin: row.is_admin === 1,
  };
}

/** What a request's session cookie amounts to. */
export type SessionState =
  | { kind: 'owner'; user: AuthUser }
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
  const row = getSessionUser(token);
  if (!row) {
    // An expired or unknown session never comes back, so the browser can stop sending its cookie.
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return { kind: 'expired' };
  }
  if (!isOwnerUser(row, env.OWNER_GOOGLE_EMAIL)) {
    // Only the owner keeps a session: one from before the owner email changed ends here.
    deleteSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return { kind: 'not-owner' };
  }
  return { kind: 'owner', user: userRowToAuthUser(row) };
}

/** The session gate for every API route after it: health and the sign-in routes are registered before it. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = resolveSession(c);
  switch (session.kind) {
    case 'anonymous': return c.json({ error: 'Not authenticated' }, 401);
    case 'expired': return c.json({ error: 'Session expired' }, 401);
    case 'not-owner': return c.json({ error: 'owner_only' }, 403);
    case 'owner':
      c.set('user', session.user);
      return next();
  }
};
