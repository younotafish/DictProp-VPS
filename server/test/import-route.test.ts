import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { AppEnv } from '../src/middleware/auth.js';
import { srs } from './support/fixtures.js';

const { createImportRoutes } = await import('../src/routes/import.js');
const { getItemById, getItemImageBinary } = await import('../src/db.js');

const USER = 'import-user';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const fetched: string[] = [];
const fetchImage = async (url: string) => {
  fetched.push(url);
  return url.includes('/fail/') ? undefined : `data:image/png;base64,${png.toString('base64')}`;
};
const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('user', { id: USER, email: '', displayName: null, photoUrl: null, isAdmin: true });
  await next();
});
app.route('/api', createImportRoutes({ fetchImage }));

const vocab = (id: string, imageUrl?: string) => ({
  type: 'vocab', data: { id, word: id, ...(imageUrl ? { imageUrl } : {}) }, srs: srs(id, 'vocab'), savedAt: 1,
});
const importItems = (body: unknown) => app.request('/api/import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('an import wraps plain cards, skips invalid entries, and fetches at most 100 remote images', async () => {
  const topLevel = Array.from({ length: 97 }, (_, index) => vocab(`imported-${index}`, `https://img.example/ok/${index}`));
  const phrase = {
    type: 'phrase',
    data: {
      id: 'imported-phrase',
      query: 'see it clearly',
      vocabs: [
        { id: 'nested-first', word: 'see', imageUrl: 'https://img.example/ok/nested-first' },
        { id: 'nested-over-cap', word: 'it', imageUrl: 'https://img.example/ok/nested-over-cap' },
        { id: 'nested-local', word: 'clearly', imageUrl: 'idb:stored' },
      ],
    },
    srs: srs('imported-phrase', 'phrase'),
    savedAt: 1,
  };
  const response = await importItems([
    ...topLevel,
    vocab('imported-failed', 'https://img.example/fail/top'),
    phrase,
    { id: 'plain-card', word: 'lucid', definition: 'clear', imageUrl: 'https://img.example/ok/plain' },
    { definition: 'no word' },
    { type: 'vocab', data: { id: 'no-srs', word: 'x' } },
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, imported: 100, skipped: 2, imagesFetched: 99 });

  // 97 top-level images, the failed one, the plain card's, and the first nested image: the cap is shared.
  assert.equal(fetched.length, 100);
  assert.ok(!fetched.includes('https://img.example/ok/nested-over-cap'));

  const plain = getItemById('plain-card', USER, false);
  assert.equal(plain?.type, 'vocab');
  assert.equal(plain?.data.definition, 'clear');
  assert.equal(plain?.srs.totalReviews, 0);
  assert.ok(getItemImageBinary('plain-card', USER));
  assert.ok(getItemImageBinary('imported-0', USER));

  assert.equal(getItemImageBinary('imported-failed', USER), null);
  assert.equal(getItemById('imported-failed', USER, false)?.data.imageUrl, undefined);
  assert.ok(getItemImageBinary('nested-first', USER));
  assert.equal(getItemImageBinary('nested-over-cap', USER), null);
  const storedPhrase = getItemById('imported-phrase', USER, false);
  assert.match(storedPhrase?.data.vocabs[0].imageUrl, /^server:has_image:/);
  assert.equal(storedPhrase?.data.vocabs[1].imageUrl, undefined);
});

test('an import with no valid entry, or with too many, is refused', async () => {
  let response = await importItems([{ definition: 'no word' }]);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'No valid items found' });
  response = await importItems(Array.from({ length: 5_001 }, () => ({})));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Import is limited to 5000 items' });
});

test('nested images are fetched five at a time, like the items\' own', async () => {
  let inFlight = 0;
  let mostInFlight = 0;
  const slowApp = new Hono<AppEnv>();
  slowApp.use('*', async (c, next) => {
    c.set('user', { id: USER, email: '', displayName: null, photoUrl: null, isAdmin: true });
    await next();
  });
  slowApp.route('/api', createImportRoutes({
    fetchImage: async () => {
      mostInFlight = Math.max(mostInFlight, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
      return `data:image/png;base64,${png.toString('base64')}`;
    },
  }));
  const vocabs = Array.from({ length: 12 }, (_, index) => ({ id: `pooled-${index}`, word: 'w', imageUrl: `https://img.example/ok/pooled-${index}` }));
  const response = await slowApp.request('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ type: 'phrase', data: { id: 'pooled-phrase', query: 'q', vocabs }, srs: srs('pooled-phrase', 'phrase'), savedAt: 1 }]),
  });
  assert.deepEqual(await response.json(), { ok: true, imported: 1, skipped: 0, imagesFetched: 12 });
  assert.equal(mostInFlight, 5);
});
