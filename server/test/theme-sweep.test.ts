import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatClient } from '../src/ai-client.js';
import type { FetchLike } from '../src/proxy-fetch.js';
import { THEME_TAXONOMY_VERSION, THEMES } from '../src/shared/item-themes.js';
import { themeInput } from '../src/themes/input.js';
import { createThemeSweep, type ThemeSweepOptions } from '../src/themes/sweep.js';
import { httpStatus, reply, type Responder } from './support/ai.js';
import { srs } from './support/fixtures.js';

const { db, getThemeRowsAfter, recordThemeResults, upsertItem } = await import('../src/db.js');

const [A, B] = THEMES.map(theme => theme.id);
const MINUTE = 60_000;

/**
 * Saves the user's own sentences, the later in the list the newer, each named in its id by its text; they are never
 * reviewed, except the `reviewed` ones.
 */
function saveSentences(userId: string, texts: readonly string[], { reviewed = [] as readonly string[], from = 1 } = {}) {
  texts.forEach((text, index) => {
    const id = `${userId}:${text}`;
    upsertItem({
      type: 'sentence',
      data: { id, text, sourceWord: 'word' },
      srs: reviewed.includes(text) ? { ...srs(id, 'sentence'), totalReviews: 2, lastReviewDate: 5 } : srs(id, 'sentence'),
      savedAt: from + index,
    }, userId);
  });
}

/**
 * DeepInfra as the sweep's chat client meets it: `respond` answers each request from the sentences it asks about, by
 * default giving each sentence the theme `scene(text)` returns (none for null).
 */
function provider(respond: (texts: string[]) => Responder | Promise<Responder>) {
  const asked: string[][] = [];
  const fetch: FetchLike = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    const texts = [...body.messages[1].content.matchAll(/^\d+\. sentence "(.*)"$/gm)].map(match => match[1]);
    asked.push(texts);
    return (await respond(texts))(init);
  };
  return { chat: createChatClient({ fetch, apiKey: () => 'test-key', retryDelayMs: 0 }), asked };
}
const answering = (scene: (text: string) => string | null = () => A) => (texts: string[]) =>
  reply({ a: texts.flatMap((text, index) => (scene(text) ? [{ i: index + 1, t: scene(text) }] : [])) });

