import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewEvent, ReviewHistory } from '../../types.ts';
import {
  HISTORY_RELOAD_AFTER_MS,
  RECENT_DAYS,
  mergeLoadedHistory,
  recentSinceFor,
  shouldReloadHistory,
  startHistoryLoads,
  type LoadedReviewHistory,
} from '../../services/reviewHistory.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 16, 15, 30);

const review = (id: string, reviewedAt: number, rating: ReviewEvent['rating'] = 'good'): ReviewEvent =>
  ({ id, itemId: `item-${id}`, itemType: 'vocab', reviewedAt, previousStep: 0, nextStep: 1, rating });
const history = (recent: ReviewEvent[], olderTimes: number[] = [], olderCount = olderTimes.length): ReviewHistory =>
  ({ recent, olderTimes, olderCount });
const ids = (merged: ReviewHistory) => merged.recent.map(event => event.id);
/** Every review a history counts: the full ones and the older times. */
const counted = (merged: ReviewHistory) => merged.recent.length + merged.olderCount;

test('a load takes reviews in full from a week and a day back, or from the oldest review still in the outbox', () => {
  assert.equal(RECENT_DAYS, 8);
  assert.equal(recentSinceFor([], NOW), NOW - 8 * DAY);
  assert.equal(recentSinceFor([review('a', NOW - HOUR)], NOW), NOW - 8 * DAY, 'a recent outbox review changes nothing');
  assert.equal(recentSinceFor([review('a', NOW - HOUR), review('b', NOW - 10 * DAY), review('c', NOW - 9 * DAY)], NOW), NOW - 10 * DAY);
});

test('the first load keeps the reviews still in the outbox, which the server may not have, this device\'s copy winning', () => {
  const pending = [review('queued', NOW - 2 * HOUR, 'hard'), review('delivered', NOW - 3 * HOUR, 'again')];
  const before = history([...pending].reverse());
  // The server already has 'delivered' (the outbox hadn't removed it yet), with its own copy.
  const remote = history([review('older', NOW - 3 * DAY), review('delivered', NOW - 3 * HOUR, 'again')], [NOW - 30 * DAY], 12);
  const merged = mergeLoadedHistory(before, remote, new Set(pending.map(event => event.id)), NOW);
  assert.deepEqual(ids(merged), ['older', 'delivered', 'queued']);
  assert.equal(merged.recent.find(event => event.id === 'queued')?.rating, 'hard');
  assert.deepEqual(merged.olderTimes, [NOW - 30 * DAY]);
  assert.equal(merged.olderCount, 12);
});

test('a reload counts no review twice: one now among the older times leaves the full ones', () => {
  // Loaded two days ago: reviews from ten days back in full. Today's load takes them from eight days back, so the
  // server sends 'old' (nine days back) as an older time this time.
  const old = review('old', NOW - 9 * DAY);
  const recentOne = review('recent', NOW - DAY);
  const before = history([old, recentOne], [NOW - 40 * DAY], 1);
  const remote = history([recentOne], [NOW - 40 * DAY, old.reviewedAt], 2);
  const merged = mergeLoadedHistory(before, remote, new Set(), NOW);
  assert.deepEqual(ids(merged), ['recent']);
  assert.equal(counted(merged), 3, 'old, recent and the one from forty days ago, each once');
});

test('a reload drops a review the server no longer reports, as one undone on another device', () => {
  const before = history([review('kept', NOW - 2 * DAY), review('undone-elsewhere', NOW - DAY)]);
  const merged = mergeLoadedHistory(before, history([review('kept', NOW - 2 * DAY)]), new Set(), NOW);
  assert.deepEqual(ids(merged), ['kept']);
});

test('a review made while the history loaded stays, whether or not the load saw it', () => {
  const startedAt = NOW - 5_000;
  const madeDuring = review('during', NOW - 1_000);
  const before = history([review('earlier', NOW - DAY), madeDuring]);
  assert.deepEqual(ids(mergeLoadedHistory(before, history([review('earlier', NOW - DAY)]), new Set(), startedAt)), ['earlier', 'during']);
  assert.deepEqual(ids(mergeLoadedHistory(before, history([review('earlier', NOW - DAY), madeDuring]), new Set(), startedAt)), ['earlier', 'during']);
});

test('coming back online or into view loads the history again after a failed load, or a quarter of an hour on', () => {
  assert.equal(HISTORY_RELOAD_AFTER_MS, 15 * MINUTE);
  assert.equal(shouldReloadHistory(null, NOW), true, 'no load has finished yet');
  assert.equal(shouldReloadHistory({ ok: false, at: NOW - 1_000 }, NOW), true, 'the last load failed (offline)');
  assert.equal(shouldReloadHistory({ ok: true, at: NOW - 15 * MINUTE }, NOW), false);
  assert.equal(shouldReloadHistory({ ok: true, at: NOW - 15 * MINUTE - 1 }, NOW), true);
  assert.equal(shouldReloadHistory({ ok: true, at: NOW + MINUTE }, NOW), false, 'a clock that went back waits');
});

