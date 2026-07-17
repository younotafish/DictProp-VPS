import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import { getSessionUser, UserRow } from '../db.js';
import { env } from '../env.js';

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

// Synthetic user used ONLY when DEV_AUTH_BYPASS=1 (local development). Never enabled in prod.
export const DEV_AUTH_USER: AuthUser = {
  id: 'dev-user',
  email: 'dev@localhost',
  displayName: 'Dev (auth bypass)',
  photoUrl: null,
  isAdmin: true,
};

function userRowToAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    photoUrl: row.photo_url,
    isAdmin: row.is_admin === 1,
  };
}

export async function requireAuth(c: Context, next: Next) {
  const path = c.req.path;

  // Skip auth for public routes
  if (path === '/api/health' || path.startsWith('/api/auth/')) {
    return next();
  }

  // Local dev only (DEV_AUTH_BYPASS=1): skip Google auth and act as a synthetic admin user.
  if (env.DEV_AUTH_BYPASS) {
    c.set('user', DEV_AUTH_USER);
    return next();
  }

  const token = getCookie(c, 'session');
  if (!token) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const userRow = getSessionUser(token);
  if (!userRow) {
    return c.json({ error: 'Session expired' }, 401);
  }

  if (!userRow.is_approved) {
    return c.json({ error: 'pending_approval' }, 403);
  }

  c.set('user', userRowToAuthUser(userRow));
  return next();
}
