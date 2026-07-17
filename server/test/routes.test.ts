import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-routes-test-'));
process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const item = {
  type: 'vocab',
  data: {
    id: 'route-item', word: 'visceral', sense: 'adj: instinctive', chinese: '', ipa: '',
    definition: 'felt deeply', synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '',
  },
  srs: {
    id: 'route-item', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0,
    lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5,
  },
  savedAt: 1,
  updatedAt: 1,
};

test('Hono routes apply reviews idempotently and expose revision deltas', async () => {
  let response = await app.request('/api/items', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([item]),
  });
  assert.equal(response.status, 200);

  const event = {
    id: 'route-review', itemId: item.data.id, itemType: 'vocab',
    reviewedAt: Date.now(), previousStep: 0, nextStep: 1,
    rating: 'hard', taskType: 'production', durationMs: 2_500, sessionId: 'route-session',
  };
  const apply = () => app.request('/api/reviews/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, itemIds: [item.data.id] }),
  });
  response = await apply();
  assert.equal(response.status, 201);
  assert.equal((await response.json() as any).applied, true);
  response = await apply();
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).applied, false);

  response = await app.request('/api/items?afterRevision=0&afterId=&limit=10');
  assert.equal(response.status, 200);
  const delta = await response.json() as any;
  assert.equal(delta.items.length, 1);
  assert.equal(delta.items[0].srs.totalReviews, 1);
  assert.equal(delta.items[0].srs.scheduler, 'fsrs-v6');
  assert.ok(delta.cursor.revision > 0);

  response = await app.request('/api/reviews?since=0');
  assert.equal(response.status, 200);
  const events = await response.json() as any[];
  assert.equal(events.length, 1);
  assert.deepEqual(
    {
      rating: events[0].rating,
      taskType: events[0].taskType,
      durationMs: events[0].durationMs,
      sessionId: events[0].sessionId,
    },
    { rating: 'hard', taskType: 'production', durationMs: 2_500, sessionId: 'route-session' },
  );

  response = await app.request(`/api/reviews/${event.id}/undo`, { method: 'POST' });
  assert.equal(response.status, 200);
  const undo = await response.json() as any;
  assert.equal(undo.undone, true);
  assert.equal(undo.items[0].srs.totalReviews, 0);

  response = await app.request(`/api/reviews/${event.id}/undo`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).undone, false);

  response = await app.request('/api/reviews?since=0');
  assert.deepEqual(await response.json(), []);
});

test('review route validates mutations before touching the database', async () => {
  const response = await app.request('/api/reviews/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: { id: '' }, itemIds: [] }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid review mutation' });
});

test('item routes reject malformed records and oversized batches', async () => {
  let response = await app.request('/api/items', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ ...item, srs: { ...item.srs, nextReview: 'tomorrow' } }]),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json() as any).error, /srs\.nextReview/);

  response = await app.request('/api/items', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Array.from({ length: 501 }, () => item)),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'At most 500 items are allowed per request' });

  response = await app.request('/api/items', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Expected array of items' });
});

test('runtime middleware exposes readiness/request ids and rejects cross-site mutations', async () => {
  let response = await app.request('/api/health', {
    headers: { 'X-Request-Id': 'route-test-request' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), 'route-test-request');
  assert.match(response.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.deepEqual(
    { status: (await response.json() as any).status },
    { status: 'ok' },
  );

  response = await app.request('/api/items', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://attacker.example',
      'Sec-Fetch-Site': 'cross-site',
    },
    body: JSON.stringify([item]),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Cross-origin mutation rejected' });

  response = await app.request('/api/items?images=true');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'Bulk image responses are disabled; use the image endpoints',
  });
});
