import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { AiError } from '../src/ai-client.js';
import {
  BACKFILL_STATUS_PATH,
  createBackfill,
  getDetachedBackfillStatus,
  type Backfill,
  type BackfillTexts,
} from '../src/tts/backfill.js';
import { audioPath, CASUAL_STYLE, timingsPath, ttsKey } from '../src/tts/cache.js';
import { createClipStore, type ClipDependencies } from '../src/tts/clips.js';
import type { LockOwner } from '../src/tts/lock.js';

const DATA_DIR = process.env.DATA_DIR!;
const LOCK_PATH = join(DATA_DIR, 'tts-backfill.lock');
const TIMING = [{ start: 0, end: 0.4, text: 'hi' }];

type ReduceBatch = (sentences: string[]) => Promise<Array<string | null>>;
const respellAll: ReduceBatch = async (sentences) => sentences.map(sentence => `${sentence} (batch)`);

interface HarnessOptions {
  reduceBatch?: ReduceBatch;
  deps?: Partial<ClipDependencies>;
  owner?: LockOwner;
}

// A backfill over the given sentences with synthesis, respelling and whisper replaced; every call is recorded, and
// `events` keeps the order the clips were made in.
function harness(texts: BackfillTexts, { reduceBatch = respellAll, deps = {}, owner }: HarnessOptions = {}) {
  const calls = { clear: [] as string[], casual: [] as string[], reduce: [] as string[], batches: [] as string[][], align: 0 };
  const events: string[] = [];
  const clipDeps: ClipDependencies = {
    synthClear: async (text) => { calls.clear.push(text); events.push(`clear ${text}`); return Buffer.from(`ID3 clear ${text}`); },
    synthCasual: async (spoken) => { calls.casual.push(spoken); events.push(`casual ${spoken}`); return Buffer.from(`ID3 casual ${spoken}`); },
    reduce: async (sentence) => { calls.reduce.push(sentence); return `${sentence} (casual)`; },
    align: async () => { calls.align++; return TIMING; },
    ...deps,
  };
  const backfill = createBackfill({
    clips: createClipStore(clipDeps),
    reduceBatch: async (sentences) => { calls.batches.push(sentences); return reduceBatch(sentences); },
    sentenceTexts: () => texts,
    retryDelayMs: 0,
    owner,
  });
  const counts = () => {
    const { running, total, done, generated, failed } = backfill.status();
    return { running, total, done, generated, failed };
  };
  return { backfill, calls, events, counts };
}

