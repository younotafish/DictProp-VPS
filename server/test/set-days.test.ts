import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewRating, ReviewTaskType, SetDaysResponse } from '../src/shared/review.js';

// GET /api/reviews/set-days: Today's streak counts the distinct sentences Got it'd in its units on each local day (a
// 'quick' review in a 'set:' session), whatever reviews each had before, and the sentences decided in its sets before
// units replaced them (a 'triage' review in a 'set:' session). A day is a calendar day in the device's time zone when
// it names one, and otherwise a date under its offset from UTC.

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
  // A zone that keeps one offset all year counts that offset's days, whatever offset the request also gives. (Etc/GMT-1
  // is an hour east of UTC: those names take POSIX's sign.)
  assert.deepEqual(getSetDays(user, 60, Date.now(), 'UTC'), getSetDays(user, 0));
  assert.deepEqual(getSetDays(user, 0, Date.now(), 'Etc/GMT-1'), getSetDays(user, 60));
  assert.deepEqual(getSetDays(user, 0, Date.now(), 'Pacific/Honolulu'), getSetDays(user, -600));
});

test('with a time zone, a day is a calendar day there: in Los Angeles, the night the clocks fall back counts as one day', () => {
  const user = 'set-days-fall-back';
  // Sunday 1 November 2026: 00:30 PDT, before the clocks go back an hour at 02:00, and 23:30 PST that night.
  storeEvent(user, 'after-midnight', Date.parse('2026-11-01T07:30:00Z'));
  storeEvent(user, 'before-midnight', Date.parse('2026-11-02T07:30:00Z'));
  // The last moment of that Sunday and the first of Monday, either side of 08:00 UTC.
  storeEvent(user, 'last-moment', Date.parse('2026-11-02T07:59:59.999Z'));
  storeEvent(user, 'first-moment', Date.parse('2026-11-02T08:00:00.000Z'));
  const now = Date.parse('2026-11-02T20:00:00Z');

  assert.deepEqual(getSetDays(user, -480, now, 'America/Los_Angeles'), { '2026-11-01': 3, '2026-11-02': 1 });
  // Neither of the day's two offsets alone gets it right: the one after the change moves the hour after midnight to
  // the day before, and the one before it moves the evening to the day after.
  assert.deepEqual(getSetDays(user, -480, now), { '2026-10-31': 1, '2026-11-01': 2, '2026-11-02': 1 });
  assert.deepEqual(getSetDays(user, -420, now), { '2026-11-01': 1, '2026-11-02': 3 });
});

test('with a time zone, the evening before the clocks spring forward stays on its own day', () => {
  const user = 'set-days-spring-forward';
  // Saturday 13 March 2027 at 23:30 PST; the clocks go forward at 02:00 on the Sunday.
  storeEvent(user, 'saturday-night', Date.parse('2027-03-14T07:30:00Z'));
  // Sunday at 23:30 PDT.
  storeEvent(user, 'sunday-night', Date.parse('2027-03-15T06:30:00Z'));
  const now = Date.parse('2027-03-15T20:00:00Z');

  assert.deepEqual(getSetDays(user, -420, now, 'America/Los_Angeles'), { '2027-03-13': 1, '2027-03-14': 1 });
  // The offset after the change puts Saturday's evening on the Sunday.
  assert.deepEqual(getSetDays(user, -420, now), { '2027-03-14': 2 });
});

test('with a time zone 5:45 ahead of UTC, the day turns at 18:15 UTC', () => {
  const user = 'set-days-kathmandu';
  storeEvent(user, 'late', Date.parse('2026-11-10T18:14:59.999Z'));
  storeEvent(user, 'early', Date.parse('2026-11-10T18:15:00.000Z'));
  storeEvent(user, 'early-too', Date.parse('2026-11-10T18:29:59.999Z'));
  const now = Date.parse('2026-11-11T12:00:00Z');

  assert.deepEqual(getSetDays(user, 345, now, 'Asia/Kathmandu'), { '2026-11-10': 1, '2026-11-11': 2 });
  assert.deepEqual(getSetDays(user, 345, now), { '2026-11-10': 1, '2026-11-11': 2 });
});

