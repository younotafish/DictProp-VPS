import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueueItem } from '../../components/search/searchQueue.ts';
import {
  clampMeaning, meaningAfterRefresh, neighbourAfterDismiss, resolveViewing, stepMeaning,
} from '../../components/search/searchViewing.ts';

test('stepping forward through the meanings comes round to the first after the last', () => {
  assert.deepEqual([0, 1, 2].map(index => stepMeaning(index, 3, 1, true)), [1, 2, 0]);
  // The forward step always wraps: the swipe and the Next arrow both come round.
  assert.deepEqual([0, 1, 2].map(index => stepMeaning(index, 3, 1, false)), [1, 2, 0]);
});

test('stepping back wraps from the first meaning only when asked', () => {
  assert.deepEqual([0, 1, 2].map(index => stepMeaning(index, 3, -1, true)), [2, 0, 1]);
  assert.deepEqual([0, 1, 2].map(index => stepMeaning(index, 3, -1, false)), [null, 0, 1]);
});

test('a result with one meaning or none has nowhere to step', () => {
  for (const count of [0, 1]) {
    for (const delta of [1, -1] as const) {
      assert.equal(stepMeaning(0, count, delta, true), null);
      assert.equal(stepMeaning(0, count, delta, false), null);
    }
  }
});

test('stepping from an index past the end keeps the arithmetic, which is why the sheet clamps first', () => {
  // GlobalSearch reads the meaning through clampMeaning, so the keys never step from a stale index like this one.
  assert.equal(stepMeaning(5, 3, -1, true), 4);
  assert.equal(stepMeaning(5, 3, 1, true), 0);
  assert.equal(stepMeaning(clampMeaning(5, 3), 3, -1, true), 1);
});

const item = (id: string, status: QueueItem['status']): QueueItem => ({ id, kind: 'lookup', query: id, status, results: null });
const readyOf = (queue: QueueItem[]) => queue.filter(entry => entry.status === 'ready');

test('an earlier lookup finishing moves the open result along without swapping it for another', () => {
  const before = [item('a', 'searching'), item('b', 'ready')];
  assert.deepEqual(resolveViewing(readyOf(before), 'b'), { index: 0, item: before[1] });
  const after = [item('a', 'ready'), before[1]];
  // By position, the sheet would now show 'a'; by id it still shows 'b', one place along.
  assert.equal(readyOf(after)[0].id, 'a');
  assert.deepEqual(resolveViewing(readyOf(after), 'b'), { index: 1, item: before[1] });
});

test('a result that is no longer ready, or no result at all, resolves to nothing', () => {
  const ready = [item('a', 'ready'), item('c', 'ready')];
  assert.equal(resolveViewing(ready, 'b'), null, 'replaced by a refresh of the same word');
  assert.equal(resolveViewing(ready, null), null);
  assert.equal(resolveViewing([], 'a'), null);
});

test('a ready lookup that came back without a card still resolves, so the sheet opens on it', () => {
  const empty: QueueItem = {
    ...item('a', 'ready'),
    results: { id: 'r', query: 'a', translation: '', grammar: '', visualKeyword: '', pronunciation: '', vocabs: [], timestamp: 1 },
  };
  assert.deepEqual(resolveViewing([empty], 'a'), { index: 0, item: empty });
  assert.equal(clampMeaning(0, 0), 0);
});

test('dismissing the open result shows the next ready one, or the previous one after the last', () => {
  const ready = readyOf([item('a', 'ready'), item('b', 'searching'), item('c', 'ready'), item('d', 'ready')]);
  assert.equal(neighbourAfterDismiss(ready, 'a'), 'c');
  assert.equal(neighbourAfterDismiss(ready, 'c'), 'd');
  assert.equal(neighbourAfterDismiss(ready, 'd'), 'c');
});

test('dismissing the last ready result closes the sheet', () => {
  assert.equal(neighbourAfterDismiss(readyOf([item('a', 'ready'), item('b', 'pending'), item('c', 'failed')]), 'a'), null);
  assert.equal(neighbourAfterDismiss([], 'a'), null);
});

test('another entry leaving the queue leaves the open result where it is', () => {
  const queue = [item('a', 'ready'), item('b', 'searching'), item('c', 'ready'), item('d', 'ready')];
  const open = resolveViewing(readyOf(queue), 'd');
  assert.deepEqual(resolveViewing(readyOf(queue.filter(entry => entry.id !== 'b')), 'd'), open);
  assert.deepEqual(resolveViewing(readyOf(queue.filter(entry => entry.id !== 'a')), 'd'), { index: 1, item: queue[3] });
});

test('a meaning past the end of the open result reads as its last meaning', () => {
  assert.equal(clampMeaning(5, 3), 2);
  assert.equal(clampMeaning(1, 3), 1);
  assert.equal(clampMeaning(0, 1), 0);
  assert.equal(clampMeaning(3, 0), 0, 'a result without meanings');
});

test('a refreshed result opens at its first meaning, and another open result keeps the meaning it shows', () => {
  assert.equal(meaningAfterRefresh('q-1', 'q-1', 3), 0);
  assert.equal(meaningAfterRefresh('q-2', 'q-1', 3), 3, 'the user moved to another result while the refresh ran');
  assert.equal(meaningAfterRefresh(undefined, 'q-1', 2), 2, 'the sheet is closed');
});

