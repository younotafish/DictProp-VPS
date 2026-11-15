import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { FakeTtsServer, installFakeMedia } from '../support/audio/fakeMedia.ts';

Object.assign(globalThis, { indexedDB, IDBKeyRange });
installFakeMedia();
const server = new FakeTtsServer();
server.install();

const realNow = Date.now;
let now = 10_000_000;
Date.now = () => now;
test.after(() => { Date.now = realNow; });

let urlsOpened = 0;
const realCreateObjectURL = URL.createObjectURL;
URL.createObjectURL = (blob: Blob) => { urlsOpened++; return realCreateObjectURL(blob); };
test.after(() => { URL.createObjectURL = realCreateObjectURL; });

const { preloadAudio, prefetchTTS, ensureTTS, WARM_CONCURRENCY } = await import('../../services/audio/clipWarmers.ts');
const cache = await import('../../services/audioCache.ts');
const { ttsKey } = await import('../../services/api.ts');

const clip = () => new Blob([new Uint8Array(24)], { type: 'audio/mpeg' });
const timings = [{ text: 'Word', start: 0.1, end: 0.3 }];
let sentences = 0;
const sentence = () => `Warm-up sentence number ${++sentences}.`;
const keyOf = (text: string) => ttsKey(text, 'Mia');
const mp3Requests = (key: string) => server.requests.filter(url => url.endsWith(`/api/tts/${key}.mp3`)).length;
const timingRequests = (key: string) => server.requests.filter(url => url.endsWith(`/api/tts/${key}/timings`)).length;
const metaAt = (key: string) => new Promise<number | undefined>((resolve, reject) => {
  const open = indexedDB.open('DictPropAudioCache', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result;
    const get = db.transaction('meta').objectStore('meta').get(key);
    get.onsuccess = () => { resolve((get.result as { at: number } | undefined)?.at); db.close(); };
    get.onerror = () => reject(get.error);
  };
});
// The server makes a clip, with timings, for each generation request.
server.onGenerate = async items => {
  for (const item of items) {
    const key = await ttsKey(item.text, item.voice ?? 'Mia');
    server.clips.set(key, clip());
    server.timings.set(key, timings);
  }
};

test('a whole session checks the device first and downloads only what is missing, straight into IndexedDB', async () => {
  const [stored, storedNoTimings, onServer, nowhere] = [sentence(), sentence(), sentence(), sentence()];
  const [storedKey, noTimingsKey, onServerKey, nowhereKey] = await Promise.all([stored, storedNoTimings, onServer, nowhere].map(keyOf));
  now = 10_000_000;
  await cache.putAudioBlob(storedKey, clip());
  await cache.putTimings(storedKey, timings);
  await cache.putAudioBlob(noTimingsKey, clip());
  server.timings.set(noTimingsKey, timings);
  server.clips.set(onServerKey, clip());
  server.timings.set(onServerKey, timings);

  now += 2 * 60 * 60 * 1000;
  const opened = urlsOpened;
  const progress: string[] = [];
  await preloadAudio([stored, `{{${storedNoTimings}}}`, onServer, nowhere, stored], (done, total) => progress.push(`${done}/${total}`), { intoMemory: false });

  assert.deepEqual(progress.slice(0, 2), ['0/4', '1/4'], 'the clip already stored with its timings counts at once');
  assert.equal(progress.at(-1), '4/4');
  assert.equal(urlsOpened, opened, 'no clip was opened as an object URL');
  assert.equal(mp3Requests(storedKey) + timingRequests(storedKey), 0, 'nothing is requested for what the device holds');
  assert.equal(mp3Requests(noTimingsKey), 0);
  assert.equal(timingRequests(noTimingsKey), 1, 'only the missing timings are fetched');
  assert.equal(mp3Requests(onServerKey), 1);
  assert.deepEqual(server.generated.filter(item => [stored, storedNoTimings, onServer, nowhere].includes(item.text)), [{ text: nowhere, voice: 'Mia' }]);
  assert.equal(mp3Requests(nowhereKey), 2, 'the missing clip is fetched again once generated');
  assert.deepEqual([...await cache.getStoredAudioKeys([storedKey, noTimingsKey, onServerKey, nowhereKey])].sort(), [storedKey, noTimingsKey, onServerKey, nowhereKey].sort());
  assert.equal((await cache.getStoredTimingKeys([storedKey, noTimingsKey, onServerKey, nowhereKey])).size, 4);
  assert.equal(await metaAt(storedKey), now, 'the clips found on the device are marked as used, as reading them did');
  assert.equal(await metaAt(noTimingsKey), now);
});

test('a session warm runs at most four downloads at once, and stopping it starts no more', async () => {
  const texts = Array.from({ length: 12 }, sentence);
  for (const key of await Promise.all(texts.map(keyOf))) server.clips.set(key, clip());
  const gates: Array<() => void> = [];
  server.latency = () => new Promise<void>(resolve => gates.push(resolve));
  server.maxInFlight = 0;
  const stop = new AbortController();
  const requestsBefore = server.requests.length;
  const generatedBefore = server.generated.length;
  try {
    const warm = preloadAudio(texts, undefined, { intoMemory: false, signal: stop.signal });
    while (gates.length < WARM_CONCURRENCY) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(server.inFlight, WARM_CONCURRENCY);
    stop.abort();
    server.latency = null;
    for (const release of gates.splice(0)) release();
    await warm;
    assert.equal(server.maxInFlight, WARM_CONCURRENCY);
    const started = server.requests.slice(requestsBefore).filter(url => url.endsWith('.mp3')).length;
    assert.equal(started, WARM_CONCURRENCY, 'the downloads under way finish, but no new one starts');
    assert.equal(server.generated.length, generatedBefore, 'nothing is generated after a stop');
  } finally {
    server.latency = null;
  }
});

test('a small warm-up opens its clips in memory and generates what the server lacks', async () => {
  const [cached, missing] = [sentence(), sentence()];
  const cachedKey = await keyOf(cached);
  server.clips.set(cachedKey, clip());
  server.timings.set(cachedKey, timings);
  const opened = urlsOpened;
  await ensureTTS([cached, missing]);
  assert.equal(urlsOpened, opened + 2, 'both clips are open, ready to play');
  assert.deepEqual(server.generated.filter(item => item.text === cached || item.text === missing), [{ text: missing, voice: 'Mia' }]);
});

test('a prefetch never asks the server to generate', async () => {
  const text = sentence();
  prefetchTTS([text]);
  const key = await keyOf(text);
  for (let attempt = 0; attempt < 50 && mp3Requests(key) === 0; attempt++) await new Promise(resolve => setImmediate(resolve));
  for (let attempt = 0; attempt < 50; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(mp3Requests(key), 1);
  assert.ok(!server.generated.some(item => item.text === text));
});