test('a review stamped past the times a Date holds counts on no day, and the rest still count', () => {
  const user = 'set-days-out-of-range';
  // Only a corrupted last review date stamps a review there, since none is stamped before its sentence's last.
  storeEvent(user, 'beyond', 1e17);
  storeEvent(user, 'kept', LATE_EVENING);
  assert.deepEqual(getSetDays(user, 0, Date.now(), 'America/Los_Angeles'), { [utcDay(LATE_EVENING)]: 1 }, 'Intl formats no time there');
  assert.deepEqual(getSetDays(user, 0), { [utcDay(LATE_EVENING)]: 1 }, 'nor does SQLite date any past the year 9999');
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
  const counted = { [utcDay(LATE_EVENING)]: 3, [utcDay(Date.now() - 399 * DAY)]: 1 };
  assert.deepEqual(getSetDays(user, 0), counted);
  // Counted in a time zone, the same reviews count.
  assert.deepEqual(getSetDays(user, 0, Date.now(), 'UTC'), counted);
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

test("the route counts in the time zone the device names and names it back; a zone it can't use leaves the offset's days, unnamed", async () => {
  // The owner's one review, from the test before: 23:30 UTC ten days ago.
  const answer = async (query: string) => {
    const response = await app.request(`/api/reviews/set-days${query}`);
    assert.equal(response.status, 200, query);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return await response.json() as SetDaysResponse;
  };
  const sameDay = { [utcDay(LATE_EVENING)]: 1 };
  const nextDay = { [utcDay(LATE_EVENING + DAY)]: 1 };

  // An older client sends its offset alone, and gets just what it always got.
  assert.deepEqual(await answer('?tzOffset=-480'), { days: sameDay });
  // Tokyo is nine hours ahead of UTC, so it was half past eight the next morning there.
  assert.deepEqual(await answer('?tzOffset=-480&tz=Asia%2FTokyo'), { days: nextDay, timeZone: 'Asia/Tokyo' });
  assert.deepEqual(await answer('?tz=Asia%2FTokyo'), { days: nextDay, timeZone: 'Asia/Tokyo' });
  assert.deepEqual(await answer('?tzOffset=540&tz=America%2FLos_Angeles'), { days: sameDay, timeZone: 'America/Los_Angeles' });
  // The zone comes back spelled exactly as the device sent it, never as Intl spells it: the client counts its history
  // by calendar day only when the answer names the very zone it sent. (Node 22's Intl calls Europe/Kyiv and
  // Asia/Kolkata by their older names, Europe/Kiev and Asia/Calcutta, and corrects a name's case, as every Intl does.)
  assert.deepEqual(await answer('?tzOffset=-480&tz=Europe%2FKyiv'), { days: nextDay, timeZone: 'Europe/Kyiv' });
  assert.deepEqual(await answer('?tzOffset=-480&tz=Asia%2FKolkata'), { days: nextDay, timeZone: 'Asia/Kolkata' });
  assert.deepEqual(await answer('?tzOffset=540&tz=america%2Flos_angeles'), { days: sameDay, timeZone: 'america/los_angeles' });
  // Empty, unknown, padded, too long, or a bare offset, which Intl takes but which names no zone.
  for (const tz of ['', 'Mars/Olympus', 'Etc/Unknown', ' Asia/Tokyo', 'Asia/Tokyo'.padEnd(65, '_'), 'x'.repeat(200), '+09:00']) {
    assert.deepEqual(await answer(`?tzOffset=-480&tz=${encodeURIComponent(tz)}`), { days: sameDay }, tz);
  }
});

test('a review stamped past the times a Date holds leaves the route answering in a time zone', async () => {
  // The owner's one review is the route tests' above: 23:30 UTC ten days ago, the next morning in Tokyo.
  storeEvent(DEV_AUTH_USER.id, 'set-days-route-beyond', 1e17);
  const response = await app.request('/api/reviews/set-days?tzOffset=-480&tz=Asia%2FTokyo');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { days: { [utcDay(LATE_EVENING + DAY)]: 1 }, timeZone: 'Asia/Tokyo' });
});
