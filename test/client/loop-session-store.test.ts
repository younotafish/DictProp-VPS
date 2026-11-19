import assert from 'node:assert/strict';
import test from 'node:test';
import { SET_START_PENALTY_MS } from '../../services/learningLoop/planner.ts';
import {
  chooseInMeet,
  finishEncoding,
  revealAnswer,
  settleSession,
  startPracticeSession,
  startSetSession,
  takeHint,
  type LoopSession,
  type PracticeSession,
  type SetSession,
} from '../../services/learningLoop/session.ts';
import {
  clearLoopSession,
  decodeLoopSession,
  encodeLoopSession,
  LOOP_MODE_KEY,
  LOOP_SESSION_MAX_AGE_MS,
  loopRecordChanged,
  loopSessionKey,
  readLoopMode,
  readLoopSession,
  readSetStarts,
  readTodayPin,
  recordSetStart,
  setStartsKey,
  todayPinKey,
  writeLoopMode,
  writeLoopSession,
  writeTodayPin,
} from '../../services/learningLoop/sessionStore.ts';
import { MemoryStorage } from '../support/memory-storage.ts';
import { DAY, HOUR, practicing, sentenceItem, vocabItem } from '../support/loop-fixtures.ts';

const T0 = new Date(2026, 10, 18, 9).getTime();
const USER = 'user-1';

/** Storage that refuses every call, as a browser in some private modes does. */
const refusing = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
  removeItem: () => { throw new Error('denied'); },
};

/** A sentence of the loop, with the schedule `srs` gives it. */
const line = (id: string, srs = {}) => sentenceItem(id, `A line called ${id}.`, { srs });

/** A set session that met the sentences 'one' (Practice) and 'two' (Can say it), now in its round with a hint taken. */
function roundSession(): SetSession {
  const items = new Map(['one', 'two'].map(id => [id, line(id)]));
  let ids = 0;
  const createId = () => `attempt-${++ids}`;
  let session = startSetSession('s1', { themeId: 'theme', itemIds: ['one', 'two'] }, T0);
  for (const [id, choice, membership] of [['one', 'practice', { practiceSince: T0 }], ['two', 'say', { sayableAt: T0 }]] as const) {
    session = revealAnswer(session);
    const step = chooseInMeet(session, items.get(id)!, choice, `e-${id}`, T0)!;
    // The choice's review, as this device applies it.
    items.set(id, line(id, { totalReviews: 1, lastReviewDate: T0, practiceChangedAt: T0, ...membership }));
    session = finishEncoding(step.advance(session), T0);
    session = settleSession(session, itemId => items.get(itemId), createId, T0);
  }
  return takeHint(session);
}

test('a session\'s record keeps its place, choices and attempts, and comes back at the cue of the card it was on', () => {
  const session = roundSession();
  assert.equal(session.phase, 'round');
  const raw = encodeLoopSession(session, USER, T0 + 2_000);
  assert.equal(JSON.parse(raw).session.step, undefined, 'the card on screen isn\'t kept');
  const restored = decodeLoopSession(raw, USER, T0 + HOUR);
  assert.ok(restored);
  assert.equal(restored.savedAt, T0 + 2_000);
  assert.deepEqual(restored.session, { ...session, step: 'cue', promptStartedAt: T0 + HOUR, hintShown: true });

  const practice = startPracticeSession('p1', ['a', 'b'], 'quiet', T0, () => 'event');
  const practiceRestored = decodeLoopSession(encodeLoopSession(practice, USER, T0), USER, T0 + 1);
  assert.deepEqual(practiceRestored?.session, { ...practice, promptStartedAt: T0 + 1 });

  const meeting = startSetSession('s2', { themeId: null, itemIds: ['x'] }, T0);
  assert.deepEqual(decodeLoopSession(encodeLoopSession(meeting, USER, T0), USER, T0)?.session, meeting);

  // A choice made after the hint keeps that, so Back can keep Can say it closed.
  const hinted = revealAnswer(takeHint(startSetSession('s3', { themeId: null, itemIds: ['x', 'y'] }, T0)));
  const chosen = chooseInMeet(hinted, line('x'), 'passive', 'e-x', T0)!.advance(hinted);
  assert.deepEqual(decodeLoopSession(encodeLoopSession(chosen, USER, T0), USER, T0)?.session, chosen);
});

