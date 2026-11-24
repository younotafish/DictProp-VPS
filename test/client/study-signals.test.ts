import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStudyEvent, type StudyEvent } from '../../server/src/shared/study-events.ts';
import { StudyExposure, exitBetween, type ExposureStart } from '../../views/detail/studyExposure.ts';
import {
  MAX_QUEUED_STUDY_EVENTS, flushStudyEvents, queueStudyEvent, readQueuedStudyEvents,
} from '../../services/studyEvents.ts';
import {
  applyServerLearnLater, flushLearnLater, learnLaterKnown, learnLaterState, setLearnLater, syncLearnLater,
} from '../../services/learnLater.ts';
import { handleSentenceKey, type SentenceKeyHandlers } from '../../views/detail/cardKeys.ts';
import { deviceKind } from '../../services/platform.ts';
import { hasWaitingSignals } from '../../hooks/useWaitingSignalsFlush.ts';

// The sentence lesson's study signals: an exposure's arithmetic (views/detail/studyExposure.ts), the queue that holds
// them until the server takes them (services/studyEvents.ts), and Learn later (services/learnLater.ts, the L key).

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
  assert.equal(event.engagedMs, 10_000);
  assert.equal(event.version, 2);
  assert.equal(event.analysisMs, 3_000);
  assert.equal(event.analysisOpens, 1);
  assert.equal(event.gotIts, 2);
  assert.equal(event.firstGotItMs, 6_000);
  assert.equal(event.tzOffset, -480);
  assert.deepEqual(event.srs, { totalReviews: 2, stability: 2.5, difficulty: 5, lapses: 0, lastReviewDate: T0 - 86_400_000, nextReview: T0 - 1 });
  assert.deepEqual(parseStudyEvent(event), event, 'what the client builds is what the server accepts');
});

test('a screen left on stops counting as engaged after a minute without an action, but listening counts in full', () => {
  const exposure = new StudyExposure(start(), T0, true, 0);
  exposure.noteActivity(T0 + 20_000); // reading: 20 s
  // Walked away for 20 minutes with the window still focused: only the first minute of the gap is engaged.
  exposure.noteActivity(T0 + 20_000 + 20 * 60_000);
  const back = T0 + 20_000 + 20 * 60_000;
  // Auto-play reads it for three minutes without a tap: listening, all of it engaged.
  exposure.setPlaying(true, back);
  exposure.setPlaying(false, back + 3 * 60_000);
  // Another app's window in front for ten minutes: neither visible nor engaged time.
  exposure.setVisible(false, back + 3 * 60_000 + 5_000);
  exposure.setVisible(true, back + 13 * 60_000 + 5_000);
  exposure.noteGotIt(back + 13 * 60_000 + 8_000);
  const event = exposure.snapshot(back + 13 * 60_000 + 8_000, 'next', true);
  // The 5 s after the audio, before the window lost focus, came with no action and past the minute: not engaged.
  assert.equal(event.engagedMs, 20_000 + 60_000 + 180_000 + 3_000);
  assert.equal(event.firstGotItMs, event.engagedMs);
  assert.equal(event.visibleMs, 20_000 + 20 * 60_000 + 180_000 + 5_000 + 3_000);
  assert.deepEqual(parseStudyEvent(event), event);
});

test('audio in the middle of an idle gap adds its own length, never a fresh minute', () => {
  // A tap starts a read that loads for 90 s, plays for 5 s, and Got it comes 65 s after the tap's minute ran out.
  const exposure = new StudyExposure(start(), T0, true, 0);
  exposure.noteActivity(T0);
  exposure.setPlaying(true, T0 + 90_000);
  exposure.setPlaying(false, T0 + 95_000);
  exposure.noteGotIt(T0 + 160_000);
  const event = exposure.snapshot(T0 + 160_000, 'next', true);
  assert.equal(event.engagedMs, 65_000);
  assert.equal(event.firstGotItMs, 65_000);
  // Coming back to the lesson is evidence the learner is there: a fresh allowance from then.
  const back = new StudyExposure(start(), T0, true, 0);
  back.setVisible(false, T0 + 10_000);
  back.setVisible(true, T0 + 600_000);
  assert.equal(back.snapshot(T0 + 630_000, 'next', true).engagedMs, 40_000);
});

