import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatClient } from '../src/ai-client.js';
import type { FetchLike } from '../src/proxy-fetch.js';
import { THEMES } from '../src/shared/item-themes.js';
import { createThemeSweep, type ThemeSweepOptions } from '../src/themes/sweep.js';
import { httpStatus, reply, type Responder } from './support/ai.js';
import { srs } from './support/fixtures.js';

const { getThemeRowsAfter, upsertItem } = await import('../src/db.js');

const [A] = THEMES.map(theme => theme.id);
const MINUTE = 60_000;

/** Saves never-reviewed words for a user, the later in the list the newer; `reviewed` ones have reviews. */
function saveWords(userId: string, words: readonly string[], { reviewed = [] as readonly string[], from = 1 } = {}) {
  words.forEach((word, index) => {
    const id = `${userId}:${word}`;
    upsertItem({
      type: 'vocab',
      data: { id, word },
      srs: reviewed.includes(word) ? { ...srs(id, 'vocab'), totalReviews: 2, lastReviewDate: 5 } : srs(id, 'vocab'),
      savedAt: from + index,
    }, userId);
  });
}

/**
 * DeepInfra as the sweep's chat client meets it: `respond` answers each request from the words it asks about, by
 * default giving each word the theme `scene(word)` returns (none for null).
 */
function provider(respond: (words: string[]) => Responder | Promise<Responder>) {
  const asked: string[][] = [];
  const fetch: FetchLike = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    const words = [...body.messages[1].content.matchAll(/^\d+\. word "(.*)"$/gm)].map(match => match[1]);
    asked.push(words);
    return (await respond(words))(init);
  };
  return { chat: createChatClient({ fetch, apiKey: () => 'test-key', retryDelayMs: 0 }), asked };
}
const answering = (scene: (word: string) => string | null = () => A) => (words: string[]) =>
  reply({ a: words.flatMap((word, index) => (scene(word) ? [{ i: index + 1, t: scene(word) }] : [])) });

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

test('a sweep labels every item that needs a theme, a batch at a time with new items first, and reports its progress', async () => {
  const user = 'sweep-labels';
  saveWords(user, ['old', 'older-seen', 'middle', 'newest-seen', 'newest'], { reviewed: ['older-seen', 'newest-seen'] });
  const fake = provider(answering());
  const { sweep } = sweepWith(fake.chat, manualClock(), { batchSize: 2 });

  assert.deepEqual(await sweep.report(user), { pending: 5, status: 'running' });
  await sweep.idle(user);
  assert.deepEqual(fake.asked, [['newest', 'middle'], ['old', 'newest-seen'], ['older-seen']]);
  assert.deepEqual(themed(user), { old: A, 'older-seen': A, middle: A, 'newest-seen': A, newest: A });
  assert.deepEqual(await sweep.report(user), { pending: 0, status: 'idle' });
  assert.equal(fake.asked.length, 3, 'nothing waits, so no sweep starts');
});

test('one sweep at a time: a trigger while it runs starts nothing, and an item saved meanwhile is labelled before it ends', async () => {
  const user = 'sweep-single-flight';
  saveWords(user, ['first', 'second']);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const fake = provider(async (words) => {
    if (words.includes('first')) await released;
    return answering()(words);
  });
  const { sweep, clock } = sweepWith(fake.chat);

  sweep.trigger(user);
  await new Promise(resolve => setTimeout(resolve, 10));
  sweep.trigger(user);
  assert.equal(fake.asked.length, 1);
  saveWords(user, ['saved-meanwhile'], { from: 10 });
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
  saveWords(user, ['at-start']);
  const fake = provider(answering());
  const { sweep, clock } = sweepWith(fake.chat);

  sweep.startAfterDelay(() => [user]);
  clock.advance(MINUTE - 1);
  assert.equal(fake.asked.length, 0);
  clock.advance(1);
  await sweep.idle(user);
  assert.deepEqual(fake.asked, [['at-start']]);

  for (const [index, word] of ['burst-1', 'burst-2', 'burst-3'].entries()) {
    saveWords(user, [word], { from: 10 + index });
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

test('a report counts again after a write, and starts a sweep when items wait and none runs', async () => {
  const user = 'sweep-report';
  saveWords(user, ['one']);
  const fake = provider(answering());
  const { sweep } = sweepWith(fake.chat);
  await sweep.report(user);
  await sweep.idle(user);
  assert.deepEqual(await sweep.report(user), { pending: 0, status: 'idle' });

  saveWords(user, ['two'], { from: 10 });
  sweep.noteItemWrite(user);
  assert.deepEqual(await sweep.report(user), { pending: 1, status: 'running' });
  await sweep.idle(user);
  assert.deepEqual(themed(user), { one: A, two: A });
});

test('a spent balance or a refused key pauses the sweep at once, says why, and only a trigger after fifteen minutes retries', async () => {
  for (const [status, body, reason] of [
    [402, 'insufficient balance', 'The AI provider\'s balance is used up.'],
    [401, 'bad key', 'The AI provider refused the key, or none is set.'],
  ] as const) {
    const user = `sweep-pause-${status}`;
    saveWords(user, ['a', 'b']);
    let failing = true;
    const fake = provider(words => (failing ? httpStatus(status, body) : answering()(words)));
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
  saveWords(user, ['f6', 'f5', 'f4', 'ok3', 'f2', 'f1']);
  const fake = provider(words => (words.includes('ok3') ? answering()(words) : httpStatus(503)));
  const { sweep } = sweepWith(fake.chat, manualClock(), { batchSize: 1 });

  await sweep.report(user);
  await sweep.idle(user);
  // Each failed batch is two requests: the chat client tries a provider failure twice.
  assert.deepEqual(fake.asked.map(words => words[0]), ['f1', 'f1', 'f2', 'f2', 'ok3', 'f4', 'f4', 'f5', 'f5', 'f6', 'f6']);
  assert.deepEqual(themed(user), { ok3: A });
  assert.deepEqual(await sweep.report(user), {
    pending: 5, status: 'paused', lastError: 'The AI service failed three batches in a row (unavailable).',
  });
});

test('an item the model never places counts a miss each sweep and leaves the count after three; the rest are labelled', async () => {
  const user = 'sweep-misses';
  saveWords(user, ['plain', 'odd']);
  const fake = provider(answering(word => (word === 'odd' ? null : A)));
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
  saveWords(user, ['waiting']);
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
