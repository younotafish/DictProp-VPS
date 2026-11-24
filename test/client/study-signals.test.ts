import assert from 'node:assert/strict';
import test from 'node:test';
import type { SentenceData, StoredItem } from '../../types.ts';
import { parseStudyEvent, type StudyEvent } from '../../server/src/shared/study-events.ts';
import { StudyExposure, exitBetween, type ExposureStart } from '../../views/detail/studyExposure.ts';
import {
  MAX_QUEUED_STUDY_EVENTS, flushStudyEvents, queueStudyEvent, readQueuedStudyEvents,
} from '../../services/studyEvents.ts';
import { withLearnLater } from '../../views/detail/speechStyle.ts';
import { handleSentenceKey, type SentenceKeyHandlers } from '../../views/detail/cardKeys.ts';

// The sentence lesson's study signals: an exposure's arithmetic (views/detail/studyExposure.ts), the queue that holds
// them until the server takes them (services/studyEvents.ts), and Learn later (speechStyle.ts withLearnLater, the L key).

const T0 = 1_700_000_000_000;

const start = (fields: Partial<ExposureStart> = {}): ExposureStart => ({
  id: 'exposure-1', itemId: 'sentence-1', sessionId: 'set:u1', from: 'Today', position: 2, runLength: 12,
  learnLater: false,
  srs: {
    id: 'sentence-1', type: 'sentence', nextReview: T0 - 1, interval: 0, memoryStrength: 20, lastReviewDate: T0 - 86_400_000,
    totalReviews: 2, correctStreak: 2, stability: 2.5, difficulty: 5, lapses: 0,
  },
  ...fields,
});

test('time counts only while the page shows, and analysis time only while its page is open on a shown page', () => {
  const exposure = new StudyExposure(start(), T0, true, -480);
  exposure.setAnalysisOpen(true, T0 + 1_000);
  exposure.setVisible(false, T0 + 3_000); // 2 s of analysis, then hidden for a minute
  exposure.setVisible(true, T0 + 63_000);
  exposure.setAnalysisOpen(false, T0 + 64_000); // 1 s more of analysis
  exposure.noteGotIt(T0 + 66_000);
  exposure.noteGotIt(T0 + 67_000);
  const event = exposure.snapshot(T0 + 70_000, 'next', true);
  assert.equal(event.visibleMs, 10_000);
  assert.equal(event.analysisMs, 3_000);
  assert.equal(event.analysisOpens, 1);
  assert.equal(event.gotIts, 2);
  assert.equal(event.firstGotItMs, 6_000);
  assert.equal(event.tzOffset, -480);
  assert.deepEqual(event.srs, { totalReviews: 2, stability: 2.5, difficulty: 5, lapses: 0, lastReviewDate: T0 - 86_400_000, nextReview: T0 - 1 });
  assert.deepEqual(parseStudyEvent(event), event, 'what the client builds is what the server accepts');
});

test('plays, listens, lookups and the star are counted; a sentence passed over at once is not kept', () => {
  const passed = new StudyExposure(start(), T0, true);
  assert.equal(passed.worthKeeping(T0 + 200), false);
  assert.equal(passed.worthKeeping(T0 + 300), true);

  const exposure = new StudyExposure(start({ srs: undefined }), T0, true, 0);
  exposure.notePlay(false);
  exposure.notePlay(true);
  exposure.noteListen();
  exposure.noteLookup('  come clean ');
  exposure.noteLookup('x'.repeat(200));
  exposure.noteCardOpen();
  exposure.noteStyleSwitch();
  exposure.noteAutoplay();
  exposure.setLearnLater(true);
  assert.equal(exposure.worthKeeping(T0 + 10), true);
  const event = exposure.snapshot(T0 + 10, 'close', true);
  assert.equal(event.plays, 1);
  assert.equal(event.autoPlays, 1);
  assert.equal(event.listens, 1);
  assert.equal(event.lookups, 2);
  assert.deepEqual(event.lookupTerms, ['come clean', 'x'.repeat(80)]);
  assert.equal(event.cardOpens, 1);
  assert.equal(event.styleSwitches, 1);
  assert.equal(event.autoplay, true);
  assert.equal(event.learnLater, true);
  assert.equal(event.learnLaterAtStart, false);
  assert.equal(event.firstGotItMs, undefined);
  assert.deepEqual(event.srs, { totalReviews: 0, stability: 0, lastReviewDate: 0, nextReview: 0 });
  assert.deepEqual(parseStudyEvent(event), event);

  // Only a star changed: still kept, though nothing else happened.
  const starred = new StudyExposure(start(), T0, true);
  starred.setLearnLater(true);
  assert.equal(starred.worthKeeping(T0 + 10), true);
});

test('how one sentence was left for another', () => {
  assert.equal(exitBetween(2, 3, false), 'next');
  assert.equal(exitBetween(3, 2, false), 'prev');
  assert.equal(exitBetween(2, 3, true), 'auto');
  assert.equal(exitBetween(2, 2, false), 'other');
  assert.equal(exitBetween(2, null, false), 'other');
});

/** In-memory localStorage that lists its keys. */
function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

const event = (id: string, startedAt: number, fields: Partial<StudyEvent> = {}): StudyEvent =>
  ({ ...new StudyExposure(start({ id }), startedAt, true, 0).snapshot(startedAt + 1_000, 'next', true), ...fields });

