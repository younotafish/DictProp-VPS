import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSrs } from '../src/db/item-write.js';

// Today's practice membership on the server: applied inside a review's own transaction, at the time the server
// stamps the review with, and carried whole by everything that stores a schedule.

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { applyReviewEvent, getItemById, undoReviewEvent, upsertItem } = await import('../src/db.js');
const { DEV_AUTH_USER } = await import('../src/middleware/auth.js');
const app = createApp({ logging: false, serveStaticFiles: false });
const USER = DEV_AUTH_USER.id;
const MINUTE = 60_000;

const vocabItem = (id: string, srs: Record<string, unknown> = {}) => ({
  type: 'vocab',
  data: {
    id, word: id, chinese: '', ipa: '', definition: `definition ${id}`,
    synonyms: [], antonyms: [], confusables: [], examples: [], history: '', register: '', mnemonic: '',
  },
  srs: {
    id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0,
    lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5, ...srs,
  },
  savedAt: 1,
  updatedAt: 1,
});

let eventCount = 0;
const review = (itemId: string, fields: Record<string, unknown>) => ({
  id: `practice-review-${++eventCount}`, itemId, itemType: 'vocab' as const, previousStep: 0, nextStep: 1,
  reviewedAt: Date.now(), ...fields,
});
const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const storedSrs = (id: string) => getItemById(id, USER, false)!.srs;
const membership = (srs: Record<string, unknown>) =>
  Object.fromEntries(['practiceSince', 'sayableAt', 'practiceChangedAt'].filter(key => key in srs).map(key => [key, srs[key]]));

test('a triage joins practice at the time the server stamps the review with, not the device clock', async () => {
  upsertItem(vocabItem('joins'), USER);
  // A device whose clock runs an hour fast: the server stamps no later than five minutes past its own time.
  const before = Date.now();
  const response = await post('/api/reviews/apply', {
    event: review('joins', { rating: 'again', taskType: 'triage', sessionId: 'set:s1', reviewedAt: before + 60 * MINUTE }),
    itemIds: ['joins'],
  });
  assert.equal(response.status, 201);
  const reply = await response.json() as { event: { reviewedAt: number }; items: Array<{ srs: Record<string, unknown> }> };
  const stamped = reply.event.reviewedAt;
  assert.ok(stamped >= before + 5 * MINUTE && stamped <= Date.now() + 5 * MINUTE, `${stamped}`);
  assert.deepEqual(membership(reply.items[0].srs), { practiceSince: stamped, practiceChangedAt: stamped });
  assert.deepEqual(membership(storedSrs('joins')), { practiceSince: stamped, practiceChangedAt: stamped });
});

test('a triage a device made before the last change of membership schedules but leaves membership alone', () => {
  upsertItem(vocabItem('late-triage'), USER);
  const now = Date.now();
  // Marked "can say it" now on one device; a device that was offline then sends "practice", made ten minutes ago.
  applyReviewEvent(review('late-triage', { rating: 'easy', taskType: 'triage', reviewedAt: now }), ['late-triage'], USER);
  const sayable = storedSrs('late-triage');
  assert.deepEqual(membership(sayable), { sayableAt: now, practiceChangedAt: now });
  const late = applyReviewEvent(
    review('late-triage', { rating: 'again', taskType: 'triage', reviewedAt: now - 10 * MINUTE, previousStep: 1, nextStep: 2 }),
    ['late-triage'],
    USER,
  );
  assert.equal(late?.applied, true);
  // Stamped at the last review, as any late review is, and counted.
  assert.equal(late?.event.reviewedAt, now);
  const after = storedSrs('late-triage');
  assert.equal(after.totalReviews, 2);
  assert.deepEqual(membership(after), membership(sayable));
});

test('undoing a review restores the schedule before it, membership and all', () => {
  upsertItem(vocabItem('undo-membership'), USER);
  const joined = applyReviewEvent(review('undo-membership', { rating: 'again', taskType: 'triage' }), ['undo-membership'], USER)!;
  const joinedSrs = storedSrs('undo-membership');
  assert.ok(joinedSrs.practiceSince !== undefined);
  const marked = applyReviewEvent(
    review('undo-membership', { rating: 'easy', taskType: 'triage', reviewedAt: Date.now() + 1, previousStep: 1, nextStep: 2 }),
    ['undo-membership'],
    USER,
  )!;
  assert.deepEqual(Object.keys(membership(storedSrs('undo-membership'))).sort(), ['practiceChangedAt', 'sayableAt']);

  assert.equal(undoReviewEvent(marked.event.id, USER)?.undone, true);
  assert.deepEqual(storedSrs('undo-membership'), joinedSrs);
  assert.equal(undoReviewEvent(joined.event.id, USER)?.undone, true);
  assert.deepEqual(membership(storedSrs('undo-membership')), {});
});

test('a review pairing a task type of Today with a rating it does not take is refused, and nothing is stored', async () => {
  upsertItem(vocabItem('refused-pair'), USER);
  for (const fields of [
    { taskType: 'triage', rating: 'hard' }, { taskType: 'speak', rating: 'easy' }, { taskType: 'recall', rating: 'easy' },
    { taskType: 'triage' },
  ]) {
    const response = await post('/api/reviews/apply', { event: review('refused-pair', fields), itemIds: ['refused-pair'] });
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.deepEqual(await response.json(), { error: 'Invalid review mutation' });
  }
  assert.equal(storedSrs('refused-pair').totalReviews, 0);
});

test('a pushed schedule keeps its membership whole, and one whose membership is malformed is refused', async () => {
  const put = (items: unknown[]) => app.request('/api/items', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(items),
  });
  const practicing = { lastReviewDate: 2_000, totalReviews: 1, practiceSince: 2_000, practiceChangedAt: 2_000 };
  let response = await put([vocabItem('pushed-membership', practicing)]);
  assert.equal(response.status, 200);
  assert.deepEqual(membership(storedSrs('pushed-membership')), { practiceSince: 2_000, practiceChangedAt: 2_000 });

  response = await put([vocabItem('pushed-membership', { ...practicing, lastReviewDate: 3_000, practiceSince: null })]);
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /practice membership is invalid/);
  assert.deepEqual(membership(storedSrs('pushed-membership')), { practiceSince: 2_000, practiceChangedAt: 2_000 });
});

test('the schedule with newer progress wins whole, so membership travels with it and never mixes', () => {
  const practicing = { lastReviewDate: 10, totalReviews: 2, practiceSince: 5, practiceChangedAt: 5 };
  const sayable = { lastReviewDate: 20, totalReviews: 3, sayableAt: 20, practiceChangedAt: 20 };
  assert.deepEqual(resolveSrs(practicing, sayable), { srs: sayable, changed: true });
  assert.deepEqual(resolveSrs(sayable, practicing), { srs: sayable, changed: false });
  // A reset carries none, and a newer one wins.
  const reset = { lastReviewDate: 30, totalReviews: 0 };
  assert.deepEqual(resolveSrs(sayable, reset), { srs: reset, changed: true });
});
