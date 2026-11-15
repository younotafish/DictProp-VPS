import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeAudioElement, FakeTtsServer, IPHONE_USER_AGENT, installFakeMedia, until } from '../support/audio/fakeMedia.ts';

const media = installFakeMedia({ userAgent: IPHONE_USER_AGENT });
new FakeTtsServer().install();

type Facade = typeof import('../../services/lazyTts.ts');
// Each case gets its own façade, which hasn't loaded the engine yet; the engine module itself is shared.
let instance = 0;
const freshFacade = async () => await import(`../../services/lazyTts.ts?instance=${++instance}`) as Facade;
const engine = await import('../../services/neuralTts.ts');
const keepAliveElement = () => FakeAudioElement.created.find(element => element.loop);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('before the engine loads, playback reads idle; once it loads, subscribers follow the engine', async () => {
  const tts = await freshFacade();
  const heard: string[] = [];
  tts.subscribePlayback(state => heard.push(state.status));
  assert.deepEqual(tts.getPlaybackState(), { status: 'idle', text: null });
  tts.speakNatural('A sentence the façade reads.', { allowDownload: true });
  await until(() => heard.includes('loading'), 'the engine loads and the subscriber hears it');
  assert.deepEqual(tts.getPlaybackState(), engine.getPlaybackState());
  tts.stopCurrent();
  assert.equal(heard.at(-1), 'idle');
});

test('a read stopped before the engine loads never starts', async () => {
  const tts = await freshFacade();
  engine.stopCurrent();
  const handle = tts.speakNatural('A sentence stopped at once.', { allowDownload: true });
  assert.equal(handle.isActive(), true);
  handle.stop();
  assert.equal(handle.isActive(), false);
  await tts.ensureTimings('');
  await tick();
  assert.deepEqual(engine.getPlaybackState(), { text: null, status: 'idle' });
  assert.ok(!media.synth.spoken.some(utterance => utterance.text === 'A sentence stopped at once.'));
});

test('a keep-alive hold taken before the engine loads is handed to it, and a release before then cancels one', async () => {
  const tts = await freshFacade();
  tts.acquireKeepAlive();
  tts.acquireKeepAlive();
  tts.releaseKeepAlive();
  await until(() => keepAliveElement()?.paused === false, 'the engine takes the remaining hold');
  tts.releaseKeepAlive();
  assert.equal(keepAliveElement()?.paused, true, 'the last release stops it');
});

test('before the engine loads, a gap is timed by a plain timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tts = await freshFacade();
  const fired: string[] = [];
  tts.afterGap(1000, () => fired.push('gap'));
  const cancel = tts.afterGap(1000, () => fired.push('cancelled'));
  cancel();
  t.mock.timers.tick(1000);
  assert.deepEqual(fired, ['gap']);
});