test('a record kept from before Today took sentences only is taken up, and its words are passed over as it settles', () => {
  const words = new Map(['old-word', 'old-card'].map(id => [id, vocabItem(id, id)]));
  const items = new Map([...words, ['kept', line('kept')]]);
  const raw = encodeLoopSession(startSetSession('v2', { themeId: 'theme', itemIds: ['old-word', 'kept', 'old-card'] }, T0), USER, T0);
  const restored = decodeLoopSession(raw, USER, T0 + HOUR);
  assert.ok(restored);
  const settled = settleSession(restored.session, id => items.get(id), () => 'x', T0 + HOUR) as SetSession;
  assert.deepEqual([settled.phase, settled.itemIds[settled.meet.index]], ['meet', 'kept']);
});

test('a record is taken up only by its user, within 12 hours, and never from the future', () => {
  const raw = encodeLoopSession(roundSession(), USER, T0);
  assert.equal(decodeLoopSession(raw, 'someone-else', T0), null);
  assert.ok(decodeLoopSession(raw, USER, T0 + LOOP_SESSION_MAX_AGE_MS));
  assert.equal(decodeLoopSession(raw, USER, T0 + LOOP_SESSION_MAX_AGE_MS + 1), null);
  assert.equal(decodeLoopSession(raw, USER, T0 - 1), null);
  assert.equal(decodeLoopSession(null, USER, T0), null);
  assert.equal(decodeLoopSession('{not json', USER, T0), null);
  assert.equal(decodeLoopSession(JSON.stringify({ ...JSON.parse(raw), version: 2 }), USER, T0), null);
});

