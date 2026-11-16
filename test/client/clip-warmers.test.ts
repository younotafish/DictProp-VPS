import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { FakeTtsServer, installFakeMedia, until } from '../support/audio/fakeMedia.ts';

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
const { loadClipUrl, loadTimingsCached } = await import('../../services/audio/clipStore.ts');
const cache = await import('../../services/audioCache.ts');
const { ttsKey } = await import('../../services/api/tts.ts');

const clip = () => new Blob([new Uint8Array(24)], { type: 'audio/mpeg' });
const timings = [{ text: 'Word', start: 0.1, end: 0.3 }];
let sentences = 0;
const sentence = () => `Warm-up sentence number ${++sentences}.`;
const keyOf = (text: string) => ttsKey(text, 'Mia');
const mp3Requests = (key: string) => server.requests.filter(url => url.endsWith(`/api/tts/${key}.mp3`)).length;
const timingRequests = (key: string) => server.requests.filter(url => url.endsWith(`/api/tts/${key}/timings`)).length;
/** Let pending tasks run (IndexedDB reads among them), so every path started has reached the network. */
const settle = async () => { for (let round = 0; round < 50; round++) await new Promise(resolve => setImmediate(resolve)); };
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

test('a session warm runs at most four downloads at once, and stopping it stops them and starts no more', async () => {
  const texts = Array.from({ length: 12 }, sentence);
  for (const key of await Promise.all(texts.map(keyOf))) server.clips.set(key, clip());
  const gates: Array<() => void> = [];
  server.latency = () => new Promise<void>(resolve => gates.push(resolve));
  server.maxInFlight = 0;
  const stop = new AbortController();
  const requestsBefore = server.requests.length;
  const generatedBefore = server.generated.length;
  const abortedBefore = server.aborted;
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
    assert.equal(started, WARM_CONCURRENCY, 'no new download starts');
    assert.equal(server.aborted, abortedBefore + WARM_CONCURRENCY, 'the downloads under way stop');
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

test('playback and a session warm share the download of a clip and of its timings, whichever asks first', async () => {
  for (const playbackFirst of [true, false]) {
    const text = sentence();
    const key = await keyOf(text);
    server.clips.set(key, clip());
    server.timings.set(key, timings);
    const gates: Array<() => void> = [];
    server.latency = () => new Promise<void>(resolve => gates.push(resolve));
    // A tap (speakNatural) loads the clip, then its timings, through these two.
    const playback = async () => { await loadClipUrl(key); await loadTimingsCached(key); };
    const warm = () => preloadAudio([text], undefined, { intoMemory: false });
    try {
      const first = playbackFirst ? playback() : warm();
      await until(() => mp3Requests(key) === 1, 'the clip is asked for');
      const second = playbackFirst ? warm() : playback();
      await settle();
      for (const release of gates.splice(0)) release();
      await until(() => timingRequests(key) === 1, 'its timings are asked for');
      await settle();
      server.latency = null;
      for (const release of gates.splice(0)) release();
      await Promise.all([first, second]);
      const order = playbackFirst ? 'playback first' : 'the warm first';
      assert.equal(mp3Requests(key), 1, `one clip download (${order})`);
      assert.equal(timingRequests(key), 1, `one timings download (${order})`);
      assert.ok((await cache.getStoredAudioKeys([key])).has(key), 'the clip is stored');
    } finally {
      server.latency = null;
      for (const release of gates.splice(0)) release();
    }
  }
});

test('a small warm-up asks for the missing clips without waiting on the timings of the clips it found', async () => {
  const [found, missing] = [sentence(), sentence()];
  const foundKey = await keyOf(found);
  server.clips.set(foundKey, clip());
  server.timings.set(foundKey, timings);
  const gates: Array<() => void> = [];
  // Only timings requests are held. The fake server calls this right after recording the request it holds.
  server.latency = () => server.requests.at(-1)?.endsWith('/timings') ? new Promise<void>(resolve => gates.push(resolve)) : Promise.resolve();
  try {
    const warm = ensureTTS([found, missing]);
    // No timings answer arrives while they're held, so this can't have waited for the found clip's timings.
    await until(() => server.generated.some(item => item.text === missing), 'the missing clip is sent to be generated');
    server.latency = null;
    for (const release of gates.splice(0)) release();
    await warm;
    assert.equal(timingRequests(foundKey), 1, "the found clip's timings are still warmed");
    const missingKey = await keyOf(missing);
    assert.equal(mp3Requests(missingKey), 2, 'the generated clip is fetched once it exists');
    assert.equal(timingRequests(missingKey), 1);
  } finally {
    server.latency = null;
    for (const release of gates.splice(0)) release();
  }
});

test('a warm-up counts each sentence once, a found clip once its timings settle', async () => {
  const texts = [sentence(), sentence(), sentence()];
  for (const key of await Promise.all(texts.map(keyOf))) {
    server.clips.set(key, clip());
    server.timings.set(key, timings);
  }
  const progress: string[] = [];
  await preloadAudio([...texts, texts[0]], (done, total) => progress.push(`${done}/${total}`));
  assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3']);
});


test('a session warm fetches each sentence in the voice it will play in, and has missing ones made in that voice', async () => {
  const [both, plain] = [sentence(), sentence()];
  const clearKey = await keyOf(both);
  const casualKey = await ttsKey(both, 'casual');
  server.clips.set(clearKey, clip());
  server.timings.set(clearKey, timings);
  const progress: string[] = [];
  // The same text in both voices counts twice; a plain text plays in the style now (clear).
  await preloadAudio([{ text: both, style: 'casual' }, { text: both, style: 'clear' }, plain, { text: both, style: 'casual' }],
    (done, total) => progress.push(`${done}/${total}`), { intoMemory: false });
  assert.equal(progress[0], '0/3');
  assert.equal(progress.at(-1), '3/3');
  assert.deepEqual(server.generated.filter(item => item.text === both || item.text === plain),
    [{ text: both, voice: 'casual' }, { text: plain, voice: 'Mia' }]);
  assert.equal(mp3Requests(casualKey), 2, 'the casual clip is looked up, then fetched once made');
  assert.deepEqual([...await cache.getStoredAudioKeys([clearKey, casualKey])].sort(), [clearKey, casualKey].sort());
});

test('only a clip the server answered it doesn\'t have is made; one that failed to download is left for the next warm', async () => {
  const [absent, failing] = [sentence(), sentence()];
  const failingKey = await keyOf(failing);
  server.failing.add(failingKey);
  try {
    const progress: string[] = [];
    await preloadAudio([absent, failing], (done, total) => progress.push(`${done}/${total}`), { intoMemory: false });
    assert.equal(progress.at(-1), '2/2', 'the failed one still counts as done');
    assert.deepEqual(server.generated.filter(item => item.text === absent || item.text === failing), [{ text: absent, voice: 'Mia' }]);
    assert.equal(mp3Requests(failingKey), 1);
    assert.equal((await cache.getStoredAudioKeys([failingKey])).size, 0);
  } finally {
    server.failing.delete(failingKey);
  }
});

test('stopping a session warm leaves a download playback shares with it to finish for playback', async () => {
  const [shared, own] = [sentence(), sentence()];
  const [sharedKey, ownKey] = await Promise.all([shared, own].map(keyOf));
  for (const key of [sharedKey, ownKey]) server.clips.set(key, clip());
  const gates: Array<() => void> = [];
  server.latency = () => new Promise<void>(resolve => gates.push(resolve));
  const stop = new AbortController();
  const abortedBefore = server.aborted;
  try {
    const warm = preloadAudio([shared, own], undefined, { intoMemory: false, signal: stop.signal });
    await until(() => mp3Requests(sharedKey) === 1 && mp3Requests(ownKey) === 1, 'both downloads start');
    const playback = loadClipUrl(sharedKey); // a tap on the shared sentence joins its download
    await settle();
    stop.abort();
    await warm;
    assert.equal(server.aborted, abortedBefore + 1, 'only the download nobody else waits for stops');
    for (const release of gates.splice(0)) release();
    assert.ok(await playback, 'playback still gets its clip');
    assert.equal(mp3Requests(sharedKey), 1, 'from the same download');
  } finally {
    server.latency = null;
    for (const release of gates.splice(0)) release();
  }
});
