import assert from 'node:assert/strict';
import test from 'node:test';

// GET /api/reviews/set-days: Today's streak counts the distinct items first met in a set on each local day.

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
/** A review event stored as the review route would have stored it; a set's meeting of a new item unless told otherwise. */
function storeEvent(userId: string, itemId: string, reviewedAt: number, fields: Record<string, unknown> = {}) {
  const row = {
    id: `set-day-${++eventCount}`, user_id: userId, item_id: itemId, item_type: 'vocab', reviewed_at: reviewedAt,
    previous_step: 0, next_step: 1, rating: 'again', task_type: 'triage', duration_ms: null, session_id: 'set:s1',
    ...fields,
  };
  reviewStmts.insert.run(row);
  return row.id;
}

test('items first met in a set count once per local day, under the offset asked for', async () => {
  const user = 'set-days-buckets';
  storeEvent(user, 'a', LATE_EVENING);
  storeEvent(user, 'b', LATE_EVENING + 10 * 60_000);
  storeEvent(user, 'c', LATE_EVENING - 5 * DAY);
  // Met twice the same day (a reset in between gave it no reviews again): still one item.
  storeEvent(user, 'a', LATE_EVENING + 20 * 60_000);

  assert.deepEqual(getSetDays(user, 0), { [utcDay(LATE_EVENING)]: 2, [utcDay(LATE_EVENING - 5 * DAY)]: 1 });
  assert.deepEqual(getSetDays(user, 60), { [utcDay(LATE_EVENING + DAY)]: 2, [utcDay(LATE_EVENING - 4 * DAY)]: 1 });
  assert.deepEqual(getSetDays(user, -600), { [utcDay(LATE_EVENING)]: 2, [utcDay(LATE_EVENING - 5 * DAY)]: 1 });
});

test('only a set meeting of a new item counts: not undone, not reviewed before, not elsewhere, not another user, not older', () => {
  const user = 'set-days-filter';
  storeEvent(user, 'counted', LATE_EVENING);
  const undone = storeEvent(user, 'undone', LATE_EVENING);
  db.prepare('UPDATE review_events SET undone_at = ? WHERE id = ?').run(LATE_EVENING + HOUR, undone);
  storeEvent(user, 'seen-before', LATE_EVENING, { previous_step: 1, next_step: 2 });
  storeEvent(user, 'practice-toggle', LATE_EVENING, { session_id: null });
  storeEvent(user, 'other-session', LATE_EVENING, { session_id: 'study:s2' });
  storeEvent(user, 'spoken', LATE_EVENING, { task_type: 'speak', rating: 'good' });
  storeEvent(user, 'got-it', LATE_EVENING, { task_type: 'quick', rating: 'good' });
  storeEvent('someone-else', 'theirs', LATE_EVENING);
  storeEvent(user, 'long-ago', Date.now() - 401 * DAY);
  storeEvent(user, 'just-in-reach', Date.now() - 399 * DAY);
  assert.deepEqual(getSetDays(user, 0), { [utcDay(LATE_EVENING)]: 1, [utcDay(Date.now() - 399 * DAY)]: 1 });
});

test('the route answers with the set days of the signed-in owner, never cached, and reads any offset it cannot use as UTC', async () => {
  const id = 'set-days-route';
  upsertItem({
    type: 'vocab',
    data: { id, word: id },
    srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0 },
    savedAt: 1,
  }, DEV_AUTH_USER.id);
  const met = applyReviewEvent({
    id: 'set-days-route-review', itemId: id, itemType: 'vocab', reviewedAt: LATE_EVENING, previousStep: 0, nextStep: 1,
    rating: 'easy', taskType: 'triage', sessionId: 'set:route',
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
