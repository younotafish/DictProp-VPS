import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredItem } from '../../types.ts';
import type { StudySession } from '../../services/studySession.ts';
import {
  SESSION_RECORD_MAX_AGE_MS,
  decodeStudySession,
  encodeStudySession,
  recordChanged,
  restoreQueue,
  restoredSession,
  type StudySessionRecord,
} from '../../services/studySessionRecord.ts';
import {
  STUDY_SESSION_KEY,
  clearStoredStudySession,
  readStoredStudySession,
  writeStoredStudySession,
} from '../../services/studySessionStore.ts';
import { installFakeMedia } from '../support/audio/fakeMedia.ts';
import { MemoryStorage } from '../support/memory-storage.ts';

// The study screen imports the speech engine, which reads the browser's media when it loads.
installFakeMedia();
const { StudyEnhanced } = await import('../../views/StudyEnhanced.tsx');

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 16, 15, 30);
const USER = 'user-1';

const session = (overrides: Partial<StudySession> = {}): StudySession => ({
  id: 'session-1',
  itemIds: ['a', 'b', 'c', 'a'],
  index: 2,
  revealed: true,
  typedAnswer: 'secret answer',
  promptStartedAt: NOW - 30_000,
  startedAt: NOW - HOUR,
  grades: [
    { itemId: 'a', rating: 'again', at: NOW - HOUR + 20_000, totalReviews: 3 },
    { itemId: 'b', rating: 'good', at: NOW - HOUR + 40_000, totalReviews: 1 },
  ],
  siblingCounts: { a: 2 },
  passedOverFrom: 1,
  ...overrides,
});

/** A record as encodeStudySession writes it, with any field replaced. */
const recordJson = (overrides: Record<string, unknown> = {}, savedAt = NOW - HOUR / 2) =>
  JSON.stringify({ ...JSON.parse(encodeStudySession(session(), USER, savedAt)), ...overrides });

test('the record holds the session\'s ids, place and grades, and nothing of its cards or its answer', () => {
  const raw = encodeStudySession(session(), USER, NOW);
  assert.deepEqual(JSON.parse(raw), {
    version: 2, userId: USER, sessionId: 'session-1', itemIds: ['a', 'b', 'c', 'a'], index: 2,
    grades: [
      { itemId: 'a', rating: 'again', at: NOW - HOUR + 20_000, totalReviews: 3 },
      { itemId: 'b', rating: 'good', at: NOW - HOUR + 40_000, totalReviews: 1 },
    ],
    startedAt: NOW - HOUR, savedAt: NOW,
  });
  assert.doesNotMatch(raw, /secret answer|siblingCounts|revealed/);
  assert.deepEqual(decodeStudySession(raw, USER, NOW + HOUR), JSON.parse(raw));
});

test('a record that can\'t be taken up decodes to nothing: unreadable, another version or user, stale, or off its list', () => {
  assert.notEqual(decodeStudySession(recordJson(), USER, NOW), null);
  const rejected: [string, string][] = [
    ['not JSON', '{"version":2,'],
    ['not an object', '"study"'],
    ['null', 'null'],
    ['another version', recordJson({ version: 1 })],
    ['another user', recordJson({ userId: 'user-2' })],
    ['no session id', recordJson({ sessionId: '' })],
    ['ids that are not strings', recordJson({ itemIds: ['a', 7] })],
    ['a grade with another rating', recordJson({ grades: [{ itemId: 'a', rating: 'perfect' }] })],
    ['a grade without a card', recordJson({ grades: [{ rating: 'good' }] })],
    ['a grade with a time that is not one', recordJson({ grades: [{ itemId: 'a', rating: 'good', at: 'soon' }] })],
    ['a grade with a review count that is not one', recordJson({ grades: [{ itemId: 'a', rating: 'good', at: NOW - HOUR, totalReviews: '2' }] })],
    ['a grade with a fractional review count', recordJson({ grades: [{ itemId: 'a', rating: 'good', at: NOW - HOUR, totalReviews: 1.5 }] })],
    ['a grade with a negative review count', recordJson({ grades: [{ itemId: 'a', rating: 'good', at: NOW - HOUR, totalReviews: -1 }] })],
    ['the place past the end', recordJson({ index: 4 })],
    ['a negative place', recordJson({ index: -1 })],
    ['a fractional place', recordJson({ index: 1.5 })],
    ['no start time', recordJson({ startedAt: null })],
  ];
  for (const [why, raw] of rejected) assert.equal(decodeStudySession(raw, USER, NOW), null, why);
  // Saved more than six hours ago, or in the future by this clock.
  assert.notEqual(decodeStudySession(recordJson({}, NOW - SESSION_RECORD_MAX_AGE_MS), USER, NOW), null);
  assert.equal(decodeStudySession(recordJson({}, NOW - SESSION_RECORD_MAX_AGE_MS - 1), USER, NOW), null);
  assert.equal(decodeStudySession(recordJson({}, NOW + 1), USER, NOW), null);
  assert.equal(SESSION_RECORD_MAX_AGE_MS, 6 * HOUR);
});

