import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

const DATA_DIR = process.env.DATA_DIR!;

const { createTtsRoutes, GENERATE_MAX_TEXT_CHARS } = await import('../src/routes/tts.js');
const { GENERATE_MAX_ITEMS } = await import('../src/shared/ai-limits.js');
const { audioPath, ttsKey } = await import('../src/tts/cache.js');
const { createPriorityQueue } = await import('../src/local-whisper.js');
type Dependencies = NonNullable<Parameters<typeof createTtsRoutes>[0]>;

const TIMING = [{ start: 0, end: 0.4, text: 'hi' }];

const clipPath = (text: string, voice = 'Mia') => audioPath(ttsKey(text, voice));

// The TTS routes with MiMo, the casual respelling and whisper replaced; nothing leaves the process.
function stub(overrides: Dependencies = {}) {
  const calls = { clear: [] as string[], casual: [] as string[], reduce: [] as string[], align: [] as string[] };
  const app = new Hono().route('/api', createTtsRoutes({
    synthClear: async (text) => { calls.clear.push(text); return Buffer.from(`ID3 clear ${text}`); },
    synthCasual: async (spoken) => { calls.casual.push(spoken); return Buffer.from(`ID3 casual ${spoken}`); },
    reduce: async (sentence) => { calls.reduce.push(sentence); return `${sentence} (casual)`; },
    align: async (_audio, priority) => { calls.align.push(priority); return TIMING; },
    ...overrides,
  }));
  const generate = (items: unknown[], init: RequestInit = {}) => app.request(new Request('http://localhost/api/tts/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
    ...init,
  }));
  return { calls, generate };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, label: string) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('requests are capped at 40 items, 1000 characters and the voices the client plays', async () => {
  const { calls, generate } = stub();
  assert.equal(GENERATE_MAX_ITEMS, 40);
  assert.equal(GENERATE_MAX_TEXT_CHARS, 1000);
  const tooMany = await generate(Array.from({ length: 41 }, (_unused, index) => ({ text: `Sentence ${index}.` })));
  assert.equal(tooMany.status, 400);
  assert.deepEqual(await tooMany.json(), { error: 'at most 40 items per request' });

  const response = await generate([
    { text: 'x'.repeat(1001) },
    { text: 'Hello there, friend.', voice: 'Chloe' },
    { text: 'Hello there, friend.', voice: 'qwen3-aiden-clear-v1' },
    { text: '   ' },
  ]);
  assert.deepEqual(await response.json(), { generated: 0, skipped: 1, failed: 3 });
  assert.equal(calls.clear.length, 0);
});

test('the response comes once the audio is stored; a lone clip is aligned afterwards at interactive priority', async () => {
  const gate = deferred();
  const { calls, generate } = stub({
    align: async (_audio, priority) => { calls.align.push(priority); await gate.promise; return TIMING; },
  });
  try {
    const text = 'The response does not wait for alignment.';
    const response = await generate([{ text }]);
    assert.deepEqual(await response.json(), { generated: 1, skipped: 0, failed: 0 });
    assert.equal(readFileSync(clipPath(text), 'utf8'), `ID3 clear ${text}`);
    assert.equal(existsSync(`${clipPath(text)}.json`), false);
    await waitFor(() => calls.align.length === 1, 'the alignment to start');
    assert.deepEqual(calls.align, ['interactive']);

    gate.release();
    await waitFor(() => existsSync(`${clipPath(text)}.json`), 'the timings file');
    assert.deepEqual(JSON.parse(readFileSync(`${clipPath(text)}.json`, 'utf8')), TIMING);
  } finally {
    gate.release();
  }
});

test('a bulk request synthesizes three clips at a time and aligns them as background work', async () => {
  let active = 0;
  let peak = 0;
  const { calls, generate } = stub({
    synthClear: async (text) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
      calls.clear.push(text);
      return Buffer.from(`ID3 ${text}`);
    },
  });
  const items = Array.from({ length: 7 }, (_unused, index) => ({ text: `Bulk sentence number ${index}.` }));
  assert.deepEqual(await (await generate(items)).json(), { generated: 7, skipped: 0, failed: 0 });
  assert.equal(peak, 3);
  await waitFor(() => items.every(item => existsSync(`${clipPath(item.text)}.json`)), 'every timings file');
  assert.ok(calls.align.length === 7 && calls.align.every(priority => priority === 'background'));
});

test('a clip whisper hears no words in stores [] timings and then counts as complete', async () => {
  const { calls, generate } = stub({ align: async () => [] });
  const text = 'A clip with no recognizable words.';
  assert.deepEqual(await (await generate([{ text }])).json(), { generated: 1, skipped: 0, failed: 0 });
  await waitFor(() => existsSync(`${clipPath(text)}.json`), 'the timings file');
  assert.equal(readFileSync(`${clipPath(text)}.json`, 'utf8'), '[]');
  assert.deepEqual(await (await generate([{ text }])).json(), { generated: 0, skipped: 1, failed: 0 });
  assert.equal(calls.clear.length, 1);
});

