import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const { createAuthRoutes } = await import('../src/routes/auth.js');
const { GoogleKeysUnavailableError } = await import('../src/google-auth.js');
type AuthDependencies = Parameters<typeof createAuthRoutes>[0];

const owner = { sub: 'owner-google-id', email: 'owner@example.com', email_verified: true as const };
const signingIn = (deps: AuthDependencies) => {
  const app = new Hono().route('/api/auth', createAuthRoutes({
    fetch: async () => Response.json({ id_token: 'signed-by-google' }),
    verifyIdToken: async () => owner,
    ...deps,
  }));
  return async (query?: string) => {
    const login = await app.request('http://localhost:3000/api/auth/login', { headers: { Host: 'localhost:3000' } });
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const cookies = login.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
    return app.request(`http://localhost:3000/api/auth/callback?${query ?? `code=google-code&state=${state}`}`, {
      headers: { Host: 'localhost:3000', Cookie: cookies },
    });
  };
};
const clears = (response: Response, name: string) =>
  response.headers.getSetCookie().some(cookie => cookie.startsWith(`${name}=;`) && /Max-Age=0/i.test(cookie));

test('a cancelled sign-in returns to the app and clears its sign-in cookies', async () => {
  const response = await signingIn({})('error=access_denied&state=whatever');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/');
  assert.ok(clears(response, 'oauth_state'));
  assert.ok(clears(response, 'oauth_return_to'));
});

test('a failure on Google\'s side is a 502, and only a bad token is a 400', async () => {
  const cases: Array<[string, AuthDependencies, number, string]> = [
    ['token endpoint refused', { fetch: async () => new Response('denied', { status: 400 }) }, 502, 'Google sign-in is unavailable'],
    ['token endpoint unreachable', { fetch: async () => { throw new Error('connect ECONNREFUSED'); } }, 502, 'Google sign-in is unavailable'],
    ['token response without an id_token', { fetch: async () => Response.json({}) }, 502, 'Google sign-in is unavailable'],
    ['signing keys unavailable', {
      verifyIdToken: async () => { throw new GoogleKeysUnavailableError('Google signing keys unavailable: 503'); },
    }, 502, 'Google sign-in is unavailable'],
    ['token fails verification', { verifyIdToken: async () => { throw new Error('"exp" claim timestamp check failed'); } }, 400, 'Invalid id_token claims'],
  ];
  for (const [label, deps, status, error] of cases) {
    const response = await signingIn(deps)();
    assert.equal(response.status, status, label);
    assert.deepEqual(await response.json(), { error }, label);
  }
  // A working exchange still signs the owner in.
  assert.equal((await signingIn({})()).status, 302);
});