/** startHistoryLoads against a fake server, outbox, window and document, with a clock the test moves. */
function startLoads(initial: LoadedReviewHistory = { recent: [], olderTimes: [], olderCount: 0, loaded: false }) {
  const fetches: { recentSince: number; resolve: (remote: ReviewHistory) => void; reject: (error: unknown) => void }[] = [];
  const errors: unknown[] = [];
  const online = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const harness = { history: initial, pending: [] as ReviewEvent[], clock: NOW, fetches, errors, online, page, stop: () => {} };
  harness.stop = startHistoryLoads({
    pending: () => harness.pending,
    fetch: recentSince => new Promise((resolve, reject) => fetches.push({ recentSince, resolve, reject })),
    update: merge => { harness.history = merge(harness.history); },
    onError: error => errors.push(error),
    online,
    page,
    now: () => harness.clock,
  });
  return harness;
}
/** Lets the loads' promise callbacks run. */
const settle = () => new Promise(resolve => setImmediate(resolve));

test('the history loads at once, and a successful load marks it loaded', async () => {
  const loads = startLoads();
  assert.equal(loads.fetches.length, 1);
  assert.equal(loads.fetches[0].recentSince, NOW - RECENT_DAYS * DAY);
  loads.fetches[0].resolve(history([review('a', NOW - DAY)], [NOW - 20 * DAY], 5));
  await settle();
  assert.equal(loads.history.loaded, true);
  assert.deepEqual(ids(loads.history), ['a']);
  assert.equal(loads.history.olderCount, 5);
});

test('after a failed load, coming back online or into view loads again; a fresh one waits a quarter of an hour', async () => {
  const loads = startLoads();
  loads.fetches[0].reject(new Error('offline'));
  await settle();
  assert.equal(loads.history.loaded, false);
  assert.equal(loads.errors.length, 1);

  loads.online.dispatchEvent(new Event('online'));
  assert.equal(loads.fetches.length, 2, 'the offline start recovers');
  loads.fetches[1].resolve(history([]));
  await settle();
  assert.equal(loads.history.loaded, true);

  loads.online.dispatchEvent(new Event('online'));
  loads.page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(loads.fetches.length, 2, 'just loaded');

  loads.clock += HISTORY_RELOAD_AFTER_MS + 1;
  loads.page.visibilityState = 'hidden';
  loads.page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(loads.fetches.length, 2, 'hiding the page loads nothing');
  loads.page.visibilityState = 'visible';
  loads.page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(loads.fetches.length, 3, 'shown again after a quarter of an hour, so other devices\' reviews arrive');
});

test('only the latest load counts, and nothing changes the history once stopped', async () => {
  const loads = startLoads();
  loads.fetches[0].reject(new Error('offline'));
  await settle();
  loads.online.dispatchEvent(new Event('online'));
  loads.page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(loads.fetches.length, 3, 'neither load has finished, so each event loads again');
  loads.fetches[2].resolve(history([review('latest', NOW - HOUR)]));
  loads.fetches[1].resolve(history([review('overtaken', NOW - HOUR)]));
  await settle();
  assert.deepEqual(ids(loads.history), ['latest']);

  loads.stop();
  loads.clock += HISTORY_RELOAD_AFTER_MS + 1;
  loads.online.dispatchEvent(new Event('online'));
  assert.equal(loads.fetches.length, 3, 'stopped: the listeners are gone');

  const stopped = startLoads();
  stopped.stop();
  stopped.fetches[0].resolve(history([review('late', NOW - HOUR)]));
  await settle();
  assert.equal(stopped.history.loaded, false, 'a load for a user who signed out changes nothing');
});

test('a load keeps the reviews in the outbox when it began, and reaches back to the oldest of them', async () => {
  const queued = review('queued', NOW - 10 * DAY, 'hard');
  const loads = startLoads({ recent: [queued], olderTimes: [], olderCount: 0, loaded: false });
  // The outbox read when the first load began was empty; this one sees the queued review.
  loads.pending = [queued];
  loads.fetches[0].reject(new Error('offline'));
  await settle();
  loads.online.dispatchEvent(new Event('online'));
  assert.equal(loads.fetches[1].recentSince, NOW - 10 * DAY);
  loads.pending = [];
  loads.fetches[1].resolve(history([review('server', NOW - DAY)]));
  await settle();
  assert.deepEqual(ids(loads.history), ['queued', 'server']);
});
