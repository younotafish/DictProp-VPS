import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewRating, ReviewTaskType } from '../src/shared/review.js';

// GET /api/reviews/set-days: Today's streak counts the distinct sentences Got it'd in its units on each local day (a
// 'quick' review in a 'set:' session), whatever reviews each had before, and the sentences decided in its sets before
// units replaced them (a 'triage' review in a 'set:' session).

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { applyReviewEvent, db, getSetDays, upsertItem } = await import('../src/db.js');
const { DEV_AUTH_USER } = await import('../src/middleware/auth.js');
const { reviewStmts } = await import('../src/db/reviews.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 23:30 UTC ten days ago: the next day an hour east of UTC, the same day ten hours west.
const LATE_EVENING = Math.floor(Date.now() / DAY) * DAY - 10 * DAY + 23.5 * HOUR;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let eventCount = 0;
/** A review event stored as the review route would have stored it; a unit's Got it on a new sentence unless told otherwise. */
function storeEvent(userId: string, itemId: string, reviewedAt: number, fields: Record<string, unknown> = {}) {
  const row = {
    id: `set-day-${++eventCount}`, user_id: userId, item_id: itemId, item_type: 'sentence', reviewed_at: reviewedAt,
    previous_step: 0, next_step: 1, rating: 'good', task_type: 'quick', duration_ms: null, session_id: 'set:u1',
    ...fields,
  };
  reviewStmts.insert.run(row);
  return row.id;
}

/** A sentence's choice in one of the sets Today had before units: Practice, as the meeting recorded it. */
const SET_CHOICE = { task_type: 'triage', rating: 'again', session_id: 'set:s1' };

/** Saves one of the user's own sentences with a schedule of `totalReviews` reviews, the last long ago. */
function saveSentence(userId: string, id: string, totalReviews: number) {
  upsertItem({
    type: 'sentence',
    data: { id, text: `Say ${id} in a unit.`, sourceWord: 'unit' },
    srs: {
      id, type: 'sentence', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: totalReviews > 0 ? 5 : 0,
      totalReviews, correctStreak: 0, stability: 0,
    },
    savedAt: 1,
  }, userId);
}

test("sentences Got it'd in a unit count once per local day, under the offset asked for", async () => {
  const user = 'set-days-buckets';
  storeEvent(user, 'a', LATE_EVENING);
  storeEvent(user, 'b', LATE_EVENING + 10 * 60_000);
  storeEvent(user, 'c', LATE_EVENING - 5 * DAY);
  // Got it'd twice the same day (a reset in between made it one to review again): still one sentence.
  storeEvent(user, 'a', LATE_EVENING + 20 * 60_000);
  // Decided in a set and Got it'd in a unit the same day: one sentence too.
  storeEvent(user, 'b', LATE_EVENING + 25 * 60_000, SET_CHOICE);

  assert.deepEqual(getSetDays(user, 0), { [utcDay(LATE_EVENING)]: 2, [utcDay(LATE_EVENING - 5 * DAY)]: 1 });
  assert.deepEqual(getSetDays(user, 60), { [utcDay(LATE_EVENING + DAY)]: 2, [utcDay(LATE_EVENING - 4 * DAY)]: 1 });
  assert.deepEqual(getSetDays(user, -600), { [utcDay(LATE_EVENING)]: 2, [utcDay(LATE_EVENING - 5 * DAY)]: 1 });
});

test("a unit's Got it counts whatever reviews came before, and so does a set's choice; an undone one, a word's, another task's or session's, another user's or an older one doesn't", () => {
  const user = 'set-days-filter';
  storeEvent(user, 'new', LATE_EVENING);
  // Due again: a unit takes it as it takes a sentence never reviewed.
  storeEvent(user, 'due-again', LATE_EVENING, { previous_step: 3, next_step: 4 });
  storeEvent(user, 'met-in-a-set', LATE_EVENING, SET_CHOICE);
  const undone = storeEvent(user, 'undone', LATE_EVENING);
  db.prepare('UPDATE review_events SET undone_at = ? WHERE id = ?').run(LATE_EVENING + HOUR, undone);
  // The Sentences tab's Got it carries no session.
  storeEvent(user, 'sentences-tab', LATE_EVENING, { session_id: null });
  storeEvent(user, 'other-session', LATE_EVENING, { session_id: 'study:s2' });
  // A practice attempt in a set's round, and the practice pill's choice, which carried no session.
  storeEvent(user, 'spoken', LATE_EVENING, { task_type: 'speak', session_id: 'set:s1' });
  storeEvent(user, 'practice-pill', LATE_EVENING, { ...SET_CHOICE, session_id: null });
  // Words: one decided in a set while Today still took words, and one Got it'd with a unit's session.
  storeEvent(user, 'a-word', LATE_EVENING, { ...SET_CHOICE, item_type: 'vocab' });
  storeEvent(user, 'a-word-got-it', LATE_EVENING, { item_type: 'vocab' });
  storeEvent('someone-else', 'theirs', LATE_EVENING);
  storeEvent(user, 'long-ago', Date.now() - 401 * DAY);
  storeEvent(user, 'just-in-reach', Date.now() - 399 * DAY);
  assert.deepEqual(getSetDays(user, 0), { [utcDay(LATE_EVENING)]: 3, [utcDay(Date.now() - 399 * DAY)]: 1 });
});

test("a unit's Got it applied through the review apply counts, whatever reviews came before; the Sentences tab's Got it and the practice pill's choice don't", () => {
  const user = 'set-days-applied';
  saveSentence(user, 'set-days-due', 2);
  saveSentence(user, 'set-days-tab', 2);
  saveSentence(user, 'set-days-pill', 3);
  const review = (itemId: string, taskType: ReviewTaskType, rating: ReviewRating, sessionId?: string) => applyReviewEvent({
    id: `${itemId}-review`, itemId, itemType: 'sentence', reviewedAt: LATE_EVENING, previousStep: 0, nextStep: 1,
    rating, taskType, ...(sessionId ? { sessionId } : {}),
  }, [itemId], user);

  assert.equal(review('set-days-due', 'quick', 'good', 'set:unit')?.event.previousStep, 2, 'the server records the reviews before');
  assert.equal(review('set-days-tab', 'quick', 'good')?.applied, true);
  assert.equal(review('set-days-pill', 'triage', 'again')?.applied, true);
  assert.deepEqual(getSetDays(user, 0), { [utcDay(LATE_EVENING)]: 1 });
});

test('the route answers with the set days of the signed-in owner, never cached, and reads any offset it cannot use as UTC', async () => {
  const id = 'set-days-route';
  saveSentence(DEV_AUTH_USER.id, id, 0);
  const met = applyReviewEvent({
    id: 'set-days-route-review', itemId: id, itemType: 'sentence', reviewedAt: LATE_EVENING, previousStep: 0, nextStep: 1,
    rating: 'good', taskType: 'quick', sessionId: 'set:route',
  }, [id], DEV_AUTH_USER.id);
  assert.equal(met?.applied, true);

  const days = async (query: string) => {
    const response = await app.request(`/api/reviews/set-days${query}`);
    assert.equal(response.status, 200, query);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return (await response.json() as { days: Record<string, number> }).days;
  };
  assert.deepEqual(await days('?tzOffset=60'), { [utcDay(LATE_EVENING + DAY)]: 1 });
  for (const query of ['', '?tzOffset=', '?tzOffset=abc', '?tzOffset=1.5', '?tzOffset=900', '?tzOffset=-841', '?tzOffset=0']) {
    assert.deepEqual(await days(query), { [utcDay(LATE_EVENING)]: 1 }, query);
  }
  assert.deepEqual(await days('?tzOffset=-720'), { [utcDay(LATE_EVENING)]: 1 });
  assert.deepEqual(await days('?tzOffset=840'), { [utcDay(LATE_EVENING + DAY)]: 1 });
});
