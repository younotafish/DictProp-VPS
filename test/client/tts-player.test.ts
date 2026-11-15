import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeAudioElement, FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, until } from '../support/audio/fakeMedia.ts';

// An iPhone, so a cache miss goes straight to the system voice. No IndexedDB: clips come from the server.
const media = installFakeMedia({ userAgent: IPHONE_USER_AGENT });
const server = new FakeTtsServer();
server.install();

const engine = await import('../../services/neuralTts.ts');
const { ttsKey } = await import('../../services/api.ts');
const { setTtsStyle } = await import('../../services/ttsSettings.ts');

const clip = () => new Blob([new Uint8Array(16)], { type: 'audio/mpeg' });
let sentences = 0;
/** A sentence no earlier case has played, so nothing is cached in memory for it yet. */
const sentence = (cached: boolean, timings?: Array<{ text: string; start: number; end: number }>) => {
  const text = `Sentence number ${++sentences} reads aloud.`;
  return (async () => {
    const key = await ttsKey(text, 'Mia');
    if (cached) server.clips.set(key, clip());
    if (timings) server.timings.set(key, timings);
    return text;
  })();
};
const reads = () => {
  const heard: string[] = [];
  return { heard, onEnd: () => heard.push('end'), onError: () => heard.push('error') };
};
/** Start a cached sentence and wait until its clip is playing. */
const playing = async (callbacks = reads()) => {
  const text = await sentence(true);
  const handle = engine.speakNatural(text, { allowDownload: true, onEnd: callbacks.onEnd, onError: callbacks.onError });
  const el = media.element();
  await until(() => el.src.startsWith('blob:') && !el.paused, 'the clip is playing');
  el.loadMetadata(4);
  el.startPlaying();
  return { text, handle, el, callbacks };
};

test.beforeEach(() => {
  engine.stopCurrent();
  FakeAudioElement.playPolicy = 'allow';
});

test('a cached clip loads, plays and ends as a finished read', async () => {
  const text = await sentence(true);
  const callbacks = reads();
  const handle = engine.speakNatural(text, { allowDownload: true, onEnd: callbacks.onEnd, onError: callbacks.onError });
  assert.deepEqual(engine.getPlaybackState(), { text, status: 'loading' });
  const el = media.element();
  assert.match(el.src, /^data:audio\/wav/, 'the request clears the previous clip off the element at once');
  await until(() => el.src.startsWith('blob:'), 'the clip is set on the element');
  assert.equal(el.paused, false, 'play() was called');
  el.startPlaying();
  assert.equal(engine.getPlaybackState().status, 'playing');
  el.finish();
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  assert.deepEqual(callbacks.heard, ['end']);
  assert.equal(handle.isActive(), true, 'the handle stays current until something else plays');
  await until(() => server.generated.some(item => item.text === text), 'the missing timings are requested');
  assert.deepEqual(server.generated.find(item => item.text === text), { text, voice: 'Mia' });
});

test('warm timings skip the quiet lead-in, starting once the metadata is known', async () => {
  const text = await sentence(true, [{ text: 'Sentence', start: 0.13, end: 0.4 }]);
  engine.speakNatural(text, { allowDownload: true });
  const el = media.element();
  await until(() => el.src.startsWith('blob:'), 'the clip is set on the element');
  assert.equal(el.paused, true, 'it waits for the metadata before playing');
  el.loadMetadata(3);
  assert.equal(el.paused, false);
  assert.ok(Math.abs(el.currentTime - 0.1) < 1e-9, `starts 30 ms before the first word, not at ${el.currentTime}`);
});

test('pause keeps the position, resume continues, and progress follows the clip', async () => {
  const { el } = await playing();
  el.currentTime = 1;
  assert.equal(engine.getPlaybackProgress(), 0.25);
  engine.pauseCurrent();
  assert.equal(engine.getPlaybackState().status, 'paused');
  assert.equal(el.paused, true);
  const plays = el.playCalls;
  engine.resumeCurrent();
  assert.equal(engine.getPlaybackState().status, 'playing');
  assert.equal(el.playCalls, plays + 1);
  assert.equal(el.currentTime, 1, 'resumed where it paused');
});

test('a resume the browser refuses goes back to paused', async () => {
  const { el } = await playing();
  el.currentTime = 1;
  engine.pauseCurrent();
  FakeAudioElement.playPolicy = 'refuse';
  engine.resumeCurrent();
  assert.equal(engine.getPlaybackState().status, 'playing');
  await until(() => engine.getPlaybackState().status === 'paused', 'the refusal is noticed');
});