async function runToEnd(backfill: Backfill) {
  const run = await backfill.start();
  assert.ok(run, 'the backfill should start');
  await run.finished;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function storeFile(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeLock(holder: { owner: LockOwner; pid: number }, ageMs = 0) {
  writeFileSync(LOCK_PATH, JSON.stringify({ ...holder, startedAt: Date.now() - ageMs }));
  const at = new Date(Date.now() - ageMs);
  utimesSync(LOCK_PATH, at, at);
}

// The pid of a process that has exited.
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid!;

test('the catalog is finished in both styles before the library starts, and the counts add up', async () => {
  const { backfill, calls, events, counts } = harness({
    catalog: ['Order catalog one.', 'Order catalog two.'],
    library: ['Order library one.', '[[Order catalog two.]]'],
  });
  await runToEnd(backfill);
  assert.deepEqual(events.slice(0, 2).sort(), ['clear Order catalog one.', 'clear Order catalog two.']);
  assert.deepEqual(events.slice(2, 4).sort(), ['casual Order catalog one. (batch)', 'casual Order catalog two. (batch)']);
  assert.deepEqual(events.slice(4), ['clear Order library one.', 'casual Order library one. (batch)']);
  assert.deepEqual(calls.batches, [['Order catalog one.', 'Order catalog two.'], ['Order library one.']]);
  assert.equal(calls.align, 6);
  assert.deepEqual(counts(), { running: false, total: 6, done: 6, generated: 6, failed: 0 });

  // A second run finds every clip complete: all six count as already cached.
  const again = harness({ catalog: ['Order catalog one.', 'Order catalog two.'], library: ['Order library one.'] });
  await runToEnd(again.backfill);
  assert.deepEqual(again.events, []);
  assert.deepEqual(again.counts(), { running: false, total: 6, done: 6, generated: 0, failed: 0 });
});

test('a casual clip with audio but no timings is aligned without being made again', async () => {
  const text = 'This casual clip predates word timings.';
  storeFile(audioPath(ttsKey(text, 'Mia')), 'ID3 clear');
  storeFile(timingsPath(ttsKey(text, 'Mia')), JSON.stringify(TIMING));
  storeFile(audioPath(ttsKey(text, CASUAL_STYLE)), 'ID3 casual');
  const { backfill, calls, counts } = harness({ catalog: [text], library: [] });
  await runToEnd(backfill);
  assert.deepEqual(calls.batches, []);
  assert.deepEqual(calls.casual, []);
  assert.equal(calls.align, 1);
  assert.deepEqual(JSON.parse(readFileSync(timingsPath(ttsKey(text, CASUAL_STYLE)), 'utf8')), TIMING);
  assert.deepEqual(counts(), { running: false, total: 2, done: 2, generated: 1, failed: 0 });
});

test('a sentence the batch left out is respelled on its own when its clip is made', async () => {
  const { backfill, calls, counts } = harness(
    { catalog: ['Left out of the batch.', 'Respelled in the batch.'], library: [] },
    { reduceBatch: async (sentences) => [null, `${sentences[1]} (batch)`] },
  );
  await runToEnd(backfill);
  assert.deepEqual(calls.reduce, ['Left out of the batch.']);
  assert.deepEqual(calls.casual.sort(), ['Left out of the batch. (casual)', 'Respelled in the batch. (batch)']);
  assert.deepEqual(counts(), { running: false, total: 4, done: 4, generated: 4, failed: 0 });
});

test('a clip that keeps failing is tried three times, then counted as failed', async () => {
  const text = 'MiMo refuses this sentence.';
  let attempts = 0;
  const { backfill, counts } = harness({ catalog: [text], library: [] }, {
    deps: { synthClear: async () => { attempts++; throw new Error('MiMo TTS 500'); } },
  });
  await runToEnd(backfill);
  assert.equal(attempts, 3);
  assert.deepEqual(counts(), { running: false, total: 2, done: 2, generated: 1, failed: 1 });
});

test('a spent respelling balance stops the casual clips that need audio for the rest of the run, counted as failed', async () => {
  const { backfill, calls, counts } = harness(
    { catalog: ['Halt catalog one.', 'Halt catalog two.'], library: ['Halt library one.'] },
    { reduceBatch: async () => { throw new AiError('quota', 'Provider quota exhausted (402)'); } },
  );
  await runToEnd(backfill);
  assert.equal(calls.batches.length, 1); // the catalog's batch; the library's casual clips never ask
  assert.deepEqual(calls.reduce, []);
  assert.deepEqual(calls.casual, []);
  assert.equal(calls.clear.length, 3);
  assert.deepEqual(counts(), { running: false, total: 6, done: 6, generated: 3, failed: 3 });
});

test('any other batch failure leaves each casual clip to be respelled on its own', async () => {
  const { backfill, calls, counts } = harness(
    { catalog: ['Fallback one.', 'Fallback two.'], library: [] },
    { reduceBatch: async () => { throw new Error('socket hang up'); } },
  );
  await runToEnd(backfill);
  assert.deepEqual(calls.reduce.sort(), ['Fallback one.', 'Fallback two.']);
  assert.deepEqual(calls.casual.sort(), ['Fallback one. (casual)', 'Fallback two. (casual)']);
  assert.deepEqual(counts(), { running: false, total: 4, done: 4, generated: 4, failed: 0 });
});

test('a run holds the lock while it works, publishes its progress, and lets go at the end', async () => {
  const gate = deferred();
  const { backfill } = harness({ catalog: ['Held under the lock.'], library: [] }, {
    deps: { align: async () => { await gate.promise; return TIMING; } },
  });
  const run = await backfill.start();
  assert.ok(run);
  assert.equal(backfill.status().running, true);
  assert.equal(backfill.status().total, 2);
  const holder = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  assert.equal(holder.owner, 'server');
  assert.equal(holder.pid, process.pid);
  const published = JSON.parse(readFileSync(BACKFILL_STATUS_PATH, 'utf8'));
  assert.equal(published.running, true);
  assert.equal(published.owner, 'server');
  assert.equal(published.total, 2);
  // The web server reports its own run from memory, not from the file it publishes.
  assert.equal(await getDetachedBackfillStatus(), null);

  // Nothing else starts meanwhile: not this backfill again, and not a detached worker.
  assert.equal(await backfill.start(), null);
  const worker = harness({ catalog: ['Held under the lock.'], library: [] }, { owner: 'worker' });
  assert.equal(await worker.backfill.start(), null);
  assert.equal(worker.backfill.status().running, false);

  gate.release();
  await run.finished;
  assert.equal(existsSync(LOCK_PATH), false);
  assert.equal(JSON.parse(readFileSync(BACKFILL_STATUS_PATH, 'utf8')).running, false);
});

test('a lock another live process holds keeps a run from starting', async () => {
  writeLock({ owner: 'worker', pid: process.ppid });
  try {
    const { backfill, events } = harness({ catalog: ['Blocked by a live worker.'], library: [] });
    assert.equal(await backfill.start(), null);
    assert.deepEqual(events, []);
  } finally {
    rmSync(LOCK_PATH, { force: true });
  }
});

test('a lock untouched for five minutes is taken over', async () => {
  writeLock({ owner: 'worker', pid: process.ppid }, 5 * 60_000 + 1_000);
  const { backfill, events } = harness({ catalog: ['After a stale lock.'], library: [] });
  await runToEnd(backfill);
  assert.equal(events.length, 2);
  assert.equal(existsSync(LOCK_PATH), false);
  assert.deepEqual(readdirSync(DATA_DIR).filter(name => name.startsWith('tts-backfill.lock')), []);
});

test('the web server takes over a lock that a server gone since left; the worker waits for it to go stale', async () => {
  writeLock({ owner: 'server', pid: deadPid() });
  try {
    const worker = harness({ catalog: ['After a restart.'], library: [] }, { owner: 'worker' });
    assert.equal(await worker.backfill.start(), null);
    const server = harness({ catalog: ['After a restart.'], library: [] });
    await runToEnd(server.backfill);
    assert.equal(server.events.length, 2);
  } finally {
    rmSync(LOCK_PATH, { force: true });
  }
});

test('the web server reports a detached worker\'s run only while its status keeps beating', async () => {
  const counts = { total: 10, done: 3, generated: 2, failed: 1, startedAt: 1, finishedAt: 0 };
  const publish = (fields: Record<string, unknown>) =>
    writeFileSync(BACKFILL_STATUS_PATH, JSON.stringify({ running: true, ...counts, owner: 'worker', heartbeatAt: Date.now(), ...fields }));

  publish({});
  assert.deepEqual(await getDetachedBackfillStatus(), { running: true, ...counts });
  // A worker from before the owner was recorded.
  publish({ owner: undefined, workerPid: 42 });
  assert.deepEqual(await getDetachedBackfillStatus(), { running: true, ...counts });
  publish({ heartbeatAt: Date.now() - 121_000 });
  assert.equal(await getDetachedBackfillStatus(), null);
  publish({ running: false });
  assert.equal(await getDetachedBackfillStatus(), null);
  publish({ owner: 'server' });
  assert.equal(await getDetachedBackfillStatus(), null);
  rmSync(BACKFILL_STATUS_PATH, { force: true });
  assert.equal(await getDetachedBackfillStatus(), null);
});
