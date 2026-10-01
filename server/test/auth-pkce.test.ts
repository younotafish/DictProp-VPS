import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-auth-pkce-test-'));
process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.DEV_AUTH_BYPASS = '0';
process.env.PUBLIC_ORIGIN = '';

const { createAuthRoutes } = await import('../src/routes/auth.js');

type Exchange = { body: URLSearchParams; release: (response: Response) => void };

// The auth routes on a bare app, with Google's token endpoint and id_token check replaced.
function harness({ hold = false } = {}) {
  const exchanges: Exchange[] = [];
  const routes = createAuthRoutes({
    fetch: (_url, init = {}) => new Promise<Response>(resolve => {
      const exchange = { body: new URLSearchParams(String(init.body)), release: resolve };
      exchanges.push(exchange);
      if (!hold) resolve(Response.json({ id_token: 'signed-by-google' }));
    }),
    verifyIdToken: async () => ({ sub: 'owner-google-id', email: 'owner@example.com', email_verified: true }),
  });
  const app = new Hono().route('/api/auth', routes);
  return { app, exchanges };
}

async function login(app: Hono) {
  const response = await app.request('http://localhost:3000/api/auth/login?returnTo=%2Flake-loop-26%2Fday%2F2', {
    headers: { Host: 'localhost:3000' },
  });
  assert.equal(response.status, 302);
  const google = new URL(response.headers.get('location')!);
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]);
  const stateCookie = cookies.find(cookie => cookie.startsWith('oauth_state='))!;
  return { google, cookieHeader: cookies.join('; '), stateCookie: stateCookie.slice('oauth_state='.length) };
}

const callback = (app: Hono, state: string, cookieHeader: string) =>
  app.request(`http://localhost:3000/api/auth/callback?code=google-code&state=${state}`, {
    headers: { Host: 'localhost:3000', Cookie: cookieHeader },
  });

async function until(condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 1_000 && !condition(); tick++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), 'condition never became true');
}

test('login sends an S256 challenge and keeps its verifier in the state cookie', async () => {
  const { app } = harness();
  const { google, stateCookie } = await login(app);
  const [state, verifier] = stateCookie.split('.');
  assert.equal(google.searchParams.get('state'), state);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(google.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
  // The verifier itself never goes to Google with the authorization request.
  assert.equal(google.toString().includes(verifier), false);
});

test('the callback redeems the code with the verifier from its own login', async () => {
  const { app, exchanges } = harness();
  const { google, cookieHeader, stateCookie } = await login(app);
  const response = await callback(app, google.searchParams.get('state')!, cookieHeader);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/lake-loop-26/day/2');
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].body.get('code'), 'google-code');
  assert.equal(exchanges[0].body.get('code_verifier'), stateCookie.split('.')[1]);
  assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('session=') && !cookie.startsWith('session=;')));
});

test('a callback without its login cookie, or with an old cookie that has no verifier, is refused unredeemed', async () => {
  const { app, exchanges } = harness();
  const { google, stateCookie } = await login(app);
  const state = google.searchParams.get('state')!;
  const verifier = stateCookie.split('.')[1];
  for (const cookieHeader of [
    '',
    `oauth_state=${state}`,
    `oauth_state=${crypto.randomUUID()}.${verifier}`,
    `oauth_state=${state}.short`,
  ]) {
    const response = await callback(app, state, cookieHeader);
    assert.equal(response.status, 400, cookieHeader);
    assert.deepEqual(await response.json(), { error: 'Invalid OAuth state' });
  }
  assert.equal(exchanges.length, 0);
});

test('at most four token exchanges run at once; a fifth is told to retry and keeps its sign-in cookies', async () => {
  const { app, exchanges } = harness({ hold: true });
  const { google, cookieHeader } = await login(app);
  const state = google.searchParams.get('state')!;
  const pending = Array.from({ length: 4 }, () => callback(app, state, cookieHeader));
  await until(() => exchanges.length === 4);

  const busy = await callback(app, state, cookieHeader);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '5');
  assert.deepEqual(busy.headers.getSetCookie(), []);
  assert.equal(exchanges.length, 4);

  for (const exchange of exchanges) exchange.release(Response.json({ id_token: 'signed-by-google' }));
  for (const response of await Promise.all(pending)) assert.equal(response.status, 302);

  // The slots are free again once the exchanges finish, failed ones included.
  const failing = callback(app, state, cookieHeader);
  await until(() => exchanges.length === 5);
  exchanges[4].release(new Response('denied', { status: 400 }));
  assert.equal((await failing).status, 500);
  const retried = callback(app, state, cookieHeader);
  await until(() => exchanges.length === 6);
  exchanges[5].release(Response.json({ id_token: 'signed-by-google' }));
  assert.equal((await retried).status, 302);
});
