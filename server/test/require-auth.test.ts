import assert from 'node:assert/strict';
import test from 'node:test';

// The real session gate, not the DEV_AUTH_BYPASS shortcut every route suite runs with.
process.env.OWNER_GOOGLE_EMAIL = 'owner@example.com';

const { createApp } = await import('../src/app.js');
const { createSession, createUserAndClaimItems, db, getSession, getSessionUser } = await import('../src/db.js');
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
const DAY = 24 * 60 * 60 * 1000;
/** A new owner session, made to look `days` old and to expire at `expiresAt` (unrenewed: 30 days after it began). */
const ownerSessionDaysOld = (days: number, expiresAt?: number) => {
  const token = createSession(owner.id).token;
  const createdAt = Date.now() - days * DAY;
  // Only the hash of a token is stored, so this dates every session of the owner; each test then uses only its own.
  db.prepare('UPDATE sessions SET created_at = ?, expires_at = ? WHERE user_id = ?')
    .run(createdAt, expiresAt ?? createdAt + 30 * DAY, owner.id);
  return token;
};
/** The Max-Age of the session cookie a response sets, or undefined when it sets none. */
const sessionMaxAge = (response: Response, token: string): number | undefined => {
  const cookie = response.headers.getSetCookie().find(header => header.startsWith(`session=${token};`));
  return cookie ? Number(/Max-Age=(\d+)/i.exec(cookie)?.[1]) : undefined;
};

test('an API request needs an owner session, and one that can\'t be used is ended', async () => {
  let response = await get('/api/items/images/manifest');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Not authenticated' });
  assert.deepEqual(response.headers.getSetCookie(), []);

  response = await get('/api/items/images/manifest', 'not-a-session');
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Session expired' });
  assert.ok(clearsSessionCookie(response));

  const strangerSession = createSession(stranger.id).token;
  response = await get('/api/items/images/manifest', strangerSession);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'owner_only' });
  assert.ok(clearsSessionCookie(response));
  assert.equal(getSessionUser(strangerSession), null);

  const ownerSession = createSession(owner.id).token;
  response = await get('/api/items/images/manifest', ownerSession);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);

  const expiring = createSession(owner.id).token;
  expire(expiring);
  response = await get('/api/items/images/manifest', expiring);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Session expired' });
  assert.ok(clearsSessionCookie(response));
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
  assert.ok(clearsSessionCookie(response));

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

test('an API request renews an owner session with fewer than 23 days left to 30 days from now, and re-sends its cookie', async () => {
  const token = ownerSessionDaysOld(8);
  const before = Date.now();
  const response = await get('/api/items/images/manifest', token);
  const after = Date.now();
  assert.equal(response.status, 200);
  assert.equal(sessionMaxAge(response, token), 30 * 24 * 60 * 60);
  assert.match(response.headers.getSetCookie().join('\n'), /^session=[^;]+; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Lax$/m);
  const { expiresAt } = getSession(token)!;
  assert.ok(expiresAt >= before + 30 * DAY && expiresAt <= after + 30 * DAY);

  // Renewed, it has its full 30 days again, so the next request leaves it alone.
  const again = await get('/api/items/images/manifest', token);
  assert.equal(sessionMaxAge(again, token), undefined);
  assert.equal(getSession(token)?.expiresAt, expiresAt);
});

test('a session with 23 days or more left is neither written nor sent again', async () => {
  const token = ownerSessionDaysOld(2);
  const { expiresAt } = getSession(token)!;
  const response = await get('/api/items/images/manifest', token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal(getSession(token)?.expiresAt, expiresAt);
});

test('a renewal stops 180 days after the sign-in, and the cookie lasts exactly as long as the session', async () => {
  const token = ownerSessionDaysOld(170, Date.now() + 5 * DAY);
  const cap = getSession(token)!.createdAt + 180 * DAY;
  const before = Date.now();
  const response = await get('/api/items/images/manifest', token);
  const after = Date.now();
  assert.equal(getSession(token)?.expiresAt, cap);
  const maxAge = sessionMaxAge(response, token)!;
  assert.ok(maxAge >= Math.floor((cap - after) / 1000) && maxAge <= Math.floor((cap - before) / 1000));

  // At the cap, nothing moves.
  const atCap = await get('/api/items/images/manifest', token);
  assert.deepEqual(atCap.headers.getSetCookie(), []);
  assert.equal(getSession(token)?.expiresAt, cap);
});

test('a renewal the database can\'t write leaves the request, the session and the cookie as they were', async () => {
  const token = ownerSessionDaysOld(8);
  const { expiresAt } = getSession(token)!;
  db.exec(`CREATE TEMP TRIGGER refuse_renewal BEFORE UPDATE OF expires_at ON sessions
    BEGIN SELECT RAISE(ABORT, 'database is locked'); END`);
  let response: Response;
  try {
    response = await get('/api/items/images/manifest', token);
  } finally {
    db.exec('DROP TRIGGER refuse_renewal');
  }
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.deepEqual(response.headers.getSetCookie(), []);
  assert.equal(getSession(token)?.expiresAt, expiresAt);

  // The next request renews it.
  response = await get('/api/items/images/manifest', token);
  assert.equal(sessionMaxAge(response, token), 30 * 24 * 60 * 60);
});
