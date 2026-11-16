import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESTART_NEAR_END, playbackStatusFor, sentenceSpaceAction, styleChangeReplay, toggleActionFor, wordCardSpaceAction,
  type ToggleOptions,
} from '../../services/audio/playbackToggle.ts';
import type { PlaybackState } from '../../services/audio/player.ts';

const SENTENCE = 'A sentence.';
const state = (status: PlaybackState['status'], text: string | null = SENTENCE): PlaybackState => ({ text: status === 'idle' ? null : text, status });

test('a sentence shows its own status only while it is the active one', () => {
  assert.equal(playbackStatusFor(state('playing'), SENTENCE), 'playing');
  assert.equal(playbackStatusFor(state('paused'), SENTENCE), 'paused');
  assert.equal(playbackStatusFor(state('playing', 'Another.'), SENTENCE), 'idle');
  assert.equal(playbackStatusFor(state('idle'), SENTENCE), 'idle');
});

test('each control variant decides a tap the way its call site does today', () => {
  // The speaker button cancels a load; the zone taps, keyboard readers and popups let it carry on; tapping the
  // sentence itself never restarts near the end.
  const speaker: ToggleOptions = { onLoading: 'cancel', restartNearEnd: true };
  const zones: ToggleOptions = { onLoading: 'ignore', restartNearEnd: true };
  const sentenceTap: ToggleOptions = { onLoading: 'ignore', restartNearEnd: false };
  const cases: Array<[PlaybackState, number, ToggleOptions, string]> = [
    [state('idle'), 0, speaker, 'start'],
    [state('playing', 'Another.'), 0.5, speaker, 'start'],
    [state('loading', 'Another.'), 0, zones, 'start'],
    [state('loading'), 0, speaker, 'cancel'],
    [state('loading'), 0, zones, 'ignore'],
    [state('paused'), 0.5, speaker, 'resume'],
    [state('paused'), 0.99, zones, 'resume'],
    [state('playing'), 0.5, speaker, 'pause'],
    [state('playing'), RESTART_NEAR_END - 0.01, zones, 'pause'],
    [state('playing'), RESTART_NEAR_END, speaker, 'restart'],
    [state('playing'), 0.99, zones, 'restart'],
    [state('playing'), 0.99, sentenceTap, 'pause'],
    [state('loading'), 0, sentenceTap, 'ignore'],
  ];
  for (const [current, progress, options, expected] of cases) {
    assert.equal(toggleActionFor(current, SENTENCE, progress, options), expected, `${current.status} ${current.text} at ${progress}`);
  }
  assert.equal(RESTART_NEAR_END, 0.85);
});

test('Clear or Casual replays a sentence it found playing or loading, and leaves a paused or idle one alone', () => {
  assert.equal(styleChangeReplay('playing'), 'replay');
  assert.equal(styleChangeReplay('loading'), 'replay');
  assert.equal(styleChangeReplay('paused'), 'none');
  assert.equal(styleChangeReplay('idle'), 'none');
});

test('Space in sentence review: auto-play\'s pause while it runs, else pause, resume, wait for a load, or start auto-play', () => {
  for (const autoPlay of ['running', 'paused'] as const) {
    for (const status of ['idle', 'loading', 'playing', 'paused'] as const) {
      assert.equal(sentenceSpaceAction({ autoPlay, status }), 'toggle-autoplay-pause', `${autoPlay} ${status}`);
    }
  }
  assert.equal(sentenceSpaceAction({ autoPlay: 'off', status: 'playing' }), 'pause');
  assert.equal(sentenceSpaceAction({ autoPlay: 'off', status: 'paused' }), 'resume');
  assert.equal(sentenceSpaceAction({ autoPlay: 'off', status: 'loading' }), 'ignore');
  assert.equal(sentenceSpaceAction({ autoPlay: 'off', status: 'idle' }), 'start-autoplay');
});

test('Space on a word card: stops example auto-play, else pauses or resumes a sentence, waits for a load, or toggles the slideshow', () => {
  for (const status of ['idle', 'loading', 'playing', 'paused'] as const) {
    assert.equal(wordCardSpaceAction({ examplesRunning: true, status }), 'stop-examples', status);
  }
  assert.equal(wordCardSpaceAction({ examplesRunning: false, status: 'playing' }), 'pause');
  assert.equal(wordCardSpaceAction({ examplesRunning: false, status: 'paused' }), 'resume');
  assert.equal(wordCardSpaceAction({ examplesRunning: false, status: 'loading' }), 'ignore');
  assert.equal(wordCardSpaceAction({ examplesRunning: false, status: 'idle' }), 'toggle-slideshow');
});