/** A clock the test moves: timers run when it passes them. */
function manualClock(start = 1_000_000) {
  let time = start;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  return {
    now: () => time,
    setTimer: (run: () => void, ms: number) => {
      const timer = { at: time + ms, run, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
    advance(ms: number) {
      time += ms;
      for (const timer of timers.filter(entry => entry.live && entry.at <= time)) {
        timer.live = false;
        timer.run();
      }
    },
    liveTimers: () => timers.filter(timer => timer.live).length,
  };
}

function sweepWith(chat: ThemeSweepOptions['chat'], clock = manualClock(), options: ThemeSweepOptions = {}) {
  return { sweep: createThemeSweep({ chat, model: 'test-model', now: clock.now, setTimer: clock.setTimer, ...options }), clock };
}

const themed = (userId: string) => Object.fromEntries(getThemeRowsAfter(userId, 0).rows.map(([itemId, themeId]) => [itemId.split(':')[1], themeId]));

test('a sweep labels every sentence that needs a theme, a batch at a time with never-reviewed ones first, and reports its progress', async () => {
  const user = 'sweep-labels';
  saveSentences(user, ['old', 'older-seen', 'middle', 'newest-seen', 'newest'], { reviewed: ['older-seen', 'newest-seen'] });
  const fake = provider(answering());
  const { sweep } = sweepWith(fake.chat, manualClock(), { batchSize: 2 });

  assert.deepEqual(await sweep.report(user), { pending: 5, status: 'running' });
  await sweep.idle(user);
  assert.deepEqual(fake.asked, [['newest', 'middle'], ['old', 'newest-seen'], ['older-seen']]);
  assert.deepEqual(themed(user), { old: A, 'older-seen': A, middle: A, 'newest-seen': A, newest: A });
  assert.deepEqual(await sweep.report(user), { pending: 0, status: 'idle' });
  assert.equal(fake.asked.length, 3, 'nothing waits, so no sweep starts');
});

test('one sweep at a time: a trigger while it runs starts nothing, and a sentence saved meanwhile is labelled before it ends', async () => {
  const user = 'sweep-single-flight';
  saveSentences(user, ['first', 'second']);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const fake = provider(async (texts) => {
    if (texts.includes('first')) await released;
    return answering()(texts);
  });
  const { sweep, clock } = sweepWith(fake.chat);

  sweep.trigger(user);
  await new Promise(resolve => setTimeout(resolve, 10));
  sweep.trigger(user);
  assert.equal(fake.asked.length, 1);
  saveSentences(user, ['saved-meanwhile'], { from: 10 });
  sweep.noteItemWrite(user);
  release();
  await sweep.idle(user);
  assert.deepEqual(fake.asked, [['second', 'first'], ['saved-meanwhile']]);
  assert.deepEqual(themed(user), { first: A, second: A, 'saved-meanwhile': A });

  // The write's own trigger comes later and finds nothing to do.
  clock.advance(30_000);
  await sweep.idle(user);
  assert.equal(fake.asked.length, 2);
});

test('it starts on its own a minute after the server starts, and half a minute after the last of a burst of writes', async () => {
  const user = 'sweep-triggers';
  saveSentences(user, ['at-start']);
  const fake = provider(answering());
  const { sweep, clock } = sweepWith(fake.chat);

  sweep.startAfterDelay(() => [user]);
  clock.advance(MINUTE - 1);
  assert.equal(fake.asked.length, 0);
  clock.advance(1);
  await sweep.idle(user);
  assert.deepEqual(fake.asked, [['at-start']]);

  for (const [index, text] of ['burst-1', 'burst-2', 'burst-3'].entries()) {
    saveSentences(user, [text], { from: 10 + index });
    sweep.noteItemWrite(user);
    clock.advance(10_000);
  }
  assert.equal(clock.liveTimers(), 1, 'each write puts the sweep off again');
  // Half a minute after the last write, made 10 seconds ago.
  clock.advance(20_000 - 1);
  assert.equal(fake.asked.length, 1);
  clock.advance(1);
  await sweep.idle(user);
  assert.deepEqual(fake.asked.slice(1), [['burst-3', 'burst-2', 'burst-1']]);
});

test('a report counts again after a write, and starts a sweep when sentences wait and none runs', async () => {
  const user = 'sweep-report';
  saveSentences(user, ['one']);
  const fake = provider(answering());
  const { sweep } = sweepWith(fake.chat);
  await sweep.report(user);
  await sweep.idle(user);
  assert.deepEqual(await sweep.report(user), { pending: 0, status: 'idle' });

  saveSentences(user, ['two'], { from: 10 });
  sweep.noteItemWrite(user);
  assert.deepEqual(await sweep.report(user), { pending: 1, status: 'running' });
  await sweep.idle(user);
  assert.deepEqual(themed(user), { one: A, two: A });
});

test("a count first deletes the theme rows of the user's words, keeps the sentences', and the classifier hears only of sentences", async () => {
  const user = 'sweep-sentences-only';
  const context = { model: 'test-model', taxonomyVersion: THEME_TAXONOMY_VERSION, now: 1 };
  // Two words the sweep labelled while Today still took words, and one saved since, never reviewed.
  for (const word of ['lucid', 'serene', 'placid']) {
    const id = `${user}:${word}`;
    upsertItem({ type: 'vocab', data: { id, word }, srs: srs(id, 'vocab'), savedAt: 50 }, user);
    if (word !== 'placid') recordThemeResults(user, [{ itemId: id, inputHash: 'w'.repeat(64), themeId: A }], context);
  }
  saveSentences(user, ['labelled', 'waiting']);
  const labelled = themeInput({ type: 'sentence', text: 'labelled' })!;
  recordThemeResults(user, [{ itemId: `${user}:labelled`, inputHash: labelled.inputHash, themeId: B }], context);
  const before = getThemeRowsAfter(user, 0).latestSeq;
  const fake = provider(answering());
  const { sweep } = sweepWith(fake.chat);

  assert.deepEqual(await sweep.report(user), { pending: 1, status: 'running' });
  await sweep.idle(user);
  assert.deepEqual(fake.asked, [['waiting']]);
  assert.deepEqual(db.prepare('SELECT item_id FROM item_themes WHERE user_id = ? ORDER BY item_id').pluck().all(user),
    [`${user}:labelled`, `${user}:waiting`]);
  // A device asking after its seq hears of the new label alone: the deletion moves no seq.
  assert.deepEqual(getThemeRowsAfter(user, before), { rows: [[`${user}:waiting`, A]], latestSeq: before + 1 });
});

test('a spent balance or a refused key pauses the sweep at once, says why, and only a trigger after fifteen minutes retries', async () => {
  for (const [status, body, reason] of [
    [402, 'insufficient balance', 'The AI provider\'s balance is used up.'],
    [401, 'bad key', 'The AI provider refused the key, or none is set.'],
  ] as const) {
    const user = `sweep-pause-${status}`;
    saveSentences(user, ['a', 'b']);
    let failing = true;
    const fake = provider(texts => (failing ? httpStatus(status, body) : answering()(texts)));
    const { sweep, clock } = sweepWith(fake.chat, manualClock(), { batchSize: 1 });

    await sweep.report(user);
    await sweep.idle(user);
    assert.equal(fake.asked.length, 1, 'neither is asked again');
    assert.deepEqual(await sweep.report(user), { pending: 2, status: 'paused', lastError: reason });

    failing = false;
    clock.advance(15 * MINUTE - 1);
    sweep.trigger(user);
    await sweep.idle(user);
    assert.equal(fake.asked.length, 1);
    clock.advance(1);
    sweep.trigger(user);
    await sweep.idle(user);
    assert.deepEqual(themed(user), { a: A, b: A });
    assert.deepEqual(await sweep.report(user), { pending: 0, status: 'idle' });
  }
});

test('three failed batches in a row pause the sweep, and a batch that labels anything starts the count again', async () => {
  const user = 'sweep-breaker';
  saveSentences(user, ['f6', 'f5', 'f4', 'ok3', 'f2', 'f1']);
  const fake = provider(texts => (texts.includes('ok3') ? answering()(texts) : httpStatus(503)));
  const { sweep } = sweepWith(fake.chat, manualClock(), { batchSize: 1 });

  await sweep.report(user);
  await sweep.idle(user);
  // Each failed batch is two requests: the chat client tries a provider failure twice.
  assert.deepEqual(fake.asked.map(texts => texts[0]), ['f1', 'f1', 'f2', 'f2', 'ok3', 'f4', 'f4', 'f5', 'f5', 'f6', 'f6']);
  assert.deepEqual(themed(user), { ok3: A });
  assert.deepEqual(await sweep.report(user), {
    pending: 5, status: 'paused', lastError: 'The AI service failed three batches in a row (unavailable).',
  });
});

test('a sentence the model never places counts a miss each sweep and leaves the count after three; the rest are labelled', async () => {
  const user = 'sweep-misses';
  saveSentences(user, ['plain', 'odd']);
  const fake = provider(answering(text => (text === 'odd' ? null : A)));
  const { sweep } = sweepWith(fake.chat);

  let report = await sweep.report(user);
  for (let sweeps = 1; sweeps <= 3; sweeps++) {
    await sweep.idle(user);
    report = await sweep.report(user);
  }
  assert.deepEqual(report, { pending: 0, status: 'idle' });
  assert.deepEqual(themed(user), { plain: A });
  // Each sweep: the batch, the chat client's second asking, and the half batch that leaves it out for good.
  assert.equal(fake.asked.length, 9);
  assert.deepEqual(fake.asked.slice(3), [['odd'], ['odd'], ['odd'], ['odd'], ['odd'], ['odd']]);
});

test('stopping aborts the request under way, records nothing, and starts nothing after', async () => {
  const user = 'sweep-stop';
  saveSentences(user, ['waiting']);
  const fake = provider(() => (init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  const { sweep, clock } = sweepWith(fake.chat);

  sweep.trigger(user);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fake.asked.length, 1);
  sweep.startAfterDelay(() => [user]);
  sweep.stop();
  await sweep.idle(user);
  assert.deepEqual(getThemeRowsAfter(user, 0).rows, []);

  sweep.trigger(user);
  sweep.noteItemWrite(user);
  clock.advance(10 * MINUTE);
  await sweep.idle(user);
  assert.equal(fake.asked.length, 1);
  assert.equal(clock.liveTimers(), 0);
  assert.deepEqual(await sweep.report(user), { pending: 1, status: 'idle' });
});
