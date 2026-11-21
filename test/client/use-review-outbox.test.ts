import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReviewOutbox } from '../../hooks/useReviewOutbox.ts';
import { SHOWN_HISTORY_MAX_AGE_MS } from '../../hooks/useReviewHistory.ts';
import { HttpError } from '../../services/http.ts';
import { readRefusedReviews } from '../../services/refusedReviews.ts';
import { enqueuePendingReviewMutation, readPendingReviewMutations } from '../../services/reviewQueue.ts';
import type { StoredItem } from '../../types.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// hooks/useReviewOutbox.ts, run once through a server render. Its callbacks keep working afterwards on the fake library
// they were given. Reviews go into a localStorage outbox in memory; Node reports no connection, so nothing is sent.
// The history it holds changes only after the first render, so the cases about it mount the hook as App does.

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
  assert.equal(queued.event.sessionId, 's1', 'the session travels with the review, as a Today unit\'s does to count');
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
  const net = { online: false, answer: (_url: string): Response | Promise<Response> => { throw new TypeError('Failed to fetch'); } };
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

test('a review the server refuses is listed under its sentence as it reads, without its markers', async t => {
  const net = fakeNetwork(t);
  const sentence: StoredItem = {
    type: 'sentence',
    data: { id: 's1', text: 'She {{ran}} to the [[station]].', sourceWord: 'run' },
    srs: { ...card().srs, id: 's1', type: 'sentence' },
    savedAt: 1,
  };
  const { outbox } = renderOutbox([sentence]);
  enqueuePendingReviewMutation('u1', {
    event: { id: 'e1', itemId: 's1', itemType: 'sentence', reviewedAt: NOW, previousStep: 0, nextStep: 1 },
    itemIds: ['s1'],
    optimisticSrs: { s1: sentence.srs },
  });
  t.mock.method(console, 'warn', () => {});
  net.online = true;
  net.answer = url => {
    assert.match(url, /\/api\/reviews\/apply$/);
    return Response.json({ error: 'Item not found' }, { status: 404 });
  };
  await outbox.flushPendingReviews();
  assert.deepEqual(readRefusedReviews('u1').entries.map(entry => entry.word), ['She ran to the station.']);
  assert.deepEqual(readPendingReviewMutations('u1'), [], 'the refused review leaves the outbox');
});

const sentenceItem = (): StoredItem => ({
  type: 'sentence',
  data: { id: 's1', text: 'She {{ran}} to the [[station]].', sourceWord: 'run' },
  srs: { ...card().srs, id: 's1', type: 'sentence' },
  savedAt: 1,
});

/**
 * useReviewOutbox mounted with createRoot, as App runs it, with just enough of a browser for React and the history's
 * loads: a window that hears 'online' and a visible page. `hook()` is what it returned at its latest render.
 */
async function mountOutbox(t: TestContext, initial: StoredItem[]) {
  const page = Object.assign(new EventTarget(), {
    nodeType: 9, visibilityState: 'visible' as DocumentVisibilityState, activeElement: null, defaultView: null as unknown,
  });
  const browser = Object.assign(new EventTarget(), { document: page, event: undefined, HTMLIFrameElement: class {} });
  page.defaultView = browser;
  const globals = globalThis as Record<string, unknown>;
  Object.assign(globals, { window: browser, document: page, IS_REACT_ACT_ENVIRONMENT: true });
  (globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
  let items = initial;
  const library = {
    latestItemsRef: { get current() { return items; }, set current(next: StoredItem[]) { items = next; } },
    updateItems: (transform: (current: StoredItem[]) => StoredItem[]) => (items = transform(items)),
    storeItemUpdates: async () => {},
  };
  let latest: ReturnType<typeof useReviewOutbox> | undefined;
  const Probe = () => { latest = useReviewOutbox('u1', library); return null; };
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: page, textContent: '',
  });
  const root = createRoot(container as unknown as Element);
  await act(() => root.render(createElement(Probe)));
  t.after(async () => {
    await act(() => root.unmount());
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  });
  return { hook: () => latest!, window: browser };
}