test("auto-play moving on carries the learner's last action, and durations run on the caller's clock", () => {
  // The learner's last tap was 50 s before auto-play moved to this sentence: 10 s of allowance left, not a fresh minute.
  const exposure = new StudyExposure(start(), 1_000_000, true, 0, { wallStart: T0, lastAction: 950_000 });
  const event = exposure.snapshot(1_000_000 + 120_000, 'auto', true);
  assert.equal(event.engagedMs, 10_000);
  assert.equal(event.visibleMs, 120_000);
  // Wall times come from wallStart plus elapsed time, whatever the device clock did meanwhile.
  assert.equal(event.startedAt, T0);
  assert.equal(event.endedAt, T0 + 120_000);
});

test('analysis time takes the same idle cap, and a read heard while away is counted apart', () => {
  const exposure = new StudyExposure(start(), T0, true, 0);
  exposure.setAnalysisOpen(true, T0 + 5_000);
  exposure.noteActivity(T0 + 15_000); // 10 s reading the analysis
  // Left on the analysis page for half an hour, the window still focused: a minute of it counts.
  exposure.setAnalysisOpen(false, T0 + 15_000 + 30 * 60_000);
  exposure.noteListen();
  exposure.setVisible(false, T0 + 15_000 + 30 * 60_000 + 1_000);
  exposure.noteListen(); // auto-play behind a locked screen
  const event = exposure.snapshot(T0 + 15_000 + 30 * 60_000 + 1_000, 'auto', true);
  assert.equal(event.analysisMs, 70_000);
  assert.equal(event.engagedMs, 5_000 + 70_000);
  assert.equal(event.listens, 1);
  assert.equal(event.listensAway, 1);
  assert.deepEqual(parseStudyEvent(event), event);
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
  exposure.setLearnLater(true, true);
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
  starred.setLearnLater(true, true);
  // A star synced from another device is the state, not a toggle made here.
  const synced = new StudyExposure(start(), T0, true);
  synced.setLearnLater(true);
  assert.equal(synced.worthKeeping(T0 + 10), false);
  assert.equal(synced.snapshot(T0 + 10, 'next', true).learnLater, true);
  assert.equal(synced.snapshot(T0 + 10, 'next', true).learnLaterToggles, undefined);
  assert.equal(starred.worthKeeping(T0 + 10), true);
});

