import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { createTtsRoutes } from '../src/routes/tts.js';
import { BACKFILL_STATUS_PATH, type BackfillStatus } from '../src/tts/backfill.js';
import { audioPath, timingsPath, ttsKey } from '../src/tts/cache.js';

type Dependencies = NonNullable<Parameters<typeof createTtsRoutes>[0]>;
const TIMING = [{ start: 0, end: 0.4, text: 'hi' }];

function routes(overrides: Dependencies = {}) {
  const synthesized: string[] = [];
  const app = new Hono().route('/api', createTtsRoutes({
    synthClear: async (text) => { synthesized.push(text); return Buffer.from(`ID3 clear ${text}`); },
    synthCasual: async (spoken) => { synthesized.push(spoken); return Buffer.from(`ID3 casual ${spoken}`); },
    reduce: async (sentence) => `${sentence} (casual)`,
    reduceBatch: async (sentences) => sentences.map(sentence => `${sentence} (batch)`),
    align: async () => TIMING,
    backfillRetryDelayMs: 0,
    ...overrides,
  }));
  return { app, synthesized };
}

function storeFile(path: string, contents: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

test('a stored clip is served with its sniffed type and cached as immutable; anything else is 400 or 404', async () => {
  const { app } = routes();
  const wav = ttsKey('Served as WAV.', 'Mia');
  const mp3 = ttsKey('Served as MP3.', 'Mia');
  storeFile(audioPath(wav), Buffer.from('RIFF\0\0\0\0WAVEfmt '));
  storeFile(audioPath(mp3), Buffer.from('ID3\x04\0\0'));

  const served = await app.request(`/api/tts/${wav}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'audio/wav');
  assert.equal(served.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('latin1', 0, 4), 'RIFF');

  const withExtension = await app.request(`/api/tts/${mp3}.mp3`);
  assert.equal(withExtension.status, 200);
  assert.equal(withExtension.headers.get('content-type'), 'audio/mpeg');

  assert.equal((await app.request(`/api/tts/${ttsKey('Never made.', 'Mia')}`)).status, 404);
  assert.equal((await app.request(`/api/tts/${wav.toUpperCase()}`)).status, 400);
  assert.equal((await app.request('/api/tts/not-a-key.mp3')).status, 400);
});

test('a clip\'s word timings are served as immutable JSON once they exist', async () => {
  const { app } = routes();
  const key = ttsKey('Timed clip.', 'Mia');
  assert.equal((await app.request(`/api/tts/${key}/timings`)).status, 404);
  storeFile(timingsPath(key), JSON.stringify(TIMING));
  const served = await app.request(`/api/tts/${key}.json/timings`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'application/json');
  assert.equal(served.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.deepEqual(await served.json(), TIMING);
  assert.equal((await app.request('/api/tts/zz/timings')).status, 400);
});

test('starting the backfill answers with the new run\'s counts, and its progress is polled until it ends', async () => {
  const { app, synthesized } = routes({ backfillTexts: () => ({ catalog: ['Backfilled by request.'], library: [] }) });
  const started = await app.request('/api/tts/backfill', { method: 'POST' });
  const status = await started.json() as BackfillStatus;
  assert.equal(status.running, true);
  assert.equal(status.total, 2);

  let polled = status;
  for (let tries = 0; polled.running && tries < 200; tries++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    polled = await (await app.request('/api/tts/backfill')).json() as BackfillStatus;
  }
  assert.deepEqual({ ...polled, startedAt: 0, finishedAt: 0 }, {
    running: false, total: 2, done: 2, generated: 2, failed: 0, startedAt: 0, finishedAt: 0,
  });
  assert.deepEqual(synthesized.sort(), ['Backfilled by request.', 'Backfilled by request. (batch)']);
});

test('while a detached worker\'s run is beating, starting the backfill answers with its progress and starts nothing', async () => {
  const worker = { running: true, total: 40, done: 12, generated: 10, failed: 0, startedAt: 5, finishedAt: 0 };
  writeFileSync(BACKFILL_STATUS_PATH, JSON.stringify({ ...worker, owner: 'worker', pid: 1, heartbeatAt: Date.now() }));
  const { app, synthesized } = routes({ backfillTexts: () => ({ catalog: ['Never backfilled here.'], library: [] }) });
  const started = await app.request('/api/tts/backfill', { method: 'POST' });
  assert.deepEqual(await started.json(), worker);
  assert.deepEqual(await (await app.request('/api/tts/backfill')).json(), worker);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(synthesized, []);
});
