import assert from 'node:assert/strict';
import test from 'node:test';
import type { LearnLaterResponse } from '../src/shared/learn-later.js';

// GET/PUT /api/learn-later: each item's latest star or unstar, outside item data; the later change wins.

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { getLearnLater, recordLearnLaterChanges } = await import('../src/db.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const put = (body: unknown) => app.request('/api/learn-later', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('the route keeps well-formed changes, counts the rest, and reads them back', async () => {
  const response = await put({ changes: [
    { itemId: 'route-s1', starred: true, changedAt: 1_000 },
    { itemId: 'route-s2', starred: 'yes', changedAt: 1_000 },
  ] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, rejected: 1, items: { 'route-s1': { starred: true, changedAt: 1_000 } } });
  // A change older than the stored one: the answer names the winner, so the device shows it at once.
  const stale = await put({ changes: [{ itemId: 'route-s1', starred: false, changedAt: 500 }] });
  assert.deepEqual(await stale.json(), { accepted: 1, rejected: 0, items: { 'route-s1': { starred: true, changedAt: 1_000 } } });
  const read = await app.request('/api/learn-later');
  const body = await read.json() as LearnLaterResponse;
  assert.deepEqual(body.items['route-s1'], { starred: true, changedAt: 1_000 });
  assert.equal(body.items['route-s2'], undefined);
  assert.equal((await put({ changes: 'no' })).status, 400);
  assert.equal((await put({ changes: Array.from({ length: 201 }, (_, i) => ({ itemId: `x${i}`, starred: true, changedAt: 1 })) })).status, 400);
});

test('the later change wins, whatever order the changes arrive in', () => {
  const user = 'learn-later-order';
  recordLearnLaterChanges(user, [{ itemId: 's', starred: true, changedAt: 2_000 }], 1);
  // An unstar made earlier, sent late by another device: the star stays.
  recordLearnLaterChanges(user, [{ itemId: 's', starred: false, changedAt: 1_500 }], 2);
  assert.deepEqual(getLearnLater(user).items.s, { starred: true, changedAt: 2_000 });
  recordLearnLaterChanges(user, [{ itemId: 's', starred: false, changedAt: 3_000 }], 3);
  assert.deepEqual(getLearnLater(user).items.s, { starred: false, changedAt: 3_000 });
  // Each user's stars are their own.
  assert.deepEqual(Object.keys(getLearnLater('learn-later-other').items), []);
});
