import assert from 'node:assert/strict';
import test from 'node:test';
import type { QueueItem } from '../../components/search/searchQueue.ts';
import { meaningAfterRefresh, stepMeaning, viewingIndexAfterDismiss } from '../../components/search/searchViewing.ts';

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

test('a meaning index past the end steps as the arrow keys always have', () => {
  // The open result can lose meanings under a stale index; the keys keep their arithmetic rather than clamp.
  assert.equal(stepMeaning(5, 3, -1, true), 4);
  assert.equal(stepMeaning(5, 3, 1, true), 0);
});

const item = (id: string, status: QueueItem['status']): QueueItem => ({ id, kind: 'lookup', query: id, status, results: null });

test('dismissing a result keeps the open position, or the last ready result when the position is gone', () => {
  const queue = [item('a', 'ready'), item('b', 'searching'), item('c', 'ready'), item('d', 'ready')];
  assert.equal(viewingIndexAfterDismiss(queue, 'a', 0), 0);
  assert.equal(viewingIndexAfterDismiss(queue, 'c', 1), 1);
  assert.equal(viewingIndexAfterDismiss(queue, 'd', 2), 1);
  // A result still running doesn't count among the ready ones.
  assert.equal(viewingIndexAfterDismiss(queue, 'b', 2), 2);
});

test('dismissing the last ready result closes the sheet', () => {
  assert.equal(viewingIndexAfterDismiss([item('a', 'ready'), item('b', 'pending'), item('c', 'failed')], 'a', 0), null);
  assert.equal(viewingIndexAfterDismiss([], 'a', 0), null);
});

test('a refreshed result opens at its first meaning, and another open result keeps the meaning it shows', () => {
  assert.equal(meaningAfterRefresh('q-1', 'q-1', 3), 0);
  assert.equal(meaningAfterRefresh('q-2', 'q-1', 3), 3, 'the user moved to another result while the refresh ran');
  assert.equal(meaningAfterRefresh(undefined, 'q-1', 2), 2, 'the sheet is closed');
});