test('stopping ends the request: the handle goes inactive and its clip\'s later events are ignored', async () => {
  const { handle, el, callbacks } = await playing();
  engine.stopCurrent();
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  assert.equal(el.paused, true);
  assert.equal(handle.isActive(), false);
  el.finish();
  assert.deepEqual(callbacks.heard, []);
});

test('a handle stops only its own request', async () => {
  const first = await playing();
  const second = await playing();
  first.handle.stop();
  assert.equal(engine.getPlaybackState().text, second.text, 'a superseded handle leaves the newer read alone');
  second.handle.stop();
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
});

test('a newer request supersedes the older one, whose events no longer count', async () => {
  const older = await playing();
  const newer = await sentence(true);
  engine.speakNatural(newer, { allowDownload: true });
  assert.deepEqual(engine.getPlaybackState(), { text: newer, status: 'loading' });
  assert.equal(older.handle.isActive(), false);
  older.el.finish();
  assert.deepEqual(engine.getPlaybackState(), { text: newer, status: 'loading' });
  assert.deepEqual(older.callbacks.heard, []);
});

test('on an iPhone a miss asks the server for the clip and reads with the system voice', async () => {
  const text = await sentence(false);
  const callbacks = reads();
  const plays = media.element().playCalls;
  engine.speakNatural(text, { allowDownload: true, onEnd: callbacks.onEnd, onError: callbacks.onError });
  await until(() => media.synth.last?.text === text, 'the system voice is asked to read');
  assert.ok(server.generated.some(item => item.text === text && item.voice === 'Mia'), 'the clip is generated for next time');
  assert.equal(engine.getPlaybackState().status, 'loading');
  media.synth.last?.onstart?.();
  assert.equal(engine.getPlaybackState().status, 'playing');
  assert.equal(engine.getPlaybackProgress(), 0, 'the system voice reports no progress');
  let mark = media.synth.calls.length;
  engine.pauseCurrent();
  assert.deepEqual(media.synth.calls.slice(mark), ['pause']);
  mark = media.synth.calls.length;
  engine.resumeCurrent();
  assert.deepEqual(media.synth.calls.slice(mark), ['resume']);
  assert.equal(media.element().playCalls, plays + 1, 'only the unlock played the element; resume left it alone');
  media.synth.last?.onend?.();
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  assert.deepEqual(callbacks.heard, ['end']);
});

test('a clip the element refuses to play is read by the system voice instead', async () => {
  const text = await sentence(true);
  FakeAudioElement.playPolicy = 'refuse';
  engine.speakNatural(text, { allowDownload: true });
  await until(() => media.synth.last?.text === text, 'the system voice takes over');
  assert.equal(engine.getPlaybackState().text, text);
});

test('changing the speech style stops what is playing', async () => {
  const { callbacks } = await playing();
  setTtsStyle('casual');
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  setTtsStyle('clear');
  assert.deepEqual(callbacks.heard, []);
});

test('a word read clears the speakers and supersedes the sentence', async () => {
  const sentenceRead = await playing();
  const word = engine.speakWord('serendipity');
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  assert.equal(sentenceRead.handle.isActive(), false);
  assert.equal(media.synth.last?.text, 'serendipity');
  assert.equal(word.isActive(), true);
  word.stop();
  assert.equal(word.isActive(), false);
});

test('a media error after playback started ends the read as if it had finished', async () => {
  const { el, callbacks } = await playing();
  el.fail();
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  assert.deepEqual(callbacks.heard, ['end']);
});

test('a seek moves the clip and shows it playing, even when the browser refuses to play', async () => {
  const { el } = await playing();
  el.currentTime = 1;
  engine.pauseCurrent();
  engine.seekCurrent(2.5);
  assert.equal(el.currentTime, 2.5);
  assert.equal(engine.getPlaybackState().status, 'playing');
  engine.pauseCurrent();
  FakeAudioElement.playPolicy = 'refuse';
  engine.seekCurrent(1.5);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.getPlaybackState().status, 'playing');
});

test('without a speech engine a miss stays loading', async () => {
  const text = await sentence(false);
  const speechSynthesis = (globalThis as unknown as { window: { speechSynthesis?: unknown } }).window;
  const synth = speechSynthesis.speechSynthesis;
  speechSynthesis.speechSynthesis = undefined;
  try {
    engine.speakNatural(text, { allowDownload: true });
    await until(() => server.generated.some(item => item.text === text), 'the miss is reached');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(engine.getPlaybackState(), { text, status: 'loading' });
  } finally {
    speechSynthesis.speechSynthesis = synth;
  }
});
