import assert from 'node:assert/strict';
import test from 'node:test';
import { SET_START_PENALTY_MS } from '../../services/learningLoop/planner.ts';
import {
  activeUnitKey,
  decodeActiveUnit,
  forgetV3State,
  readActiveUnit,
  readSetStarts,
  readTodayPin,
  recordSetStart,
  setStartsKey,
  todayPinKey,
  unitSessionId,
  writeActiveUnit,
  writeTodayPin,
  type ActiveUnit,
} from '../../services/learningLoop/sessionStore.ts';
import { MemoryStorage } from '../support/memory-storage.ts';
import { DAY } from '../support/loop-fixtures.ts';

const T0 = new Date(2026, 10, 18, 9).getTime();
const USER = 'user-1';

/** Storage that refuses every call, as a browser in some private modes does. */
const refusing = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
  removeItem: () => { throw new Error('denied'); },
};

const UNIT: ActiveUnit = { version: 1, userId: USER, id: 'unit-1', themeId: 'eating-out', itemIds: ['s3', 's1', 's2'], startedAt: T0 };

test('the active unit lives under the user\'s key and reads back as it was written', () => {
  const storage = new MemoryStorage();
  assert.equal(readActiveUnit(USER, storage), null, 'none yet');
  writeActiveUnit(UNIT, storage);
  assert.equal(activeUnitKey(USER), 'today_unit_v1:user-1');
  assert.deepEqual(JSON.parse(storage.getItem(activeUnitKey(USER))!), UNIT);
  assert.deepEqual(readActiveUnit(USER, storage), UNIT);
  assert.equal(readActiveUnit('another', storage), null);
  assert.equal(unitSessionId(UNIT), 'set:unit-1', 'the session its lesson records its reviews in');

  // A unit from Unsorted has no theme; the next start replaces the unit before it.
  const next: ActiveUnit = { ...UNIT, id: 'unit-2', themeId: null, itemIds: ['u1'], startedAt: T0 + DAY };
  writeActiveUnit(next, storage);
  assert.deepEqual(readActiveUnit(USER, storage), next);
});

test('an active unit that is damaged, foreign or oversized reads as none', () => {
  const raw = (change: Record<string, unknown>) => JSON.stringify({ ...UNIT, ...change });
  const damaged: [string, string | null][] = [
    ['nothing kept', null],
    ['not JSON', '{not json'],
    ['a list', '[]'],
    ['another version', raw({ version: 2 })],
    ['another user\'s', raw({ userId: 'someone-else' })],
    ['no user', raw({ userId: undefined })],
    ['an empty id', raw({ id: '' })],
    // The server takes a review's session id, 'set:' and the unit's id, up to 200 characters, and refuses the review
    // beyond that.
    ['an id too long for its session id', raw({ id: 'x'.repeat(197) })],
    ['a theme that is neither an id nor null', raw({ themeId: 7 })],
    ['an empty theme', raw({ themeId: '' })],
    ['no sentences', raw({ itemIds: [] })],
    ['sentences that are no list', raw({ itemIds: 's1' })],
    ['a sentence id that is no string', raw({ itemIds: ['s1', 2] })],
    ['a sentence id too long', raw({ itemIds: ['x'.repeat(201)] })],
    ['a sentence twice', raw({ itemIds: ['s1', 's2', 's1'] })],
    ['more than 100 sentences', raw({ itemIds: Array.from({ length: 101 }, (_, i) => `s${i}`) })],
    ['no start', raw({ startedAt: undefined })],
    ['a start that is no time', raw({ startedAt: 'yesterday' })],
  ];
  for (const [what, value] of damaged) assert.equal(decodeActiveUnit(value, USER), null, what);
  // A hundred sentences, and fields it doesn't know, still read: only the record's own fields come back.
  const hundred = Array.from({ length: 100 }, (_, i) => `s${i}`);
  assert.deepEqual(decodeActiveUnit(raw({ itemIds: hundred, note: 'from a later build' }), USER), { ...UNIT, itemIds: hundred });
  // So does the longest id whose session id fits, at 200 characters.
  const longest = decodeActiveUnit(raw({ id: 'x'.repeat(196) }), USER);
  assert.ok(longest);
  assert.equal(unitSessionId(longest).length, 200);
});

test('reading and writing the active unit never throw when storage is missing or refuses', () => {
  assert.equal(readActiveUnit(USER, refusing), null);
  assert.equal(readActiveUnit(USER, null), null);
  assert.doesNotThrow(() => writeActiveUnit(UNIT, refusing));
  assert.doesNotThrow(() => writeActiveUnit(UNIT, null));
});

test('v3\'s loop session and mode go, and nothing else does; storage that refuses keeps them, without a throw', () => {
  const storage = new MemoryStorage();
  storage.setItem('today_session_v1:user-1', '{"version":1}');
  storage.setItem('today_session_v1:another', '{"version":1}');
  storage.setItem('today_mode_v1', 'quiet');
  writeActiveUnit(UNIT, storage);
  writeTodayPin(USER, { day: '2026-11-18', themeId: 'eating-out' }, storage);
  recordSetStart(USER, 'eating-out', T0, storage);
  forgetV3State(USER, storage);
  assert.equal(storage.getItem('today_session_v1:user-1'), null);
  assert.equal(storage.getItem('today_mode_v1'), null);
  assert.equal(storage.getItem('today_session_v1:another'), '{"version":1}', 'another user\'s is theirs to forget');
  assert.deepEqual(readActiveUnit(USER, storage), UNIT);
  assert.deepEqual(readTodayPin(USER, storage), { day: '2026-11-18', themeId: 'eating-out' });
  assert.deepEqual(readSetStarts(USER, T0, storage), { 'eating-out': T0 });
  assert.doesNotThrow(() => forgetV3State(USER, refusing));
  assert.doesNotThrow(() => forgetV3State(USER, null));
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

test('unit starts keep the newest per theme, only while the two-day hold counts, at most 50', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readSetStarts(USER, T0, storage), {});
  assert.deepEqual(recordSetStart(USER, 'cooking', T0 - DAY, storage), { cooking: T0 - DAY });
  assert.deepEqual(recordSetStart(USER, 'cooking', T0, storage), { cooking: T0 }, 'the newer start of a theme replaces the older');
  assert.deepEqual(recordSetStart(USER, null, T0, storage), { cooking: T0 }, 'a unit from Unsorted isn\'t noted');
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
