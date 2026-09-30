import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { logout } from '../../services/auth.ts';

// logout only needs fetch, localStorage and window.location.reload from the browser.
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
  reloads = 0;
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

test('the library signs out only after sending what this device has not sent', () => {
  const app = readFileSync(fileURLToPath(new URL('../../App.tsx', import.meta.url)), 'utf8');
  const handler = app.match(/const handleSignOut = useCallback\(async[\s\S]*?\n {2}\}, \[/)?.[0];
  assert.ok(handler, 'App.tsx defines handleSignOut');
  assert.match(handler, /flushPendingReviews\(\)/);
  assert.ok(handler.indexOf('pushDirtyItems()') < handler.indexOf('logout()'), 'changes are pushed before the session ends');
  assert.match(handler, /SIGN_OUT_FLUSH_MS/);
  assert.match(app, /onSignOut=\{handleSignOut\}/);
  assert.doesNotMatch(app, /onSignOut=\{logout\}/);
});
