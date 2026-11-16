import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useUndoOffer } from '../../hooks/useUndoOffer.ts';
import type { DetailContext } from '../../hooks/useDetailView.ts';
import { getItemContentHash } from '../../services/itemHash.ts';
import { hasUnsentChanges, isUnsent, selectUnsent, sendBeforeLeaving, type PushHold } from '../../services/unsentChanges.ts';
import type { StoredItem } from '../../types.ts';

const card = (id: string, definition = `definition of ${id}`): StoredItem => ({
  type: 'vocab',
  data: { id, word: id, chinese: '', ipa: '', definition, synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '' },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 1,
});
/** A copy the server has acknowledged. */
const synced = (item: StoredItem): StoredItem => ({ ...item, lastSyncedHash: getItemContentHash(item) });
const edited = (item: StoredItem, definition: string): StoredItem => ({ ...item, data: { ...item.data, definition } as StoredItem['data'] });
const noHold: PushHold = { heldIds: new Set(), refused: new Map() };

test('only a change the server has not acknowledged is unsent', () => {
  assert.equal(isUnsent(card('new'), noHold), true, 'never pushed');
  assert.equal(isUnsent(synced(card('clean')), noHold), false);
  assert.equal(isUnsent(edited(synced(card('edited')), 'changed'), noHold), true);
});

test('an item held for an undo, or refused at its current content, waits; one edited after the refusal goes again', () => {
  const held = edited(synced(card('held')), 'deleted, maybe');
  assert.equal(isUnsent(held, { ...noHold, heldIds: new Set(['held']) }), false);
  assert.equal(isUnsent(held, { ...noHold, heldIds: new Set(['another']) }), true);

  const refusedCopy = edited(synced(card('refused')), 'too large');
  const refused = new Map([['refused', getItemContentHash(refusedCopy)]]);
  assert.equal(isUnsent(refusedCopy, { ...noHold, refused }), false);
  assert.equal(isUnsent(edited(refusedCopy, 'fixed'), { ...noHold, refused }), true);
});

test('a push selects the unsent items, among the given ids when there are some', () => {
  const items = [card('a'), synced(card('b')), card('c'), card('held')];
  const hold: PushHold = { heldIds: new Set(['held']), refused: new Map() };
  assert.deepEqual(selectUnsent(items, hold).map(item => item.data.id), ['a', 'c']);
  assert.deepEqual(selectUnsent(items, hold, new Set(['c', 'b', 'held'])).map(item => item.data.id), ['c']);
});

test('changes are waiting while an undo is on offer, a review is queued, or an item is unsent; refused ones do not count', () => {
  const clean = [synced(card('a'))];
  let reviewReads = 0;
  const noReviews = () => { reviewReads++; return 0; };

  assert.equal(hasUnsentChanges(clean, noHold, noReviews), false);
  assert.equal(hasUnsentChanges(clean, noHold, () => 1), true, 'a queued review');
  assert.equal(hasUnsentChanges([...clean, card('b')], noHold, noReviews), true, 'an unsent item');

  reviewReads = 0;
  assert.equal(hasUnsentChanges(clean, { ...noHold, heldIds: new Set(['a']) }, noReviews), true, 'an open undo offer');
  assert.equal(reviewReads, 0, 'an open undo offer answers without reading the outbox');

  const refusedCopy = card('refused');
  const refused = new Map([['refused', getItemContentHash(refusedCopy)]]);
  assert.equal(hasUnsentChanges([...clean, refusedCopy], { ...noHold, refused }, noReviews), false);
});

test('an undo offer can hold several items back, and an empty hold holds none', () => {
  const items = [edited(synced(card('a')), 'refreshed'), edited(synced(card('b')), 'refreshed'), card('c')];
  const hold: PushHold = { ...noHold, heldIds: new Set(['a', 'b']) };
  assert.deepEqual(selectUnsent(items, hold).map(item => item.data.id), ['c']);
  assert.deepEqual(selectUnsent(items, noHold).map(item => item.data.id), ['a', 'b', 'c']);
  assert.equal(hasUnsentChanges([synced(card('a'))], hold, () => 0), true, 'held items wait for the offer to close');
  assert.equal(hasUnsentChanges([synced(card('a'))], noHold, () => 0), false);
});

