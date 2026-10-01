import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomUUID } from 'crypto';
import { env } from '../env.js';
import { proxyFetch } from '../proxy-fetch.js';
import type { FetchLike } from '../ai-client.js';
import { DEV_AUTH_USER } from '../middleware/auth.js';
import { createPkcePair, verifyGoogleIdToken, type GoogleIdentity } from '../google-auth.js';
import { CANONICAL_ORIGIN, isWwwHost, requestedHost } from '../canonical-host.js';
import {
  findUserByGoogleId,
  createUserAndClaimItems,
  getUserCount,
  createSession,
  getSessionUser,
  deleteSession,
} from '../db.js';
import { isOwnerUser, ownerLoginDecision } from '../owner-access.js';
import { sanitizeAuthReturnTo } from '../auth-return.js';

// A few concurrent sign-ins is all one owner needs; more than that is a flood holding Google round trips open.
const MAX_TOKEN_EXCHANGES = 4;
// The state cookie is "<state>.<PKCE verifier>": the state's UUID and 32 random bytes in base64url.
const OAUTH_STATE_COOKIE = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

export interface AuthRouteDependencies {
  fetch?: FetchLike;
  verifyIdToken?: (idToken: string, audience: string) => Promise<GoogleIdentity>;
}

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

// Cookies are Secure whenever the sign-in round trip runs on https, even if a proxy leaves out the header.
function isSecure(c: any): boolean {
  const proto = c.req.header('x-forwarded-proto') || 'http';
  return proto === 'https' || getRedirectUri(c).startsWith('https://');
}

export function createAuthRoutes(deps: AuthRouteDependencies = {}) {
  const fetchToken = deps.fetch ?? proxyFetch;
  const verifyIdToken = deps.verifyIdToken ?? verifyGoogleIdToken;
  let tokenExchanges = 0;
  const authRoutes = new Hono();

  // GET /api/auth/login — redirect to Google OAuth
  authRoutes.get('/login', (c) => {
    const state = randomUUID();
    const pkce = createPkcePair();
    const redirectUri = getRedirectUri(c);
    const returnTo = sanitizeAuthReturnTo(c.req.query('returnTo'));

    // The verifier rides in the state cookie: it is bound to this state and leaves with it at the callback.
    setCookie(c, 'oauth_state', `${state}.${pkce.verifier}`, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecure(c),
      path: '/api/auth/callback',
      maxAge: 300, // 5 minutes
    });

    setCookie(c, 'oauth_return_to', returnTo, {
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
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      access_type: 'online',
      prompt: 'select_account',
    });

    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // GET /api/auth/callback — Google redirects here with ?code=...&state=...
  authRoutes.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const saved = getCookie(c, 'oauth_state')?.match(OAUTH_STATE_COOKIE);
    const returnTo = sanitizeAuthReturnTo(getCookie(c, 'oauth_return_to'));
    const clearSignInCookies = () => {
      deleteCookie(c, 'oauth_state', { path: '/api/auth/callback' });
      deleteCookie(c, 'oauth_return_to', { path: '/api/auth/callback' });
    };

    // Without the cookie its own login set there is no verifier, so a callback can't redeem a code it didn't
    // start, even an intercepted one.
    if (!code || !state || !saved || saved[1] !== state) {
      clearSignInCookies();
      return c.json({ error: 'Invalid OAuth state' }, 400);
    }
    // The code is still unspent, so a busy reply keeps the cookies: reloading the callback finishes the sign-in.
    if (tokenExchanges >= MAX_TOKEN_EXCHANGES) {
      c.header('Retry-After', '5');
      return c.json({ error: 'Sign-in is busy. Try again shortly.' }, 503);
    }
    clearSignInCookies();

    const redirectUri = getRedirectUri(c);
    let payload: GoogleIdentity;
    tokenExchanges++;
    try {
      // Exchange code for tokens — MUST use proxyFetch (system firewall blocks native fetch)
      const tokenController = new AbortController();
      const tokenTimeout = setTimeout(() => tokenController.abort(), 30_000);
      let tokenRes: Response;
      try {
        tokenRes = await fetchToken('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: saved[2],
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

      try {
        payload = await verifyIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID);
      } catch (error) {
        console.warn('Google id_token verification failed:', error instanceof Error ? error.message : error);
        return c.json({ error: 'Invalid id_token claims' }, 400);
      }
    } finally {
      tokenExchanges--;
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

    return c.redirect(returnTo);
  });

  // GET /api/auth/gate — Caddy forward-auth endpoint for the private trip site
  authRoutes.get('/gate', (c) => {
    if (env.DEV_AUTH_BYPASS) return c.body(null, 204);

    const returnTo = sanitizeAuthReturnTo(c.req.query('returnTo'));
    if (isWwwHost(requestedHost(c.req))) {
      // Caddy's handle_path strips the trip prefix from X-Forwarded-Uri; then the trip root is the way back.
      const forwardedUri = sanitizeAuthReturnTo(c.req.header('x-forwarded-uri'));
      c.header('Cache-Control', 'private, no-store');
      return c.redirect(`${CANONICAL_ORIGIN}${forwardedUri === '/' ? returnTo : forwardedUri}`, 308);
    }
    const token = getCookie(c, 'session');
    if (token) {
      const userRow = getSessionUser(token);
      if (userRow && isOwnerUser(userRow, env.OWNER_GOOGLE_EMAIL)) {
        return c.body(null, 204);
      }

      if (userRow) deleteSession(token);
      deleteCookie(c, 'session', { path: '/' });
    }

    c.header('Cache-Control', 'private, no-store');
    return c.redirect(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
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

  return authRoutes;
}

export const authRoutes = createAuthRoutes();