test('a damaged record reads as none, whatever part of it is wrong', () => {
  const good = JSON.parse(encodeLoopSession(roundSession(), USER, T0));
  const practice = JSON.parse(encodeLoopSession(startPracticeSession('p', ['a', 'b'], 'speak', T0, () => 'e'), USER, T0));
  const withSession = (base: { session: object }, change: (session: Record<string, unknown>) => void) => {
    const copy = structuredClone(base) as { session: Record<string, unknown> };
    change(copy.session);
    return JSON.stringify(copy);
  };
  const damaged: [string, string][] = [
    ['unknown kind', withSession(good, session => { session.kind = 'lesson'; })],
    ['empty id', withSession(good, session => { session.id = ''; })],
    ['a repeated item', withSession(good, session => { session.itemIds = ['one', 'one']; })],
    ['an item id too long', withSession(good, session => { session.itemIds = ['x'.repeat(201)]; })],
    ['too many items', withSession(good, session => { session.itemIds = Array.from({ length: 101 }, (_, i) => `i${i}`); })],
    ['an unknown phase', withSession(good, session => { session.phase = 'done'; })],
    ['a Meet past the set', withSession(good, session => { (session.meet as { index: number }).index = 3; })],
    ['a choice for an item not in the set', withSession(good, session => {
      (session.meet as { choices: Record<string, unknown> }).choices.zz = { choice: 'say', eventId: 'e', at: T0, totalReviews: 1 };
    })],
    ['a choice\'s hint that is neither absent nor true', withSession(good, session => {
      (session.meet as { choices: Record<string, { hinted?: unknown }> }).choices.two.hinted = false;
    })],
    ['an unknown choice', withSession(good, session => {
      (session.meet as { choices: Record<string, { choice: string }> }).choices.two.choice = 'known';
    })],
    ['a round item not chosen for practice', withSession(good, session => {
      const round = session.round as { queue: string[]; attempts: Record<string, unknown> };
      round.queue.push('two');
      round.attempts.two = { tries: 0, hinted: false, eventId: 'x' };
    })],
    ['a queued item without its attempt', withSession(good, session => { (session.round as { attempts: object }).attempts = {}; })],
    ['an outcome the tries can\'t give', withSession(good, session => {
      (session.round as { attempts: Record<string, unknown> }).attempts.one = { tries: 2, hinted: true, outcome: 'good', eventId: 'e', at: T0, totalReviews: 2 };
    })],
    ['Good with the hint', withSession(good, session => {
      (session.round as { attempts: Record<string, unknown> }).attempts.one = { tries: 1, hinted: true, outcome: 'good', eventId: 'e', at: T0, totalReviews: 2 };
    })],
    ['a Practice choice left out of the round', withSession(good, session => {
      (session.meet as { choices: Record<string, { choice: string }> }).choices.two.choice = 'practice';
    })],
    ['an attempt whose item isn\'t queued', withSession(good, session => {
      const round = session.round as { queue: string[]; index: number };
      round.queue = round.queue.filter(id => id !== 'one');
      round.index = 0;
    })],
    ['an outcome without its time', withSession(good, session => {
      (session.round as { attempts: Record<string, unknown> }).attempts.one = { tries: 1, hinted: false, outcome: 'good', eventId: 'e' };
    })],
    ['a round while meeting', withSession(good, session => { session.phase = 'meet'; })],
    ['a practice mode', withSession(practice, session => { session.mode = 'loud'; })],
    ['a practice place past its queue', withSession(practice, session => { session.index = 3; })],
    ['a practice attempt for an item not in it', withSession(practice, session => {
      (session.attempts as Record<string, unknown>).zz = { tries: 0, hinted: false, eventId: 'e' };
    })],
  ];
  for (const [what, raw] of damaged) assert.equal(decodeLoopSession(raw, USER, T0), null, what);
});

test('the record lives under the user\'s key; reading, writing and clearing never throw', () => {
  const storage = new MemoryStorage();
  const session = roundSession();
  writeLoopSession(session, USER, T0, storage);
  assert.ok(storage.getItem(loopSessionKey(USER)));
  assert.equal(loopSessionKey(USER), 'today_session_v1:user-1');
  assert.equal(readLoopSession(USER, T0 + 1, storage)?.session.id, 's1');
  assert.equal(readLoopSession('another', T0 + 1, storage), null);
  clearLoopSession(USER, storage);
  assert.equal(readLoopSession(USER, T0 + 1, storage), null);
  assert.equal(readLoopSession(USER, T0, refusing), null);
  assert.equal(readLoopSession(USER, T0, null), null);
  assert.doesNotThrow(() => writeLoopSession(session, USER, T0, refusing));
  assert.doesNotThrow(() => clearLoopSession(USER, refusing));
});

test('the record is written again only when the session moves, chooses or answers, not as a card is revealed', () => {
  const session = roundSession();
  assert.equal(loopRecordChanged(null, session), true);
  assert.equal(loopRecordChanged(session, revealAnswer(session)), false);
  assert.equal(loopRecordChanged(session, { ...session, promptStartedAt: T0 + 5 }), false);
  assert.equal(loopRecordChanged(session, { ...session, phase: 'summary' }), true);
  assert.equal(loopRecordChanged(session, { ...session, id: 'other' }), true);
  const items = new Map([['p', line('p', practicing(T0 - 9 * DAY, { nextReview: T0 - HOUR, lastReviewDate: T0 - 2 * DAY }))]]);
  const practice = settleSession(startPracticeSession('ps', ['p'], 'speak', T0, () => 'e'), id => items.get(id), () => 'x', T0);
  assert.equal(loopRecordChanged(practice, revealAnswer(practice)), false);
  assert.equal(loopRecordChanged(practice, takeHint(practice)), true, 'a hint taken caps the attempt, so it is kept');
  assert.equal(loopRecordChanged(practice as LoopSession, session), true);
  assert.equal(loopRecordChanged(practice, { ...practice, index: 1 } as PracticeSession), true);
});

