import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeAudioElement, FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, until } from '../support/audio/fakeMedia.ts';
import { startAtForOffset } from '../../services/ttsAlignment.ts';

// Playing a sentence from one of its words: services/ttsAlignment.ts startAtForOffset, which finds the word in the
// clip's timings, and the engine's speakNaturalAt, which plays the sentence's own clip from there.

const MAC_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const media = installFakeMedia({ userAgent: IPHONE_USER_AGENT });
const server = new FakeTtsServer();
server.install();
let workersStarted = 0;
Object.assign(globalThis, { Worker: class { constructor() { workersStarted++; } postMessage() {} terminate() {} } });

const engine = await import('../../services/neuralTts.ts');
const { ttsKey } = await import('../../services/api/tts.ts');
const { setTtsStyle } = await import('../../services/ttsSettings.ts');

const TIMINGS = [
  { text: 'The', start: 0.1, end: 0.3 },
  { text: 'quick', start: 0.35, end: 0.7 },
  { text: 'brown', start: 0.75, end: 1.1 },
  { text: 'fox', start: 1.2, end: 1.5 },
];

test('a word\'s offset finds its start in the timings: at the word, inside it, and past leading spaces', () => {
  const text = 'The quick brown fox';
  assert.equal(startAtForOffset(text, TIMINGS, 4), 0.35, 'the first letter of "quick"');
  assert.equal(startAtForOffset(text, TIMINGS, 12), 0.75, 'inside "brown"');
  assert.equal(startAtForOffset(text, TIMINGS, 0), 0.1);
  // The offsets count the sentence as shown, with its leading spaces; the timings belong to the trimmed text.
  assert.equal(startAtForOffset('  The quick brown fox', TIMINGS, 6), 0.35);
  assert.equal(startAtForOffset(text, null, 4), null, 'no timings, no start');
  assert.equal(startAtForOffset(text, [], 4), null);
});

const clip = () => new Blob([new Uint8Array(16)], { type: 'audio/mpeg' });
let sentences = 0;
/** A sentence no earlier case has played, with its clips (and their timings) in the voices given. */
const sentence = async (voices: Record<string, boolean>) => {
  const text = `The quick brown fox number ${++sentences}`;
  for (const [voice, withTimings] of Object.entries(voices)) {
    const key = await ttsKey(text, voice);
    server.clips.set(key, clip());
    if (withTimings) server.timings.set(key, TIMINGS);
  }
  return text;
};
const OFFSET_OF_BROWN = 10;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test.beforeEach(() => {
  engine.stopCurrent();
  FakeAudioElement.playPolicy = 'allow';
  server.latency = null;
});

test('the sentence\'s clip plays from the word, and the speakers show the whole sentence loading from the tap on', async () => {
  const text = await sentence({ Mia: true });
  const heard: string[] = [];
  engine.speakNaturalAt(`  {{${text.slice(0, 3)}}}${text.slice(3)}`, OFFSET_OF_BROWN + 2, { onEnd: () => heard.push('end') });
  assert.deepEqual(engine.getPlaybackState(), { text, status: 'loading' }, 'the full sentence, at once');
  const el = media.element();
  await until(() => el.src.startsWith('blob:'), 'the clip is set');
  el.loadMetadata(2);
  assert.equal(el.currentTime, 0.75, 'from "brown"');
  assert.equal(el.paused, false);
  el.startPlaying();
  assert.deepEqual(engine.getPlaybackState(), { text, status: 'playing' });
  el.finish();
  assert.deepEqual(heard, ['end']);
});

test('in the casual style, a sentence with only its clear clip plays that clip from the word, as a tap on it would', async () => {
  setTtsStyle('casual');
  try {
    const text = await sentence({ Mia: true });
    engine.speakNaturalAt(text, OFFSET_OF_BROWN);
    const el = media.element();
    await until(() => el.src.startsWith('blob:'), 'the clear clip is set');
    el.loadMetadata(2);
    assert.equal(el.currentTime, 0.75);
    assert.ok(!server.generated.some(item => item.text !== text && text.endsWith(item.text)), 'no fragment is made');
  } finally {
    setTtsStyle('clear');
  }
});

