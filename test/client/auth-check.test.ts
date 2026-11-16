import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAuth, initialAuthState } from '../../services/auth.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// checkAuth needs fetch and localStorage from the browser; each test scripts the server's answer.
const globals = globalThis as unknown as Record<string, unknown>;
const storage = new MemoryStorage();
globals.localStorage = storage;
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; });

const user = { id: 'u1', email: 'me@example.com', displayName: 'Me', photoUrl: null, isAdmin: true };
const signedIn = () => storage.setItem('vps_auth_user', JSON.stringify({ user }));
const signedOut = () => storage.removeItem('vps_auth_user');
const respondWith = (respond: () => Promise<Response>) => {
  globalThis.fetch = (async () => respond()) as typeof fetch;
};

test('a signed-in answer is cached, and a 401 or 403 clears the cached session', async () => {
  signedOut();
  respondWith(async () => Response.json({ user }));
  assert.deepEqual(await checkAuth(), { user });
  assert.deepEqual(JSON.parse(storage.getItem('vps_auth_user')!), { user });

  for (const status of [401, 403]) {
    signedIn();
    respondWith(async () => new Response('', { status }));
    assert.deepEqual(await checkAuth(), { user: null });
    assert.equal(storage.getItem('vps_auth_user'), null);
  }
});

test('a server error or no connection opens the cached session offline, or none without one', async () => {
  for (const respond of [
    async () => new Response('Bad Gateway', { status: 502 }),
    () => Promise.reject(new TypeError('Failed to fetch')),
  ]) {
    respondWith(respond);
    signedIn();
    assert.deepEqual(await checkAuth(), { user, offline: true });
    assert.ok(storage.getItem('vps_auth_user'), 'the cached session stays');
    signedOut();
    assert.deepEqual(await checkAuth(), { user: null });
  }
});

test('a check that stalls gives up after ten seconds and opens the cached session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  })) as typeof fetch;
  signedIn();
  const pending = checkAuth();
  t.mock.timers.tick(9_999);
  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { user, offline: true });
});

test('launch opens with a cached session, but not with one that has no id', () => {
  signedIn();
  assert.deepEqual(initialAuthState(), { user, loading: false });
  storage.setItem('vps_auth_user', JSON.stringify({ user: { email: 'me@example.com' } }));
  assert.deepEqual(initialAuthState(), { user: null, loading: true });
  storage.setItem('vps_auth_user', '{damaged');
  assert.deepEqual(initialAuthState(), { user: null, loading: true });
});

test('a session cached by an older build, with its pending flag, still opens signed in', async () => {
  for (const pending of [false, true]) {
    storage.setItem('vps_auth_user', JSON.stringify({ user, pending }));
    assert.deepEqual(initialAuthState(), { user, loading: false });
    respondWith(() => Promise.reject(new TypeError('Failed to fetch')));
    assert.deepEqual(await checkAuth(), { user, offline: true });
  }
});
