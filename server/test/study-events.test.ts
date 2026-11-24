import assert from 'node:assert/strict';
import test from 'node:test';
import type { StudyEvent } from '../src/shared/study-events.js';
import { parseStudyEvent } from '../src/shared/study-events.js';

// POST /api/study-events: the lesson's study signals, one row per exposure, the latest copy kept; a malformed event is
// dropped without failing the batch.

process.env.DEV_AUTH_BYPASS = '1';

const { createApp } = await import('../src/app.js');
const { db, getStudyEventCount, recordStudyEvents } = await import('../src/db.js');
const { DEV_AUTH_USER } = await import('../src/middleware/auth.js');
const app = createApp({ logging: false, serveStaticFiles: false });

const event = (fields: Partial<StudyEvent> = {}): StudyEvent => ({
  id: 'exposure-1', itemId: 'sentence-1', sessionId: 'set:u1', from: 'Today',
  startedAt: 1_000, endedAt: 9_000, final: true, visibleMs: 8_000, analysisMs: 2_000, analysisOpens: 1,
  plays: 2, autoPlays: 0, listens: 1, styleSwitches: 0, lookups: 1, lookupTerms: ['come clean'], cardOpens: 0,
  gotIts: 1, firstGotItMs: 7_500, learnLater: false, learnLaterAtStart: false, autoplay: false, exit: 'next',
  position: 3, runLength: 15, tzOffset: -480,
  srs: { totalReviews: 2, stability: 3.5, difficulty: 5.1, lapses: 0, lastReviewDate: 500, nextReview: 800 },
  ...fields,
});

const post = (body: unknown) => app.request('/api/study-events', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const row = (id: string) => db.prepare('SELECT * FROM study_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;

test('a well-formed event parses to itself, and anything off is refused', () => {
  assert.deepEqual(parseStudyEvent(event()), event());
  assert.deepEqual(parseStudyEvent({ ...event(), extra: 'dropped' }), event());
  assert.deepEqual(parseStudyEvent(event({ engagedMs: 7_500, version: 2 })), event({ engagedMs: 7_500, version: 2 }));
  for (const broken of [
    { ...event(), endedAt: 500 },
    { ...event(), analysisMs: 9_000 },
    { ...event(), exit: 'sideways' },
    { ...event(), plays: -1 },
    { ...event(), lookupTerms: Array.from({ length: 11 }, () => 'x') },
    { ...event(), tzOffset: 900 },
    { ...event(), srs: { totalReviews: 1 } },
    { ...event(), position: 0 },
    { ...event(), id: '' },
    { ...event(), engagedMs: 9_000 },
    { ...event(), engagedMs: 1_000 },
    { ...event(), listensAway: -1 },
    { ...event(), version: 2 }, // a version 2 event without engaged time
    { ...event(), version: 2, engagedMs: { valueOf() { throw new Error('boom'); } } }, // refused, never thrown on
    { ...event(), version: 2, engagedMs: 6_000 }, // its first Got it (7.5 s) past its engaged time
    { ...event(), version: 0 },
  ]) {
    assert.equal(parseStudyEvent(broken), null, JSON.stringify(broken));
  }
});

test('the route keeps the well-formed events of a batch and counts the rest', async () => {
  const response = await post({ events: [event({ id: 'route-a' }), { ...event({ id: 'route-b' }), exit: 'nowhere' }] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: 1, rejected: 1 });
  const stored = row('route-a');
  assert.equal(stored?.user_id, DEV_AUTH_USER.id);
  assert.equal(stored?.item_id, 'sentence-1');
  assert.equal(stored?.session_id, 'set:u1');
  assert.equal(stored?.got_its, 1);
  assert.equal(stored?.final, 1);
  assert.deepEqual(JSON.parse(stored?.data as string), event({ id: 'route-a' }));
  assert.equal(row('route-b'), undefined);
});

test('a body that is no batch, or too big a batch, is refused', async () => {
  assert.equal((await post({ events: 'nope' })).status, 400);
  assert.equal((await post([event()])).status, 400);
  const tooMany = Array.from({ length: 201 }, (_, index) => event({ id: `too-many-${index}` }));
  assert.equal((await post({ events: tooMany })).status, 400);
  assert.equal(row('too-many-0'), undefined);
});

test('a running copy is replaced by a later one and by the finished one, never the other way round', () => {
  const user = 'study-upsert';
  recordStudyEvents(user, [event({ id: 'up-1', final: false, endedAt: 5_000, visibleMs: 4_000, analysisMs: 0, gotIts: 0 })], 1);
  // A copy that reaches no further than the stored one (another tab's, sent late) changes nothing.
  recordStudyEvents(user, [event({ id: 'up-1', final: false, endedAt: 4_000, visibleMs: 3_000, analysisMs: 0, gotIts: 0 })], 2);
  assert.equal(row('up-1')?.ended_at, 5_000);
  recordStudyEvents(user, [event({ id: 'up-1', final: true, endedAt: 9_000 })], 3);
  assert.equal(row('up-1')?.final, 1);
  assert.equal(row('up-1')?.got_its, 1);
  // Once finished, a running copy (taken before it finished, sent after) doesn't take it back.
  recordStudyEvents(user, [event({ id: 'up-1', final: false, endedAt: 9_500, gotIts: 0 })], 4);
  assert.equal(row('up-1')?.final, 1);
  assert.equal(row('up-1')?.got_its, 1);
  assert.equal(getStudyEventCount(user), 1);
});

test('a finished copy replaces a running one even when the device clock went back between them', () => {
  recordStudyEvents('study-clock', [event({ id: 'clock-1', final: false, endedAt: 9_000, gotIts: 0 })], 1);
  recordStudyEvents('study-clock', [event({ id: 'clock-1', final: true, endedAt: 8_000, visibleMs: 7_000, analysisMs: 0 })], 2);
  assert.equal(row('clock-1')?.final, 1);
  assert.equal(row('clock-1')?.ended_at, 8_000);
});

test("a run as long as the Sentences tab's whole list is accepted", () => {
  assert.notEqual(parseStudyEvent(event({ position: 15_000, runLength: 20_000 })), null);
});

test("another user's copy of an exposure id never overwrites it", () => {
  recordStudyEvents('study-owner', [event({ id: 'shared-id', final: false, endedAt: 2_000, visibleMs: 1_000, analysisMs: 0 })], 1);
  recordStudyEvents('study-intruder', [event({ id: 'shared-id', itemId: 'other', endedAt: 9_000 })], 2);
  assert.equal(row('shared-id')?.user_id, 'study-owner');
  assert.equal(row('shared-id')?.item_id, 'sentence-1');
  assert.equal(getStudyEventCount('study-intruder'), 0);
});
