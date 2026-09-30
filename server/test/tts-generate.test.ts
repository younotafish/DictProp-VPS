import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'dictprop-tts-generate-test-'));
process.env.DATA_DIR = DATA_DIR;

const {
  cleanCasualRespelling,
  GENERATE_MAX_ITEMS,
  GENERATE_MAX_TEXT_CHARS,
  setTtsDependenciesForTest,
  ttsRoutes,
} = await import('../src/routes/tts.js');
const { createPriorityQueue } = await import('../src/local-whisper.js');
type Dependencies = Parameters<typeof setTtsDependenciesForTest>[0];

const app = new Hono().route('/api', ttsRoutes);
const TIMING = [{ start: 0, end: 0.4, text: 'hi' }];

// Mirrors ttsKey in src/routes/tts.ts (and the client).
const clipPath = (text: string, voice = 'Mia') => {
  const key = createHash('sha256').update(`${voice}\n${text.trim()}`).digest('hex');
  return join(DATA_DIR, 'tts', key.slice(0, 2), key);
};

const generate = (items: unknown[], init: RequestInit = {}) => app.request(new Request('http://localhost/api/tts/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items }),
  ...init,
}));

// Replaces MiMo, the casual respelling and whisper for one test; nothing leaves the process.
function stub(overrides: Dependencies = {}) {
  const calls = { clear: [] as string[], casual: [] as string[], reduce: [] as string[], align: [] as string[] };
  const restore = setTtsDependenciesForTest({
    synthClear: async (text) => { calls.clear.push(text); return Buffer.from(`ID3 clear ${text}`); },
    synthCasual: async (spoken) => { calls.casual.push(spoken); return Buffer.from(`ID3 casual ${spoken}`); },
    reduce: async (sentence) => { calls.reduce.push(sentence); return `${sentence} (casual)`; },
    align: async (_audio, priority) => { calls.align.push(priority); return TIMING; },
    ...overrides,
  });
  return { calls, restore };
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
  const { calls, restore } = stub();
  try {
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
  } finally {
    restore();
  }
});

test('the response comes once the audio is stored; a lone clip is aligned afterwards at interactive priority', async () => {
  const gate = deferred();
  const { calls, restore } = stub({
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
    restore();
  }
});

test('a bulk request synthesizes three clips at a time and aligns them as background work', async () => {
  let active = 0;
  let peak = 0;
  const { calls, restore } = stub({
    synthClear: async (text) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
      calls.clear.push(text);
      return Buffer.from(`ID3 ${text}`);
    },
  });
  try {
    const items = Array.from({ length: 7 }, (_unused, index) => ({ text: `Bulk sentence number ${index}.` }));
    assert.deepEqual(await (await generate(items)).json(), { generated: 7, skipped: 0, failed: 0 });
    assert.equal(peak, 3);
    await waitFor(() => items.every(item => existsSync(`${clipPath(item.text)}.json`)), 'every timings file');
    assert.ok(calls.align.length === 7 && calls.align.every(priority => priority === 'background'));
  } finally {
    restore();
  }
});

test('a clip whisper hears no words in stores [] timings and then counts as complete', async () => {
  const { calls, restore } = stub({ align: async () => [] });
  try {
    const text = 'A clip with no recognizable words.';
    assert.deepEqual(await (await generate([{ text }])).json(), { generated: 1, skipped: 0, failed: 0 });
    await waitFor(() => existsSync(`${clipPath(text)}.json`), 'the timings file');
    assert.equal(readFileSync(`${clipPath(text)}.json`, 'utf8'), '[]');
    assert.deepEqual(await (await generate([{ text }])).json(), { generated: 0, skipped: 1, failed: 0 });
    assert.equal(calls.clear.length, 1);
  } finally {
    restore();
  }
});

test('a failed alignment stores no timings, and the next request aligns without re-synthesizing', async () => {
  const text = 'Alignment fails the first time.';
  let attempts = 0;
  const failing = stub({ align: async () => { attempts++; throw new Error('whisper crashed'); } });
  try {
    assert.deepEqual(await (await generate([{ text }])).json(), { generated: 1, skipped: 0, failed: 0 });
    await waitFor(() => attempts === 1, 'the alignment attempt');
    await sleep(50);
    assert.equal(existsSync(clipPath(text)), true);
    assert.equal(existsSync(`${clipPath(text)}.json`), false);
  } finally {
    failing.restore();
  }

  const working = stub();
  try {
    assert.deepEqual(await (await generate([{ text }])).json(), { generated: 1, skipped: 0, failed: 0 });
    await waitFor(() => existsSync(`${clipPath(text)}.json`), 'the timings file');
    assert.equal(working.calls.clear.length, 0);
  } finally {
    working.restore();
  }
});

test('a failed casual respelling stores nothing; a good one is voiced and kept beside the clip', async () => {
  const text = 'I am going to head home now.';
  const failed = stub({ reduce: async () => null });
  try {
    assert.deepEqual(await (await generate([{ text, voice: 'casual' }])).json(), { generated: 0, skipped: 0, failed: 1 });
    assert.equal(existsSync(clipPath(text, 'casual')), false);
    assert.equal(existsSync(`${clipPath(text, 'casual')}.txt`), false);
    assert.equal(failed.calls.casual.length, 0);
  } finally {
    failed.restore();
  }

  const working = stub({ reduce: async () => "I'm gonna head home now." });
  try {
    assert.deepEqual(await (await generate([{ text, voice: 'casual' }])).json(), { generated: 1, skipped: 0, failed: 0 });
    assert.deepEqual(working.calls.casual, ["I'm gonna head home now."]);
    assert.equal(readFileSync(`${clipPath(text, 'casual')}.txt`, 'utf8'), "I'm gonna head home now.");
    await waitFor(() => existsSync(`${clipPath(text, 'casual')}.json`), 'the casual timings file');
  } finally {
    working.restore();
  }
});

test('a client that disconnects stops further clips from starting', async () => {
  const gate = deferred();
  const { calls, restore } = stub({
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
    restore();
  }
});

test('writes leave no temporary files behind', () => {
  const leftovers = readdirSync(join(DATA_DIR, 'tts'), { recursive: true })
    .map(String)
    .filter(name => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('casual respellings lose wrapping quotes but keep their apostrophes', () => {
  assert.equal(cleanCasualRespelling('"I\'m gonna go."'), "I'm gonna go.");
  assert.equal(cleanCasualRespelling('“Goin\' home, ya know”'), "Goin' home, ya know");
  assert.equal(cleanCasualRespelling("'cause I said so, that's why"), "'cause I said so, that's why");
  assert.equal(cleanCasualRespelling("  gimme a sec  "), 'gimme a sec');
  assert.equal(cleanCasualRespelling('""'), null);
  assert.equal(cleanCasualRespelling('   '), null);
  assert.equal(cleanCasualRespelling(42), null);
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
