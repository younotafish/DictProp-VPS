import assert from 'node:assert/strict';
import test from 'node:test';
import { cameOnline, nextRetryAt, NO_TROUBLE, pushFailed, pushSucceeded, retryDue } from '../../services/syncRetry.ts';

// services/syncRetry.ts: when a failed push is tried again.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

test('a failed push is tried again after 8 s, then 16 s, 32 s and on, doubling up to 5 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 30].map(failures => nextRetryAt(failures, 0)), [
    8 * SECOND, 16 * SECOND, 32 * SECOND, 64 * SECOND, 128 * SECOND, 256 * SECOND, 5 * MINUTE, 5 * MINUTE, 5 * MINUTE,
  ]);
  assert.equal(nextRetryAt(2, 1_000_000), 1_000_000 + 16 * SECOND, 'counted from the last failure');
  assert.equal(nextRetryAt(5_000, 0), 5 * MINUTE, 'a count far past the cap stays at it');
});

test('each failure adds one, keeps when the first failed, and puts the next try further off; a success ends it all', () => {
  const once = pushFailed(NO_TROUBLE, 100_000);
  assert.deepEqual(once, { failures: 1, firstFailureAt: 100_000, nextRetryAt: 108_000 });
  const twice = pushFailed(once, 110_000);
  assert.deepEqual(twice, { failures: 2, firstFailureAt: 100_000, nextRetryAt: 126_000 });
  assert.equal(retryDue(twice, 125_999), false);
  assert.equal(retryDue(twice, 126_000), true);
  assert.equal(pushSucceeded(), NO_TROUBLE, 'the same object, so a success after a success changes nothing');
  assert.equal(retryDue(NO_TROUBLE, Number.MAX_SAFE_INTEGER), false, 'nothing is due without a failure');
});

test('coming back online after failures starts the count over with a try due at once; with none it changes nothing', () => {
  const failing = pushFailed(pushFailed(pushFailed(NO_TROUBLE, 0), 8 * SECOND), 24 * SECOND);
  const back = cameOnline(failing, 30 * SECOND);
  assert.deepEqual(back, { failures: 0, firstFailureAt: null, nextRetryAt: 30 * SECOND });
  assert.equal(retryDue(back, 30 * SECOND), true);
  assert.equal(cameOnline(NO_TROUBLE, 30 * SECOND), NO_TROUBLE);
  assert.deepEqual(pushFailed(back, 31 * SECOND), { failures: 1, firstFailureAt: 31 * SECOND, nextRetryAt: 39 * SECOND });
});
