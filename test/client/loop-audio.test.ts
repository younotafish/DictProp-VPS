import assert from 'node:assert/strict';
import test from 'node:test';
import type { WarmEntry } from '../../services/audio/clipWarmers.ts';
import type { PlaybackState, PlaybackStatus, SpeakHandle } from '../../services/neuralTts.ts';
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
  let state: PlaybackState = { text: null, status: 'idle' };
  let progress = 0;
  const log: string[] = [];
  const prefetched: WarmEntry[][] = [];
  const handle = (label: string): SpeakHandle => {
    const mine = ++owner;
    return {
      stop: () => {
        if (mine !== owner) return;
        owner++;
        state = { text: null, status: 'idle' };
        log.push(`stop ${label}`);
      },
      isActive: () => mine === owner,
    };
  };
  const engine: LoopAudioEngine = {
    speakNatural: (text, options) => {
      log.push(`play ${text} [${style}]${options?.allowDownload === false ? ' (no download)' : ''}`);
      state = { text, status: 'loading' };
      return handle(text);
    },
    speakWord: text => {
      log.push(`say ${text}`);
      state = { text: null, status: 'idle' };
      return handle(`word ${text}`);
    },
    getPlaybackState: () => state,
    getPlaybackProgress: () => progress,
    pauseCurrent: () => {
      log.push('pause');
      state = { ...state, status: 'paused' };
    },
    resumeCurrent: () => {
      log.push('resume');
      state = { ...state, status: 'playing' };
    },
    prefetchTTS: entries => { prefetched.push([...entries]); },
    getTtsStyle: () => style,
    setTtsStyle: value => {
      log.push(`voice ${value}`);
      style = value;
    },
  };
  return {
    log,
    prefetched,
    engine,
    audio: createLoopAudio(engine),
    /** The sentence playing moves on: it plays, pauses or ends, `played` of the way through. */
    set: (status: PlaybackStatus, played = 0) => {
      state = status === 'idle' ? { text: null, status } : { ...state, status };
      progress = played;
    },
  };
}

const SENTENCE = 'Could you keep an eye on my bag?';

test('a word\'s answer says the word in the system voice; a sentence\'s plays its clip, never starting the download as it shows', () => {
  const { audio, log } = fakeEngine();
  audio.sayAnswer({ kind: 'word', text: 'crestfallen' });
  audio.sayAnswer({ kind: 'sentence', text: SENTENCE });
  assert.deepEqual(log, ['say crestfallen', `play ${SENTENCE} [clear] (no download)`]);
});

test('saying it again may start the download, as any play someone asked for does', () => {
  const { audio, log } = fakeEngine();
  audio.replay({ kind: 'sentence', text: SENTENCE });
  audio.replay({ kind: 'word', text: 'crestfallen' });
  assert.deepEqual(log, [`play ${SENTENCE} [clear]`, 'say crestfallen']);
});

test('a sentence plays in its own voice, switched before the read starts; one without a voice plays in the current one', () => {
  const { audio, log } = fakeEngine('clear');
  audio.sayAnswer({ kind: 'sentence', text: SENTENCE, style: 'casual' });
  audio.replay({ kind: 'sentence', text: SENTENCE, style: 'casual' });
  audio.sayAnswer({ kind: 'sentence', text: 'Another one.' });
  assert.deepEqual(log, [
    'voice casual',
    `play ${SENTENCE} [casual] (no download)`,
    `play ${SENTENCE} [casual]`,
    'play Another one. [casual] (no download)',
  ]);
});

test('blank answers say nothing, and surrounding space is trimmed', () => {
  const { audio, log } = fakeEngine();
  audio.sayAnswer({ kind: 'word', text: '  ' });
  audio.replay({ kind: 'sentence', text: '', style: 'casual' });
  audio.sayAnswer({ kind: 'word', text: ' run ' });
  assert.deepEqual(log, ['say run']);
});

test('E plays the example without its markers, then pauses, resumes, and plays again near its end, ignoring a press while it loads', () => {
  const { audio, log, set } = fakeEngine();
  const example = 'She looked {{crestfallen}} after the loss.';
  const plain = 'She looked crestfallen after the loss.';
  audio.toggleExample(example);
  audio.toggleExample(example);
  assert.deepEqual(log, [`play ${plain} [clear]`], 'still loading: let it start');
  set('playing', 0.3);
  audio.toggleExample(example);
  set('paused', 0.3);
  audio.toggleExample(example);
  set('playing', 0.9);
  audio.toggleExample(example);
  assert.deepEqual(log, [`play ${plain} [clear]`, 'pause', 'resume', `play ${plain} [clear]`]);
  audio.toggleExample('   ');
  assert.equal(log.length, 4, 'nothing to play');
});

test('stopping stops what the session started, its card speakers\' reads included, once, and never audio it didn\'t start', () => {
  const { audio, engine, log, set } = fakeEngine();
  audio.sayAnswer({ kind: 'sentence', text: SENTENCE });
  set('playing', 0.4);
  audio.stopAll();
  audio.stopAll();
  assert.deepEqual(log, [`play ${SENTENCE} [clear] (no download)`, `stop ${SENTENCE}`]);

  // The example's speaker on the card started this read: owned, it stops with the session's.
  log.length = 0;
  audio.own(engine.speakNatural('From the speaker.'));
  audio.stopAll();
  assert.deepEqual(log, ['play From the speaker. [clear]', 'stop From the speaker.']);

  // A read the session started that something else has since superseded is no longer the session's to stop.
  log.length = 0;
  audio.replay({ kind: 'sentence', text: SENTENCE });
  engine.speakNatural('The card view reads this.');
  audio.stopAll();
  assert.deepEqual(log, [`play ${SENTENCE} [clear]`, 'play The card view reads this. [clear]']);
});

test('prefetching fetches the sentences\' clips in their voices, a sentence without one in the voice before it, and skips words', () => {
  const { audio, prefetched } = fakeEngine('clear');
  audio.prefetch([
    { kind: 'sentence', text: ' First. ' },
    { kind: 'sentence', text: 'Second.', style: 'casual' },
    { kind: 'word', text: 'skip' },
    { kind: 'sentence', text: 'Third.' },
    { kind: 'sentence', text: '  ' },
  ]);
  assert.deepEqual(prefetched, [[
    { text: 'First.', style: 'clear' },
    { text: 'Second.', style: 'casual' },
    { text: 'Third.', style: 'casual' },
  ]]);
  audio.prefetch([{ kind: 'word', text: 'only words' }]);
  audio.prefetch([]);
  assert.equal(prefetched.length, 1, 'nothing to fetch asks for nothing');
});
