import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomUUID } from 'crypto';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';
import { DEV_AUTH_USER } from '../middleware/auth.js';
import { verifyGoogleIdToken } from '../google-auth.js';
import {
  findUserByGoogleId,
  createUserAndClaimItems,
  getUserCount,
  createSession,
  getSessionUser,
  deleteSession,
  approveUser,
  listAllUsers,
} from '../db.js';
import { isOwnerUser, ownerLoginDecision } from '../owner-access.js';

export const authRoutes = new Hono();

function getRedirectUri(c: any): string {
  if (env.PUBLIC_ORIGIN) return `${env.PUBLIC_ORIGIN}/api/auth/callback`;
  const proto = c.req.header('x-forwarded-proto') || 'http';
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || 'localhost:3001';
  const normalizedHost = host.split(',')[0].trim().toLowerCase();
  if (proto === 'https' && normalizedHost === 'dictprop.online') {
    return 'https://dictprop.online/api/auth/callback';
  }
  if (proto === 'http' && /^(?:localhost|127\.0\.0\.1):(?:3000|3001|3002)$/.test(normalizedHost)) {
    return `http://${normalizedHost}/api/auth/callback`;
  }
  return 'https://dictprop.online/api/auth/callback';
}

function isSecure(c: any): boolean {
  const proto = c.req.header('x-forwarded-proto') || 'http';
  return proto === 'https';
}

// GET /api/auth/login — redirect to Google OAuth
authRoutes.get('/login', (c) => {
  const state = randomUUID();
  const redirectUri = getRedirectUri(c);

  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecure(c),
    path: '/api/auth/callback',
    maxAge: 300, // 5 minutes
  });

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

// GET /api/auth/callback — Google redirects here with ?code=...&state=...
authRoutes.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const savedState = getCookie(c, 'oauth_state');

  // Clear the state cookie
  deleteCookie(c, 'oauth_state', { path: '/api/auth/callback' });

  if (!code || !state || state !== savedState) {
    return c.json({ error: 'Invalid OAuth state' }, 400);
  }

  const redirectUri = getRedirectUri(c);

  // Exchange code for tokens — MUST use proxyFetch (system firewall blocks native fetch)
  const tokenController = new AbortController();
  const tokenTimeout = setTimeout(() => tokenController.abort(), 30_000);
  let tokenRes: Response;
  try {
    tokenRes = await proxyFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
      signal: tokenController.signal,
    });
  } finally {
    clearTimeout(tokenTimeout);
  }

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('Google token exchange failed:', err);
    return c.json({ error: 'OAuth token exchange failed' }, 500);
  }

  const tokens = await tokenRes.json() as { id_token?: string };
  if (!tokens.id_token) {
    return c.json({ error: 'No id_token in response' }, 500);
  }

  let payload;
  try {
    payload = await verifyGoogleIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID);
  } catch (error) {
    console.warn('Google id_token verification failed:', error instanceof Error ? error.message : error);
    return c.json({ error: 'Invalid id_token claims' }, 400);
  }

  // This is a private single-owner deployment. Existing data belongs to the first admin account;
  // unknown Google identities are rejected before they can create a user or session.
  let userRow = findUserByGoogleId(payload.sub);
  const access = ownerLoginDecision(userRow, payload.email, getUserCount(), env.OWNER_GOOGLE_EMAIL);
  if (access === 'deny') {
    return c.json({ error: 'This DictProp instance is private.' }, 403);
  }
  if (access === 'bootstrap') {
    userRow = createUserAndClaimItems({
      googleId: payload.sub,
      email: payload.email,
      displayName: payload.name || null,
      photoUrl: payload.picture || null,
    });
  }
  if (!userRow) return c.json({ error: 'This DictProp instance is private.' }, 403);

  // Create session
  const session = createSession(userRow.id);

  setCookie(c, 'session', session.token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecure(c),
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });

  return c.redirect('/');
});

// GET /api/auth/me — current user info
authRoutes.get('/me', (c) => {
  // Local dev only: report the synthetic bypass user so the client treats us as signed in.
  if (env.DEV_AUTH_BYPASS) {
    return c.json({ user: DEV_AUTH_USER, pending: false });
  }

  const token = getCookie(c, 'session');
  if (!token) {
    return c.json({ error: 'Not authenticated' }, 401);
  }

  const userRow = getSessionUser(token);
  if (!userRow) {
    return c.json({ error: 'Session expired' }, 401);
  }
  if (!isOwnerUser(userRow, env.OWNER_GOOGLE_EMAIL)) {
    deleteSession(token);
    deleteCookie(c, 'session', { path: '/' });
    return c.json({ error: 'owner_only' }, 403);
  }

  return c.json({
    user: {
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.display_name,
      photoUrl: userRow.photo_url,
      isAdmin: userRow.is_admin === 1,
    },
    pending: userRow.is_approved === 0,
  });
});

// POST /api/auth/logout — destroy session
authRoutes.post('/logout', (c) => {
  const token = getCookie(c, 'session');
  if (token) {
    deleteSession(token);
  }
  deleteCookie(c, 'session', { path: '/' });
  return c.json({ ok: true });
});

// POST /api/auth/approve/:userId — admin approves a pending user
authRoutes.post('/approve/:userId', (c) => {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Not authenticated' }, 401);

  const callerRow = getSessionUser(token);
  if (!callerRow || !isOwnerUser(callerRow, env.OWNER_GOOGLE_EMAIL)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  approveUser(c.req.param('userId'));
  return c.json({ ok: true });
});

// GET /api/auth/users — admin lists all users
authRoutes.get('/users', (c) => {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Not authenticated' }, 401);

  const callerRow = getSessionUser(token);
  if (!callerRow || !isOwnerUser(callerRow, env.OWNER_GOOGLE_EMAIL)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const users = listAllUsers().map(u => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    photoUrl: u.photo_url,
    isApproved: u.is_approved === 1,
    isAdmin: u.is_admin === 1,
    createdAt: u.created_at,
  }));

  return c.json({ users });
});
