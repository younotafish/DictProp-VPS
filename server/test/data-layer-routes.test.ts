import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-data-layer-routes-test-'));
process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const png = (seed: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);
const dataUri = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const srs = (id: string, type: string) => ({
  id, type, nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0,
});
const vocab = (id: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  type: 'vocab', data: { id, word: 'lucid', definition: 'clear', ...data }, srs: srs(id, 'vocab'), savedAt: 1, updatedAt: 1, ...extra,
});
const phrase = (id: string, vocabs: Array<Record<string, unknown>>) => ({
  type: 'phrase', data: { id, query: 'see it clearly', vocabs }, srs: srs(id, 'phrase'), savedAt: 1, updatedAt: 1,
});
const send = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const putItems = (items: unknown) => app.request('/api/items', send('PUT', items));
const putImage = (id: string, bytes: Buffer) => app.request(`/api/items/${id}/image`, {
  method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes,
});
const manifest = async () => await (await app.request('/api/items/images/manifest')).json() as string[];

test('a push that leaves out a field the server keeps saves the edit without returning the item as canonical', async () => {
  const audit = { status: 'current_general', reason: 'Normal in current American English.', confidence: 'high', auditedAt: 1 };
  let response = await putItems([vocab('route-carry', { usageAudit: audit })]);
  assert.equal(response.status, 200);
  const revision = (await response.json() as any).revisions['route-carry'];

  const edited = vocab('route-carry', { definition: 'easy to understand' }, { serverRevision: revision, updatedAt: 2 });
  response = await putItems([edited]);
  assert.equal(response.status, 200);
  const saved = await response.json() as any;
  assert.deepEqual(saved.conflicts, []);
  assert.deepEqual(saved.canonical, []);
  assert.ok(saved.revisions['route-carry'] > revision);

  const item = await (await app.request('/api/items/route-carry')).json() as any;
  assert.equal(item.data.definition, 'easy to understand');
  assert.deepEqual(item.data.usageAudit, audit);

  // The client keeps its copy at the unchanged revision and pushes it again; that changes nothing.
  response = await putItems([{ ...edited, serverRevision: saved.revisions['route-carry'] }]);
  assert.equal((await response.json() as any).revisions['route-carry'], saved.revisions['route-carry']);
});

test('item writes are refused when their data is oversized or holds an inline image outside imageUrl', async () => {
  let deep: unknown = 'deep';
  for (let depth = 0; depth < 40; depth++) deep = [deep];
  for (const [items, error] of [
    [[vocab('route-large', { definition: 'x'.repeat(300 * 1024) })], 'item.data exceeds 256 KB'],
    [[vocab('route-inline', { mnemonic: dataUri(png('mnemonic')) })], 'item has an inline image outside imageUrl'],
    [[phrase('route-inline-phrase', [{ id: 'route-inline-vocab', word: 'clearly', mnemonic: dataUri(png('vocab')) }])],
      'item has an inline image outside imageUrl'],
    [[vocab('route-deep', { examples: deep })], 'item is nested too deeply'],
  ] as const) {
    const response = await putItems(items);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: `Invalid item at index 0: ${error}` });
  }
  let response = await app.request('/api/items/route-inline', send('PUT', vocab('route-inline', {
    examples: [{ sentence: dataUri(png('example')) }],
  })));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'item has an inline image outside imageUrl' });
  for (const id of ['route-large', 'route-inline', 'route-inline-phrase', 'route-deep']) {
    assert.equal((await app.request(`/api/items/${id}`)).status, 404, id);
  }

  // imageUrl itself, on the item or on a phrase vocab, still carries an image into image storage.
  response = await putItems([
    vocab('route-image', { imageUrl: dataUri(png('item')) }),
    phrase('route-phrase', [{ id: 'route-phrase-vocab', word: 'clearly', imageUrl: dataUri(png('phrase vocab')) }]),
  ]);
  assert.equal(response.status, 200);
  const ids = await manifest();
  assert.ok(ids.includes('route-image') && ids.includes('route-phrase-vocab'));
});

