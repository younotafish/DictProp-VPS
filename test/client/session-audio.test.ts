import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionAudio, type SessionAudioEngine } from '../../components/study/sessionAudio.ts';
import type { PlaybackState, PlaybackStatus, SpeakHandle } from '../../services/neuralTts.ts';

/**
 * An engine with one voice, like services/neuralTts: each speak supersedes the one before, and a handle stops only the
 * playback it started, while nothing has superseded it. A sentence starts loading; the test moves it on with set().
 * The log says what played, with ' (no download)' when a miss mustn't start the Kokoro download.
 */
function fakeEngine() {
  let owner = 0;
  let state: PlaybackState = { text: null, status: 'idle' };
  let progress = 0;
  const log: string[] = [];
  const prefetched: string[][] = [];
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
  const engine: SessionAudioEngine = {
    speakNatural: (text, options) => {
      const plain = text.trim();
      if (!plain) return { stop: () => {}, isActive: () => false };
      log.push(`play ${plain}${options?.allowDownload === false ? ' (no download)' : ''}`);
      state = { text: plain, status: 'loading' };
      return handle(plain);
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
    prefetchTTS: texts => { prefetched.push([...texts]); },
  };
  return {
    log,
    prefetched,
    audio: createSessionAudio(engine),
    /** The sentence playing moves on: it plays, pauses or ends, `played` of the way through. */
    set: (status: PlaybackStatus, played = 0) => {
      state = status === 'idle' ? { text: null, status } : { ...state, status };
      progress = played;
    },
    /** Something else in the app speaks: a speaker button, the card view, another tab's screen. */
    foreign: (text: string) => engine.speakNatural(text),
  };
}

const PROMPT = 'She looked crestfallen.';

test('a prompt played as its card appears never starts the voice download; one replayed for a key may', () => {
  const { audio, log } = fakeEngine();
  audio.playPrompt(PROMPT);
  audio.replayPrompt(PROMPT);
  assert.deepEqual(log, [`play ${PROMPT} (no download)`, `play ${PROMPT}`]);
});

test('stopping stops what the session started, once', () => {
  const { audio, log, set } = fakeEngine();
  audio.playPrompt(PROMPT);
  set('playing', 0.4);
  audio.stopAll();
  audio.stopAll();
  assert.deepEqual(log, [`play ${PROMPT} (no download)`, `stop ${PROMPT}`]);
});

test('audio the session did not start is never stopped, even when it took over from the session\'s', () => {
  const { audio, log, foreign } = fakeEngine();
  audio.playPrompt(PROMPT);
  foreign('A sentence from somewhere else.');
  audio.stopAll();
  assert.deepEqual(log, [`play ${PROMPT} (no download)`, 'play A sentence from somewhere else.']);

  const later = fakeEngine();
  later.foreign('Already playing.');
  later.audio.stopAll();
  assert.deepEqual(later.log, ['play Already playing.']);
});

test('a handle a newer session speak superseded is never stopped again, and a speak of nothing hides nothing', () => {
  const { audio, log } = fakeEngine();
  audio.playPrompt(PROMPT);
  audio.sayWord('crestfallen');
  audio.playPrompt('   ');
  audio.sayWord(' ');
  audio.stopAll();
  assert.deepEqual(log, [`play ${PROMPT} (no download)`, 'say crestfallen', 'stop word crestfallen']);
});

test('the answer showing says the word, unless a sentence is playing or loading, which it would cut off', () => {
  const { audio, log, set } = fakeEngine();
  audio.playPrompt(PROMPT);
  audio.sayWordOnReveal('crestfallen');
  set('playing', 0.3);
  audio.sayWordOnReveal('crestfallen');
  assert.deepEqual(log, [`play ${PROMPT} (no download)`]);

  set('paused', 0.3);
  audio.sayWordOnReveal('crestfallen');
  set('idle');
  audio.sayWordOnReveal('crestfallen');
  assert.deepEqual(log.slice(1), ['say crestfallen', 'say crestfallen']);
});

test('E once the answer shows plays, pauses, resumes and restarts the example as every play control does', () => {
  const { audio, log, set, foreign } = fakeEngine();
  // Markers and spaces don't make it another sentence.
  const shown = ' She looked {{crestfallen}}. ';
  audio.toggleSentence(shown);
  audio.toggleSentence(shown);
  assert.deepEqual(log, [`play ${PROMPT}`], 'a sentence still loading is left to start');

  set('playing', 0.5);
  audio.toggleSentence(shown);
  audio.toggleSentence(shown);
  set('playing', 0.9);
  audio.toggleSentence(shown);
  assert.deepEqual(log.slice(1), ['pause', 'resume', `play ${PROMPT}`], 'near its end it starts again from the top');

  foreign('Another sentence.');
  set('playing', 0.2);
  audio.toggleSentence(shown);
  assert.equal(log.at(-1), `play ${PROMPT}`, 'another sentence playing: the example starts instead');
  audio.stopAll();
  assert.equal(log.at(-1), `stop ${PROMPT}`, 'and it is the session\'s to stop');
  audio.toggleSentence('   ');
  assert.equal(log.at(-1), `stop ${PROMPT}`, 'no sentence, no sound');
});

test('prefetching only fetches: it hands the prompts to the fetch-only warm-up and plays nothing', () => {
  const { audio, log, prefetched } = fakeEngine();
  audio.prefetch(['One.', 'Two.']);
  audio.prefetch([]);
  assert.deepEqual(prefetched, [['One.', 'Two.']]);
  assert.deepEqual(log, []);
});