// hooks/useUndoOffer.ts, run once through a server render. Its callbacks keep working afterwards: they close over
// the hook's refs, and React ignores a state update that comes after a server render, so the library they call
// can be a fake that records each call.
function renderUndoOffer(initial: StoredItem[], detailVersion = 0) {
  let items = initial;
  const calls: string[] = [];
  const views: DetailContext[] = [];
  const library = {
    latestItemsRef: { get current() { return items; }, set current(next: StoredItem[]) { items = next; } },
    holdFromPush: (ids: readonly string[] | null) => { calls.push(`hold ${ids?.length ? ids.join(',') : 'none'}`); },
    pushDirtyItems: async (ids?: ReadonlySet<string>) => { calls.push(`push ${[...ids ?? []].join(',')}`); return 0; },
    replaceItem: (id: string, update: (item: StoredItem) => StoredItem) => {
      const index = items.findIndex(item => item.data.id === id);
      if (index < 0) return undefined;
      const next = update(items[index]);
      items = items.map((item, at) => (at === index ? next : item));
      return next;
    },
    storeItemUpdates: async (stored: StoredItem[]) => { calls.push(`store ${stored.map(item => item.data.id).join(',')}`); },
  };
  const detail = {
    detailVersionRef: { current: detailVersion },
    updateDetailContext: (next: DetailContext | null | ((prev: DetailContext | null) => DetailContext | null)) => {
      if (next && typeof next !== 'function') views.push(next);
    },
  };
  let undo: ReturnType<typeof useUndoOffer> | undefined;
  const Probe = () => { undo = useUndoOffer(library, detail); return null; };
  renderToStaticMarkup(createElement(Probe));
  return { undo: undo!, calls, views, items: () => items };
}

// The offer's 6-second timer goes through window.setTimeout, which each test's mock clock drives.
(globalThis as { window?: unknown }).window = {
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
};
const deleted = (item: StoredItem): StoredItem => ({ ...item, isDeleted: true, updatedAt: 2 });
const undelete = (item: StoredItem): StoredItem => (item.isDeleted ? { ...item, isDeleted: undefined, updatedAt: 1 } : item);

test('an offer holds every item it names until it closes, and closing pushes them all', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { undo, calls } = renderUndoOffer([card('a'), card('b')]);
  undo.offerUndoChange({ ids: ['a', 'b'], message: 'Refreshed “gamut”', undo: undelete });
  assert.deepEqual(calls, ['hold a,b']);
  undo.closeUndoOffer();
  assert.deepEqual(calls, ['hold a,b', 'hold none', 'push a,b']);
  undo.closeUndoOffer();
  assert.equal(calls.length, 3, 'closing again does nothing');
});

test('a new offer sends the open one on first, and an offer closes by itself after six seconds', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { undo, calls } = renderUndoOffer([card('a'), card('b')]);
  undo.offerUndo('Deleted', card('a'), undelete);
  undo.offerUndo('Archived', card('b'), undelete);
  assert.deepEqual(calls, ['hold a', 'hold none', 'push a', 'hold b']);
  t.mock.timers.tick(5_999);
  assert.equal(calls.length, 4);
  t.mock.timers.tick(1);
  assert.deepEqual(calls.slice(4), ['hold none', 'push b']);
});

test('undo restores each held item still in the library and stores them together', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { undo, calls, items } = renderUndoOffer([deleted(card('a')), deleted(card('b')), card('c')]);
  undo.offerUndoChange({ ids: ['a', 'b', 'gone'], message: 'Deleted 2 cards', undo: undelete });
  await undo.undoLastChange();
  assert.deepEqual(items().map(item => [item.data.id, !!item.isDeleted]), [['a', false], ['b', false], ['c', false]]);
  assert.deepEqual(calls, ['hold a,b,gone', 'hold none', 'push a,b,gone', 'store a,b']);
  await undo.undoLastChange();
  assert.equal(calls.length, 4, 'nothing left to undo');
});

