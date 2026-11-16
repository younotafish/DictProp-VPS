import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { AppEnv } from '../src/middleware/auth.js';
import { srs } from './support/fixtures.js';

// POST /api/import's image phase has a deadline (IMPORT_IMAGE_PHASE_MS in server/src/shared/import-limits.ts, eight
// minutes), here shortened.

const { createImportRoutes } = await import('../src/routes/import.js');
const { getItemById, getItemImageBinary } = await import('../src/db.js');

const USER = 'image-deadline-user';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const DATA_URI = `data:image/png;base64,${png.toString('base64')}`;

test('past the image deadline no picture starts, those downloading are cut off, and the cards save without them', async () => {
  const requested: string[] = [];
  const cutOff: string[] = [];
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER, email: '', displayName: null, photoUrl: null, isAdmin: true });
    await next();
  });
  app.route('/api', createImportRoutes({
    imagePhaseDeadlineMs: 100,
    // fast.example answers at once; slow.example takes 5 s, unless its fetch is aborted first.
    fetchImage: (url, signal) => {
      requested.push(url);
      if (url.startsWith('https://fast.example/')) return Promise.resolve(DATA_URI);
      return new Promise((resolve) => {
        const answer = setTimeout(() => resolve(DATA_URI), 5_000);
        signal.addEventListener('abort', () => {
          clearTimeout(answer);
          cutOff.push(url);
          resolve(undefined);
        }, { once: true });
      });
    },
  }));

  const fast = ['f0', 'f1', 'f2'];
  const slow = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'];
  const body = [
    ...fast.map(id => ({ type: 'vocab', data: { id, word: id, imageUrl: `https://fast.example/${id}` }, srs: srs(id, 'vocab'), savedAt: 1 })),
    ...slow.map(id => ({ type: 'vocab', data: { id, word: id, imageUrl: `https://slow.example/${id}` }, srs: srs(id, 'vocab'), savedAt: 1 })),
  ];
  const started = Date.now();
  const response = await app.request('/api/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, imported: 10, skipped: 0, imagesFetched: 3 });
  assert.ok(Date.now() - started < 4_000, 'the reply came at the deadline, not after the slow downloads');

  // Five workers: the three fast pictures, then five slow ones, which the deadline cuts off; s5 and s6 never start.
  const slowUrls = slow.map(id => `https://slow.example/${id}`);
  assert.deepEqual(requested, [...fast.map(id => `https://fast.example/${id}`), ...slowUrls.slice(0, 5)]);
  assert.deepEqual(cutOff.sort(), slowUrls.slice(0, 5));

  for (const id of fast) assert.ok(getItemImageBinary(id, USER), id);
  for (const id of slow) {
    assert.equal(getItemImageBinary(id, USER), null, id);
    assert.equal(getItemById(id, USER, false)?.data.imageUrl, undefined, `${id} keeps no remote URL`);
  }
});
