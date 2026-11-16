import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

// services/speech.ts logs each voice event through logger.log; on a loaded machine those stdout lines can garble the
// test runner's stream ('Unable to deserialize cloned data') after every subtest has passed. Mute them for the file.
mock.method(console, 'log', () => {});

// services/speech.ts, the system voice: its reset when the page comes back into view. The module reads the page and
// the speech engine when it loads, so each test installs its own and imports a fresh copy.

/** The parts of speechSynthesis the system voice uses. Its voices arrive late, as Chrome's do. */
class FakeSynth extends EventTarget {
  voices: Array<{ name: string; lang: string; localService: boolean }> = [];
  spoken: string[] = [];
  cancels = 0;
  paused = false;
  getVoices() { return this.voices; }
  speak(utterance: { text: string }) { this.spoken.push(utterance.text); }
  cancel() { this.cancels++; }
  resume() {}

  /** The voices load: Chrome fires voiceschanged once they're in. */
  loadVoices() {
    this.voices = [{ name: 'Samantha', lang: 'en-US', localService: true }];
    this.dispatchEvent(new Event('voiceschanged'));
  }
}

class FakeUtterance {
  lang = '';
  rate = 1;
  voice: unknown = null;
  constructor(readonly text: string) {}
}

/** A page whose visibility a test changes, firing visibilitychange as the browser does. */
class FakePage extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  show(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

const globals = globalThis as Record<string, unknown>;
let copies = 0;
const loadSpeech = async (browser: { window?: unknown; document?: unknown }) => {
  Object.assign(globals, browser, { SpeechSynthesisUtterance: FakeUtterance });
  return await import(`../../services/speech.ts?copy=${++copies}`) as typeof import('../../services/speech.ts');
};

afterEach(() => {
  mock.timers.reset();
  delete globals.window;
  delete globals.document;
  delete globals.SpeechSynthesisUtterance;
});

test('the page coming back into view resets the engine, and an utterance still waiting for the voices stays silent', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const synth = new FakeSynth();
  const page = new FakePage();
  const { speak } = await loadSpeech({ window: { speechSynthesis: synth }, document: page });

  speak('waiting for the voices');
  page.show('hidden');
  assert.equal(synth.cancels, 0, 'going into the background leaves speech alone');
  page.show('visible');
  assert.equal(synth.cancels, 1, 'coming back cancels the engine');

  synth.loadVoices();
  assert.deepEqual(synth.spoken, [], 'the voices arriving don’t start the utterance the reset dropped');
  speak('after the reset');
  assert.deepEqual(synth.spoken, ['after the reset'], 'speech after the reset plays');
});

test('an utterance the reset dropped stays silent when the wait for the voices times out too', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const synth = new FakeSynth();
  const page = new FakePage();
  const { speak } = await loadSpeech({ window: { speechSynthesis: synth }, document: page });

  speak('waiting for the voices');
  page.show('visible');
  mock.timers.tick(1_500);
  assert.deepEqual(synth.spoken, []);
});

test('the module loads without a page or a speech engine', async () => {
  const speech = await loadSpeech({});
  assert.equal(typeof speech.speak, 'function');
  assert.doesNotThrow(() => speech.cancelSpeech(), 'stopping speech where there is none does nothing');

  const withoutEngine = await loadSpeech({ window: {}, document: new FakePage() });
  assert.equal(withoutEngine.speak('hello'), null, 'a page without a speech engine speaks nothing');
});