/** Lets the hook's loads and renders run until `check` holds. */
async function until(check: () => boolean, what: string) {
  for (let tries = 0; tries < 400; tries++) {
    if (check()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  assert.fail(`timed out waiting until ${what}`);
}

const EMPTY_HISTORY = { recent: [], olderTimes: [], olderCount: 0 };

test('a review the server refuses leaves the history, so Today\'s goal and streak count only what the server stored', async t => {
  t.mock.method(console, 'warn', () => {});
  const net = fakeNetwork(t);
  net.online = true;
  net.answer = url => {
    if (url.includes('/api/reviews/history')) return Response.json(EMPTY_HISTORY);
    assert.match(url, /\/api\/reviews\/apply$/);
    return Response.json({ error: 'Item not found' }, { status: 404 });
  };
  const view = await mountOutbox(t, [sentenceItem()]);
  await until(() => view.hook().reviewHistory.loaded, 'the history has loaded');

  await act(async () => { await view.hook().updateSRS('s1', 'good', { sessionId: 'set:u1' }); });
  assert.deepEqual(view.hook().reviewHistory.recent, [], 'the refused Got it no longer counts');
  assert.equal(readRefusedReviews('u1').entries.length, 1, 'the user hears of it');
  assert.deepEqual(readPendingReviewMutations('u1'), []);
});

test('a refused review stays out of the history when a load that began while it was queued lands after the refusal', async t => {
  t.mock.method(console, 'warn', () => {});
  const net = fakeNetwork(t);
  const historyAnswers: (() => void)[] = [];
  let historyRequests = 0;
  net.answer = url => {
    if (url.includes('/api/reviews/history')) {
      historyRequests++;
      if (!net.online) throw new TypeError('Failed to fetch');
      return new Promise<Response>(resolve => historyAnswers.push(() => resolve(Response.json(EMPTY_HISTORY))));
    }
    return Response.json({ error: 'Item not found' }, { status: 404 });
  };
  // Offline: the first load fails, and a Got it waits in the outbox.
  const view = await mountOutbox(t, [sentenceItem()]);
  await until(() => historyRequests === 1, 'the first load has failed');
  await act(async () => { await view.hook().updateSRS('s1', 'good', { sessionId: 'set:u1' }); });
  assert.equal(view.hook().reviewHistory.recent.length, 1);

  // Back online: a load starts with the review still queued, and the outbox drains to a refusal before it lands.
  net.online = true;
  await act(async () => { view.window.dispatchEvent(new Event('online')); });
  await until(() => historyAnswers.length === 1, 'a load is under way');
  await act(() => view.hook().flushPendingReviews());
  assert.deepEqual(view.hook().reviewHistory.recent, []);
  historyAnswers[0]();
  await until(() => view.hook().reviewHistory.loaded, 'the load has landed');
  assert.deepEqual(view.hook().reviewHistory.recent, [], 'the server never stored it, so the load brings nothing back');
});

test('Today\'s refresh loads the history again once its last load is over a minute old, never sooner', async t => {
  const net = fakeNetwork(t);
  let clock = NOW;
  t.mock.method(Date, 'now', () => clock);
  let historyRequests = 0;
  net.answer = url => {
    assert.match(url, /\/api\/reviews\/history/);
    historyRequests++;
    return Response.json(EMPTY_HISTORY);
  };
  const view = await mountOutbox(t, [card()]);
  await until(() => view.hook().reviewHistory.loaded, 'the history has loaded');
  assert.equal(SHOWN_HISTORY_MAX_AGE_MS, 60_000);

  clock += SHOWN_HISTORY_MAX_AGE_MS;
  await act(async () => { view.hook().refreshReviewHistory(); });
  assert.equal(historyRequests, 1, 'a minute old: still fresh enough');
  clock += 1;
  await act(async () => { view.hook().refreshReviewHistory(); });
  await until(() => historyRequests === 2, 'the history loads again');
});
