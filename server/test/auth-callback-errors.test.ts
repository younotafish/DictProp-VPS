import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';
process.env.GOOGLE_CLIENT_ID = 'test-client';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';

const { createAuthRoutes } = await import('../src/routes/auth.js');
const { GoogleKeysUnavailableError } = await import('../src/google-auth.js');
const { signInFailurePage } = await import('../src/sign-in-failure.js');
type AuthDependencies = Parameters<typeof createAuthRoutes>[0];

// What a browser's navigation accepts.
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const owner = { sub: 'owner-google-id', email: 'owner@example.com', email_verified: true as const };
const signingIn = (deps: AuthDependencies) => {
  const app = new Hono().route('/api/auth', createAuthRoutes({
    fetch: async () => Response.json({ id_token: 'signed-by-google' }),
    verifyIdToken: async () => owner,
    ...deps,
  }));
  return async (query?: string, headers: Record<string, string> = {}) => {
    const login = await app.request('http://localhost:3000/api/auth/login', { headers: { Host: 'localhost:3000' } });
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const cookies = login.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
    return app.request(`http://localhost:3000/api/auth/callback?${query ?? `code=google-code&state=${state}`}`, {
      headers: { Host: 'localhost:3000', Cookie: cookies, ...headers },
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

test('a browser whose sign-in fails gets a page saying why, with a link back to the app, at the same status', async () => {
  const stranger = { sub: 'stranger-google-id', email: 'stranger@example.com', email_verified: true as const };
  const cases: Array<[string, AuthDependencies, string | undefined, number, string, string]> = [
    ['a state no login set', {}, 'code=google-code&state=not-this-one', 400, 'Invalid OAuth state',
      'This sign-in has expired or was already used. Start it again from DictProp.'],
    ['Google unavailable', { fetch: async () => new Response('denied', { status: 400 }) }, undefined, 502,
      'Google sign-in is unavailable', 'Google sign-in is unavailable. Try again in a few minutes.'],
    ['a token that fails verification', { verifyIdToken: async () => { throw new Error('"exp" claim timestamp check failed'); } },
      undefined, 400, 'Invalid id_token claims', 'Google’s answer couldn’t be verified. Start the sign-in again from DictProp.'],
    ['an account that isn\'t the owner\'s', { verifyIdToken: async () => stranger }, undefined, 403,
      'This DictProp instance is private.',
      'This DictProp instance is private. If it’s yours, sign in with the Google account that owns it.'],
  ];
  for (const [label, deps, query, status, error, words] of cases) {
    const page = await signingIn(deps)(query, { Accept: BROWSER });
    assert.equal(page.status, status, label);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/, label);
    const html = await page.text();
    assert.ok(html.includes(`<p>${words}</p>`), label);
    assert.ok(html.includes('<a href="/">Back to DictProp</a>'), label);

    // Any other caller still gets the JSON error.
    const reply = await signingIn(deps)(query, { Accept: 'application/json' });
    assert.equal(reply.status, status, label);
    assert.deepEqual(await reply.json(), { error }, label);
  }
});

test('the failure page escapes the words it shows', () => {
  const html = signInFailurePage('<script>alert("hi")</script> & \'more\'');
  assert.equal(html.includes('<script>'), false);
  assert.ok(html.includes('<p>&#60;script&#62;alert(&#34;hi&#34;)&#60;/script&#62; &#38; &#39;more&#39;</p>'));
});
