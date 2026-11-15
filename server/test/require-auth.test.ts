import assert from 'node:assert/strict';
import test from 'node:test';

// The real session gate, not the DEV_AUTH_BYPASS shortcut every route suite runs with.
process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';

const { createApp } = await import('../src/app.js');
const { createSession, createUserAndClaimItems, db, getSessionUser } = await import('../src/db.js');
const app = createApp({ logging: false, serveStaticFiles: false });

// The first user is the admin owner; a later one is not an owner (it exists only if the owner email changed).
const owner = createUserAndClaimItems({
  googleId: 'gate-owner', email: 'owner@example.com', displayName: 'Owner', photoUrl: 'https://example.com/owner.png',
});
const stranger = createUserAndClaimItems({ googleId: 'gate-stranger', email: 'stranger@example.com', displayName: null, photoUrl: null });

const withSession = (token?: string): RequestInit => (token ? { headers: { Cookie: `session=${token}` } } : {});
const get = (path: string, token?: string) => app.request(path, withSession(token));
const expire = (token: string) => {
  // Only the hash of a token is stored; expire every session of the user that holds this one.
  const userId = getSessionUser(token)?.id;
  assert.ok(userId);
  db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, userId);
};
const clearsSessionCookie = (response: Response) =>
  response.headers.getSetCookie().some(cookie => cookie.startsWith('session=;') && /Max-Age=0/i.test(cookie));

test('an API request needs an owner session', async () => {
  let response = await get('/api/items/images/manifest');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Not authenticated' });

  response = await get('/api/items/images/manifest', 'not-a-session');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Session expired' });

  const strangerSession = createSession(stranger.id).token;
  response = await get('/api/items/images/manifest', strangerSession);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'owner_only' });
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal(getSessionUser(strangerSession)?.id, stranger.id);

  const ownerSession = createSession(owner.id).token;
  response = await get('/api/items/images/manifest', ownerSession);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);

  const expiring = createSession(stranger.id).token;
  expire(expiring);
  response = await get('/api/items/images/manifest', expiring);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Session expired' });
  assert.deepEqual(response.headers.getSetCookie(), []);
});

test('health and the sign-in routes answer without a session, and unknown sign-in paths are JSON 404s', async () => {
  let response = await get('/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, 'ok');

  for (const [path, method] of [['/api/auth/unknown', 'GET'], ['/api/auth/me', 'POST']] as const) {
    response = await app.request(path, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'Not found' });
  }
});

test('/api/auth/me reports the owner, and refuses and ends a session that is not the owner\'s', async () => {
  let response = await get('/api/auth/me');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Not authenticated' });

  response = await get('/api/auth/me', 'not-a-session');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Session expired' });
  assert.deepEqual(response.headers.getSetCookie(), []);

  const strangerSession = createSession(stranger.id).token;
  response = await get('/api/auth/me', strangerSession);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'owner_only' });
  assert.ok(clearsSessionCookie(response));
  assert.equal(getSessionUser(strangerSession), null);

  const ownerSession = createSession(owner.id).token;
  response = await get('/api/auth/me', ownerSession);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    user: { id: owner.id, email: 'owner@example.com', displayName: 'Owner', photoUrl: 'https://example.com/owner.png', isAdmin: true },
  });
});

test('signing out ends the session on the server and clears its cookie', async () => {
  const ownerSession = createSession(owner.id).token;
  assert.equal((await get('/api/auth/me', ownerSession)).status, 200);

  const response = await app.request('/api/auth/logout', { method: 'POST', ...withSession(ownerSession) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.ok(clearsSessionCookie(response));

  assert.equal((await get('/api/auth/me', ownerSession)).status, 401);
  assert.equal((await get('/api/items/images/manifest', ownerSession)).status, 401);
});
