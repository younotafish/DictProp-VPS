import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeAudioElement, FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, installFakeMediaSession, until } from '../support/audio/fakeMedia.ts';

// An iPhone, so a cache miss goes straight to the system voice. No IndexedDB: clips come from the server.
const media = installFakeMedia({ userAgent: IPHONE_USER_AGENT });
const lockScreen = installFakeMediaSession();
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
  return {
    heard,
    onEnd: () => heard.push('end'),
    onError: () => heard.push('error'),
    onInterrupted: (reason: string) => heard.push(`interrupted: ${reason}`),
  };
};
/** Let every queued microtask run, the engine's interruption reports among them. */
const microtasks = () => new Promise<void>(resolve => setImmediate(resolve));
/** Start a cached sentence and wait until its clip is playing. */
const playing = async (callbacks = reads()) => {
  const text = await sentence(true);
  const handle = engine.speakNatural(text, { allowDownload: true, ...callbacks });
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

test('after the browser refuses a clip it had seeked into, the system voice alone pauses and resumes', async () => {
  // Warm timings make the clip start past its lead-in, so the refused clip is left at a position past zero.
  const text = await sentence(true, [{ text: 'Sentence', start: 0.13, end: 0.4 }]);
  FakeAudioElement.playPolicy = 'refuse';
  engine.speakNatural(text, { allowDownload: true });
  const el = media.element();
  await until(() => el.src.startsWith('blob:'), 'the clip is set on the element');
  el.loadMetadata(3);
  await until(() => media.synth.last?.text === text, 'the system voice takes over');
  media.synth.last?.onstart?.();
  assert.ok(el.currentTime > 0, 'the refused clip sits past its start');
  assert.equal(engine.getPlaybackProgress(), 0, 'the refused clip\'s position is not the read\'s progress');
  engine.pauseCurrent();
  FakeAudioElement.playPolicy = 'allow';
  const plays = el.playCalls;
  const mark = media.synth.calls.length;
  engine.resumeCurrent();
  assert.equal(el.playCalls, plays, 'the refused clip does not start under the voice');
  assert.deepEqual(media.synth.calls.slice(mark), ['resume']);
  assert.equal(engine.getPlaybackState().status, 'playing');
});

test('changing the speech style stops what is playing', async () => {
  const { callbacks } = await playing();
  setTtsStyle('casual');
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  setTtsStyle('clear');
  assert.deepEqual(callbacks.heard, []);
});

test('in the casual style a casual clip plays, with its timings', async () => {
  setTtsStyle('casual');
  try {
    const text = `Sentence number ${++sentences} reads aloud.`;
    const casualKey = await ttsKey(text, 'casual');
    const clearKey = await ttsKey(text, 'Mia');
    server.clips.set(casualKey, clip());
    server.timings.set(casualKey, [{ text: 'Sentence', start: 0.05, end: 0.3 }]);
    engine.speakNatural(text, { allowDownload: true });
    const el = media.element();
    await until(() => el.src.startsWith('blob:'), 'the casual clip is set on the element');
    el.loadMetadata(3);
    assert.ok(server.requests.some(url => url.endsWith(`/api/tts/${casualKey}.mp3`)));
    assert.ok(!server.requests.some(url => url.endsWith(`/api/tts/${clearKey}.mp3`)), 'the clear clip is not fetched');
    assert.ok(!server.generated.some(item => item.text === text), 'nothing is generated');
  } finally {
    setTtsStyle('clear');
  }
});

test('in the casual style a missing casual clip is requested while the clear clip plays', async () => {
  setTtsStyle('casual');
  try {
    const text = await sentence(true);
    engine.speakNatural(text, { allowDownload: true });
    const el = media.element();
    await until(() => el.src.startsWith('blob:') && !el.paused, 'the clear clip plays');
    assert.deepEqual(server.generated.filter(item => item.text === text), [{ text, voice: 'casual' }]);
  } finally {
    setTtsStyle('clear');
  }
});

test('in the casual style with no clip at all, both styles are requested and the system voice reads', async () => {
  setTtsStyle('casual');
  try {
    const text = await sentence(false);
    engine.speakNatural(text, { allowDownload: true });
    await until(() => media.synth.last?.text === text, 'the system voice reads');
    assert.deepEqual(server.generated.filter(item => item.text === text), [{ text, voice: 'casual' }, { text, voice: 'Mia' }]);
  } finally {
    setTtsStyle('clear');
  }
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

test('a media error after playback started fails the read instead of finishing it', async () => {
  const { el, callbacks } = await playing();
  el.fail();
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  assert.deepEqual(callbacks.heard, ['error']);
});

test('a seek moves the clip and plays it, and shows it paused again when the browser refuses to play', async () => {
  const { el } = await playing();
  el.currentTime = 1;
  engine.pauseCurrent();
  engine.seekCurrent(2.5);
  assert.equal(el.currentTime, 2.5);
  assert.equal(el.paused, false);
  assert.equal(engine.getPlaybackState().status, 'playing');
  engine.pauseCurrent();
  FakeAudioElement.playPolicy = 'refuse';
  engine.seekCurrent(1.5);
  assert.equal(engine.getPlaybackState().status, 'playing');
  await until(() => engine.getPlaybackState().status === 'paused', 'the refusal is noticed');
});

test('a seek while the system voice reads leaves it alone', async () => {
  const text = await sentence(false);
  engine.speakNatural(text, { allowDownload: true });
  await until(() => media.synth.last?.text === text, 'the system voice reads');
  media.synth.last?.onstart?.();
  engine.pauseCurrent();
  const el = media.element();
  const plays = el.playCalls;
  engine.seekCurrent(1);
  assert.equal(el.playCalls, plays, 'nothing plays on the element');
  assert.equal(engine.getPlaybackState().status, 'paused', 'it still shows the voice paused');
});

test('without a speech engine a miss fails the read instead of loading for good', async () => {
  const text = await sentence(false);
  const speechSynthesis = (globalThis as unknown as { window: { speechSynthesis?: unknown } }).window;
  const synth = speechSynthesis.speechSynthesis;
  speechSynthesis.speechSynthesis = undefined;
  const callbacks = reads();
  try {
    engine.speakNatural(text, { allowDownload: true, onEnd: callbacks.onEnd, onError: callbacks.onError });
    await until(() => callbacks.heard.length > 0, 'the read fails');
    assert.deepEqual(callbacks.heard, ['error']);
    assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  } finally {
    speechSynthesis.speechSynthesis = synth;
  }
});

test('another sentence, a word, a stop or a style change ends a live read, which hears why once, after the call that ended it', async () => {
  const cases: Array<[string, () => void]> = [
    ['superseded', () => { engine.speakNatural('Another sentence altogether.', { allowDownload: true }); }],
    ['superseded', () => { engine.speakWord('serendipity'); }],
    ['stopped', () => engine.stopCurrent()],
    ['style-changed', () => setTtsStyle('casual')],
  ];
  try {
    for (const [reason, interrupt] of cases) {
      const { callbacks } = await playing();
      interrupt();
      assert.deepEqual(callbacks.heard, [], 'not during the call that interrupts');
      await microtasks();
      assert.deepEqual(callbacks.heard, [`interrupted: ${reason}`]);
      engine.stopCurrent();
      await microtasks();
      assert.deepEqual(callbacks.heard, [`interrupted: ${reason}`], 'once');
    }
  } finally {
    setTtsStyle('clear');
  }
});

test('a read still loading hears an interruption too', async () => {
  const callbacks = reads();
  engine.speakNatural(await sentence(true), { allowDownload: true, ...callbacks });
  engine.stopCurrent();
  await microtasks();
  assert.deepEqual(callbacks.heard, ['interrupted: stopped']);
});

test('the owner\'s own stop, the end of a read and its failure are never interruptions', async () => {
  const stopped = await playing();
  stopped.handle.stop();
  // A view's unmount stops its own read, then calls stopCurrent() for whatever else may play.
  engine.stopCurrent();
  const ended = await playing();
  ended.el.finish();
  engine.speakWord('afterwards');
  const failed = await playing();
  failed.el.fail();
  engine.stopCurrent();
  await microtasks();
  assert.deepEqual(stopped.callbacks.heard, []);
  assert.deepEqual(ended.callbacks.heard, ['end']);
  assert.deepEqual(failed.callbacks.heard, ['error']);
});

test('a hold between reads hears the next speech or stop, and nothing once released', async () => {
  const ended = await playing();
  ended.el.finish();
  const heard: string[] = [];
  const hold = () => engine.reservePlayback(reason => heard.push(reason));
  hold();
  engine.pauseCurrent();
  engine.resumeCurrent();
  await microtasks();
  assert.deepEqual(heard, [], 'pause and resume end nothing');
  engine.speakWord('hello');
  await microtasks();
  assert.deepEqual(heard, ['superseded']);

  hold();
  engine.stopCurrent();
  await microtasks();
  assert.deepEqual(heard, ['superseded', 'stopped']);

  const release = hold();
  release();
  engine.speakNatural(await sentence(true), { allowDownload: true });
  await microtasks();
  assert.deepEqual(heard, ['superseded', 'stopped'], 'a released hold hears nothing');

  // Taken while another read still plays, a hold hears at once that something else speaks.
  await playing();
  hold();
  await microtasks();
  assert.deepEqual(heard, ['superseded', 'stopped', 'superseded']);
});

test('the lock screen follows the engine unless an override says playing or paused', async () => {
  const { el } = await playing();
  assert.equal(lockScreen.playbackState, 'playing');
  engine.setPlaybackStateOverride('paused');
  assert.equal(lockScreen.playbackState, 'paused', 'the override wins over a playing clip');
  el.finish();
  assert.equal(engine.getPlaybackState().status, 'idle');
  assert.equal(lockScreen.playbackState, 'paused');
  engine.setPlaybackStateOverride('playing');
  assert.equal(lockScreen.playbackState, 'playing', 'auto-play reads as playing in a gap between reads');
  engine.setPlaybackStateOverride(null);
  assert.equal(lockScreen.playbackState, 'none', 'back to the engine\'s idle');
});

test('a pause the OS makes shows the read paused, and the clip playing again shows it playing', async () => {
  const { el, callbacks } = await playing();
  el.externalPause();
  assert.equal(engine.getPlaybackState().status, 'paused');
  assert.equal(lockScreen.playbackState, 'paused');
  el.startPlaying();
  assert.equal(engine.getPlaybackState().status, 'playing');
  assert.deepEqual(callbacks.heard, [], 'neither an end nor an interruption');
});

test('the pause events the engine causes itself change nothing: its own pause, a stop, and the pause at the end', async () => {
  const own = await playing();
  engine.pauseCurrent();
  own.el.onpause?.();
  assert.equal(engine.getPlaybackState().status, 'paused');
  engine.resumeCurrent();
  own.el.ended = true;
  own.el.onpause?.();
  assert.equal(engine.getPlaybackState().status, 'playing', 'the pause that comes with the end');
  own.el.ended = false;
  engine.stopCurrent();
  own.el.onpause?.();
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' }, 'a stopped read stays stopped');
});