test('a grade in a record written before grades kept their time is taken as given when the record was saved', () => {
  const savedAt = NOW - HOUR / 2;
  const raw = recordJson({ grades: [{ itemId: 'a', rating: 'again' }, { itemId: 'b', rating: 'good', at: NOW - HOUR + 40_000 }] }, savedAt);
  assert.deepEqual(decodeStudySession(raw, USER, NOW)?.grades, [
    { itemId: 'a', rating: 'again', at: savedAt },
    { itemId: 'b', rating: 'good', at: NOW - HOUR + 40_000 },
  ]);
});

test('a grade in a record written before grades kept their review count takes its card\'s count when the session is taken up', () => {
  const raw = recordJson({ grades: [{ itemId: 'a', rating: 'again', at: NOW - HOUR + 20_000 }, session().grades[1]] });
  const record = decodeStudySession(raw, USER, NOW)!;
  assert.deepEqual(record.grades, [{ itemId: 'a', rating: 'again', at: NOW - HOUR + 20_000 }, session().grades[1]]);
  const counts: Record<string, number> = { a: 4, b: 7 };
  assert.deepEqual(restoredSession(record, 3, NOW, {}, id => counts[id]).grades, [
    { itemId: 'a', rating: 'again', at: NOW - HOUR + 20_000, totalReviews: 4 },
    { itemId: 'b', rating: 'good', at: NOW - HOUR + 40_000, totalReviews: 1 },
  ], 'a grade that kept its count keeps it');
});

test('taken up again, a session goes on at the first card still studied and not reviewed since the record was written', () => {
  const record: Pick<StudySessionRecord, 'itemIds' | 'index' | 'savedAt'> = { itemIds: ['a', 'b', 'c', 'd', 'a'], index: 1, savedAt: NOW };
  const present = (...ids: string[]) => (id: string) => ids.includes(id);
  const reviewedAt = (times: Record<string, number>) => (id: string) => times[id] ?? 0;
  assert.equal(restoreQueue(record, present('a', 'b', 'c', 'd'), reviewedAt({})), 1);
  // b was deleted or archived, and c reviewed on another device after the record: d is next.
  assert.equal(restoreQueue(record, present('a', 'c', 'd'), reviewedAt({ c: NOW + 1 })), 3);
  // a was graded in this session (before the record) and brought back to the end: its second showing stays.
  assert.equal(restoreQueue({ ...record, index: 4 }, present('a', 'b'), reviewedAt({ a: NOW - HOUR })), 4);
  assert.equal(restoreQueue({ ...record, index: 4 }, present('a', 'b'), reviewedAt({ a: NOW + HOUR })), null, 'no card left');
});

test('a restored session is at its card, unrevealed and unanswered, with its start and grades and nothing passed over', () => {
  const record = decodeStudySession(encodeStudySession(session(), USER, NOW), USER, NOW)!;
  const restored = restoredSession(record, 3, NOW + 60_000, { a: 2 }, () => 0);
  assert.deepEqual(restored, {
    id: 'session-1', itemIds: ['a', 'b', 'c', 'a'], index: 3, revealed: false, typedAnswer: '', promptStartedAt: NOW + 60_000,
    startedAt: NOW - HOUR, grades: session().grades, siblingCounts: { a: 2 },
  });
  assert.equal('passedOverFrom' in restored, false);
  assert.equal('ended' in restored, false);
});

test('the record is written again when the session moves on, never as an answer is typed or shown', () => {
  const current = session({ revealed: false, typedAnswer: '' });
  const changed = (next: StudySession) => recordChanged(current, next);
  assert.equal(recordChanged(null, current), true, 'a session starts');
  assert.equal(changed({ ...current, typedAnswer: 'ran' }), false, 'typing');
  assert.equal(changed({ ...current, revealed: true }), false, 'showing the answer');
  assert.equal(changed({ ...current, index: 3 }), true, 'another card');
  assert.equal(changed({ ...current, grades: [...current.grades, { itemId: 'c', rating: 'easy', at: NOW, totalReviews: 1 }] }), true, 'a grade');
  assert.equal(changed({ ...current, grades: current.grades.slice(0, -1) }), true, 'an undo');
  assert.equal(changed({ ...current, itemIds: [...current.itemIds, 'c'] }), true, 'a card brought back');
  assert.equal(changed({ ...current, id: 'session-2' }), true, 'another session');
});

test('the device keeps one record, which reading, writing and clearing reach even when storage fails', t => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });
  assert.equal(STUDY_SESSION_KEY, 'study_session_v2');
  assert.equal(readStoredStudySession(), null);
  writeStoredStudySession('{"version":2}');
  assert.equal(storage.getItem('study_session_v2'), '{"version":2}');
  assert.equal(readStoredStudySession(), '{"version":2}');
  clearStoredStudySession();
  assert.equal(readStoredStudySession(), null);

  // Storage that refuses: nothing throws, and nothing is read.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  assert.equal(readStoredStudySession(), null);
  assert.doesNotThrow(() => writeStoredStudySession('{}'));
  assert.doesNotThrow(() => clearStoredStudySession());
});

