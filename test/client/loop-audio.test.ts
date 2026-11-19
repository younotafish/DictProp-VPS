import assert from 'node:assert/strict';
import test from 'node:test';
import type { WarmEntry } from '../../services/audio/clipWarmers.ts';
import type { SpeakHandle } from '../../services/neuralTts.ts';
import type { TtsStyle } from '../../services/ttsSettings.ts';
import { createLoopAudio, type LoopAudioEngine } from '../../views/today/loopAudio.ts';

/**
 * An engine with one voice, like services/neuralTts: each speak supersedes the one before, and a handle stops only the
 * playback it started, while nothing has superseded it. The log says what played, in which voice, and ' (no download)'
 * when a missing clip mustn't start the Kokoro download.
 */
function fakeEngine(initialStyle: TtsStyle = 'clear') {
  let owner = 0;
  let style = initialStyle;
  const log: string[] = [];
  const prefetched: WarmEntry[][] = [];
  const handle = (label: string): SpeakHandle => {
    const mine = ++owner;
    return {
      stop: () => {
        if (mine !== owner) return;
        owner++;
        log.push(`stop ${label}`);
      },
      isActive: () => mine === owner,
    };
  };
  const engine: LoopAudioEngine = {
    speakNatural: (text, options) => {
      log.push(`play ${text} [${style}]${options?.allowDownload === false ? ' (no download)' : ''}`);
      return handle(text);
    },
    prefetchTTS: entries => { prefetched.push([...entries]); },
    getTtsStyle: () => style,
    setTtsStyle: value => {
      log.push(`voice ${value}`);
      style = value;
    },
  };
  return { log, prefetched, engine, audio: createLoopAudio(engine) };
}

const SENTENCE = 'Could you keep an eye on my bag?';

test('an answer plays the sentence\'s clip, never starting the download as it shows', () => {
  const { audio, log } = fakeEngine();
  audio.sayAnswer({ text: SENTENCE });
  assert.deepEqual(log, [`play ${SENTENCE} [clear] (no download)`]);
});

test('saying it again may start the download, as any play someone asked for does', () => {
  const { audio, log } = fakeEngine();
  audio.replay({ text: SENTENCE });
  assert.deepEqual(log, [`play ${SENTENCE} [clear]`]);
});

test('a sentence plays in its own voice, switched before the read starts; one without a voice plays in the current one', () => {
  const { audio, log } = fakeEngine('clear');
  audio.sayAnswer({ text: SENTENCE, style: 'casual' });
  audio.replay({ text: SENTENCE, style: 'casual' });
  audio.sayAnswer({ text: 'Another one.' });
  assert.deepEqual(log, [
    'voice casual',
    `play ${SENTENCE} [casual] (no download)`,
    `play ${SENTENCE} [casual]`,
    'play Another one. [casual] (no download)',
  ]);
});

test('blank answers say nothing, and surrounding space is trimmed', () => {
  const { audio, log } = fakeEngine();
  audio.sayAnswer({ text: '  ' });
  audio.replay({ text: '', style: 'casual' });
  audio.sayAnswer({ text: ' See you soon. ' });
  assert.deepEqual(log, ['play See you soon. [clear] (no download)']);
});

test('stopping stops what the session started, its card speaker\'s reads included, once, and never audio it didn\'t start', () => {
  const { audio, engine, log } = fakeEngine();
  audio.sayAnswer({ text: SENTENCE });
  audio.stopAll();
  audio.stopAll();
  assert.deepEqual(log, [`play ${SENTENCE} [clear] (no download)`, `stop ${SENTENCE}`]);

  // The sentence's speaker on the card started this read: owned, it stops with the session's.
  log.length = 0;
  audio.own(engine.speakNatural('From the speaker.'));
  audio.stopAll();
  assert.deepEqual(log, ['play From the speaker. [clear]', 'stop From the speaker.']);

  // A read the session started that something else has since superseded is no longer the session's to stop.
  log.length = 0;
  audio.replay({ text: SENTENCE });
  engine.speakNatural('The sentence lesson reads this.');
  audio.stopAll();
  assert.deepEqual(log, [`play ${SENTENCE} [clear]`, 'play The sentence lesson reads this. [clear]']);
});

test('prefetching fetches the sentences\' clips in their voices, a sentence without one in the voice before it, and skips blanks', () => {
  const { audio, prefetched } = fakeEngine('clear');
  audio.prefetch([
    { text: ' First. ' },
    { text: 'Second.', style: 'casual' },
    { text: 'Third.' },
    { text: '  ' },
  ]);
  assert.deepEqual(prefetched, [[
    { text: 'First.', style: 'clear' },
    { text: 'Second.', style: 'casual' },
    { text: 'Third.', style: 'casual' },
  ]]);
  audio.prefetch([{ text: ' ' }]);
  audio.prefetch([]);
  assert.equal(prefetched.length, 1, 'nothing to fetch asks for nothing');
});
