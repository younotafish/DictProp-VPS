import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { randomUUID } from 'crypto';
import { env } from '../env.js';
import { proxyFetch, type FetchLike } from '../proxy-fetch.js';
import { clearSessionCookie, resolveSession, SESSION_COOKIE, setSessionCookie } from '../middleware/auth.js';
import { createPkcePair, GoogleKeysUnavailableError, verifyGoogleIdToken, type GoogleIdentity } from '../google-auth.js';
import { CANONICAL_ORIGIN, forwardedHost, isWwwHost, signInOrigin, wantsSecureCookies } from '../canonical-host.js';
import {
  findUserByGoogleId,
  createUserAndClaimItems,
  getUserCount,
  createSession,
  deleteSession,
} from '../db.js';
import { ownerLoginDecision } from '../owner-access.js';
import { sanitizeAuthReturnTo } from '../auth-return.js';
import { signInFailure, SIGN_IN_FAILURES } from '../sign-in-failure.js';

// A few concurrent sign-ins is all one owner needs; more than that is a flood holding Google round trips open.
const MAX_TOKEN_EXCHANGES = 4;
// The state cookie is "<state>.<PKCE verifier>": the state's UUID and 32 random bytes in base64url.
const OAUTH_STATE_COOKIE = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

export interface AuthRouteDependencies {
  fetch?: FetchLike;
  verifyIdToken?: (idToken: string, audience: string) => Promise<GoogleIdentity>;
}

// Google sends the sign-in back to this URI.
const getRedirectUri = (c: Context): string => `${signInOrigin(c.req)}/api/auth/callback`;

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
      secure: wantsSecureCookies(c.req),
      path: '/api/auth/callback',
      maxAge: 300, // 5 minutes
    });

    setCookie(c, 'oauth_return_to', returnTo, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: wantsSecureCookies(c.req),
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
    const clearSignInCookies = () => {
      deleteCookie(c, 'oauth_state', { path: '/api/auth/callback' });
      deleteCookie(c, 'oauth_return_to', { path: '/api/auth/callback' });
    };
    // A cancelled or refused sign-in comes back with ?error= and no code: return to the app's sign-in screen.
    // Not to returnTo: a private site would send the visitor straight back to Google.
    if (c.req.query('error')) {
      clearSignInCookies();
      return c.redirect('/');
    }
    const code = c.req.query('code');
    const state = c.req.query('state');
    const saved = getCookie(c, 'oauth_state')?.match(OAUTH_STATE_COOKIE);
    const returnTo = sanitizeAuthReturnTo(getCookie(c, 'oauth_return_to'));

    // Without the cookie its own login set there is no verifier, so a callback can't redeem a code it didn't
    // start, even an intercepted one.
    if (!code || !state || !saved || saved[1] !== state) {
      clearSignInCookies();
      return signInFailure(c, SIGN_IN_FAILURES.invalidState);
    }
    // The code is still unspent, so a busy reply keeps the cookies: reloading the callback finishes the sign-in.
    if (tokenExchanges >= MAX_TOKEN_EXCHANGES) {
      c.header('Retry-After', '5');
      return signInFailure(c, SIGN_IN_FAILURES.busy);
    }
    clearSignInCookies();

    const redirectUri = getRedirectUri(c);
    let payload: GoogleIdentity;
    tokenExchanges++;
    try {
      // Exchange code for tokens — MUST use proxyFetch (system firewall blocks native fetch). The deadline
      // covers reading the response, not only its headers.
      let idToken: string | undefined;
      const tokenController = new AbortController();
      const tokenTimeout = setTimeout(() => tokenController.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
      try {
        const tokenRes = await fetchToken('https://oauth2.googleapis.com/token', {
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
        if (!tokenRes.ok) {
          console.error(`Google token exchange refused (${tokenRes.status}):`, await tokenRes.text());
          return signInFailure(c, SIGN_IN_FAILURES.googleUnavailable);
        }
        idToken = (await tokenRes.json() as { id_token?: string }).id_token;
      } catch (error) {
        console.error('Google token exchange did not complete:', error instanceof Error ? error.message : error);
        return signInFailure(c, SIGN_IN_FAILURES.googleUnavailable);
      } finally {
        clearTimeout(tokenTimeout);
      }
      if (!idToken) {
        console.error('Google token exchange returned no id_token');
        return signInFailure(c, SIGN_IN_FAILURES.googleUnavailable);
      }

      try {
        payload = await verifyIdToken(idToken, env.GOOGLE_CLIENT_ID);
      } catch (error) {
        if (error instanceof GoogleKeysUnavailableError) {
          console.error('Google id_token not checked:', error.message);
          return signInFailure(c, SIGN_IN_FAILURES.googleUnavailable);
        }
        console.warn('Google id_token verification failed:', error instanceof Error ? error.message : error);
        return signInFailure(c, SIGN_IN_FAILURES.invalidToken);
      }
    } finally {
      tokenExchanges--;
    }

    // This is a private single-owner deployment. Existing data belongs to the first admin account;
    // unknown Google identities are rejected before they can create a user or session.
    let userRow = findUserByGoogleId(payload.sub);
    const access = ownerLoginDecision(userRow, payload.email, getUserCount(), env.OWNER_GOOGLE_EMAIL);
    if (access === 'deny') return signInFailure(c, SIGN_IN_FAILURES.notOwner);
    if (access === 'bootstrap') {
      userRow = createUserAndClaimItems({
        googleId: payload.sub,
        email: payload.email,
        displayName: payload.name || null,
        photoUrl: payload.picture || null,
      });
    }
    if (!userRow) return signInFailure(c, SIGN_IN_FAILURES.notOwner);

    setSessionCookie(c, createSession(userRow.id).token);
    return c.redirect(returnTo);
  });

  // GET /api/auth/gate — Caddy forward-auth endpoint for the private static sites (the trip site, the SD flashcards)
  authRoutes.get('/gate', (c) => {
    if (env.DEV_AUTH_BYPASS) return c.body(null, 204);

    const returnTo = sanitizeAuthReturnTo(c.req.query('returnTo'));
    if (isWwwHost(forwardedHost(c.req))) {
      // Caddy's handle_path strips the site prefix from X-Forwarded-Uri; then the site root is the way back.
      const forwardedUri = sanitizeAuthReturnTo(c.req.header('x-forwarded-uri'));
      c.header('Cache-Control', 'private, no-store');
      return c.redirect(`${CANONICAL_ORIGIN}${forwardedUri === '/' ? returnTo : forwardedUri}`, 308);
    }
    if (resolveSession(c).kind === 'owner') return c.body(null, 204);

    c.header('Cache-Control', 'private, no-store');
    return c.redirect(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  });

  // GET /api/auth/me — the signed-in owner, which local development's bypass user also is
  authRoutes.get('/me', (c) => {
    const session = resolveSession(c);
    switch (session.kind) {
      case 'anonymous': return c.json({ error: 'Not authenticated' }, 401);
      case 'expired': return c.json({ error: 'Session expired' }, 401);
      case 'not-owner': return c.json({ error: 'owner_only' }, 403);
      case 'owner': return c.json({ user: session.user });
    }
  });

  // POST /api/auth/logout — destroy session
  authRoutes.post('/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      deleteSession(token);
    }
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  return authRoutes;
}

export const authRoutes = createAuthRoutes();