test('the queue keeps one copy per exposure per user, oldest first, and drops new ones once full', () => {
  const storage = memoryStorage();
  queueStudyEvent('u1', event('b', T0 + 10), storage);
  queueStudyEvent('u1', event('a', T0), storage);
  queueStudyEvent('u1', event('a', T0, { gotIts: 1 }), storage); // the newer copy replaces the older
  queueStudyEvent('u2', event('c', T0), storage);
  storage.setItem('study_events_pending_u1:broken', '{');
  assert.deepEqual(readQueuedStudyEvents('u1', storage).map(e => [e.id, e.gotIts]), [['a', 1], ['b', 0]]);
  assert.equal(storage.getItem('study_events_pending_u1:broken'), null, 'a damaged entry is removed');
  assert.deepEqual(readQueuedStudyEvents('u2', storage).map(e => e.id), ['c']);

  const full = memoryStorage();
  for (let index = 0; index < MAX_QUEUED_STUDY_EVENTS; index++) full.map.set(`study_events_pending_u1:${index}`, '{}');
  queueStudyEvent('u1', event('late', T0), full);
  assert.equal(full.getItem('study_events_pending_u1:late'), null);
});

test('a flush sends batches and removes what was taken, keeps a copy queued meanwhile, and stops at a failure', async () => {
  const storage = memoryStorage();
  queueStudyEvent('u1', event('a', T0), storage);
  queueStudyEvent('u1', event('b', T0 + 1), storage);
  const sent: StudyEvent[][] = [];
  await flushStudyEvents('u1', {
    storage,
    send: async (events) => {
      sent.push(events);
      if (sent.length > 1) return;
      // While the first request is out, the lesson queues a newer copy of 'b' and a new exposure.
      queueStudyEvent('u1', event('b', T0 + 1, { gotIts: 1 }), storage);
      queueStudyEvent('u1', event('c', T0 + 2), storage);
    },
  });
  assert.deepEqual(sent.map(batch => batch.map(e => `${e.id}:${e.gotIts}`)), [['a:0', 'b:0'], ['b:1', 'c:0']]);
  assert.deepEqual(readQueuedStudyEvents('u1', storage), []);

  const failing = memoryStorage();
  queueStudyEvent('u1', event('x', T0), failing);
  await flushStudyEvents('u1', { storage: failing, send: async () => { throw new Error('offline'); } });
  assert.deepEqual(readQueuedStudyEvents('u1', failing).map(e => e.id), ['x']);

  const once = memoryStorage();
  for (let index = 0; index < 45; index++) queueStudyEvent('u1', event(`k${index}`, T0 + index), once);
  const keepaliveBatches: number[] = [];
  await flushStudyEvents('u1', { storage: once, keepalive: true, send: async (events, keepalive) => {
    assert.equal(keepalive, true);
    keepaliveBatches.push(events.length);
  } });
  assert.deepEqual(keepaliveBatches, [40], 'a hiding page sends one small batch');
  assert.equal(readQueuedStudyEvents('u1', once).length, 5);
});

const sentence = (learnLater?: number): StoredItem => ({
  type: 'sentence',
  data: { id: 's1', text: 'He came clean.', sourceWord: 'come clean', ...(learnLater ? { learnLater } : {}) },
  savedAt: T0 - 1_000,
  updatedAt: T0 - 500,
  srs: start().srs!,
});

test('Learn later stars a sentence with the time, takes the star away, and writes nothing when already as asked', () => {
  const plain = sentence();
  const starred = withLearnLater(plain, true, T0);
  assert.equal((starred?.data as SentenceData).learnLater, T0);
  assert.equal(starred?.updatedAt, T0);
  assert.equal(starred?.srs, plain.srs);
  assert.equal(withLearnLater(sentence(5), true, T0), null);
  const unstarred = withLearnLater(sentence(5), false, T0);
  assert.equal('learnLater' in (unstarred?.data ?? {}), false);
  assert.equal(withLearnLater(plain, false, T0), null);
});

test('L toggles Learn later where the sentence can be starred, and does nothing elsewhere', () => {
  const done: string[] = [];
  const handlers = (toggle?: () => void): SentenceKeyHandlers => ({
    title: '', speakSentenceAt: () => {}, readCurrentSentence: () => {}, isSentencePreview: false,
    catalogSentencePreview: false, handleRemember: () => {}, handleResetSRS: () => {}, handleDeleteItem: () => {},
    onSpace: () => {}, handleToggleLearnLater: toggle,
  });
  const press = (key: string, modifiers: { shiftKey?: boolean; metaKey?: boolean } = {}) => {
    const e = { key, repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers, prevented: false,
      preventDefault() { e.prevented = true; } };
    return e;
  };
  const l = press('l');
  handleSentenceKey(l, handlers(() => done.push('toggle')));
  handleSentenceKey(press('L', { metaKey: true }), handlers(() => done.push('cmd-l')));
  const unstarrable = press('l');
  handleSentenceKey(unstarrable, handlers(undefined));
  assert.deepEqual(done, ['toggle']);
  assert.equal(l.prevented, true);
  assert.equal(unstarrable.prevented, false);
});