test('a failed alignment stores no timings, and the next request aligns without re-synthesizing', async () => {
  const text = 'Alignment fails the first time.';
  let attempts = 0;
  const failing = stub({ align: async () => { attempts++; throw new Error('whisper crashed'); } });
  assert.deepEqual(await (await failing.generate([{ text }])).json(), { generated: 1, skipped: 0, failed: 0 });
  await waitFor(() => attempts === 1, 'the alignment attempt');
  await sleep(50);
  assert.equal(existsSync(clipPath(text)), true);
  assert.equal(existsSync(`${clipPath(text)}.json`), false);

  const working = stub();
  assert.deepEqual(await (await working.generate([{ text }])).json(), { generated: 1, skipped: 0, failed: 0 });
  await waitFor(() => existsSync(`${clipPath(text)}.json`), 'the timings file');
  assert.equal(working.calls.clear.length, 0);
});

test('a failed casual respelling stores nothing; a good one is voiced and kept beside the clip', async () => {
  const text = 'I am going to head home now.';
  const failed = stub({ reduce: async () => null });
  assert.deepEqual(await (await failed.generate([{ text, voice: 'casual' }])).json(), { generated: 0, skipped: 0, failed: 1 });
  assert.equal(existsSync(clipPath(text, 'casual')), false);
  assert.equal(existsSync(`${clipPath(text, 'casual')}.txt`), false);
  assert.equal(failed.calls.casual.length, 0);

  const working = stub({ reduce: async () => "I'm gonna head home now." });
  assert.deepEqual(await (await working.generate([{ text, voice: 'casual' }])).json(), { generated: 1, skipped: 0, failed: 0 });
  assert.deepEqual(working.calls.casual, ["I'm gonna head home now."]);
  assert.equal(readFileSync(`${clipPath(text, 'casual')}.txt`, 'utf8'), "I'm gonna head home now.");
  await waitFor(() => existsSync(`${clipPath(text, 'casual')}.json`), 'the casual timings file');
});

test('a client that disconnects stops further clips from starting', async () => {
  const gate = deferred();
  const { calls, generate } = stub({
    synthClear: async (text) => { calls.clear.push(text); await gate.promise; return Buffer.from(`ID3 ${text}`); },
  });
  try {
    const controller = new AbortController();
    const items = Array.from({ length: 6 }, (_unused, index) => ({ text: `Abandoned sweep sentence ${index}.` }));
    const pending = generate(items, { signal: controller.signal });
    await waitFor(() => calls.clear.length === 3, 'three clips to start');
    controller.abort();
    gate.release();
    assert.deepEqual(await (await pending).json(), { generated: 3, skipped: 0, failed: 0 });
    assert.equal(calls.clear.length, 3);
    await waitFor(() => items.slice(0, 3).every(item => existsSync(`${clipPath(item.text)}.json`)), 'the started clips to align');
  } finally {
    gate.release();
  }
});

test('writes leave no temporary files behind', async () => {
  // Writes of its own (a clip, its timings, a casual respelling), so the scan never looks at an empty directory.
  // When the whole file runs, it covers every earlier test's writes too.
  const { generate } = stub();
  const text = 'Every write lands under its final name.';
  assert.deepEqual(await (await generate([{ text }, { text, voice: 'casual' }])).json(), { generated: 2, skipped: 0, failed: 0 });
  await waitFor(() => existsSync(`${clipPath(text)}.json`) && existsSync(`${clipPath(text, 'casual')}.json`), 'both timings files');
  assert.ok(existsSync(`${clipPath(text, 'casual')}.txt`));
  const leftovers = readdirSync(join(DATA_DIR, 'tts'), { recursive: true })
    .map(String)
    .filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('the alignment queue runs one task at a time and takes interactive work before queued background work', async () => {
  const schedule = createPriorityQueue();
  const order: string[] = [];
  const first = deferred();
  const task = (name: string, wait?: Promise<void>) => async () => {
    order.push(`start ${name}`);
    if (wait) await wait;
    order.push(`end ${name}`);
    return name;
  };
  const results = Promise.all([
    schedule(task('backfill 1', first.promise), 'background'),
    schedule(task('backfill 2'), 'background'),
    schedule(task('backfill 3'), 'background'),
    schedule(task('live'), 'interactive'),
  ]);
  await sleep(5);
  first.release();
  assert.deepEqual(await results, ['backfill 1', 'backfill 2', 'backfill 3', 'live']);
  assert.deepEqual(order, [
    'start backfill 1', 'end backfill 1',
    'start live', 'end live',
    'start backfill 2', 'end backfill 2',
    'start backfill 3', 'end backfill 3',
  ]);
  // A failing task rejects its own promise without stalling the queue.
  await assert.rejects(schedule(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await schedule(async () => 'after'), 'after');
});