test('a clip whose timings take longer than 400 ms gives way to the rest of the sentence, still shown as the sentence', async () => {
  const text = await sentence({ Mia: true });
  const gates: Array<() => void> = [];
  server.latency = () => server.requests.at(-1)?.endsWith('/timings') ? new Promise<void>(resolve => gates.push(resolve)) : Promise.resolve();
  try {
    engine.speakNaturalAt(text, OFFSET_OF_BROWN);
    await until(() => gates.length > 0, 'the timings are asked for');
    await sleep(250);
    assert.notEqual(media.synth.last?.text, 'brown fox number ' + sentences, 'it waits for the timings a moment');
    await until(() => media.synth.last?.text === `brown fox number ${sentences}`, 'the rest is read');
    assert.equal(gates.length, 1, 'without the timings, which never came');
    assert.deepEqual(engine.getPlaybackState(), { text, status: 'loading' });
    media.synth.last?.onstart?.();
    assert.deepEqual(engine.getPlaybackState(), { text, status: 'playing' });
  } finally {
    server.latency = null;
    for (const release of gates.splice(0)) release();
  }
});

test('with no clip at all, the rest is read and the server is asked for the whole sentence\'s clip, never the fragment\'s', async () => {
  const text = `Nothing cached for sentence ${++sentences}`;
  const before = server.generated.length;
  engine.speakNaturalAt(text, 8);
  await until(() => media.synth.last?.text === `cached for sentence ${sentences}`, 'the rest is read');
  assert.deepEqual(server.generated.slice(before), [{ text, voice: 'Mia' }]);
});

test('on a laptop a word tap never starts the Kokoro download: the system voice reads the rest', async () => {
  Object.defineProperty(globalThis.navigator, 'userAgent', { configurable: true, value: MAC_USER_AGENT });
  try {
    const text = `Not cached on the laptop, sentence ${++sentences}`;
    engine.speakNaturalAt(text, 4);
    await until(() => media.synth.last?.text === `cached on the laptop, sentence ${sentences}`, 'the system voice reads');
    assert.equal(workersStarted, 0);
  } finally {
    Object.defineProperty(globalThis.navigator, 'userAgent', { configurable: true, value: IPHONE_USER_AGENT });
  }
});

test('the sentence playing already moves to the word in place; seekOnly never starts a read', async () => {
  const text = await sentence({ Mia: true });
  const playing = engine.speakNatural(text, { allowDownload: true });
  const el = media.element();
  await until(() => el.src.startsWith('blob:'), 'the clip is set');
  el.loadMetadata(2);
  el.startPlaying();
  el.currentTime = 0.2;
  engine.pauseCurrent();
  const seek = engine.speakNaturalAt(text, OFFSET_OF_BROWN, { seekOnly: true });
  assert.equal(el.currentTime, 0.75);
  assert.equal(el.paused, false, 'a paused clip plays on from the word');
  assert.deepEqual(engine.getPlaybackState(), { text, status: 'playing' });
  assert.equal(playing.isActive(), true, 'the same read, not a new one');
  assert.equal(seek.isActive(), true);

  engine.stopCurrent();
  const idle = engine.speakNaturalAt(text, OFFSET_OF_BROWN, { seekOnly: true });
  assert.equal(idle.isActive(), false);
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' }, 'nothing starts');
});

test('a read made up on the spot asks the server for nothing when it misses', async () => {
  const text = `Made up on the spot, number ${++sentences}`;
  const before = server.generated.length;
  engine.speakNatural(text, { generateOnMiss: false });
  await until(() => media.synth.last?.text === text, 'the system voice reads');
  assert.equal(server.generated.length, before);
});
