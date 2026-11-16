import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
process.env.GOOGLE_CLIENT_ID = 'test-client';

const { createAuthRoutes } = await import('../src/routes/auth.js');
const { setSessionCookie } = await import('../src/middleware/auth.js');
const { getSessionUser } = await import('../src/db.js');

const owner = { sub: 'owner-google-id', email: 'owner@example.com', email_verified: true as const };
const app = new Hono().route('/api/auth', createAuthRoutes({
  fetch: async () => Response.json({ id_token: 'signed-by-google' }),
  verifyIdToken: async () => owner,
}));

/** A Set-Cookie header as its name, value and attributes (attribute names lowercased). */
function parseCookie(header: string) {
  const [pair, ...attributes] = header.split(/;\s*/);
  const equals = pair.indexOf('=');
  return {
    name: pair.slice(0, equals),
    value: pair.slice(equals + 1),
    attributes: Object.fromEntries(attributes.map((attribute) => {
      const [name, value = ''] = attribute.split('=');
      return [name.toLowerCase(), value];
    })),
  };
}

const sessionCookieOf = (response: Response) =>
  response.headers.getSetCookie().map(parseCookie).find(cookie => cookie.name === 'session');

/** Sign the owner in through Google (stubbed) and return the session cookie the callback sets. */
async function signIn(origin: string, headers: Record<string, string>) {
  const login = await app.request(`${origin}/api/auth/login`, { headers });
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
  const cookies = login.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
  const callback = await app.request(`${origin}/api/auth/callback?code=google-code&state=${state}`, {
    headers: { ...headers, Cookie: cookies },
  });
  assert.equal(callback.status, 302);
  const session = sessionCookieOf(callback);
  assert.ok(session?.value, 'the callback sets the session cookie');
  return session;
}

const SESSION_SECONDS = String(30 * 24 * 60 * 60);

test('signing in sets a cookie for every path that scripts can\'t read and that lasts as long as the session', async () => {
  const cookie = await signIn('http://dictprop.online', { Host: 'dictprop.online', 'X-Forwarded-Proto': 'https' });
  assert.equal(getSessionUser(cookie.value)?.email, 'owner@example.com');
  assert.deepEqual(cookie.attributes, { 'max-age': SESSION_SECONDS, path: '/', httponly: '', secure: '', samesite: 'Lax' });
});

test('local development over plain http gets the same cookie without Secure, which would never come back', async () => {
  const cookie = await signIn('http://localhost:3000', { Host: 'localhost:3000' });
  assert.deepEqual(cookie.attributes, { 'max-age': SESSION_SECONDS, path: '/', httponly: '', samesite: 'Lax' });
});

test('signing out clears the cookie at the path it was set on', async () => {
  const headers = { Host: 'dictprop.online', 'X-Forwarded-Proto': 'https' };
  const cookie = await signIn('http://dictprop.online', headers);
  const response = await app.request('http://dictprop.online/api/auth/logout', {
    method: 'POST',
    headers: { ...headers, Cookie: `session=${cookie.value}` },
  });
  assert.equal(response.status, 200);
  const cleared = sessionCookieOf(response);
  assert.equal(cleared?.value, '');
  assert.equal(cleared?.attributes['max-age'], '0');
  assert.equal(cleared?.attributes.path, '/');
  assert.equal(getSessionUser(cookie.value), null);
});

test('a renewed cookie carries the sign-in cookie\'s attributes, with Max-Age the whole seconds the session has left', async () => {
  const renewing = new Hono().get('/renew', (c) => {
    setSessionCookie(c, 'session-token', 10 * 24 * 60 * 60 * 1000 + 999);
    return c.body(null, 204);
  });
  const response = await renewing.request('http://dictprop.online/renew', {
    headers: { Host: 'dictprop.online', 'X-Forwarded-Proto': 'https' },
  });
  const cookie = sessionCookieOf(response);
  assert.equal(cookie?.value, 'session-token');
  assert.deepEqual(cookie?.attributes, {
    'max-age': String(10 * 24 * 60 * 60), path: '/', httponly: '', secure: '', samesite: 'Lax',
  });
});