test('the mode is Speak unless Quiet was chosen on this device', () => {
  const storage = new MemoryStorage();
  assert.equal(readLoopMode(storage), 'speak');
  writeLoopMode('quiet', storage);
  assert.equal(storage.getItem(LOOP_MODE_KEY), 'quiet');
  assert.equal(LOOP_MODE_KEY, 'today_mode_v1');
  assert.equal(readLoopMode(storage), 'quiet');
  storage.setItem(LOOP_MODE_KEY, 'loud');
  assert.equal(readLoopMode(storage), 'speak');
  assert.equal(readLoopMode(refusing), 'speak');
  assert.doesNotThrow(() => writeLoopMode('quiet', refusing));
});

test('the day pin is kept per user and read back only when well formed', () => {
  const storage = new MemoryStorage();
  assert.equal(readTodayPin(USER, storage), null);
  writeTodayPin(USER, { day: '2026-11-18', themeId: 'eating-out' }, storage);
  assert.equal(todayPinKey(USER), 'today_pin_v1:user-1');
  assert.deepEqual(readTodayPin(USER, storage), { day: '2026-11-18', themeId: 'eating-out' });
  assert.equal(readTodayPin('another', storage), null);
  for (const damaged of ['{"day":"18/11/2026","themeId":"x"}', '{"day":"2026-11-18","themeId":""}', '[]', 'nope']) {
    storage.setItem(todayPinKey(USER), damaged);
    assert.equal(readTodayPin(USER, storage), null, damaged);
  }
  writeTodayPin(USER, null, storage);
  assert.equal(storage.getItem(todayPinKey(USER)), null);
  assert.equal(readTodayPin(USER, refusing), null);
  assert.doesNotThrow(() => writeTodayPin(USER, { day: '2026-11-18', themeId: 'x' }, refusing));
});

test('set starts keep the newest per theme, only while the two-day hold counts, at most 50', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readSetStarts(USER, T0, storage), {});
  assert.deepEqual(recordSetStart(USER, 'cooking', T0 - DAY, storage), { cooking: T0 - DAY });
  assert.deepEqual(recordSetStart(USER, 'cooking', T0, storage), { cooking: T0 }, 'the newer start of a theme replaces the older');
  assert.deepEqual(recordSetStart(USER, null, T0, storage), { cooking: T0 }, 'a set from Unsorted isn\'t noted');
  assert.deepEqual(readSetStarts(USER, T0 + SET_START_PENALTY_MS - 1, storage), { cooking: T0 });
  assert.deepEqual(readSetStarts(USER, T0 + SET_START_PENALTY_MS, storage), {}, 'past the hold it no longer counts');
  assert.equal(setStartsKey(USER), 'today_set_starts_v1:user-1');

  for (let i = 0; i < 60; i++) recordSetStart(USER, `theme-${i}`, T0 + i, storage);
  const kept = readSetStarts(USER, T0 + 60, storage);
  assert.equal(Object.keys(kept).length, 50);
  assert.equal(kept['theme-59'], T0 + 59);
  assert.equal(kept['theme-9'], undefined, 'the oldest go first');

  storage.setItem(setStartsKey(USER), JSON.stringify({ good: T0, bad: 'yesterday', '': T0 }));
  assert.deepEqual(readSetStarts(USER, T0, storage), { good: T0 });
  storage.setItem(setStartsKey(USER), '[1,2]');
  assert.deepEqual(readSetStarts(USER, T0, storage), {});
  assert.deepEqual(readSetStarts(USER, T0, refusing), {});
  assert.deepEqual(recordSetStart(USER, 'x', T0, refusing), { x: T0 }, 'kept for this visit');
});