test('an image whose blob is gone is served as missing rather than as an empty image', async () => {
  const bytes = png('route-dangling');
  assert.equal((await putImage('route-dangling', bytes)).status, 200);
  db.prepare('DELETE FROM image_blobs WHERE content_hash = ?').run(sha256(bytes));

  assert.equal((await app.request('/api/items/route-dangling/image')).status, 404);
  const response = await app.request('/api/items/images', send('POST', { ids: ['route-dangling'] }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {});
  assert.equal((await manifest()).includes('route-dangling'), false);
});

test('the image endpoint names its bytes with a strong ETag and answers a matching revalidation with 304', async () => {
  let response = await putItems([vocab('route-etag')]);
  const revision = (await response.json() as any).revisions['route-etag'];
  const bytes = png('route-etag');
  response = await putImage('route-etag', bytes);
  assert.equal(response.status, 200);
  // The upload reaches delta clients through the item's revision.
  response = await app.request(`/api/items?afterRevision=${revision}&limit=50`);
  assert.ok((await response.json() as any).items.some((item: any) => item.data.id === 'route-etag'));

  const etag = `"${sha256(bytes)}"`;
  response = await app.request('/api/items/route-etag/image');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), etag);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=300, must-revalidate');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);

  for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
    response = await app.request('/api/items/route-etag/image', { headers: { 'If-None-Match': header } });
    assert.equal(response.status, 304, header);
    assert.equal(response.headers.get('etag'), etag);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  response = await app.request('/api/items/route-etag/image', { headers: { 'If-None-Match': '"other"' } });
  assert.equal(response.status, 200);
});

test('malformed JSON bodies get a 400 instead of failing the request', async () => {
  for (const [path, method, error] of [
    ['/api/items/images', 'POST', 'Expected { ids: string[] }'],
    ['/api/items/images', 'PUT', 'Expected { [id]: dataUri }'],
    ['/api/items', 'PUT', 'Expected array of items'],
    ['/api/items/route-malformed', 'PUT', 'item must be an object'],
  ] as const) {
    const response = await app.request(path, send(method, '{not json'));
    assert.equal(response.status, 400, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error });
  }
});

test('deleting an id the user never saved leaves the revision clock alone', async () => {
  const head = async () => (await (await app.request('/api/items?afterRevision=0&limit=1')).json() as any).headRevision;
  const before = await head();
  const response = await app.request('/api/items/route-never-saved', { method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal(await head(), before);
});

test('comparison saves are bounded, and neither an older nor a future-dated copy wins', async () => {
  const put = (body: unknown) => app.request('/api/comparisons', send('PUT', body));
  for (const body of [
    { key: 'k'.repeat(1_001), words: ['fable', 'parable'], data: {} },
    { key: 'many', words: Array.from({ length: 11 }, (_, index) => `word${index}`), data: {} },
    { key: 'empty-word', words: ['fable', ''], data: {} },
    { key: 'no-words', words: [], data: {} },
  ]) {
    const response = await put(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Expected a key of at most 1000 characters and 1-10 words' });
  }

  const words = ['fable', 'parable'];
  assert.equal((await put({ key: 'fable|parable', words, data: { v: 'newer' }, updatedAt: 2_000 })).status, 200);
  assert.equal((await put({ key: 'fable|parable', words, data: { v: 'older' }, updatedAt: 1_000 })).status, 200);
  const before = Date.now();
  const future = { key: 'legend|myth', words: ['legend', 'myth'], data: { v: 'future' }, updatedAt: before + 365 * 86_400_000 };
  assert.equal((await put(future)).status, 200);

  const saved = new Map((await (await app.request('/api/comparisons')).json() as any[]).map(entry => [entry.key, entry]));
  assert.deepEqual(saved.get('fable|parable').data, { v: 'newer' });
  assert.equal(saved.get('fable|parable').updatedAt, 2_000);
  const clamped = saved.get('legend|myth').updatedAt;
  assert.ok(clamped >= before && clamped <= Date.now() + 5 * 60 * 1000, String(clamped));
});
