import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReviewOutbox } from '../../hooks/useReviewOutbox.ts';
import { HttpError } from '../../services/http.ts';
import { enqueuePendingReviewMutation, readPendingReviewMutations } from '../../services/reviewQueue.ts';
import type { StoredItem } from '../../types.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// hooks/useReviewOutbox.ts, run once through a server render. Its callbacks keep working afterwards on the fake library
// they were given. Reviews go into a localStorage outbox in memory; Node reports no connection, so nothing is sent.

const NOW = Date.UTC(2026, 10, 16, 15, 30);

const card = (fields: Partial<StoredItem> = {}): StoredItem => ({
  type: 'vocab',
  data: { id: 'w1', word: 'gamut', chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id: 'w1', type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
  ...fields,
});

function renderOutbox(initial: StoredItem[]) {
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
  let items = initial;
  const library = {
    latestItemsRef: { get current() { return items; }, set current(next: StoredItem[]) { items = next; } },
    updateItems: (transform: (current: StoredItem[]) => StoredItem[]) => (items = transform(items)),
    storeItemUpdates: async () => {},
  };
  let outbox: ReturnType<typeof useReviewOutbox> | undefined;
  const Probe = () => { outbox = useReviewOutbox('u1', library); return null; };
  renderToStaticMarkup(createElement(Probe));
  return { outbox: outbox!, items: () => items };
}

test('a review given its time is stamped with it, on the copy shown and on the event the outbox sends', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const { outbox, items } = renderOutbox([card()]);
  const gradedAt = NOW - 25;
  await outbox.updateSRS('w1', 'again', { taskType: 'meaning', durationMs: 4_000, sessionId: 's1', eventId: 'e1', reviewedAt: gradedAt });
  const [reviewed] = items();
  assert.equal(reviewed.srs.lastReviewDate, gradedAt);
  assert.equal(reviewed.updatedAt, gradedAt);
  const [queued] = readPendingReviewMutations('u1');
  assert.equal(queued.event.reviewedAt, gradedAt);
  assert.equal(queued.optimisticSrs.w1.lastReviewDate, gradedAt);
  assert.equal(queued.event.nextStep, 1);

  // Without one, a review is stamped with the time it is made.
  await outbox.updateSRS('w1', 'good', { eventId: 'e2' });
  assert.equal(items()[0].srs.lastReviewDate, NOW);
  assert.equal(readPendingReviewMutations('u1').find(mutation => mutation.event.id === 'e2')?.event.reviewedAt, NOW);
});

/**
 * The connection the hook sees: Node's navigator reports none until `online` is set, and fetch answers with `answer`,
 * which by default fails the way a fetch with no connection does.
 */
function fakeNetwork(t: TestContext) {
  const net = { online: false, answer: (_url: string): Response => { throw new TypeError('Failed to fetch'); } };
  const realFetch = globalThis.fetch;
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => net.online });
  globalThis.fetch = (async (input: string | URL | Request) => net.answer(String(input))) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    Reflect.deleteProperty(globalThis.navigator, 'onLine');
  });
  return net;
}

test('an undo takes the review back on the server, and says so', async t => {
  const net = fakeNetwork(t);
  net.online = true;
  net.answer = url => {
    assert.match(url, /\/api\/reviews\/e1\/undo$/);
    return Response.json({ undone: true, eventId: 'e1', items: [], baseRevisions: {} });
  };
  assert.equal(await renderOutbox([card()]).outbox.undoSRSReview('e1'), true);
});

test('an undo of a review still in the outbox does nothing and says so, online or not', async t => {
  const net = fakeNetwork(t);
  const { outbox } = renderOutbox([card()]);
  enqueuePendingReviewMutation('u1', {
    event: { id: 'e1', itemId: 'w1', itemType: 'vocab', reviewedAt: NOW, previousStep: 0, nextStep: 1 },
    itemIds: ['w1'],
    optimisticSrs: { w1: card().srs },
  });
  assert.equal(await outbox.undoSRSReview('e1'), false);
  // Online, the outbox sends it first; a server that can't take it yet keeps it waiting (and the outbox says so).
  t.mock.method(console, 'warn', () => {});
  net.online = true;
  net.answer = () => new Response('Unavailable', { status: 503 });
  assert.equal(await outbox.undoSRSReview('e1'), false);
  assert.equal(readPendingReviewMutations('u1').length, 1);
});

test('a failed undo request throws its own error, which the study screen puts in words', async t => {
  const net = fakeNetwork(t);
  net.online = true;
  net.answer = () => Response.json({ error: 'Review is no longer the latest change for this item' }, { status: 409 });
  await assert.rejects(renderOutbox([card()]).outbox.undoSRSReview('e1'), (error: unknown) => error instanceof HttpError && error.status === 409);
});