test('signing out clears the record, while a sign-out that couldn\'t reach the server keeps it with the session', async t => {
  const storage = new MemoryStorage();
  const globals = globalThis as unknown as Record<string, unknown>;
  const realFetch = globalThis.fetch;
  const realWindow = globals.window;
  let reloads = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  globals.window = { ...(realWindow as object), location: { reload: () => { reloads++; } } };
  t.after(() => {
    globalThis.fetch = realFetch;
    globals.window = realWindow;
    Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const { logout } = await import('../../services/auth.ts');
  storage.setItem(STUDY_SESSION_KEY, recordJson());

  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
  assert.equal(await logout(), false);
  assert.notEqual(storage.getItem(STUDY_SESSION_KEY), null, 'still signed in, so the session can still be taken up');

  globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
  assert.equal(await logout(), true);
  assert.equal(storage.getItem(STUDY_SESSION_KEY), null);
  assert.equal(reloads, 1);
});

const card = (id: string): StoredItem => ({
  type: 'vocab',
  data: {
    id, word: `word-${id}`, chinese: '', ipa: '', definition: '', synonyms: [], antonyms: [], confusables: [], examples: [],
    history: '', register: '', mnemonic: '',
  },
  srs: { id, type: 'vocab', nextReview: 0, interval: 0, memoryStrength: 0, lastReviewDate: 0, totalReviews: 0, correctStreak: 0, stability: 0.5 },
  savedAt: 0,
});

test('the study screen takes a session up at its card after a reload, and clears a record it can\'t take up', t => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });
  t.mock.method(Date, 'now', () => NOW);
  const items = ['a', 'b', 'c', 'd'].map(card);
  const render = (userId: string) => renderToStaticMarkup(createElement(StudyEnhanced, {
    userId, items, reviewHistory: { recent: [], olderTimes: [], olderCount: 0 },
    onReview: async () => true, onUndoReview: async () => true, onOpenExampleSentence: () => {}, onViewCards: () => {},
  }));
  storage.setItem(STUDY_SESSION_KEY, encodeStudySession(session(), USER, NOW - HOUR / 2));

  // At the third of its four cards, word-c, with the answer hidden.
  const restored = render(USER);
  assert.match(restored, /<span class="text-sm font-semibold text-slate-600">3 \/ 4<\/span>/);
  assert.match(restored, />word-c</);
  assert.match(restored, /<\/svg> Show answer<\/button>/);

  // Another user's record goes.
  assert.match(render('user-2'), /Today&#x27;s Study/);
  assert.equal(storage.getItem(STUDY_SESSION_KEY), null);

  // A record whose cards have all been reviewed elsewhere since has nothing left, and goes too.
  storage.setItem(STUDY_SESSION_KEY, encodeStudySession(session({ itemIds: ['a', 'b', 'c'] }), USER, NOW - HOUR / 2));
  const reviewedElsewhere = items.map(item => ({ ...item, srs: { ...item.srs, totalReviews: 1, lastReviewDate: NOW - 60_000 } }));
  assert.match(renderToStaticMarkup(createElement(StudyEnhanced, {
    userId: USER, items: reviewedElsewhere, reviewHistory: { recent: [], olderTimes: [], olderCount: 0 },
    onReview: async () => true, onUndoReview: async () => true, onOpenExampleSentence: () => {}, onViewCards: () => {},
  })), /Today&#x27;s Study/);
  assert.equal(storage.getItem(STUDY_SESSION_KEY), null);
});

test('a session taken up from a record written before grades kept their review count still shows the card it brought back', t => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => { Reflect.deleteProperty(globalThis, 'localStorage'); });
  t.mock.method(Date, 'now', () => NOW);
  // a was rated Again, then b Good; a's own review is its only one since, and it comes back at the end.
  const gradedAt = { a: NOW - HOUR + 20_000, b: NOW - HOUR + 40_000 };
  const items = ['a', 'b'].map(id => {
    const item = card(id);
    return { ...item, srs: { ...item.srs, totalReviews: 1, lastReviewDate: gradedAt[id as 'a' | 'b'] } };
  });
  storage.setItem(STUDY_SESSION_KEY, recordJson({
    itemIds: ['a', 'b', 'a'], index: 2,
    grades: [{ itemId: 'a', rating: 'again', at: gradedAt.a }, { itemId: 'b', rating: 'good', at: gradedAt.b }],
  }));
  const markup = renderToStaticMarkup(createElement(StudyEnhanced, {
    userId: USER, items, reviewHistory: { recent: [], olderTimes: [], olderCount: 0 },
    onReview: async () => true, onUndoReview: async () => true, onOpenExampleSentence: () => {}, onViewCards: () => {},
  }));
  assert.match(markup, /<span class="text-sm font-semibold text-slate-600">3 \/ 3<\/span>/);
  assert.match(markup, />word-a</);
});
