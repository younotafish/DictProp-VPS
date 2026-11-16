import assert from 'node:assert/strict';
import test from 'node:test';
import { logout } from '../../services/auth.ts';
import { consumeSearchRetries, readPendingRequests, rememberSearchRetry, writePendingRequests } from '../../services/searchRecovery.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// logout only needs fetch, localStorage, sessionStorage and window.location.reload from the browser.
const globals = globalThis as unknown as Record<string, unknown>;
const realFetch = globalThis.fetch;
const storage = new Map<string, string>();
let reloads = 0;
globals.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
};
globals.window = { location: { reload: () => { reloads++; } } };

const signedIn = () => {
  storage.set('vps_auth_user', JSON.stringify({ user: { id: 'u1', email: 'me@example.com' }, pending: false }));
  globals.sessionStorage = new MemoryStorage();
  reloads = 0;
};
/** What the search keeps in the tab for later, through the search's own code: a request whose session expired and one a
 *  reload cut off. */
const searchesKept = () => {
  rememberSearchRetry({ kind: 'analyze', query: 'gamut', forceAI: true });
  writePendingRequests([{ request: { kind: 'analyze', query: 'bank' }, at: Date.now() }]);
};
const respondWith = (respond: () => Promise<Response>) => {
  globalThis.fetch = (async () => respond()) as typeof fetch;
};

test.after(() => { globalThis.fetch = realFetch; });

test('offline, sign-out keeps the session and the page, so the local library stays open', async () => {
  signedIn();
  respondWith(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.equal(await logout(), false);
  assert.ok(storage.has('vps_auth_user'));
  assert.equal(reloads, 0);
});

test('a server error keeps the session too, since the server session may still be live', async () => {
  signedIn();
  respondWith(async () => new Response('Bad Gateway', { status: 502 }));
  assert.equal(await logout(), false);
  assert.ok(storage.has('vps_auth_user'));
  assert.equal(reloads, 0);
});

test('once the server has signed out, the cached session goes and the page reloads', async () => {
  signedIn();
  respondWith(async () => Response.json({ ok: true }));
  assert.equal(await logout(), true);
  assert.equal(storage.has('vps_auth_user'), false);
  assert.equal(reloads, 1);
});

test('a sign-out that fails keeps the searches the tab runs again later', async () => {
  signedIn();
  searchesKept();
  respondWith(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.equal(await logout(), false);
  assert.deepEqual(readPendingRequests(Date.now()), [{ kind: 'analyze', query: 'bank' }]);
  assert.deepEqual(consumeSearchRetries(), [{ kind: 'analyze', query: 'gamut', forceAI: true }]);
});

test('once the server has signed out, the searches kept in the tab go too, so the next account never runs them', async () => {
  signedIn();
  searchesKept();
  respondWith(async () => Response.json({ ok: true }));
  assert.equal(await logout(), true);
  assert.deepEqual(readPendingRequests(Date.now()), []);
  assert.deepEqual(consumeSearchRetries(), []);
});