test("each device's kind is told apart, an iPad presenting itself as a Mac included, and travels with the event", () => {
  const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
  assert.equal(deviceKind({ userAgent: SAFARI_MAC, platform: 'MacIntel', maxTouchPoints: 0 }), 'mac');
  // iPadOS Safari's desktop-class mode: a Mac's user agent, but touch points.
  assert.equal(deviceKind({ userAgent: SAFARI_MAC, platform: 'MacIntel', maxTouchPoints: 5 }), 'ipad');
  assert.equal(deviceKind({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5 }), 'ipad');
  assert.equal(deviceKind({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', platform: 'iPhone', maxTouchPoints: 5 }), 'iphone');
  assert.equal(deviceKind({ userAgent: 'Mozilla/5.0 (Linux; Android 15)', platform: 'Linux armv8l', maxTouchPoints: 5 }), 'android');
  assert.equal(deviceKind({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 0 }), 'windows');
  assert.equal(deviceKind(undefined), 'other');

  const event = new StudyExposure(start({ device: 'ipad', standalone: true }), T0, true, 0).snapshot(T0 + 1_000, 'next', true);
  assert.equal(event.device, 'ipad');
  assert.equal(event.standalone, true);
  assert.deepEqual(parseStudyEvent(event), event);
  assert.equal(parseStudyEvent({ ...event, device: 'toaster' }), null);
});

test('how one sentence was left for another', () => {
  assert.equal(exitBetween(2, 3, false), 'next');
  assert.equal(exitBetween(3, 2, false), 'prev');
  assert.equal(exitBetween(2, 3, true), 'auto');
  // A sentence deleted at the end of the run while auto-play is on falls back a place: not auto-play's move.
  assert.equal(exitBetween(3, 2, true), 'prev');
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

test('a flush asked for while one is out runs again after it, so a reconnect during a failing request is not lost', async () => {
  const storage = memoryStorage();
  queueStudyEvent('u1', event('r1', T0), storage);
  let calls = 0;
  let failFirst!: (error: Error) => void;
  const first = flushStudyEvents('u1', { storage, send: () => {
    calls++;
    return calls === 1 ? new Promise<void>((_, reject) => { failFirst = reject; }) : Promise.resolve();
  } });
  await flushStudyEvents('u1', { storage, send: async () => { throw new Error('not this one'); } }); // the 'online' trigger
  failFirst(new Error('network changed'));
  await first;
  assert.equal(calls, 2);
  assert.deepEqual(readQueuedStudyEvents('u1', storage), []);
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
  await flushStudyEvents('u1', { storage: once, keepalive: true, now: 1_000_000, send: async (events, keepalive) => {
    assert.equal(keepalive, true);
    keepaliveBatches.push(events.length);
  } });
  assert.deepEqual(keepaliveBatches, [40], 'a hiding page sends one small batch');
  assert.equal(readQueuedStudyEvents('u1', once).length, 5);
});

test('a hiding page sends the running copy first, even while another flush is out, and batches stay under the size caps', async () => {
  const storage = memoryStorage();
  for (let index = 0; index < 45; index++) queueStudyEvent('u1', event(`old${index}`, T0 + index), storage);
  queueStudyEvent('u1', event('running', T0 + 100, { final: false }), storage);
  let release!: () => void;
  const slow = flushStudyEvents('u1', { storage, send: () => new Promise<void>(resolve => { release = resolve; }) });
  const keepalive: string[][] = [];
  // The running copy goes as it is, even one storage refused (here: never queued at all).
  const unqueued = event('running-now', T0 + 200, { final: false });
  await flushStudyEvents('u1', { storage, keepalive: true, now: 2_000_000, current: unqueued, send: async (events) => { keepalive.push(events.map(e => e.id)); } });
  // visibilitychange and pagehide back to back: the second keepalive waits for the next foreground.
  await flushStudyEvents('u1', { storage, keepalive: true, now: 2_000_500, send: async (events) => { keepalive.push(events.map(e => e.id)); } });
  assert.equal(keepalive.length, 1, 'not held back by the flush in flight');
  assert.equal(keepalive[0][0], 'running-now');
  release();
  await slow;

  const big = memoryStorage();
  const term = '词'.repeat(80);
  for (let index = 0; index < 40; index++) {
    queueStudyEvent('u1', event(`big${index}`, T0 + index, { lookups: 10, lookupTerms: Array.from({ length: 10 }, () => term) }), big);
  }
  const sizes: number[] = [];
  await flushStudyEvents('u1', { storage: big, keepalive: true, now: 3_000_000, send: async (events) => {
    sizes.push(new TextEncoder().encode(JSON.stringify({ events })).length);
  } });
  assert.ok(sizes[0] < 60 * 1024, `keepalive body ${sizes[0]} bytes`);
});

test('a hiding page with no storage at all still sends the running copy', async () => {
  const sent: string[] = [];
  await flushStudyEvents('u1', { storage: null, keepalive: true, now: 9_000_000, current: event('alone', T0, { final: false }),
    send: async (events) => { sent.push(...events.map(e => e.id)); } });
  assert.deepEqual(sent, ['alone']);
});

test("the offset from UTC is read at the exposure's wall-clock start, not from the monotonic clock", () => {
  const july = Date.UTC(2026, 6, 1, 12);
  const exposure = new StudyExposure(start(), 5_000, true, undefined, { wallStart: july });
  assert.equal(exposure.snapshot(6_000, 'next', true).tzOffset, -new Date(july).getTimezoneOffset());
});

test('a star shows at once, waits for the server, and the later change wins wherever it was made', async () => {
  const storage = memoryStorage();
  assert.equal(learnLaterState('u1', 's1', storage).starred, false);
  const star = setLearnLater('u1', 's1', true, T0, storage)!;
  assert.equal(star.changedAt, T0);
  assert.deepEqual(learnLaterState('u1', 's1', storage), { starred: true, changedAt: T0 });

  // Offline: the send fails, the star stays shown and waiting.
  await flushLearnLater('u1', { storage, send: async () => { throw new Error('offline'); } });
  assert.equal(learnLaterState('u1', 's1', storage).starred, true);

  // The server holds an older unstar from another device: the star made here is later, stays, and goes up.
  const sent: unknown[] = [];
  await syncLearnLater('u1', {
    storage,
    load: async () => ({ items: { s1: { starred: false, changedAt: T0 - 5_000 }, s2: { starred: true, changedAt: T0 - 1 } } }),
    send: async (changes) => { sent.push(...changes); return { accepted: changes.length, rejected: 0, items: {} }; },
  });
  assert.deepEqual(sent, [{ itemId: 's1', starred: true, changedAt: T0 }]);
  assert.deepEqual(learnLaterState('u1', 's1', storage), { starred: true, changedAt: T0 });
  assert.equal(learnLaterState('u1', 's2', storage).starred, true, "another device's star shows here");

  // An unstar on another device after the star here wins once read, and drops nothing waiting that is newer.
  applyServerLearnLater('u1', { s1: { starred: false, changedAt: T0 + 10_000 } }, storage);
  assert.equal(learnLaterState('u1', 's1', storage).starred, false);
});

test("a change that lost to a later one on the server shows the winner at once, and an item id can be any string", async () => {
  const storage = memoryStorage();
  // The iPad unstars, but the Mac (clock ahead) starred it later: the server keeps the star and says so.
  setLearnLater('u1', 's1', false, T0, storage);
  await flushLearnLater('u1', { storage, send: async () => ({
    accepted: 1, rejected: 0, items: { s1: { starred: true, changedAt: T0 + 60_000 } },
  }) });
  assert.deepEqual(learnLaterState('u1', 's1', storage), { starred: true, changedAt: T0 + 60_000 });
  // One PUT's answer isn't a full read: an unstarred sentence isn't known to be unstarred yet.
  assert.equal(learnLaterKnown('u1', storage), false);
  await syncLearnLater('u1', { storage, load: async () => ({ items: {} }), send: async (changes) => ({ accepted: changes.length, rejected: 0, items: {} }) });
  assert.equal(learnLaterKnown('u1', storage), true);
  assert.equal(learnLaterKnown('u2', storage), false);

  for (const odd of ['__proto__', 'constructor', 'toString']) {
    assert.deepEqual(learnLaterState('u1', odd, storage), { starred: false, changedAt: 0 });
    setLearnLater('u1', odd, true, T0, storage);
    await flushLearnLater('u1', { storage, send: async (changes) => ({ accepted: changes.length, rejected: 0, items: {} }) });
    assert.deepEqual(learnLaterState('u1', odd, storage), { starred: true, changedAt: T0 });
  }
});

test("one tab's cleanup never takes another tab's newer change of the same sentence", async () => {
  const storage = memoryStorage();
  setLearnLater('u1', 's1', true, T0, storage); // tab A
  const batches: unknown[][] = [];
  await flushLearnLater('u1', { storage, send: async (changes) => {
    batches.push(changes);
    // Tab B unstars while A's first request is out: a key of its own.
    if (batches.length === 1) setLearnLater('u1', 's1', false, T0 + 1_000, storage);
    const last = changes[changes.length - 1];
    return { accepted: changes.length, rejected: 0, items: { s1: { starred: last.starred, changedAt: last.changedAt } } };
  } });
  assert.deepEqual(batches, [
    [{ itemId: 's1', starred: true, changedAt: T0 }],
    [{ itemId: 's1', starred: false, changedAt: T0 + 1_000 }],
  ]);
  // A's flush ran again for B's change (the loop's next round): the unstar went too, and shows.
  assert.equal(learnLaterState('u1', 's1', storage).starred, false);
});

test("an older answer from one tab never overwrites another tab's newer word, item by item", () => {
  const storage = memoryStorage();
  // Tab B's full read landed: S starred.
  applyServerLearnLater('u1', { S: { starred: true, changedAt: T0 + 5_000 } }, storage);
  // Tab A, holding an answer read earlier, applies it after: S older and unstarred, T new.
  applyServerLearnLater('u1', { S: { starred: false, changedAt: T0 }, T: { starred: true, changedAt: T0 } }, storage);
  assert.deepEqual(learnLaterState('u1', 'S', storage), { starred: true, changedAt: T0 + 5_000 });
  assert.deepEqual(learnLaterState('u1', 'T', storage), { starred: true, changedAt: T0 });
});

test("an unstar's time moves past the star's, even when the star was set by a clock running fast", () => {
  const storage = memoryStorage();
  setLearnLater('u1', 's1', true, T0 + 3_600_000, storage); // clock an hour ahead
  const unstar = setLearnLater('u1', 's1', false, T0, storage)!; // clock corrected
  assert.equal(unstar.changedAt, T0 + 3_600_001);
  assert.equal(learnLaterState('u1', 's1', storage).starred, false);
  assert.equal(learnLaterState('u2', 's1', storage).starred, false, "another user's stars are their own");
});

test('the app knows whether a lesson left signals or stars waiting, for its user only', () => {
  const storage = memoryStorage();
  assert.equal(hasWaitingSignals('u1', storage), false);
  storage.setItem('learn_later_v1:u1', '{}');
  assert.equal(hasWaitingSignals('u1', storage), false, 'the cache of known stars is nothing to send');
  storage.setItem('learn_later_pending_u2:s1', '{}');
  assert.equal(hasWaitingSignals('u1', storage), false);
  storage.setItem('study_events_pending_u1:e1', '{}');
  assert.equal(hasWaitingSignals('u1', storage), true);
  assert.equal(hasWaitingSignals('u1', null), false);
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