test('an action offer holds and pushes nothing, and its undo runs the action\'s own', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { undo, calls } = renderUndoOffer([card('a')]);
  let undone = 0;
  undo.offerUndoAction('Cleared 3 results', () => { undone++; });
  await undo.undoLastChange();
  assert.equal(undone, 1);
  assert.deepEqual(calls, ['hold none', 'hold none'], 'no push and no store');
});

test('only a single card goes back into the open view it left, and only while that view is unchanged', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before: DetailContext = { groups: [{ title: 'b', items: [card('b')] }, { title: 'a', items: [card('a')] }], groupIndex: 0, itemIndex: 0, openId: 1 };
  const single = renderUndoOffer([deleted(card('a'))], 7);
  single.undo.offerUndo('Deleted', card('a'), undelete, { before, version: 7 });
  await single.undo.undoLastChange();
  assert.equal(single.views.length, 1);
  assert.equal(single.views[0].groupIndex, 1);

  const changed = renderUndoOffer([deleted(card('a'))], 8);
  changed.undo.offerUndo('Deleted', card('a'), undelete, { before, version: 7 });
  await changed.undo.undoLastChange();
  assert.equal(changed.views.length, 0, 'the view changed since');

  const several = renderUndoOffer([deleted(card('a')), deleted(card('b'))], 7);
  several.undo.offerUndoChange({ ids: ['a', 'b'], message: 'Deleted 2 cards', undo: undelete, view: { before, version: 7 } });
  await several.undo.undoLastChange();
  assert.equal(several.views.length, 0);
});

test('leaving closes the undo offer, then saves, sends the reviews and pushes, in that order', async () => {
  const steps: string[] = [];
  await sendBeforeLeaving({
    closeUndoOffer: () => { steps.push('close undo offer'); },
    saveLocal: async () => { steps.push('save'); },
    flushReviews: async () => { steps.push('reviews'); },
    push: async () => { steps.push('push'); },
    timeoutMs: 1_000,
    onError: error => { throw error; },
  });
  steps.push('sign out');
  assert.deepEqual(steps, ['close undo offer', 'save', 'reviews', 'push', 'sign out']);
});

test('with nothing to save, the reviews start at once', () => {
  const steps: string[] = [];
  void sendBeforeLeaving({
    closeUndoOffer: () => {},
    saveLocal: () => undefined,
    flushReviews: async () => { steps.push('reviews'); },
    push: async () => {},
    timeoutMs: 1_000,
    onError: () => {},
  });
  assert.deepEqual(steps, ['reviews'], 'started before sendBeforeLeaving returned');
});

test('a failed step is reported and stops the rest, and leaving still goes ahead', async () => {
  const steps: string[] = [];
  const errors: unknown[] = [];
  await sendBeforeLeaving({
    closeUndoOffer: () => {},
    saveLocal: async () => { throw new Error('storage full'); },
    flushReviews: async () => { steps.push('reviews'); },
    push: async () => { steps.push('push'); },
    timeoutMs: 1_000,
    onError: error => { errors.push(error); },
  });
  assert.deepEqual(steps, []);
  assert.match(String(errors[0]), /storage full/);
});

test('a server that never answers holds leaving up for timeoutMs at most', async () => {
  const started = Date.now();
  let pushes = 0;
  await sendBeforeLeaving({
    closeUndoOffer: () => {},
    saveLocal: () => undefined,
    flushReviews: async () => {},
    push: () => { pushes++; return new Promise(() => {}); },
    timeoutMs: 30,
    onError: () => {},
  });
  assert.equal(pushes, 1);
  assert.ok(Date.now() - started < 1_000, 'gave up after the timeout');
});
