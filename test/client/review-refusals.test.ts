import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../../services/http.ts';
import {
  clearRefusedReviews,
  describeRefusedReview,
  dismissRefusedReviews,
  readRefusedReviews,
  recordRefusedReview,
  subscribeRefusedReviews,
  unseenRefusedReviews,
} from '../../services/refusedReviews.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

const refusal = (n: number) => ({ itemId: `item-${n}`, word: `word ${n}`, reviewedAt: 1_000 + n, reason: 'The card isn’t on the server' });

test('refused reviews are kept per account, newest fifty, with long text clipped', () => {
  const storage = new MemoryStorage();
  assert.equal(recordRefusedReview('user', { ...refusal(0), word: 'w'.repeat(500), reason: 'r'.repeat(500) }, storage, 5), true);
  const [first] = readRefusedReviews('user', storage).entries;
  assert.equal(first.word.length, 120);
  assert.equal(first.reason.length, 200);
  assert.equal(first.recordedAt, 5);
  assert.equal(readRefusedReviews('someone else', storage).entries.length, 0);

  for (let n = 1; n <= 60; n++) recordRefusedReview('user', refusal(n), storage, 10 + n);
  const { entries } = readRefusedReviews('user', storage);
  assert.equal(entries.length, 50);
  assert.equal(entries[0].itemId, 'item-11');
  assert.equal(entries[49].itemId, 'item-60');
  assert.ok(!storage.getItem('review_refusals_user')!.includes('srs'), 'no item bodies');

  // A blank title falls back to the item id.
  recordRefusedReview('user', { ...refusal(61), word: '  ' }, storage, 100);
  assert.equal(readRefusedReviews('user', storage).entries.at(-1)!.word, 'item-61');
});

test('dismissing hides the notice until the next refusal, and Clear all empties the list', () => {
  const storage = new MemoryStorage();
  recordRefusedReview('user', refusal(1), storage, 10);
  recordRefusedReview('user', refusal(2), storage, 20);
  assert.equal(unseenRefusedReviews(readRefusedReviews('user', storage)), 2);

  dismissRefusedReviews('user', storage, 30);
  assert.equal(unseenRefusedReviews(readRefusedReviews('user', storage)), 0);
  assert.equal(readRefusedReviews('user', storage).entries.length, 2, 'the list keeps them');

  recordRefusedReview('user', refusal(3), storage, 40);
  assert.equal(unseenRefusedReviews(readRefusedReviews('user', storage)), 1);

  clearRefusedReviews('user', storage);
  assert.equal(storage.getItem('review_refusals_user'), null);
  assert.deepEqual(readRefusedReviews('user', storage), { entries: [], dismissedAt: 0 });
});

test('a damaged or unwritable log reads as empty and reports the failed write', () => {
  const storage = new MemoryStorage();
  storage.setItem('review_refusals_user', '{not json');
  assert.deepEqual(readRefusedReviews('user', storage).entries, []);
  storage.setItem('review_refusals_user', JSON.stringify({ entries: [refusal(1), { ...refusal(2), recordedAt: 2 }, null], dismissedAt: 'x' }));
  assert.deepEqual(readRefusedReviews('user', storage), { entries: [{ ...refusal(2), recordedAt: 2 }], dismissedAt: 0 });

  const full = new MemoryStorage();
  full.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(recordRefusedReview('user', refusal(1), full), false);
  assert.equal(recordRefusedReview('user', refusal(1), null), false);
});

test('a refusal is described in words, with what the server said', () => {
  assert.equal(describeRefusedReview(new HttpError('Apply review failed (404): Item not found', 404, 'Item not found')), 'The card isn’t on the server: Item not found');
  assert.equal(describeRefusedReview(new HttpError('Apply review failed (409)', 409, '')), 'It clashed with a newer change');
  assert.equal(describeRefusedReview(new HttpError('Apply review failed (418)', 418, '')), 'Refused (418)');
  assert.equal(describeRefusedReview(new Error('boom')), 'boom');
});

test('the refusal log tells its listeners about changes here and in other tabs', () => {
  const tabs = new EventTarget();
  const globals = globalThis as unknown as { window?: EventTarget };
  const realWindow = globals.window;
  globals.window = tabs;
  try {
    let calls = 0;
    const unsubscribe = subscribeRefusedReviews(() => { calls++; });
    recordRefusedReview('user', refusal(1), new MemoryStorage());
    assert.equal(calls, 1, 'a change in this tab');
    const otherTab = (key: string | null) => tabs.dispatchEvent(Object.assign(new Event('storage'), { key }));
    otherTab('review_refusals_user');
    otherTab(null);
    otherTab('review_mutations_pending_user:event');
    assert.equal(calls, 3, 'a change to the log in another tab, or storage cleared there, but not the outbox');
    unsubscribe();
    otherTab('review_refusals_user');
    assert.equal(calls, 3);
  } finally {
    globals.window = realWindow;
  }
});
